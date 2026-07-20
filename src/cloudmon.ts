import { runAwsCli } from './awscli.js';
import { auditLog } from './audit.js';
import type { Project } from './state.js';

/**
 * Cloud-resident monitoring — the piece the local watchtower structurally
 * cannot provide: alerting that keeps working when the laptop is closed.
 *
 * Route 53 health checks probe the URL from AWS's global network, a CloudWatch
 * alarm watches that health check, and SNS emails the founder. Plus the two
 * alarms that catch the failure modes our stacks actually hit: unhealthy load
 * balancer targets and a burst of 5xx.
 *
 * Route 53 health-check metrics only exist in us-east-1, and a CloudWatch
 * alarm can only notify an SNS topic in ITS OWN region — so the canary alarm
 * and its topic live in us-east-1 while the load-balancer alarms and their
 * topic live in the project's region. That is why there are two topics.
 */

const CANARY_REGION = 'us-east-1';

async function aws<T>(args: string[], region: string, timeoutMs = 60_000): Promise<T> {
  const res = await runAwsCli([...args, '--region', region, '--output', 'json'], timeoutMs);
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split(/\r?\n/).slice(-2).join(' '));
  return JSON.parse(res.stdout || '{}') as T;
}

/** Split a URL into the pieces Route 53 health checks need (pure, testable). */
export function healthCheckTarget(url: string): { fqdn: string; port: number; type: 'HTTP' | 'HTTPS'; path: string } {
  const u = new URL(url);
  const https = u.protocol === 'https:';
  return {
    fqdn: u.hostname,
    port: u.port ? Number(u.port) : https ? 443 : 80,
    type: https ? 'HTTPS' : 'HTTP',
    path: u.pathname && u.pathname !== '/' ? u.pathname : '/',
  };
}

async function ensureTopic(region: string, name: string, email: string): Promise<string> {
  // create-topic is idempotent: same name returns the existing ARN.
  const topic = await aws<{ TopicArn: string }>(['sns', 'create-topic', '--name', name], region);
  const subs = await aws<{ Subscriptions: Array<{ Endpoint: string; SubscriptionArn: string }> }>(
    ['sns', 'list-subscriptions-by-topic', '--topic-arn', topic.TopicArn], region,
  );
  // Includes still-pending subscriptions — re-subscribing would just resend
  // a confirmation email the founder may already have open.
  const already = (subs.Subscriptions ?? []).some((s) => s.Endpoint === email);
  if (!already) {
    await aws(['sns', 'subscribe', '--topic-arn', topic.TopicArn, '--protocol', 'email', '--notification-endpoint', email], region);
  }
  return topic.TopicArn;
}

async function ensureHealthCheck(url: string, projectName: string): Promise<string> {
  const t = healthCheckTarget(url);
  const callerRef = `plainops-${projectName}`;
  // Route 53 is global; list first so re-running doesn't create duplicates.
  const list = await aws<{ HealthChecks: Array<{ Id: string; CallerReference: string }> }>(
    ['route53', 'list-health-checks'], CANARY_REGION, 60_000,
  );
  const existing = (list.HealthChecks ?? []).find((h) => h.CallerReference === callerRef);
  if (existing) return existing.Id;

  const config = JSON.stringify({
    Type: t.type,
    FullyQualifiedDomainName: t.fqdn,
    Port: t.port,
    ResourcePath: t.path,
    RequestInterval: 30,
    FailureThreshold: 2,
  });
  const created = await aws<{ HealthCheck: { Id: string } }>(
    ['route53', 'create-health-check', '--caller-reference', callerRef, '--health-check-config', config],
    CANARY_REGION, 60_000,
  );
  return created.HealthCheck.Id;
}

export async function enableCloudMonitoring(p: Project, email: string, log: (l: string) => void): Promise<string> {
  if ((p.cloud ?? 'aws') !== 'aws') {
    return `Cloud-resident monitoring is AWS-only in this version. On ${p.cloud === 'gcp' ? 'GCP' : 'Azure'} the equivalents are Cloud Monitoring uptime checks / Azure Monitor availability tests — I can set those up with the CLI (approval-gated) if you want them now.`;
  }
  const url = p.siteUrl ?? p.outputs?.app_url ?? p.outputs?.gateway_url ?? p.outputs?.api_url;
  if (!url) throw new Error('Nothing to monitor yet — this project has no live URL.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`"${email}" doesn't look like an email address — SNS needs one it can send alerts to.`);

  const created: string[] = [];

  log('Creating the alert topic in us-east-1 (where health-check metrics live)…');
  const canaryTopic = await ensureTopic(CANARY_REGION, `po-${p.name}-alerts`, email);
  log(`Creating a Route 53 health check that probes ${url} from AWS's global network every 30s…`);
  const hcId = await ensureHealthCheck(url, p.name);
  created.push(`Route 53 health check ${hcId} — probes ${url} every 30s from multiple regions`);

  await aws(
    ['cloudwatch', 'put-metric-alarm',
      '--alarm-name', `po-${p.name}-down`,
      '--alarm-description', `PlainOps: ${p.name} is not responding`,
      '--namespace', 'AWS/Route53', '--metric-name', 'HealthCheckStatus',
      '--dimensions', `Name=HealthCheckId,Value=${hcId}`,
      '--statistic', 'Minimum', '--period', '60', '--evaluation-periods', '2',
      '--threshold', '1', '--comparison-operator', 'LessThanThreshold',
      '--treat-missing-data', 'breaching',
      '--alarm-actions', canaryTopic, '--ok-actions', canaryTopic],
    CANARY_REGION,
  );
  created.push(`Alarm po-${p.name}-down → emails you when the site fails 2 checks in a row (and again when it recovers)`);

  // Load-balancer alarms live in the project's region with their own topic.
  const albName = `po-${p.name}`;
  let lbDim: string | null = null;
  try {
    const lbs = await aws<{ LoadBalancers: Array<{ LoadBalancerArn: string }> }>(
      ['elbv2', 'describe-load-balancers', '--names', albName], p.region,
    );
    const arn = lbs.LoadBalancers?.[0]?.LoadBalancerArn;
    if (arn) lbDim = arn.split(':loadbalancer/')[1];
  } catch {
    /* no ALB on this stack */
  }

  if (lbDim) {
    const regionTopic = await ensureTopic(p.region, `po-${p.name}-alerts`, email);
    await aws(
      ['cloudwatch', 'put-metric-alarm',
        '--alarm-name', `po-${p.name}-unhealthy-targets`,
        '--alarm-description', `PlainOps: ${p.name} has unhealthy containers behind the load balancer`,
        '--namespace', 'AWS/ApplicationELB', '--metric-name', 'UnHealthyHostCount',
        '--dimensions', `Name=LoadBalancer,Value=${lbDim}`,
        '--statistic', 'Maximum', '--period', '60', '--evaluation-periods', '3',
        '--threshold', '1', '--comparison-operator', 'GreaterThanOrEqualToThreshold',
        '--treat-missing-data', 'notBreaching',
        '--alarm-actions', regionTopic, '--ok-actions', regionTopic],
      p.region,
    );
    await aws(
      ['cloudwatch', 'put-metric-alarm',
        '--alarm-name', `po-${p.name}-5xx-burst`,
        '--alarm-description', `PlainOps: ${p.name} is returning server errors`,
        '--namespace', 'AWS/ApplicationELB', '--metric-name', 'HTTPCode_ELB_5XX_Count',
        '--dimensions', `Name=LoadBalancer,Value=${lbDim}`,
        '--statistic', 'Sum', '--period', '300', '--evaluation-periods', '1',
        '--threshold', '10', '--comparison-operator', 'GreaterThanThreshold',
        '--treat-missing-data', 'notBreaching',
        '--alarm-actions', regionTopic],
      p.region,
    );
    created.push(`Alarm po-${p.name}-unhealthy-targets → fires when containers fail their health checks for 3 minutes`);
    created.push(`Alarm po-${p.name}-5xx-burst → fires on more than 10 server errors in 5 minutes`);
  }

  auditLog({ type: 'cloudmon.enabled', summary: `${p.name}: cloud monitoring (${created.length} resources) → ${email}` });
  return [
    `Cloud-resident monitoring is live for ${p.name} — this keeps watching with PlainOps closed and your laptop off:`,
    ...created.map((c) => `  • ${c}`),
    '',
    `⚠ Check ${email} now and click the AWS confirmation link — SNS will not send alerts until you confirm the subscription.`,
    'Cost: about $0.50/month for the health check plus ~$0.10 per alarm.',
    'These alarms also feed run_diagnosis, which reports any alarm currently firing.',
  ].join('\n');
}
