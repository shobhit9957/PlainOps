import { runAwsCli } from './awscli.js';
import { auditLog } from './audit.js';
import type { Project } from './state.js';

/**
 * Scheduled jobs (cron) WITHOUT new blueprints: EventBridge Scheduler drives
 * the infrastructure the project already has.
 *
 *   container / microservices — run the service's OWN task definition as a
 *     one-off Fargate task on a schedule, with the command overridden
 *     (same image, same env, same network — the migrate.ts trick, on a timer).
 *   serverless — send a message to the project's SQS queue on a schedule; the
 *     existing worker Lambda consumes it exactly like any other job.
 *
 * The model translates "every night at 3am" into a cron expression; this
 * module validates/normalizes it and builds the AWS plumbing (a narrow
 * scheduler role, scoped to this project's resources, created on first use).
 */

async function awsJson<T>(args: string[], region: string, timeoutMs = 60_000): Promise<T> {
  const res = await runAwsCli([...args, '--region', region, '--output', 'json'], timeoutMs);
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split(/\r?\n/).slice(-3).join(' '));
  return JSON.parse(res.stdout || '{}') as T;
}

/**
 * Normalize a schedule to AWS Scheduler syntax (pure, testable).
 * Accepts `cron(...)`/`rate(...)` verbatim, or a standard 5-field cron which
 * is converted to AWS's 6-field form (day-of-month/day-of-week exclusivity
 * via `?`, year appended).
 */
export function normalizeSchedule(input: string): string {
  const s = input.trim();
  if (/^(cron|rate|at)\(.+\)$/i.test(s)) return s;
  const fields = s.split(/\s+/);
  if (fields.length === 5) {
    const [min, hour, dom, mon, dow] = fields;
    if (dow === '*' || dow === '?') return `cron(${min} ${hour} ${dom} ${mon} ? *)`;
    return `cron(${min} ${hour} ${dom === '*' ? '?' : dom} ${mon} ${dow} *)`;
  }
  throw new Error(`"${input}" is not a schedule I understand — give me a 5-field cron ("0 3 * * *"), or AWS syntax like cron(0 3 * * ? *) / rate(1 hour).`);
}

/** Schedule name for a job (pure): stable, prefixed, AWS-safe. */
export function scheduleName(projectName: string, job: string): string {
  const clean = job.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'job';
  return `po-${projectName}-${clean}`.slice(0, 64);
}

/** EventBridge Scheduler target for an ECS one-off task (pure, testable). */
export function ecsScheduleTarget(opts: {
  clusterArn: string;
  taskDefinitionArn: string;
  roleArn: string;
  containerName: string;
  command: string;
  subnets: string[];
  securityGroups: string[];
  assignPublicIp: string;
}): string {
  return JSON.stringify({
    Arn: opts.clusterArn,
    RoleArn: opts.roleArn,
    EcsParameters: {
      TaskDefinitionArn: opts.taskDefinitionArn,
      LaunchType: 'FARGATE',
      NetworkConfiguration: {
        awsvpcConfiguration: {
          Subnets: opts.subnets,
          SecurityGroups: opts.securityGroups,
          AssignPublicIp: opts.assignPublicIp,
        },
      },
    },
    Input: JSON.stringify({ containerOverrides: [{ name: opts.containerName, command: ['sh', '-c', opts.command] }] }),
    RetryPolicy: { MaximumRetryAttempts: 1 },
  });
}

/** Scheduler target that drops a job message on the project's SQS queue (pure). */
export function sqsScheduleTarget(queueArn: string, roleArn: string, jobName: string): string {
  return JSON.stringify({
    Arn: queueArn,
    RoleArn: roleArn,
    SqsParameters: {},
    Input: JSON.stringify({ source: 'plainops-schedule', job: jobName, firedBy: 'EventBridge Scheduler' }),
    RetryPolicy: { MaximumRetryAttempts: 1 },
  });
}

/* ---------------------------------------------------------------- plumbing */

async function accountId(region: string): Promise<string> {
  const who = await awsJson<{ Account: string }>(['sts', 'get-caller-identity'], region);
  return who.Account;
}

/** Narrow role EventBridge Scheduler assumes — scoped to this project's names. */
async function ensureSchedulerRole(p: Project, region: string): Promise<string> {
  const roleName = `po-${p.name}-scheduler`;
  try {
    const existing = await awsJson<{ Role: { Arn: string } }>(['iam', 'get-role', '--role-name', roleName], region);
    return existing.Role.Arn;
  } catch {
    /* create below */
  }
  const acct = await accountId(region);
  const trust = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'scheduler.amazonaws.com' }, Action: 'sts:AssumeRole' }],
  });
  const created = await awsJson<{ Role: { Arn: string } }>(
    ['iam', 'create-role', '--role-name', roleName, '--assume-role-policy-document', trust,
      '--description', `PlainOps: lets EventBridge Scheduler run ${p.name}'s scheduled jobs`],
    region, 60_000,
  );
  const policy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: 'ecs:RunTask', Resource: `arn:aws:ecs:${region}:${acct}:task-definition/po-${p.name}*` },
      { Effect: 'Allow', Action: 'iam:PassRole', Resource: `arn:aws:iam::${acct}:role/po-${p.name}*` },
      { Effect: 'Allow', Action: 'sqs:SendMessage', Resource: `arn:aws:sqs:${region}:${acct}:po-${p.name}*` },
    ],
  });
  await awsJson(['iam', 'put-role-policy', '--role-name', roleName, '--policy-name', 'plainops-scheduler', '--policy-document', policy], region, 60_000);
  // IAM propagation: a brand-new role can take a few seconds to be assumable.
  await new Promise((r) => setTimeout(r, 8_000));
  return created.Role.Arn;
}

export interface ScheduleRequest {
  job: string;
  schedule: string;
  /** container/microservices: the shell command to run. Ignored for serverless. */
  command?: string;
  /** microservices: which service's image/env to run the command in. */
  service?: string;
}

export async function createSchedule(p: Project, req: ScheduleRequest, log: (l: string) => void): Promise<string> {
  if ((p.cloud ?? 'aws') !== 'aws') {
    return 'Scheduled jobs are AWS-wired today. On GCP the equivalent is Cloud Scheduler (gcloud scheduler jobs create), on Azure a timer — I can set either up through the gated CLI right now if you want.';
  }
  const out = p.outputs ?? {};
  const region = p.region;
  const expr = normalizeSchedule(req.schedule);
  const name = scheduleName(p.name, req.job);

  let target: string;
  let how: string;

  if (out.queue_url && out.api_function) {
    // Serverless: schedule → SQS message → existing worker Lambda.
    const attrs = await awsJson<{ Attributes: { QueueArn: string } }>(
      ['sqs', 'get-queue-attributes', '--queue-url', out.queue_url, '--attribute-names', 'QueueArn'], region,
    );
    const roleArn = await ensureSchedulerRole(p, region);
    target = sqsScheduleTarget(attrs.Attributes.QueueArn, roleArn, req.job);
    how = `drops a job message on the queue; the worker Lambda processes it (job field: "${req.job}")`;
  } else if (out.cluster_name && (out.service_name || out.service_names)) {
    if (!req.command?.trim()) {
      return 'Tell me the command the job should run inside the container (for example "node jobs/cleanup.js" or "python manage.py clearsessions").';
    }
    const serviceName = out.service_name ?? (req.service?.trim() || Object.keys(JSON.parse(out.service_names ?? '{}'))[0]);
    const svc = await awsJson<{
      services: Array<{ taskDefinition: string; networkConfiguration?: { awsvpcConfiguration?: { subnets: string[]; securityGroups: string[]; assignPublicIp?: string } } }>;
    }>(['ecs', 'describe-services', '--cluster', out.cluster_name, '--services', serviceName], region);
    const service = svc.services?.[0];
    const net = service?.networkConfiguration?.awsvpcConfiguration;
    if (!service || !net) throw new Error(`Could not read service ${serviceName} to build the schedule.`);
    const td = await awsJson<{ taskDefinition: { taskDefinitionArn: string; containerDefinitions: Array<{ name: string }> } }>(
      ['ecs', 'describe-task-definition', '--task-definition', service.taskDefinition], region,
    );
    const clusters = await awsJson<{ clusters: Array<{ clusterArn: string }> }>(['ecs', 'describe-clusters', '--clusters', out.cluster_name], region);
    const clusterArn = clusters.clusters?.[0]?.clusterArn;
    if (!clusterArn) throw new Error(`Cluster ${out.cluster_name} not found.`);
    const roleArn = await ensureSchedulerRole(p, region);
    target = ecsScheduleTarget({
      clusterArn,
      taskDefinitionArn: td.taskDefinition.taskDefinitionArn,
      roleArn,
      containerName: td.taskDefinition.containerDefinitions[0].name,
      command: req.command.trim(),
      subnets: net.subnets,
      securityGroups: net.securityGroups,
      assignPublicIp: net.assignPublicIp ?? 'ENABLED',
    });
    how = `runs \`${req.command.trim()}\` as a one-off Fargate task with ${serviceName}'s own image, env, and network`;
  } else {
    return 'Nothing deployed to schedule against yet — deploy the project first; jobs reuse its containers or queue.';
  }

  log(`Creating schedule ${name} (${expr})…`);
  const create = await runAwsCli(
    ['scheduler', 'create-schedule', '--name', name, '--schedule-expression', expr,
      '--flexible-time-window', 'Mode=OFF', '--target', target, '--region', region, '--output', 'json'],
    60_000,
  );
  if (create.code !== 0) {
    if (/ConflictException|already exist/i.test(create.stderr)) {
      const update = await runAwsCli(
        ['scheduler', 'update-schedule', '--name', name, '--schedule-expression', expr,
          '--flexible-time-window', 'Mode=OFF', '--target', target, '--region', region, '--output', 'json'],
        60_000,
      );
      if (update.code !== 0) throw new Error(update.stderr.trim().split(/\r?\n/).pop() ?? 'update failed');
      auditLog({ type: 'schedule.updated', summary: `${p.name}: ${name} → ${expr}` });
      return `Schedule ${name} UPDATED: ${expr} — ${how}. (It already existed; the expression/target were replaced.)`;
    }
    throw new Error(create.stderr.trim().split(/\r?\n/).pop() ?? 'create-schedule failed');
  }
  auditLog({ type: 'schedule.created', summary: `${p.name}: ${name} → ${expr}` });
  return [
    `Scheduled ✔ ${name}: ${expr} — ${how}.`,
    'This runs in YOUR AWS account via EventBridge Scheduler — laptop off, PlainOps closed, it still fires.',
    'Cost: EventBridge Scheduler is $1.00/million invocations (essentially free at cron scale) + the task/Lambda runtime while the job runs.',
    'Say "list scheduled jobs" to see everything, or "remove the <job> schedule" to delete one.',
  ].join('\n');
}

export async function listSchedules(p: Project): Promise<string> {
  if ((p.cloud ?? 'aws') !== 'aws') return 'Scheduled jobs are AWS-wired today.';
  const res = await awsJson<{ Schedules: Array<{ Name: string; State: string }> }>(
    ['scheduler', 'list-schedules', '--name-prefix', `po-${p.name}-`], p.region,
  );
  const schedules = res.Schedules ?? [];
  if (!schedules.length) return 'No scheduled jobs exist for this project.';
  const lines: string[] = [];
  for (const s of schedules.slice(0, 10)) {
    try {
      const detail = await awsJson<{ ScheduleExpression: string }>(['scheduler', 'get-schedule', '--name', s.Name], p.region);
      lines.push(`${s.Name}: ${detail.ScheduleExpression} (${s.State})`);
    } catch {
      lines.push(`${s.Name}: (${s.State})`);
    }
  }
  return `Scheduled jobs for ${p.name}:\n${lines.join('\n')}`;
}

export async function removeSchedule(p: Project, job: string): Promise<string> {
  if ((p.cloud ?? 'aws') !== 'aws') return 'Scheduled jobs are AWS-wired today.';
  const name = job.startsWith(`po-${p.name}-`) ? job : scheduleName(p.name, job);
  const res = await runAwsCli(['scheduler', 'delete-schedule', '--name', name, '--region', p.region], 60_000);
  if (res.code !== 0) throw new Error(res.stderr.trim().split(/\r?\n/).pop() ?? `could not delete ${name}`);
  auditLog({ type: 'schedule.deleted', summary: `${p.name}: ${name}` });
  return `Schedule ${name} deleted — the job will not fire again.`;
}
