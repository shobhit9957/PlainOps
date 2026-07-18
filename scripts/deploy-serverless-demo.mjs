// Real end-to-end serverless deploy (API Gateway + Lambda + SQS + DynamoDB).
//   node scripts/deploy-serverless-demo.mjs deploy
//   node scripts/deploy-serverless-demo.mjs destroy
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertProject, getProject } from '../src/state.ts';
import { deployServerless } from '../src/serverless.ts';
import * as orchestrator from '../src/orchestrator.ts';

const REGION = process.env.FM_REGION || 'ap-south-1';
const NAME = 'svless';
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'examples', 'order-pipeline');
const mode = process.argv[2] || 'deploy';
const log = (l) => console.log(new Date().toISOString().slice(11, 19), l);

upsertProject({
  name: NAME,
  region: REGION,
  status: getProject(NAME)?.status ?? 'new',
  createdAt: getProject(NAME)?.createdAt ?? new Date().toISOString(),
  accountId: getProject(NAME)?.accountId,
  outputs: getProject(NAME)?.outputs,
});

if (mode === 'deploy') {
  const url = await deployServerless(NAME, src, log);
  log('API URL: ' + url);
} else if (mode === 'destroy') {
  await orchestrator.destroy(NAME, log);
  log('Torn down.');
} else {
  console.error('Unknown mode:', mode);
  process.exit(1);
}
