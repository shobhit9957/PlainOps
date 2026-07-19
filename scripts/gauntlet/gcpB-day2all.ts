// GCP day-2 battery against the live microservices stack: diagnosis, estate
// scan, EOL version check, CI/CD plan — the routine ops a DevOps engineer runs.
import { log } from './common.ts';
import { getProject } from '../../src/state.ts';

const NAME = 'gtl-gcp-shop';
const p = getProject(NAME);
if (!p) throw new Error('missing project ' + NAME);

const { collectDiagnosis } = await import('../../src/diagnosis.ts');
log('=== DIAGNOSIS (project scope) ===');
log(await collectDiagnosis(NAME, 'routine post-deploy health review'));

const { scanGcpEstate } = await import('../../src/clouds/estate.ts');
log('=== GCP ESTATE SCAN ===');
log(await scanGcpEstate(p.cloudTarget!, p.region));

const { checkVersions } = await import('../../src/readiness.ts');
log('=== CHECK VERSIONS ===');
log(await checkVersions(p));

const { generateWorkflow } = await import('../../src/cicd.ts');
log('=== CI/CD PLAN (GCP) ===');
const plan = generateWorkflow(p);
if (!plan.yaml.includes('gcloud builds submit')) throw new Error('gcp micro workflow lacks Cloud Build step');
if (!plan.yaml.includes('gcloud run deploy')) throw new Error('gcp micro workflow lacks Cloud Run roll step');
log(`file: ${plan.fileName} | secrets: ${plan.secretsNeeded.join(',')} | ${plan.note}`);
log(plan.yaml);
log('DAY2ALL COMPLETE');
