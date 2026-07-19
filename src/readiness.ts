import fs from 'node:fs';
import path from 'node:path';
import { runAwsCli } from './awscli.js';
import { auditLog } from './audit.js';
import type { Project } from './state.js';

/**
 * Launch readiness + version hygiene — the questions a senior DevOps engineer
 * asks BEFORE the traffic spike or the CVE, not after:
 *
 *   preflightLaunch — read-only: can this stack actually absorb a launch?
 *     Fargate vCPU quota vs the autoscaling ceiling, scaling headroom,
 *     database connection math, monitoring and backups in place.
 *   checkVersions   — read-only: is anything running on a runtime, base
 *     image, or database engine that is end-of-life?
 *
 * Both report facts with a verdict per line; fixes go through the normal
 * approval-gated tools.
 */

async function awsJson<T>(args: string[], region: string, timeoutMs = 45_000): Promise<T> {
  const res = await runAwsCli([...args, '--region', region, '--output', 'json'], timeoutMs);
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split(/\r?\n/).slice(-2).join(' '));
  return JSON.parse(res.stdout || '{}') as T;
}

export interface CheckLine {
  check: string;
  status: 'PASS' | 'WARN' | 'INFO';
  detail: string;
}

/** Render a readiness report (pure, testable). */
export function renderReport(title: string, lines: CheckLine[], skipped: string[]): string {
  const icon = { PASS: '✅', WARN: '⚠', INFO: 'ℹ' } as const;
  const warns = lines.filter((l) => l.status === 'WARN').length;
  const head = warns === 0 ? `${title}: ready — no blockers found.` : `${title}: ${warns} thing(s) to fix before you trust it under load.`;
  return [
    head,
    ...lines.map((l) => `${icon[l.status]} ${l.check}: ${l.detail}`),
    ...(skipped.length ? ['', `Could not check: ${skipped.join('; ')}.`] : []),
  ].join('\n');
}

/* ------------------------------------------------------------- preflight */

/** Rough max-connections for RDS Postgres by instance class (pure). */
export function pgMaxConnections(instanceClass: string): number {
  // LEAST(DBInstanceClassMemory/9531392, 5000): ~112/GiB of RAM.
  if (/micro/.test(instanceClass)) return 112;
  if (/small/.test(instanceClass)) return 225;
  if (/medium/.test(instanceClass)) return 450;
  if (/large/.test(instanceClass)) return 900;
  return 400;
}

export async function preflightLaunch(p: Project): Promise<string> {
  if ((p.cloud ?? 'aws') !== 'aws') {
    return 'The built-in preflight covers AWS today. For GCP/Azure I can run the same checks through the read-only CLI (quotas, scaling ceilings, backups) — say the word.';
  }
  const out = p.outputs ?? {};
  const region = p.region;
  const lines: CheckLine[] = [];
  const skipped: string[] = [];
  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      skipped.push(`${name} (${(e as Error).message.slice(0, 70)})`);
    }
  };

  if (p.siteBucket) return 'Static sites have no capacity to preflight — S3 scales automatically. Launch away.';
  if (out.api_function && !out.cluster_name) {
    return 'Serverless stacks scale to zero and back automatically; the ceilings that matter are account-level Lambda concurrency (default 1000, check with aws_cli: `aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384`) and DynamoDB on-demand, which needs no preflight. Monitoring/backups: run enable_cloud_monitoring and verify_backups.';
  }
  if (!out.cluster_name) return 'Nothing deployed to preflight yet.';

  // Gather ECS shape once: services, task vCPU, autoscaling ceilings.
  let services: string[] = [];
  if (out.service_name) services = [out.service_name];
  else if (out.service_names) services = Object.keys(JSON.parse(out.service_names));

  let taskVcpu = 0.25;
  let maxSum = 0;
  let desiredSum = 0;
  let maxIsCeiling = false;

  await run('capacity', async () => {
    const desc = await awsJson<{ services: Array<{ serviceName: string; desiredCount: number; taskDefinition: string }> }>(
      ['ecs', 'describe-services', '--cluster', out.cluster_name, '--services', ...services.slice(0, 10)], region,
    );
    const first = desc.services?.[0];
    if (first) {
      const td = await awsJson<{ taskDefinition: { cpu?: string } }>(
        ['ecs', 'describe-task-definition', '--task-definition', first.taskDefinition], region,
      );
      taskVcpu = Number(td.taskDefinition.cpu ?? '256') / 1024;
    }
    desiredSum = (desc.services ?? []).reduce((s, x) => s + (x.desiredCount ?? 0), 0);

    const scal = await awsJson<{ ScalableTargets: Array<{ ResourceId: string; MinCapacity: number; MaxCapacity: number }> }>(
      ['application-autoscaling', 'describe-scalable-targets', '--service-namespace', 'ecs'], region,
    );
    const ours = (scal.ScalableTargets ?? []).filter((t) => t.ResourceId.includes(`service/${out.cluster_name}/`));
    maxSum = ours.reduce((s, t) => s + t.MaxCapacity, 0);
    if (ours.length === 0) {
      lines.push({ check: 'Autoscaling', status: 'WARN', detail: 'No autoscaling targets — the service is pinned at a fixed count and a traffic spike has nowhere to go.' });
    } else {
      const pinned = ours.filter((t) => t.MaxCapacity <= t.MinCapacity);
      lines.push({
        check: 'Autoscaling ceiling',
        status: pinned.length ? 'WARN' : 'PASS',
        detail: pinned.length
          ? `MAX equals MIN on ${pinned.length} service(s) — autoscaling is configured but cannot actually scale. Raising MaxCapacity is a one-command fix I can apply with approval.`
          : `services can scale to ${maxSum} task(s) total (currently ${desiredSum} running).`,
      });
      maxIsCeiling = true;
    }
  });

  await run('Fargate quota', async () => {
    const q = await awsJson<{ Quota: { Value: number } }>(
      ['service-quotas', 'get-service-quota', '--service-code', 'fargate', '--quota-code', 'L-3032A538'], region,
    );
    const quota = q.Quota?.Value ?? 0;
    const needed = Math.ceil((maxIsCeiling ? maxSum : desiredSum) * taskVcpu);
    lines.push({
      check: 'Fargate vCPU quota',
      status: needed > quota ? 'WARN' : 'PASS',
      detail:
        needed > quota
          ? `scaling to the ceiling needs ~${needed} vCPUs but the account quota is ${quota} — the scale-out will FAIL mid-launch. I can request an increase (aws_cli, approval-gated) — AWS usually grants it in hours.`
          : `${quota} vCPUs available; full scale-out needs ~${needed}.`,
    });
  });

  if (p.blueprint?.withDatabase && out.db_endpoint) {
    await run('database', async () => {
      const db = await awsJson<{ DBInstances: Array<{ DBInstanceClass: string; MultiAZ: boolean; BackupRetentionPeriod: number }> }>(
        ['rds', 'describe-db-instances', '--db-instance-identifier', `po-${p.name}`], region,
      );
      const inst = db.DBInstances?.[0];
      if (!inst) return;
      const maxConn = pgMaxConnections(inst.DBInstanceClass);
      const worstTasks = maxIsCeiling ? maxSum : desiredSum;
      const assumedPool = 10;
      const needed = worstTasks * assumedPool;
      lines.push({
        check: 'DB connections',
        status: needed > maxConn ? 'WARN' : 'PASS',
        detail:
          needed > maxConn
            ? `${worstTasks} tasks × ~${assumedPool} pooled connections ≈ ${needed}, but ${inst.DBInstanceClass} tops out around ${maxConn} — under full scale the app will hit "too many connections". Fix: smaller pools, PgBouncer, or a bigger class.`
            : `~${needed} connections at full scale vs ~${maxConn} available on ${inst.DBInstanceClass}.`,
      });
      lines.push({
        check: 'DB backups',
        status: inst.BackupRetentionPeriod > 0 ? 'PASS' : 'WARN',
        detail: inst.BackupRetentionPeriod > 0 ? `automated backups ON (${inst.BackupRetentionPeriod}-day retention).` : 'automated backups are OFF — one bad migration and the data is gone.',
      });
      if (!inst.MultiAZ) {
        lines.push({ check: 'DB availability', status: 'INFO', detail: 'single-AZ instance — fine for cost, but an AZ event takes the database down with it. Multi-AZ roughly doubles the DB cost.' });
      }
    });
  }

  await run('monitoring', async () => {
    const alarms = await awsJson<{ MetricAlarms: Array<{ AlarmName: string }> }>(
      ['cloudwatch', 'describe-alarms', '--alarm-name-prefix', `po-${p.name}`], region,
    );
    const n = alarms.MetricAlarms?.length ?? 0;
    lines.push({
      check: 'Always-on monitoring',
      status: n > 0 ? 'PASS' : 'WARN',
      detail: n > 0 ? `${n} alarm(s) watching this stack.` : 'no CloudWatch alarms exist — if it goes down at 3am nobody finds out until a user complains. enable_cloud_monitoring fixes this in one approval.',
    });
  });

  auditLog({ type: 'preflight.run', summary: `${p.name}: ${lines.filter((l) => l.status === 'WARN').length} warning(s)` });
  return renderReport(`Launch preflight for "${p.name}"`, lines, skipped);
}

/* -------------------------------------------------------------- versions */

interface VersionVerdict {
  level: 'ok' | 'aging' | 'eol';
  note: string;
}

// Dates are stated so the founder can judge; table maintained by hand like
// the price table in estimator.ts.
const LAMBDA_RUNTIMES: Record<string, VersionVerdict> = {
  'nodejs16.x': { level: 'eol', note: 'Node 16 ended April 2023; Lambda has deprecated this runtime' },
  'nodejs18.x': { level: 'eol', note: 'Node 18 ended April 2025 — move to nodejs22.x' },
  'nodejs20.x': { level: 'aging', note: 'Node 20 LTS maintenance ended April 2026 — plan the move to nodejs22.x' },
  'nodejs22.x': { level: 'ok', note: 'current LTS' },
  'python3.8': { level: 'eol', note: 'Python 3.8 ended October 2024' },
  'python3.9': { level: 'eol', note: 'Python 3.9 ended October 2025' },
  'python3.10': { level: 'aging', note: 'Python 3.10 support ends October 2026' },
  'python3.11': { level: 'ok', note: 'supported until October 2027' },
  'python3.12': { level: 'ok', note: 'supported until October 2028' },
  'go1.x': { level: 'eol', note: 'deprecated — use provided.al2023 for Go' },
  'dotnet6': { level: 'eol', note: '.NET 6 ended November 2024' },
};

const BASE_IMAGES: Array<{ re: RegExp; verdict: VersionVerdict }> = [
  { re: /^node:16(\b|[.-])/, verdict: { level: 'eol', note: 'Node 16 ended April 2023' } },
  { re: /^node:18(\b|[.-])/, verdict: { level: 'eol', note: 'Node 18 ended April 2025' } },
  { re: /^node:20(\b|[.-])/, verdict: { level: 'aging', note: 'Node 20 LTS maintenance ended April 2026 — move to node:22' } },
  { re: /^node:22(\b|[.-])/, verdict: { level: 'ok', note: 'current LTS' } },
  { re: /^python:3\.8(\b|[.-])/, verdict: { level: 'eol', note: 'Python 3.8 ended October 2024' } },
  { re: /^python:3\.9(\b|[.-])/, verdict: { level: 'eol', note: 'Python 3.9 ended October 2025' } },
  { re: /^python:3\.10(\b|[.-])/, verdict: { level: 'aging', note: 'Python 3.10 ends October 2026' } },
  { re: /^(debian:buster|ubuntu:18\.04|ubuntu:20\.04)(\b|[.-])?/, verdict: { level: 'eol', note: 'this OS release is past standard support' } },
];

/** Judge a Lambda runtime id (pure, testable). */
export function judgeLambdaRuntime(runtime: string): VersionVerdict {
  return LAMBDA_RUNTIMES[runtime] ?? { level: 'ok', note: 'not in the EOL table — likely current' };
}

/** Judge a Dockerfile FROM image (pure, testable). */
export function judgeBaseImage(image: string): VersionVerdict | null {
  const clean = image.trim().toLowerCase();
  for (const b of BASE_IMAGES) if (b.re.test(clean)) return b.verdict;
  return null;
}

/** Pull FROM images out of a Dockerfile (pure, testable). */
export function dockerfileBaseImages(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => /^\s*FROM\s+([^\s]+)/i.exec(l)?.[1])
    .filter((x): x is string => Boolean(x) && x !== 'scratch')
    .map((x) => x.replace(/\s+AS\s+.*$/i, ''));
}

export async function checkVersions(p: Project): Promise<string> {
  const lines: CheckLine[] = [];
  const skipped: string[] = [];
  const out = p.outputs ?? {};
  const toStatus = (v: VersionVerdict): 'PASS' | 'WARN' | 'INFO' => (v.level === 'eol' ? 'WARN' : v.level === 'aging' ? 'INFO' : 'PASS');

  // Dockerfiles in the attached repo (root + one level of service folders).
  if (p.repoPath && fs.existsSync(p.repoPath)) {
    const candidates = [path.join(p.repoPath, 'Dockerfile')];
    try {
      for (const e of fs.readdirSync(p.repoPath, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          candidates.push(path.join(p.repoPath, e.name, 'Dockerfile'));
        }
      }
    } catch { /* best-effort */ }
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const rel = path.relative(p.repoPath, file).replace(/\\/g, '/');
      for (const img of dockerfileBaseImages(fs.readFileSync(file, 'utf8'))) {
        const v = judgeBaseImage(img);
        if (v) lines.push({ check: `Base image ${img} (${rel})`, status: toStatus(v), detail: v.note });
      }
    }
    if (!lines.length) lines.push({ check: 'Base images', status: 'PASS', detail: 'no end-of-life base images found in the repo\'s Dockerfiles.' });
  }

  // Lambda runtimes (serverless stacks).
  if ((p.cloud ?? 'aws') === 'aws') {
    for (const fnKey of ['api_function', 'worker_function'] as const) {
      const fn = out[fnKey];
      if (!fn) continue;
      try {
        const cfg = await awsJson<{ Runtime?: string }>(['lambda', 'get-function-configuration', '--function-name', fn], p.region);
        if (cfg.Runtime) {
          const v = judgeLambdaRuntime(cfg.Runtime);
          lines.push({ check: `Lambda ${fn} (${cfg.Runtime})`, status: toStatus(v), detail: v.note });
        }
      } catch (e) {
        skipped.push(`lambda ${fn} (${(e as Error).message.slice(0, 60)})`);
      }
    }
    // Database engine + patch policy.
    if (p.blueprint?.withDatabase && out.db_endpoint) {
      try {
        const db = await awsJson<{ DBInstances: Array<{ EngineVersion: string; AutoMinorVersionUpgrade: boolean }> }>(
          ['rds', 'describe-db-instances', '--db-instance-identifier', `po-${p.name}`], p.region,
        );
        const inst = db.DBInstances?.[0];
        if (inst) {
          const major = parseInt(inst.EngineVersion, 10);
          lines.push({
            check: `PostgreSQL ${inst.EngineVersion}`,
            status: major <= 13 ? 'WARN' : 'PASS',
            detail: major <= 13 ? 'this major version is at/past end of standard support on RDS — plan a major-version upgrade.' : 'supported major version.',
          });
          lines.push({
            check: 'RDS minor patches',
            status: inst.AutoMinorVersionUpgrade ? 'PASS' : 'INFO',
            detail: inst.AutoMinorVersionUpgrade ? 'auto minor-version upgrade is ON — security patches apply in the maintenance window.' : 'auto minor-version upgrade is OFF — minor security patches need a manual apply.',
          });
        }
      } catch (e) {
        skipped.push(`rds (${(e as Error).message.slice(0, 60)})`);
      }
    }
  }

  if (!lines.length) return 'Nothing to version-check yet — attach a repo or deploy first.';
  auditLog({ type: 'versions.check', summary: `${p.name}: ${lines.filter((l) => l.status === 'WARN').length} EOL finding(s)` });
  return renderReport(`Version hygiene for "${p.name}"`, lines, skipped) + '\n(Dates from the built-in table — spot-check anything critical against the vendor\'s lifecycle page.)';
}
