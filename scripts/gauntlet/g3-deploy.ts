// Gauntlet L3b: deploy the app with a version marker, verify the marker
// actually serves through the ALB.  Usage: g3-deploy.ts v1|v2
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, expectContent } from './common.ts';
import { getProject } from '../../src/state.ts';
import { deployApp } from '../../src/orchestrator.ts';

const NAME = 'gtl-app';
const version = process.argv[2] ?? 'v1';
const here = path.dirname(fileURLToPath(import.meta.url));
const workdir = path.join(here, '..', '..', '.gauntlet-workdir', 'app');

const marker = `GAUNTLET-${version.toUpperCase()}`;
const indexFile = path.join(workdir, 'index.html');
let html = fs.readFileSync(indexFile, 'utf8');
html = html.replace(/GAUNTLET-V\d+/g, '').replace('</body>', `<p>${marker}</p></body>`);
if (!html.includes(marker)) html += `\n<p>${marker}</p>`;
fs.writeFileSync(indexFile, html);
log(`marker ${marker} written into index.html`);

const url = await deployApp(NAME, log);
log(`deployApp returned: ${url}`);
await expectContent(url, marker);
const p = getProject(NAME);
log(`L3 DEPLOY ${version} COMPLETE — live at ${p?.outputs?.app_url}`);
