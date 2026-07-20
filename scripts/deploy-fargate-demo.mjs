// Real end-to-end Fargate deploy of the static-site (nginx) to a REAL AWS account.
//   node scripts/deploy-fargate-demo.mjs deploy   → provision + build + go live
//   node scripts/deploy-fargate-demo.mjs destroy  → tear the whole stack down
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertProject, getProject } from '../src/state.ts';
import * as orchestrator from '../src/orchestrator.ts';

const REGION = process.env.FM_REGION || 'ap-south-1';
const NAME = 'fgsite';
const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.join(here, '..', 'examples', 'static-site');
const mode = process.argv[2] || 'deploy';
const log = (l) => console.log(new Date().toISOString().slice(11, 19), l);

upsertProject({
  name: NAME,
  repoPath: siteDir,
  region: REGION,
  status: getProject(NAME)?.status ?? 'new',
  createdAt: getProject(NAME)?.createdAt ?? new Date().toISOString(),
  bootstrapBucket: getProject(NAME)?.bootstrapBucket,
  accountId: getProject(NAME)?.accountId,
  outputs: getProject(NAME)?.outputs,
  // Sized for a 20k concurrent target: start at 2 nginx containers, autoscale to 24.
  blueprint: {
    projectName: NAME,
    region: REGION,
    cpu: 256,
    memoryMb: 512,
    desiredCount: 2,
    maxCount: 24,
    withDatabase: false,
    healthPath: '/',
    containerPort: 80,
    appSecrets: [],
    budgetMonthlyUsd: 80,
  },
});

if (mode === 'deploy') {
  log('=== PROVISION (creating VPC, ALB, ECS, autoscaling) ===');
  await orchestrator.provision(NAME, log);
  log('=== DEPLOY (build nginx image in your account, roll out) ===');
  const url = await orchestrator.deployApp(NAME, log);
  log('LIVE URL: ' + url);
} else if (mode === 'destroy') {
  log('=== DESTROY ===');
  await orchestrator.destroy(NAME, log);
  log('Torn down.');
} else {
  console.error('Unknown mode:', mode);
  process.exit(1);
}
