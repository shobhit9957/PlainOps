// D1: the monolith — task-manager (Express) + RDS Postgres 16, deployed V1.
// Proofs: live URL marker, real CRUD against RDS, schema introspection route.
import { REGION, log, expectContent } from './common.ts';
import { prepWorkdir, stampRelease, NAME, workdir } from './mono-common.ts';
import { upsertProject, getProject } from '../../src/state.ts';
import { provision, deployApp } from '../../src/orchestrator.ts';
import { putAppSecret } from '../../src/aws.ts';

log('=== D1: MONOLITH (task-manager + RDS Postgres 16) ===');
prepWorkdir();
stampRelease('TASKMGR-V1', 0, 'release v1');

upsertProject({
  name: NAME,
  repoPath: workdir,
  region: REGION,
  archetype: 'app',
  status: getProject(NAME)?.status ?? 'new',
  createdAt: getProject(NAME)?.createdAt ?? new Date().toISOString(),
  bootstrapBucket: getProject(NAME)?.bootstrapBucket,
  accountId: getProject(NAME)?.accountId,
  outputs: getProject(NAME)?.outputs,
  blueprint: {
    projectName: NAME,
    region: REGION,
    cpu: 256,
    memoryMb: 512,
    desiredCount: 1,
    maxCount: 4,
    withDatabase: true,
    healthPath: '/health',
    containerPort: 3000,
    appSecrets: ['APP_TOKEN'],
    budgetMonthlyUsd: 40,
  },
});

const outputs = await provision(NAME, log);
log('outputs: ' + Object.keys(outputs).join(', '));
const arns = JSON.parse(outputs.secret_arns ?? '{}');
if (!arns.APP_TOKEN) throw new Error('secret_arns missing APP_TOKEN — blueprint contract broke');
await putAppSecret(REGION, arns.APP_TOKEN, 'gauntlet-mono-v1-' + Date.now());
log('APP_TOKEN value stored in Secrets Manager.');

const url = await deployApp(NAME, log);
log('MONOLITH LIVE: ' + url);

await expectContent(url + '/api/version', 'TASKMGR-V1');

// CRUD against the real RDS (the app retries its DB connection at boot).
let created = false;
for (let i = 0; i < 15; i++) {
  const r = await fetch(url + '/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'gauntlet-crud-proof', description: 'written through the live ALB into RDS' }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (r?.status === 201) { created = true; break; }
  log(`waiting for DB readiness (POST /api/tasks → ${r?.status ?? 'unreachable'}) ${i + 1}/15`);
  await new Promise((r2) => setTimeout(r2, 10_000));
}
if (!created) throw new Error('CRUD proof failed: POST /api/tasks never returned 201');
await expectContent(url + '/api/tasks', 'gauntlet-crud-proof');
await expectContent(url + '/api/_tables', 'tasks');
log('D1 COMPLETE: monolith live, RDS CRUD verified end to end.');
