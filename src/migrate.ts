import fs from 'node:fs';
import path from 'node:path';
import { runAwsCli } from './awscli.js';
import { tailAppLogs } from './aws.js';
import { auditLog } from './audit.js';
import type { Project } from './state.js';

/**
 * Database schema migrations — the step that breaks more deploys than any
 * other, and the one that makes naive rollback dangerous (you can roll code
 * back; you cannot roll a dropped column back).
 *
 * PlainOps' approach:
 *   1. DETECT the project's migration tool from its own files.
 *   2. LINT the pending migrations for destructive statements and say so in
 *      plain English before anything runs.
 *   3. SNAPSHOT the database first (backup.ts), then run the migration as a
 *      one-off task inside the founder's cloud using the SAME image and
 *      network as the running service — no local database access needed.
 */

export interface MigrationPlan {
  tool: string;
  command: string;
  note: string;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Detect the migration tool from the repo's own files (pure, testable). */
export function detectMigrations(repoPath: string): MigrationPlan | null {
  const has = (rel: string) => fs.existsSync(path.join(repoPath, rel));
  const pkg = readJson(path.join(repoPath, 'package.json'));
  const deps = { ...(pkg?.dependencies as object), ...(pkg?.devDependencies as object) } as Record<string, string>;

  if (has('prisma/schema.prisma') || deps?.prisma || deps?.['@prisma/client']) {
    return { tool: 'Prisma', command: 'npx prisma migrate deploy', note: 'Applies every pending migration in prisma/migrations.' };
  }
  if (has('knexfile.js') || has('knexfile.ts') || deps?.knex) {
    return { tool: 'Knex', command: 'npx knex migrate:latest', note: 'Runs pending Knex migrations.' };
  }
  if (deps?.['node-pg-migrate']) {
    return { tool: 'node-pg-migrate', command: 'npx node-pg-migrate up', note: 'Applies pending SQL migrations.' };
  }
  if (deps?.['sequelize-cli'] || deps?.sequelize) {
    return { tool: 'Sequelize', command: 'npx sequelize-cli db:migrate', note: 'Runs pending Sequelize migrations.' };
  }
  if (deps?.typeorm) {
    return { tool: 'TypeORM', command: 'npx typeorm migration:run', note: 'TypeORM often needs a datasource flag (-d) — confirm the exact command with the founder if this fails.' };
  }
  if (has('manage.py')) {
    return { tool: 'Django', command: 'python manage.py migrate --noinput', note: 'Applies pending Django migrations.' };
  }
  if (has('alembic.ini')) {
    return { tool: 'Alembic', command: 'alembic upgrade head', note: 'Upgrades to the latest Alembic revision.' };
  }
  if (has('Gemfile') && has('db/migrate')) {
    return { tool: 'Rails', command: 'bundle exec rails db:migrate', note: 'Applies pending Rails migrations.' };
  }
  if (has('flyway.conf') || has('sql/migrations')) {
    return { tool: 'Flyway', command: 'flyway migrate', note: 'Requires the Flyway CLI inside the image.' };
  }
  return null;
}

const DESTRUCTIVE: Array<{ re: RegExp; risk: string }> = [
  { re: /\bDROP\s+TABLE\b/i, risk: 'drops a table (all its rows are gone)' },
  { re: /\bDROP\s+COLUMN\b/i, risk: 'drops a column (that data is gone)' },
  { re: /\bTRUNCATE\b/i, risk: 'empties a table' },
  { re: /\bALTER\s+COLUMN\b[\s\S]{0,80}\bTYPE\b/i, risk: 'changes a column type (can fail or lose precision on existing rows)' },
  { re: /\bRENAME\s+(?:TABLE|COLUMN)\b/i, risk: 'renames a table/column (old code breaks the moment it deploys)' },
  { re: /\bSET\s+NOT\s+NULL\b/i, risk: 'adds NOT NULL (fails if existing rows hold nulls)' },
  { re: /\bDROP\s+CONSTRAINT\b/i, risk: 'drops a constraint' },
  { re: /\bRemoveField\b|\bDeleteModel\b/, risk: 'Django: removes a field/model (destructive)' },
  { re: /\bremove_column\b|\bdrop_table\b/, risk: 'Rails: removes a column/table (destructive)' },
];

export interface RiskReport {
  file: string;
  risks: string[];
}

/** Scan migration text for destructive statements (pure, testable). */
export function lintMigrationText(text: string): string[] {
  const found = new Set<string>();
  for (const d of DESTRUCTIVE) if (d.re.test(text)) found.add(d.risk);
  return [...found];
}

const MIGRATION_DIRS = ['prisma/migrations', 'migrations', 'db/migrate', 'alembic/versions', 'sql/migrations'];

/** Walk the repo's migration folders and report destructive statements. */
export function scanMigrationRisks(repoPath: string): RiskReport[] {
  const out: RiskReport[] = [];
  for (const dir of MIGRATION_DIRS) {
    const full = path.join(repoPath, dir);
    if (!fs.existsSync(full)) continue;
    const files: string[] = [];
    const walk = (d: string, depth = 0) => {
      if (depth > 2) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/\.(sql|py|rb|js|ts)$/.test(e.name)) files.push(p);
      }
    };
    walk(full);
    const recent = files
      .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 25);
    for (const { f } of recent) {
      let text = '';
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      const risks = lintMigrationText(text);
      if (risks.length) out.push({ file: path.relative(repoPath, f).replace(/\\/g, '/'), risks });
    }
  }
  return out;
}

export function describeRisks(reports: RiskReport[]): string {
  if (reports.length === 0) return 'No destructive statements found in the recent migrations — this looks additive and safe to apply.';
  return [
    `⚠ ${reports.length} migration file(s) contain DESTRUCTIVE changes:`,
    ...reports.slice(0, 8).map((r) => `  ${r.file}\n    ${r.risks.join('; ')}`),
    '',
    'Destructive migrations cannot be undone by a code rollback. The safe pattern is expand-then-contract:',
    '  1. Deploy a migration that ADDS the new shape (old code keeps working).',
    '  2. Deploy the code that uses it.',
    '  3. Only once that is stable, deploy the migration that REMOVES the old shape.',
    'I always snapshot the database before running migrations, so a bad one is recoverable — but the restore costs downtime.',
  ].join('\n');
}

/* --------------------------------------------------------------- execution */

/**
 * node-postgres-based CLIs read the plain DATABASE_URL and get rejected by
 * RDS PG15+'s default rds.force_ssl=1 — live signature: FATAL 28000 from
 * ClientAuthentication ("no pg_hba.conf entry … no encryption"). The app
 * itself connects fine because it sets ssl explicitly. PGSSLMODE=no-verify
 * makes these tools connect over TLS the same way the app does (RDS-managed
 * cert, no local CA needed). psycopg/libpq REJECT that value, so it is
 * scoped to the tools that understand it.
 */
const PGSSLMODE_TOOLS = new Set(['node-pg-migrate', 'Knex', 'Sequelize', 'TypeORM']);

export function migrationTaskOverrides(
  containerName: string,
  plan: MigrationPlan,
): { containerOverrides: Array<{ name: string; command: string[]; environment?: Array<{ name: string; value: string }> }> } {
  return {
    containerOverrides: [
      {
        name: containerName,
        command: ['sh', '-c', plan.command],
        ...(PGSSLMODE_TOOLS.has(plan.tool) ? { environment: [{ name: 'PGSSLMODE', value: 'no-verify' }] } : {}),
      },
    ],
  };
}

async function awsJson<T>(args: string[], region: string, timeoutMs = 60_000): Promise<T> {
  const res = await runAwsCli([...args, '--region', region, '--output', 'json'], timeoutMs);
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split(/\r?\n/).slice(-3).join(' '));
  return JSON.parse(res.stdout || '{}') as T;
}

/**
 * Run the migration command as a one-off ECS task, reusing the running
 * service's task definition, subnets, and security groups — so it has the
 * same image, the same database credentials, and the same network reach.
 */
export async function runMigrations(p: Project, plan: MigrationPlan, log: (l: string) => void): Promise<string> {
  if ((p.cloud ?? 'aws') !== 'aws') {
    return `Automated migration runs are AWS-only right now. On ${p.cloud === 'gcp' ? 'GCP' : 'Azure'} the equivalent is a one-off job with the same image — I can run it with the CLI (approval-gated) if you tell me to.`;
  }
  const out = p.outputs ?? {};
  const cluster = out.cluster_name;
  if (!cluster) return 'This project has no ECS cluster — migrations run inside the app container, so this applies to the container/microservices stacks.';

  // Prefer a service that owns the database; on microservices let the caller's
  // container image be any service — they share the same DB credentials.
  const serviceName = out.service_name ?? Object.keys(JSON.parse(out.service_names ?? '{}'))[0];
  if (!serviceName) return 'Could not determine which service to run the migration in.';

  const svc = await awsJson<{
    services: Array<{
      taskDefinition: string;
      networkConfiguration?: { awsvpcConfiguration?: { subnets: string[]; securityGroups: string[]; assignPublicIp?: string } };
    }>;
  }>(['ecs', 'describe-services', '--cluster', cluster, '--services', serviceName], p.region);
  const service = svc.services?.[0];
  const net = service?.networkConfiguration?.awsvpcConfiguration;
  if (!service || !net) throw new Error(`Could not read the network configuration of service ${serviceName}.`);

  const td = await awsJson<{ taskDefinition: { containerDefinitions: Array<{ name: string }> } }>(
    ['ecs', 'describe-task-definition', '--task-definition', service.taskDefinition], p.region,
  );
  const containerName = td.taskDefinition.containerDefinitions[0]?.name;
  if (!containerName) throw new Error('Task definition has no container to run the migration in.');

  const overrides = JSON.stringify(migrationTaskOverrides(containerName, plan));
  const network = JSON.stringify({
    awsvpcConfiguration: { subnets: net.subnets, securityGroups: net.securityGroups, assignPublicIp: net.assignPublicIp ?? 'ENABLED' },
  });

  log(`Running "${plan.command}" as a one-off task in your cluster (same image, same database)…`);
  const run = await awsJson<{ tasks: Array<{ taskArn: string }>; failures?: Array<{ reason: string }> }>(
    ['ecs', 'run-task', '--cluster', cluster, '--task-definition', service.taskDefinition, '--launch-type', 'FARGATE',
      '--network-configuration', network, '--overrides', overrides, '--started-by', 'plainops-migrate'],
    p.region, 120_000,
  );
  const taskArn = run.tasks?.[0]?.taskArn;
  if (!taskArn) throw new Error(`Could not start the migration task: ${run.failures?.[0]?.reason ?? 'unknown reason'}`);

  log('Waiting for the migration task to finish…');
  const waited = await runAwsCli(['ecs', 'wait', 'tasks-stopped', '--cluster', cluster, '--tasks', taskArn, '--region', p.region], 900_000);
  if (waited.code !== 0) throw new Error('Timed out waiting for the migration task — check the logs before retrying.');

  const done = await awsJson<{ tasks: Array<{ containers: Array<{ exitCode?: number; reason?: string }>; stoppedReason?: string }> }>(
    ['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', taskArn], p.region,
  );
  const container = done.tasks?.[0]?.containers?.[0];
  const exitCode = container?.exitCode;
  let logs = '';
  if (out.log_group) {
    logs = (await tailAppLogs(p.region, out.log_group, 15).catch(() => '')) || '';
    logs = logs.split(/\r?\n/).slice(-25).join('\n');
  }
  auditLog({ type: 'migrate.run', summary: `${p.name}: ${plan.tool} "${plan.command}" exit ${exitCode ?? '?'}` });
  if (exitCode === 0) {
    return `Migrations applied successfully (${plan.tool}).${logs ? `\n\nLast log lines:\n${logs}` : ''}`;
  }
  throw new Error(
    `The migration task exited with code ${exitCode ?? '?'}${container?.reason ? ` (${container.reason})` : ''}${done.tasks?.[0]?.stoppedReason ? ` — ${done.tasks[0].stoppedReason}` : ''}.` +
      `${logs ? `\n\nLast log lines:\n${logs}` : ''}\nThe database snapshot taken beforehand is your restore point.`,
  );
}
