import { runAwsCli } from './awscli.js';

/**
 * Adopted-infrastructure scanner: evidence about EVERYTHING running in an AWS
 * region, not just stacks PlainOps deployed. This is what makes the 3am story
 * work for someone whose app existed long before PlainOps did: ECS services
 * and their rollout state, autoscaling limits (the classic "max is 4, traffic
 * needs 10"), load-balancer target health, alarms currently firing, and recent
 * error lines from the busiest log groups. Read-only, best-effort throughout.
 */

const SECTION_CAP = 2800;

function cap(s: string, n = SECTION_CAP): string {
  return s.length > n ? s.slice(0, n) + '\n…(truncated)' : s;
}

async function awsJson<T>(args: string[], region: string, timeoutMs = 45_000): Promise<T> {
  const res = await runAwsCli([...args, '--region', region, '--output', 'json'], timeoutMs);
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split(/\r?\n/).slice(-3).join(' '));
  return JSON.parse(res.stdout || '{}') as T;
}

interface Section {
  title: string;
  body: string;
}

async function trySection(title: string, fn: () => Promise<string>): Promise<Section> {
  try {
    return { title, body: cap((await fn()).trim() || '(none found)') };
  } catch (e) {
    return { title, body: `(could not collect: ${(e as Error).message})` };
  }
}

async function ecsSection(region: string): Promise<string> {
  const clusters = await awsJson<{ clusterArns: string[] }>(['ecs', 'list-clusters'], region);
  if (!clusters.clusterArns?.length) return 'No ECS clusters in this region.';
  const lines: string[] = [];
  for (const clusterArn of clusters.clusterArns.slice(0, 5)) {
    const cluster = clusterArn.split('/').pop()!;
    const svcList = await awsJson<{ serviceArns: string[] }>(['ecs', 'list-services', '--cluster', cluster], region);
    if (!svcList.serviceArns?.length) {
      lines.push(`cluster ${cluster}: no services`);
      continue;
    }
    for (let i = 0; i < svcList.serviceArns.length && i < 20; i += 10) {
      const batch = svcList.serviceArns.slice(i, i + 10);
      const desc = await awsJson<{
        services: Array<{
          serviceName: string;
          desiredCount: number;
          runningCount: number;
          pendingCount: number;
          deployments?: Array<{ rolloutState?: string; failedTasks?: number }>;
          events?: Array<{ message: string }>;
        }>;
      }>(['ecs', 'describe-services', '--cluster', cluster, '--services', ...batch], region);
      for (const s of desc.services ?? []) {
        const rollout = s.deployments?.[0]?.rolloutState ?? '?';
        const failed = s.deployments?.[0]?.failedTasks ?? 0;
        const flag = s.runningCount < s.desiredCount || rollout === 'FAILED' || failed > 0 ? '  ⚠' : '';
        lines.push(`cluster ${cluster} / ${s.serviceName}: desired ${s.desiredCount}, running ${s.runningCount}, pending ${s.pendingCount}, rollout ${rollout}${failed ? `, failedTasks ${failed}` : ''}${flag}`);
        const ev = s.events?.[0]?.message;
        if (flag && ev) lines.push(`    latest event: ${ev.slice(0, 180)}`);
      }
    }
  }
  return lines.join('\n');
}

async function scalingSection(region: string): Promise<string> {
  const targets = await awsJson<{
    ScalableTargets: Array<{ ResourceId: string; MinCapacity: number; MaxCapacity: number }>;
  }>(['application-autoscaling', 'describe-scalable-targets', '--service-namespace', 'ecs'], region);
  if (!targets.ScalableTargets?.length) return 'No ECS autoscaling targets configured (services will NOT scale beyond their fixed desired count).';
  return targets.ScalableTargets.map((t) => `${t.ResourceId}: min ${t.MinCapacity}, MAX ${t.MaxCapacity}`).join('\n') +
    '\n(If running count is pinned at MAX while load is high, the ceiling itself is the bottleneck — raising MaxCapacity is a one-command fix I can apply with approval.)';
}

async function albSection(region: string): Promise<string> {
  const lbs = await awsJson<{ LoadBalancers: Array<{ LoadBalancerArn: string; LoadBalancerName: string; State?: { Code?: string } }> }>(
    ['elbv2', 'describe-load-balancers'], region,
  );
  if (!lbs.LoadBalancers?.length) return 'No load balancers in this region.';
  const lines: string[] = [];
  for (const lb of lbs.LoadBalancers.slice(0, 6)) {
    lines.push(`${lb.LoadBalancerName}: state ${lb.State?.Code ?? '?'}`);
    const tgs = await awsJson<{ TargetGroups: Array<{ TargetGroupArn: string; TargetGroupName: string }> }>(
      ['elbv2', 'describe-target-groups', '--load-balancer-arn', lb.LoadBalancerArn], region,
    );
    for (const tg of (tgs.TargetGroups ?? []).slice(0, 8)) {
      const health = await awsJson<{ TargetHealthDescriptions: Array<{ TargetHealth: { State: string; Reason?: string } }> }>(
        ['elbv2', 'describe-target-health', '--target-group-arn', tg.TargetGroupArn], region,
      );
      const states: Record<string, number> = {};
      let reason = '';
      for (const t of health.TargetHealthDescriptions ?? []) {
        states[t.TargetHealth.State] = (states[t.TargetHealth.State] ?? 0) + 1;
        if (t.TargetHealth.State !== 'healthy' && t.TargetHealth.Reason) reason = t.TargetHealth.Reason;
      }
      const summary = Object.entries(states).map(([k, v]) => `${v} ${k}`).join(', ') || 'no targets';
      const bad = (states.unhealthy ?? 0) > 0 || (states.healthy ?? 0) === 0;
      lines.push(`  target group ${tg.TargetGroupName}: ${summary}${bad ? ` ⚠${reason ? ` (${reason})` : ''}` : ''}`);
    }
  }
  return lines.join('\n');
}

async function alarmsSection(region: string): Promise<string> {
  const alarms = await awsJson<{ MetricAlarms: Array<{ AlarmName: string; StateReason: string; MetricName?: string }> }>(
    ['cloudwatch', 'describe-alarms', '--state-value', 'ALARM'], region,
  );
  if (!alarms.MetricAlarms?.length) return 'No CloudWatch alarms currently firing.';
  return alarms.MetricAlarms
    .slice(0, 10)
    .map((a) => `🔔 ${a.AlarmName}${a.MetricName ? ` (${a.MetricName})` : ''}: ${a.StateReason.slice(0, 160)}`)
    .join('\n');
}

async function errorLogsSection(region: string): Promise<string> {
  const groups = await awsJson<{ logGroups: Array<{ logGroupName: string; storedBytes?: number }> }>(
    ['logs', 'describe-log-groups', '--limit', '50'], region,
  );
  const candidates = (groups.logGroups ?? [])
    .filter((g) => /ecs|lambda|app|api|service|plainops/i.test(g.logGroupName))
    .sort((a, b) => (b.storedBytes ?? 0) - (a.storedBytes ?? 0))
    .slice(0, 3);
  if (candidates.length === 0) return 'No application-looking log groups found.';
  const since = Date.now() - 60 * 60 * 1000;
  const out: string[] = [];
  for (const g of candidates) {
    const res = await runAwsCli(
      ['logs', 'filter-log-events', '--log-group-name', g.logGroupName, '--start-time', String(since),
        '--filter-pattern', '?ERROR ?Error ?error ?Exception ?FATAL', '--max-items', '25',
        '--query', 'events[].message', '--region', region, '--output', 'json'],
      60_000,
    );
    if (res.code !== 0) {
      out.push(`${g.logGroupName}: (could not read)`);
      continue;
    }
    let messages: string[] = [];
    try { messages = JSON.parse(res.stdout || '[]'); } catch { /* ignore */ }
    out.push(messages.length === 0
      ? `${g.logGroupName}: no error-level lines in the last hour`
      : `${g.logGroupName} — ${messages.length} error line(s) in the last hour, most recent:\n  ${messages.slice(-6).map((m) => m.trim().slice(0, 220)).join('\n  ')}`);
  }
  return out.join('\n');
}

/** Full-region evidence sweep for infrastructure PlainOps did not deploy. */
export async function scanAwsEstate(region: string): Promise<string> {
  const sections = await Promise.all([
    trySection('ECS services (desired vs running, rollout)', () => ecsSection(region)),
    trySection('Autoscaling limits (min/MAX per service)', () => scalingSection(region)),
    trySection('Load balancers + target health', () => albSection(region)),
    trySection('CloudWatch alarms currently FIRING', () => alarmsSection(region)),
    trySection('Recent error-level log lines (last hour, busiest app log groups)', () => errorLogsSection(region)),
  ]);
  return sections.map((s) => `### ${s.title}\n${s.body}`).join('\n\n');
}
