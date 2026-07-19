// Gauntlet day-2 switchboard: run one real day-2 operation against a project.
//   g5-day2.ts <project> <step> [args...]
import { REGION, log } from './common.ts';
import { getProject } from '../../src/state.ts';
import { runAwsCli } from '../../src/awscli.ts';

const name = process.argv[2];
const step = process.argv[3];
const rest = process.argv.slice(4);
const p = getProject(name ?? '');
if (!p) {
  console.error(`Unknown project: ${name}`);
  process.exit(2);
}

async function main(): Promise<string> {
  switch (step) {
    case 'versions': {
      const { checkVersions } = await import('../../src/readiness.ts');
      return checkVersions(p!);
    }
    case 'preflight': {
      const { preflightLaunch } = await import('../../src/readiness.ts');
      return preflightLaunch(p!);
    }
    case 'diagnosis': {
      const { collectDiagnosis } = await import('../../src/diagnosis.ts');
      return collectDiagnosis(p!.name, rest[0], rest[1] === 'account' ? 'account' : 'project');
    }
    case 'drift': {
      const { checkDrift } = await import('../../src/ops.ts');
      return checkDrift(p!, log);
    }
    case 'savings': {
      const { findSavings } = await import('../../src/ops.ts');
      return findSavings(REGION);
    }
    case 'security': {
      const { scanSecurity } = await import('../../src/security.ts');
      return scanSecurity(REGION);
    }
    case 'logs': {
      const { tailAppLogs } = await import('../../src/aws.ts');
      return (await tailAppLogs(REGION, p!.outputs!.log_group, Number(rest[0]) || 15)) || '(no entries)';
    }
    case 'backup': {
      const { backupNow } = await import('../../src/backup.ts');
      return backupNow(p!);
    }
    case 'verifybackups': {
      const { verifyBackups } = await import('../../src/backup.ts');
      return verifyBackups(p!);
    }
    case 'drill': {
      const { runDrDrill } = await import('../../src/backup.ts');
      return runDrDrill(p!, log);
    }
    case 'schedule-create': {
      const { createSchedule } = await import('../../src/schedule.ts');
      return createSchedule(p!, { job: rest[0], schedule: rest[1], command: rest[2] }, log);
    }
    case 'schedule-list': {
      const { listSchedules } = await import('../../src/schedule.ts');
      return listSchedules(p!);
    }
    case 'schedule-remove': {
      const { removeSchedule } = await import('../../src/schedule.ts');
      return removeSchedule(p!, rest[0]);
    }
    case 'cloudmon': {
      const { enableCloudMonitoring } = await import('../../src/cloudmon.ts');
      return enableCloudMonitoring(p!, rest[0], log);
    }
    case 'rollback': {
      const { rollbackDeployment } = await import('../../src/ops.ts');
      return rollbackDeployment(p!, rest[0], log);
    }
    case 'rotate-value': {
      const { putAppSecret } = await import('../../src/aws.ts');
      const arns = JSON.parse(p!.outputs?.secret_arns ?? '{}');
      if (!arns[rest[0]]) throw new Error(`no secret ${rest[0]}`);
      await putAppSecret(REGION, arns[rest[0]], rest[1]);
      return `new value stored for ${rest[0]}`;
    }
    case 'bounce': {
      const { bounceService } = await import('../../src/rotate.ts');
      return bounceService(p!, log);
    }
    case 'chaos-break': {
      const r = await runAwsCli(['ecs', 'update-service', '--cluster', p!.outputs!.cluster_name, '--service', p!.outputs!.service_name, '--desired-count', '0', '--region', REGION], 60_000);
      if (r.code !== 0) throw new Error(r.stderr);
      return 'CHAOS: service desired-count set to 0 OUT-OF-BAND (simulating a 3am mystery outage)';
    }
    case 'chaos-restore': {
      const r = await runAwsCli(['ecs', 'update-service', '--cluster', p!.outputs!.cluster_name, '--service', p!.outputs!.service_name, '--desired-count', '1', '--region', REGION], 60_000);
      if (r.code !== 0) throw new Error(r.stderr);
      const w = await runAwsCli(['ecs', 'wait', 'services-stable', '--cluster', p!.outputs!.cluster_name, '--services', p!.outputs!.service_name, '--region', REGION], 600_000);
      return w.code === 0 ? 'service restored to desired 1 and stable' : 'restore issued but not stable yet';
    }
    default:
      throw new Error(`unknown step: ${step}`);
  }
}

const out = await main();
console.log('\n===== RESULT =====\n' + out);
