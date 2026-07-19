// GCP L3: microservices — gateway + 2 Cloud Run services with deterministic
// cross-service URLs injected as env.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './common.ts';
import { upsertProject, getProject } from '../../src/state.ts';
import { deployGcp } from '../../src/multicloud.ts';

const NAME = 'gtl-gcp-shop';
const PROJECT = process.env.GCP_TARGET_PROJECT!;
const REGION = process.env.GCP_REGION || 'asia-south1';
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'gcp-fixtures', 'micro');

upsertProject({
  name: NAME,
  repoPath: src,
  region: REGION,
  cloud: 'gcp',
  cloudTarget: PROJECT,
  archetype: 'microservices',
  status: getProject(NAME)?.status ?? 'new',
  createdAt: getProject(NAME)?.createdAt ?? new Date().toISOString(),
  outputs: getProject(NAME)?.outputs,
});

const url = await deployGcp(NAME, 'microservices', { sourcePath: src }, log);
log('GCP MICROSERVICES LIVE: ' + url);
