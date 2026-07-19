// Gauntlet L4: complex architecture — gateway + 2 internal services behind one
// ALB with Cloud Map private DNS, per-service ECR/CodeBuild/ECS/autoscaling.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REGION, log } from './common.ts';
import { upsertProject, getProject } from '../../src/state.ts';
import { deployMicroservices } from '../../src/microservices.ts';

const NAME = 'gtl-shop';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');
const appDir = path.join(repoRoot, '.gauntlet-workdir', 'micro');

log('Generating gateway + 2 services…');
execFileSync('node', [path.join(repoRoot, 'scripts', 'generate-services.mjs'), '--count', '2', '--out', appDir], { stdio: 'inherit' });

upsertProject({
  name: NAME,
  repoPath: appDir,
  region: REGION,
  status: getProject(NAME)?.status ?? 'new',
  createdAt: getProject(NAME)?.createdAt ?? new Date().toISOString(),
  bootstrapBucket: getProject(NAME)?.bootstrapBucket,
  accountId: getProject(NAME)?.accountId,
  outputs: getProject(NAME)?.outputs,
});

const url = await deployMicroservices(NAME, appDir, log);
log('L4 MICROSERVICES LIVE: ' + url);
