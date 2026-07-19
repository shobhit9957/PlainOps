// Gauntlet teardown: destroy a stack, or clean the CLI-created extras.
//   g9-teardown.ts <project>      → tofu destroy / static teardown
//   g9-teardown.ts extras         → schedules, scheduler roles, alarms,
//                                   health checks, SNS topics, manual snapshots
// NEVER touches the bootstrap bucket plainops-<account>-<region>.
import { REGION, log } from './common.ts';
import { getProject } from '../../src/state.ts';
import { destroy } from '../../src/orchestrator.ts';
import { runAwsCli } from '../../src/awscli.ts';

const target = process.argv[2];

async function aws(args: string[], region = REGION): Promise<{ code: number; stdout: string; stderr: string }> {
  return runAwsCli([...args, '--region', region, '--output', 'json'], 120_000);
}

async function cleanExtras(): Promise<void> {
  for (const proj of ['gtl-app', 'gtl-api', 'gtl-shop']) {
    // EventBridge schedules + the narrow scheduler role.
    const list = await aws(['scheduler', 'list-schedules', '--name-prefix', `po-${proj}-`]);
    if (list.code === 0) {
      for (const s of (JSON.parse(list.stdout || '{}').Schedules ?? []) as Array<{ Name: string }>) {
        log(`deleting schedule ${s.Name}`);
        await aws(['scheduler', 'delete-schedule', '--name', s.Name]);
      }
    }
    const role = `po-${proj}-scheduler`;
    const roleRes = await aws(['iam', 'get-role', '--role-name', role]);
    if (roleRes.code === 0) {
      log(`deleting role ${role}`);
      await aws(['iam', 'delete-role-policy', '--role-name', role, '--policy-name', 'plainops-scheduler']);
      await aws(['iam', 'delete-role', '--role-name', role]);
    }
    // CloudWatch alarms (canary in us-east-1, ALB alarms in-region).
    for (const [region, names] of [
      ['us-east-1', [`po-${proj}-down`]],
      [REGION, [`po-${proj}-unhealthy-targets`, `po-${proj}-5xx-burst`]],
    ] as const) {
      const del = await aws(['cloudwatch', 'delete-alarms', '--alarm-names', ...names], region);
      if (del.code === 0) log(`deleted alarms ${names.join(',')} in ${region}`);
    }
    // Route 53 health check by caller reference.
    const hcs = await aws(['route53', 'list-health-checks'], 'us-east-1');
    if (hcs.code === 0) {
      for (const h of (JSON.parse(hcs.stdout || '{}').HealthChecks ?? []) as Array<{ Id: string; CallerReference: string }>) {
        if (h.CallerReference === `plainops-${proj}`) {
          log(`deleting health check ${h.Id}`);
          await aws(['route53', 'delete-health-check', '--health-check-id', h.Id], 'us-east-1');
        }
      }
    }
    // SNS alert topics both regions.
    for (const region of ['us-east-1', REGION]) {
      const topics = await aws(['sns', 'list-topics'], region);
      if (topics.code !== 0) continue;
      for (const t of (JSON.parse(topics.stdout || '{}').Topics ?? []) as Array<{ TopicArn: string }>) {
        if (t.TopicArn.endsWith(`:po-${proj}-alerts`)) {
          log(`deleting topic ${t.TopicArn}`);
          await aws(['sns', 'delete-topic', '--topic-arn', t.TopicArn], region);
        }
      }
    }
    // Manual RDS snapshots from backup_now (automated ones die with the instance).
    const snaps = await aws(['rds', 'describe-db-snapshots', '--snapshot-type', 'manual']);
    if (snaps.code === 0) {
      for (const s of (JSON.parse(snaps.stdout || '{}').DBSnapshots ?? []) as Array<{ DBSnapshotIdentifier: string }>) {
        if (s.DBSnapshotIdentifier.startsWith(`po-${proj}-plainops-`)) {
          log(`deleting manual snapshot ${s.DBSnapshotIdentifier}`);
          await aws(['rds', 'delete-db-snapshot', '--db-snapshot-identifier', s.DBSnapshotIdentifier]);
        }
      }
    }
  }
  log('extras cleanup complete');
}

if (target === 'extras') {
  await cleanExtras();
} else {
  const p = getProject(target ?? '');
  if (!p) {
    console.error(`Unknown project: ${target}`);
    process.exit(2);
  }
  log(`=== DESTROY ${target} ===`);
  await destroy(target!, log);
  log(`${target} torn down.`);
}
