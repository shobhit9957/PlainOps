// Final authoritative sweep: prove the region carries NOTHING gauntlet-made.
// Only the bootstrap bucket (plainops-<account>-<region>) may remain — it is
// permanent by design. Exits non-zero if anything is found.
import { REGION, log } from './common.ts';
import { runAwsCli } from '../../src/awscli.ts';

async function aws(args: string[], region = REGION): Promise<unknown> {
  const r = await runAwsCli([...args, '--region', region, '--output', 'json'], 120_000);
  if (r.code !== 0) throw new Error(`${args.join(' ')} → ${r.stderr.split(/\r?\n/).pop()}`);
  return JSON.parse(r.stdout || '{}');
}

const findings: string[] = [];
const check = (label: string, items: unknown[]) => {
  if (items.length) findings.push(`${label}: ${JSON.stringify(items).slice(0, 300)}`);
  log(`${items.length === 0 ? '✓' : '✗'} ${label}: ${items.length}`);
};

const clusters = (await aws(['ecs', 'list-clusters'])) as { clusterArns: string[] };
check('ECS clusters po-*', clusters.clusterArns.filter((a) => a.includes('/po-')));

const albs = (await aws(['elbv2', 'describe-load-balancers'])) as { LoadBalancers: Array<{ LoadBalancerName: string }> };
check('ALBs po-*', albs.LoadBalancers.filter((l) => l.LoadBalancerName.startsWith('po-')));

const rds = (await aws(['rds', 'describe-db-instances'])) as { DBInstances: Array<{ DBInstanceIdentifier: string }> };
check('RDS instances po-*', rds.DBInstances.filter((d) => d.DBInstanceIdentifier.startsWith('po-')));

const snaps = (await aws(['rds', 'describe-db-snapshots', '--snapshot-type', 'manual'])) as { DBSnapshots: Array<{ DBSnapshotIdentifier: string }> };
check('manual RDS snapshots po-*', snaps.DBSnapshots.filter((s) => s.DBSnapshotIdentifier.startsWith('po-')));

const lambdas = (await aws(['lambda', 'list-functions'])) as { Functions: Array<{ FunctionName: string }> };
check('Lambdas po-*', lambdas.Functions.filter((f) => f.FunctionName.startsWith('po-')));

const tables = (await aws(['dynamodb', 'list-tables'])) as { TableNames: string[] };
check('DynamoDB tables po-*', tables.TableNames.filter((t) => t.startsWith('po-')));

const queues = (await aws(['sqs', 'list-queues', '--queue-name-prefix', 'po-'])) as { QueueUrls?: string[] };
check('SQS queues po-*', queues.QueueUrls ?? []);

const repos = (await aws(['ecr', 'describe-repositories'])) as { repositories: Array<{ repositoryName: string }> };
check('ECR repos po-*', repos.repositories.filter((r) => r.repositoryName.startsWith('po-')));

const logs = (await aws(['logs', 'describe-log-groups', '--log-group-name-prefix', '/plainops/'])) as { logGroups: Array<{ logGroupName: string }> };
check('log groups /plainops/*', logs.logGroups);

const schedules = (await aws(['scheduler', 'list-schedules', '--name-prefix', 'po-'])) as { Schedules: Array<{ Name: string }> };
check('EventBridge schedules po-*', schedules.Schedules);

for (const region of [REGION, 'us-east-1']) {
  const alarms = (await aws(['cloudwatch', 'describe-alarms', '--alarm-name-prefix', 'po-'], region)) as { MetricAlarms: Array<{ AlarmName: string }> };
  check(`alarms po-* (${region})`, alarms.MetricAlarms);
  const topics = (await aws(['sns', 'list-topics'], region)) as { Topics: Array<{ TopicArn: string }> };
  check(`SNS topics po-*-alerts (${region})`, topics.Topics.filter((t) => /:po-.*-alerts$/.test(t.TopicArn)));
}

const hcs = (await aws(['route53', 'list-health-checks'], 'us-east-1')) as { HealthChecks: Array<{ CallerReference: string }> };
check('Route 53 health checks plainops-*', hcs.HealthChecks.filter((h) => h.CallerReference.startsWith('plainops-')));

const buckets = (await aws(['s3api', 'list-buckets'])) as { Buckets: Array<{ Name: string }> };
const gauntletBuckets = buckets.Buckets.filter(
  (b) => (b.Name.startsWith('plainops-') || b.Name.includes('gtl-')) && !/^plainops-\d{12}-[a-z0-9-]+$/.test(b.Name),
);
check('S3 buckets (gauntlet, excl. bootstrap)', gauntletBuckets);

if (findings.length) {
  log('REGION NOT CLEAN:\n' + findings.join('\n'));
  process.exit(1);
}
log('REGION CLEAN ✓ — nothing gauntlet-made remains (bootstrap bucket excluded by design).');
