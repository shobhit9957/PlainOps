// Gauntlet L1: static site — deploy, verify a real 200, leave up for teardown.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGION, log } from './common.ts';
import { upsertProject, getProject } from '../../src/state.ts';
import { deployStatic } from '../../src/orchestrator.ts';

const NAME = 'gtl-site';
const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.join(here, '..', '..', 'examples', 'static-site');

upsertProject({
  name: NAME,
  region: REGION,
  status: getProject(NAME)?.status ?? 'new',
  createdAt: getProject(NAME)?.createdAt ?? new Date().toISOString(),
  siteBucket: getProject(NAME)?.siteBucket,
  siteUrl: getProject(NAME)?.siteUrl,
});

const url = await deployStatic(NAME, siteDir, log);
log('L1 STATIC LIVE: ' + url);
