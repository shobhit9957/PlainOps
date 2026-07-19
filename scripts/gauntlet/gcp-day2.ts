// GCP day-2 switchboard against a live project.
//   gcp-day2.ts <project> <step> [args...]
import { log } from './common.ts';
import { getProject } from '../../src/state.ts';

const name = process.argv[2];
const step = process.argv[3];
const rest = process.argv.slice(4);
const p = getProject(name ?? '');
if (!p) { console.error(`Unknown project: ${name}`); process.exit(2); }

async function main(): Promise<string> {
  switch (step) {
    case 'diagnosis': {
      const { collectDiagnosis } = await import('../../src/diagnosis.ts');
      return collectDiagnosis(p!.name, rest[0], rest[1] === 'account' ? 'account' : 'project');
    }
    case 'estate': {
      const { scanGcpEstate } = await import('../../src/clouds/estate.ts');
      return scanGcpEstate(p!.cloudTarget!, p!.region);
    }
    case 'versions': {
      const { checkVersions } = await import('../../src/readiness.ts');
      return checkVersions(p!);
    }
    case 'cicd': {
      const { generateWorkflow } = await import('../../src/cicd.ts');
      const plan = generateWorkflow(p!);
      return `file: ${plan.fileName}\nsecrets: ${plan.secretsNeeded.join(', ')}\nnote: ${plan.note}\n---\n${plan.yaml.slice(0, 700)}`;
    }
    case 'chaos-break': {
      // Out-of-band: delete the Cloud Run service so drift/diagnosis must catch it.
      const { runCloudCli } = await import('../../src/clouds/cloudcli.ts');
      const svc = p!.outputs?.service_name ?? `po-${p!.name}`;
      const r = await runCloudCli('gcp', ['run', 'services', 'delete', svc, '--region', p!.region, '--project', p!.cloudTarget!, '--quiet'], 120_000);
      return r.code === 0 ? `CHAOS: deleted Cloud Run service ${svc} out-of-band` : `delete failed: ${(r.stderr || r.stdout).split('\n').pop()}`;
    }
    default:
      throw new Error(`unknown step: ${step}`);
  }
}
console.log('\n===== RESULT =====\n' + (await main()));
