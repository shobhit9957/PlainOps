// GCP L1: Cloud Run app via deploy_gcp. Pre-sets cloudTarget so the deploy
// skips the ADC preflight gate; tofu authenticates via GOOGLE_OAUTH_ACCESS_TOKEN
// (the operator's active gcloud login) exported in the shell.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './common.ts';
import { upsertProject, getProject } from '../../src/state.ts';
import { deployGcp } from '../../src/multicloud.ts';

const NAME = 'gtl-gcp-app';
const PROJECT = process.env.GCP_TARGET_PROJECT!;
const REGION = process.env.GCP_REGION || 'asia-south1';
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, 'gcp-fixtures', 'app');

upsertProject({
  name: NAME,
  repoPath: repo,
  region: REGION,
  cloud: 'gcp',
  cloudTarget: PROJECT, // <- short-circuits requireGcpReady (ADC gate)
  archetype: 'app',
  status: getProject(NAME)?.status ?? 'new',
  createdAt: getProject(NAME)?.createdAt ?? new Date().toISOString(),
  outputs: getProject(NAME)?.outputs,
});

const url = await deployGcp(NAME, 'app', { sourcePath: repo, containerPort: 8080 }, log);
log('GCP APP LIVE: ' + url);
