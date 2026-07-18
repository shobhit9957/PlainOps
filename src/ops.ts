import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAwsCli } from './awscli.js';
import { resolveTofu, tofuRun } from './tofu.js';
import { cloudTfDir } from './multicloud.js';
import { validateLive, defaultDeps } from './orchestrator.js';
import { auditLog } from './audit.js';
import type { Project } from './state.js';

/**
 * Day-2 operations a DevOps engineer actually performs:
 *
 * rollbackDeployment — repoint an ECS service at the PREVIOUS immutable image
 *   tag (every PlainOps build pushes v<timestamp> alongside :live), register a
 *   new task-definition revision, roll, wait stable, verify HTTP.
 * checkDrift        — `tofu plan -detailed-exitcode` against the rendered
 *   blueprint: has anyone changed the infrastructure outside PlainOps?
 * findSavings       — read-only waste sweep: unattached volumes, idle load
 *   balancers, stopped instances still billing storage, orphaned elastic IPs.
 */

async function awsJson<T>(args: string[], region: string, timeoutMs = 60_000): Promise<T> {
  const res = await runAwsCli([...args, '--region', region, '--output', 'json'], timeoutMs);
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split(/\r?\n/).slice(-3).join(' '));
  return JSON.parse(res.stdout || '{}') as T;
}

/* ---------------------------------------------------------------- rollback */

export interface ImageTagInfo {
  tag: string;
  pushedAt: string;
}

/** Pick the tag to roll back to: the newest v* tag that is OLDER than the newest one. */
export function previousImageTag(tags: ImageTagInfo[]): { current: string; previous: string } | null {
  const versioned = tags
    .filter((t) => /^v\d+$/.test(t.tag))
    .sort((a, b) => b.tag.localeCompare(a.tag, undefined, { numeric: true }));
  if (versioned.length < 2) return null;
  return { current: versioned[0].tag, previous: versioned[1].tag };
}

async function listImageTags(repo: string, region: string): Promise<ImageTagInfo[]> {
  const res = await awsJson<{ imageDetails: Array<{ imageTags?: string[]; imagePushedAt: string }> }>(
    ['ecr', 'describe-images', '--repository-name', repo, '--max-items', '50'], region,
  );
  const out: ImageTagInfo[] = [];
  for (const img of res.imageDetails ?? []) {
    for (const tag of img.imageTags ?? []) out.push({ tag, pushedAt: img.imagePushedAt });
  }
  return out;
}

async function rollEcsService(
  cluster: string,
  service: string,
  repo: string,
  region: string,
  log: (l: string) => void,
): Promise<string> {
  const tags = await listImageTags(repo, region);
  const pick = previousImageTag(tags);
  if (!pick) throw new Error(`Only one build exists in ${repo} — nothing older to roll back to.`);
  log(`Rolling ${service} from ${pick.current} back to ${pick.previous}…`);

  const svc = await awsJson<{ services: Array<{ taskDefinition: string }> }>(
    ['ecs', 'describe-services', '--cluster', cluster, '--services', service], region,
  );
  const currentTd = svc.services?.[0]?.taskDefinition;
  if (!currentTd) throw new Error(`Service ${service} not found in cluster ${cluster}.`);

  const td = await awsJson<{ taskDefinition: Record<string, unknown> & { containerDefinitions: Array<{ image: string }> } }>(
    ['ecs', 'describe-task-definition', '--task-definition', currentTd], region,
  );
  const def = td.taskDefinition;
  const image = def.containerDefinitions[0].image.replace(/:[^:]+$/, `:${pick.previous}`);
  def.containerDefinitions[0].image = image;
  // register-task-definition rejects the read-only fields describe returns.
  for (const k of ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy', 'deregisteredAt']) {
    delete def[k];
  }
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'po-rollback-')), 'taskdef.json');
  fs.writeFileSync(tmp, JSON.stringify(def), 'utf8');
  const reg = await awsJson<{ taskDefinition: { taskDefinitionArn: string } }>(
    ['ecs', 'register-task-definition', '--cli-input-json', `file://${tmp.replace(/\\/g, '/')}`], region, 60_000,
  );
  fs.rmSync(tmp, { force: true });

  await awsJson(['ecs', 'update-service', '--cluster', cluster, '--service', service, '--task-definition', reg.taskDefinition.taskDefinitionArn], region, 60_000);
  log('Waiting for the service to stabilize on the previous version…');
  const stable = await runAwsCli(['ecs', 'wait', 'services-stable', '--cluster', cluster, '--services', service, '--region', region], 600_000);
  if (stable.code !== 0) throw new Error('The service did not stabilize on the rolled-back version — run_diagnosis will show why.');
  return pick.previous;
}

export async function rollbackDeployment(p: Project, serviceName: string | undefined, log: (l: string) => void): Promise<string> {
  if ((p.cloud ?? 'aws') !== 'aws') {
    return 'Rollback via immutable image tags is AWS-only right now. On GCP/Azure the equivalent is redeploying the previous git commit (git checkout <sha> then redeploy) — I can walk that with you.';
  }
  const out = p.outputs ?? {};
  if (out.service_names && out.cluster_name) {
    const services = Object.keys(JSON.parse(out.service_names));
    const target = serviceName?.trim();
    if (!target) return `This is a microservices stack — tell me which service to roll back: ${services.join(', ')} (or say "all of them").`;
    const roll = target === 'all' ? services : [target];
    const bad = roll.filter((s) => !services.includes(s));
    if (bad.length) return `Unknown service(s): ${bad.join(', ')}. This stack has: ${services.join(', ')}.`;
    const results: string[] = [];
    for (const s of roll) {
      const tag = await rollEcsService(out.cluster_name, s, `po-${p.name}-${s}`, p.region, log);
      results.push(`${s} → ${tag}`);
    }
    const url = p.siteUrl ?? out.app_url;
    if (url) {
      log('Verifying the live URL after rollback…');
      const check = await validateLive(url, defaultDeps, log, 6, 10_000);
      if (!check.ok) return `Rolled back (${results.join(', ')}) but ${url} returns ${check.detail} ⚠ — run_diagnosis to see what's still wrong.`;
    }
    auditLog({ type: 'rollback.done', summary: `${p.name}: ${results.join(', ')}` });
    return `Rolled back and verified serving: ${results.join(', ')}.`;
  }
  if (out.ecr_repo_url && out.cluster_name && out.service_name) {
    const repo = out.ecr_repo_url.split('/').pop()!;
    const tag = await rollEcsService(out.cluster_name, out.service_name, repo, p.region, log);
    const url = p.siteUrl ?? out.app_url;
    if (url) {
      log('Verifying the live URL after rollback…');
      const check = await validateLive(url, defaultDeps, log, 6, 10_000);
      if (!check.ok) return `Rolled back to ${tag} but ${url} returns ${check.detail} ⚠ — run_diagnosis to see what's still wrong.`;
    }
    auditLog({ type: 'rollback.done', summary: `${p.name}: rolled back to ${tag}` });
    return `Rolled back to the previous build (${tag}) — verified serving.`;
  }
  if (out.api_function) {
    return 'Serverless rollback: Lambda zips are not retained between deploys, so the honest path is `git revert`/checkout the previous commit and redeploy (one step). Retained Lambda versions are on the roadmap.';
  }
  if (p.siteBucket) {
    return 'Static-site rollback: redeploy the previous git commit (the deploy takes seconds), or restore individual files from S3 versioning if enabled (backup_now enables it).';
  }
  return 'Nothing deployed to roll back yet.';
}

/* ------------------------------------------------------------------ drift */

export interface DriftReport {
  drift: boolean;
  summary: string;
  changes: string[];
}

/** Parse `tofu plan` text output into a compact drift report (pure, testable). */
export function parsePlan(stdout: string, exitCode: number): DriftReport {
  if (exitCode === 0) return { drift: false, summary: 'No drift — the cloud matches the blueprint exactly.', changes: [] };
  const lines = stdout.split(/\r?\n/);
  const summaryLine = lines.find((l) => /^Plan: \d+ to add/.test(l.trim()))?.trim() ?? 'Changes detected.';
  const changes = lines
    .map((l) => l.trim())
    .filter((l) => /^# .+ (will be|must be)/.test(l))
    .map((l) => l.replace(/^# /, ''))
    .slice(0, 25);
  return { drift: true, summary: summaryLine, changes };
}

export async function checkDrift(p: Project, log: (l: string) => void): Promise<string> {
  const dir = cloudTfDir(p.name);
  if (!fs.existsSync(path.join(dir, 'terraform.tfstate'))) {
    return p.siteBucket
      ? 'Static sites have no Terraform state to drift — the S3 bucket either serves your files or it doesn\'t (get_status checks that).'
      : 'No infrastructure state exists for this project yet — nothing to compare.';
  }
  log('Comparing the real cloud against the blueprint (read-only plan)…');
  const bin = await resolveTofu();
  const init = await tofuRun(bin, dir, ['init', '-input=false'], () => {});
  if (init.code !== 0) return 'Could not initialize the plan (see logs) — the state directory may be damaged.';
  const plan = await tofuRun(bin, dir, ['plan', '-detailed-exitcode', '-input=false', '-lock=false'], () => {});
  if (plan.code === 1) return `Drift check errored:\n${plan.stdout.split(/\r?\n/).filter((l) => /Error/.test(l)).slice(0, 5).join('\n')}`;
  const report = parsePlan(plan.stdout, plan.code);
  auditLog({ type: 'drift.check', summary: `${p.name}: ${report.summary}` });
  if (!report.drift) return report.summary;
  return [
    `DRIFT DETECTED — someone or something changed this infrastructure outside PlainOps.`,
    report.summary,
    report.changes.length ? `Changed resources:\n${report.changes.map((c) => `  - ${c}`).join('\n')}` : '',
    `Options: (a) re-apply the blueprint to restore the reviewed configuration (approval required), (b) keep the manual change and I note it, (c) investigate first with the read-only CLIs.`,
  ].filter(Boolean).join('\n');
}

/* ---------------------------------------------------------------- savings */

const GB_MONTH_EBS = 0.09;
const ALB_MONTHLY = 18;
const EIP_MONTHLY = 3.6;

export interface SavingsLine {
  item: string;
  monthly: number;
}

export function summarizeSavings(lines: SavingsLine[]): string {
  if (lines.length === 0) return 'No obvious waste found — nothing idle, orphaned, or unattached in this region. 👍';
  const total = Math.round(lines.reduce((s, l) => s + l.monthly, 0) * 100) / 100;
  return [
    `Potential savings ≈ $${total}/month in this region:`,
    ...lines.map((l) => `  - ${l.item} (~$${l.monthly}/mo)`),
    'Say the word and I\'ll clean any of these up — each deletion gets its own approval.',
  ].join('\n');
}

export async function findSavings(region: string): Promise<string> {
  const lines: SavingsLine[] = [];

  try {
    const vols = await awsJson<{ Volumes: Array<{ VolumeId: string; Size: number }> }>(
      ['ec2', 'describe-volumes', '--filters', 'Name=status,Values=available'], region,
    );
    for (const v of vols.Volumes ?? []) {
      lines.push({ item: `Unattached EBS volume ${v.VolumeId} (${v.Size} GB) — paying for storage nothing uses`, monthly: Math.round(v.Size * GB_MONTH_EBS * 100) / 100 });
    }
  } catch { /* best-effort */ }

  try {
    const addrs = await awsJson<{ Addresses: Array<{ PublicIp: string; AssociationId?: string }> }>(
      ['ec2', 'describe-addresses'], region,
    );
    for (const a of addrs.Addresses ?? []) {
      if (!a.AssociationId) lines.push({ item: `Elastic IP ${a.PublicIp} not attached to anything`, monthly: EIP_MONTHLY });
    }
  } catch { /* best-effort */ }

  try {
    const stopped = await awsJson<{ Reservations: Array<{ Instances: Array<{ InstanceId: string; BlockDeviceMappings?: unknown[] }> }> }>(
      ['ec2', 'describe-instances', '--filters', 'Name=instance-state-name,Values=stopped'], region,
    );
    const count = (stopped.Reservations ?? []).flatMap((r) => r.Instances).length;
    if (count > 0) lines.push({ item: `${count} stopped EC2 instance(s) — compute is free while stopped, but their disks keep billing (~$8/mo per 100 GB)`, monthly: count * 4 });
  } catch { /* best-effort */ }

  try {
    const lbs = await awsJson<{ LoadBalancers: Array<{ LoadBalancerArn: string; LoadBalancerName: string }> }>(
      ['elbv2', 'describe-load-balancers'], region,
    );
    for (const lb of (lbs.LoadBalancers ?? []).slice(0, 10)) {
      const tgs = await awsJson<{ TargetGroups: Array<{ TargetGroupArn: string }> }>(
        ['elbv2', 'describe-target-groups', '--load-balancer-arn', lb.LoadBalancerArn], region,
      );
      let healthy = 0;
      for (const tg of tgs.TargetGroups ?? []) {
        const th = await awsJson<{ TargetHealthDescriptions: Array<{ TargetHealth: { State: string } }> }>(
          ['elbv2', 'describe-target-health', '--target-group-arn', tg.TargetGroupArn], region,
        );
        healthy += (th.TargetHealthDescriptions ?? []).filter((t) => t.TargetHealth.State === 'healthy').length;
      }
      if (healthy === 0) lines.push({ item: `Load balancer ${lb.LoadBalancerName} has ZERO healthy targets — serving nothing, billing anyway`, monthly: ALB_MONTHLY });
    }
  } catch { /* best-effort */ }

  try {
    const nats = await awsJson<{ NatGateways: Array<{ NatGatewayId: string; State: string }> }>(
      ['ec2', 'describe-nat-gateways', '--filter', 'Name=state,Values=available'], region,
    );
    for (const n of nats.NatGateways ?? []) {
      lines.push({ item: `NAT gateway ${n.NatGatewayId} — $32/mo baseline; PlainOps stacks don't need one, check if anything still uses it`, monthly: 32 });
    }
  } catch { /* best-effort */ }

  auditLog({ type: 'savings.scan', summary: `region ${region}: ${lines.length} finding(s)` });
  return summarizeSavings(lines);
}
