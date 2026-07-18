// Real end-to-end microservices deploy (shared ALB + Cloud Map + ECS + DocumentDB).
//   node scripts/deploy-microservices-demo.mjs deploy <sourceDir>
//   node scripts/deploy-microservices-demo.mjs destroy
import path from 'node:path';
import { upsertProject, getProject } from '../src/state.ts';
import { deployMicroservices } from '../src/microservices.ts';
import * as orchestrator from '../src/orchestrator.ts';

const REGION = process.env.FM_REGION || 'ap-south-1';
const NAME = process.env.FM_NAME || 'msdemo';
const mode = process.argv[2] || 'deploy';
const src = process.argv[3] || path.join(process.cwd(), '.ms-scaled');
const log = (l) => console.log(new Date().toISOString().slice(11, 19), l);

upsertProject({
  name: NAME,
  region: REGION,
  status: getProject(NAME)?.status ?? 'new',
  createdAt: getProject(NAME)?.createdAt ?? new Date().toISOString(),
  accountId: getProject(NAME)?.accountId,
  bootstrapBucket: getProject(NAME)?.bootstrapBucket,
  outputs: getProject(NAME)?.outputs,
});

if (mode === 'deploy') {
  const url = await deployMicroservices(NAME, src, log);
  log('APP URL: ' + url);
} else if (mode === 'destroy') {
  await orchestrator.destroy(NAME, log);
  log('Torn down.');
} else {
  console.error('Unknown mode:', mode);
  process.exit(1);
}
