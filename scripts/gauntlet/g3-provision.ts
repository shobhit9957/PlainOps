// Gauntlet L3a: provision the full container stack — VPC, ALB, ECS, ECR,
// CodeBuild, autoscaling, RDS Postgres, a declared secret — then store the
// secret value so tasks can start. Long: RDS takes 10–15 min.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGION, log } from './common.ts';
import { upsertProject, getProject } from '../../src/state.ts';
import { provision } from '../../src/orchestrator.ts';
import { putAppSecret } from '../../src/aws.ts';

const NAME = 'gtl-app';
const here = path.dirname(fileURLToPath(import.meta.url));
const example = path.join(here, '..', '..', 'examples', 'static-site');
const workdir = path.join(here, '..', '..', '.gauntlet-workdir', 'app');

// Working copy so v1/v2 markers can be written between deploys.
fs.rmSync(workdir, { recursive: true, force: true });
fs.mkdirSync(workdir, { recursive: true });
fs.cpSync(example, workdir, { recursive: true });

upsertProject({
  name: NAME,
  repoPath: workdir,
  region: REGION,
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
    healthPath: '/',
    containerPort: 80,
    appSecrets: ['APP_TOKEN'],
    budgetMonthlyUsd: 40,
  },
});

log('=== L3 PROVISION (VPC, ALB, ECS, ECR, CodeBuild, autoscaling, RDS, secret shell) ===');
const outputs = await provision(NAME, log);
log('outputs: ' + Object.keys(outputs).join(', '));

const arns = JSON.parse(outputs.secret_arns ?? '{}');
if (!arns.APP_TOKEN) throw new Error('secret_arns missing APP_TOKEN — blueprint contract broke');
await putAppSecret(REGION, arns.APP_TOKEN, 'gauntlet-secret-v1-' + Date.now());
log('APP_TOKEN value stored in Secrets Manager (v1). L3 provision COMPLETE.');
