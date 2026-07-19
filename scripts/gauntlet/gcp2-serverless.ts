// GCP L2: Cloud Functions gen2 + Pub/Sub + Firestore via deploy_gcp serverless.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './common.ts';
import { upsertProject, getProject } from '../../src/state.ts';
import { deployGcp } from '../../src/multicloud.ts';

const NAME = 'gtl-gcp-api';
const PROJECT = process.env.GCP_TARGET_PROJECT!;
const REGION = process.env.GCP_REGION || 'asia-south1';
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'gcp-fixtures', 'serverless');

upsertProject({
  name: NAME,
  repoPath: src,
  region: REGION,
  cloud: 'gcp',
  cloudTarget: PROJECT,
  archetype: 'serverless',
  status: getProject(NAME)?.status ?? 'new',
  createdAt: getProject(NAME)?.createdAt ?? new Date().toISOString(),
  outputs: getProject(NAME)?.outputs,
});

const url = await deployGcp(NAME, 'serverless', { sourcePath: src }, log);
log('GCP SERVERLESS LIVE: ' + url);

// Exercise: GET the API health, then POST an order (API → Pub/Sub → worker).
const g = await fetch(url.replace(/\/$/, ''), { signal: AbortSignal.timeout(15000) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as any);
log(`GET ${url} → HTTP ${g.status}: ${(await g.text()).slice(0, 160)}`);
const p = await fetch(url.replace(/\/$/, ''), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: 'gcp-widget' }), signal: AbortSignal.timeout(15000) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as any);
log(`POST order → HTTP ${p.status}: ${(await p.text()).slice(0, 160)}`);
