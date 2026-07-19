// D7: CI/CD generation against REAL deployed outputs.
//   - gtl-mono + gtl-shop: full setup_cicd through the tool layer (writes the
//     workflow into the disposable workdir repos)
//   - gtl-api (serverless): plan-only generateWorkflow (its repo is a bundled
//     example folder — we don't write into the product repo)
// Every emitted workflow must reference the project's real resource names.
import fs from 'node:fs';
import path from 'node:path';
import { log } from './common.ts';
import { autoApprove } from './approve.ts';
import { getProject } from '../../src/state.ts';
import { dispatchTool } from '../../src/agent/tools.ts';
import { generateWorkflow } from '../../src/cicd.ts';

const stop = autoApprove();
log('=== D7: CI/CD PIPELINE GENERATION (real outputs) ===');

for (const name of ['gtl-mono', 'gtl-shop']) {
  const p = getProject(name);
  if (!p || p.status !== 'live') { log(`${name}: skipped (not live)`); continue; }
  const r = await dispatchTool('setup_cicd', {}, { projectName: name });
  log(`--- setup_cicd ${name} ---\n${r}`);
  const dest = path.join(p.repoPath!, '.github', 'workflows', 'plainops-deploy.yml');
  if (!fs.existsSync(dest)) throw new Error(`${name}: workflow file was not written at ${dest}`);
  const yaml = fs.readFileSync(dest, 'utf8');
  for (const needle of name === 'gtl-mono'
    ? [p.outputs!.cluster_name, p.outputs!.service_name, p.outputs!.ecr_repo_url]
    : [p.outputs!.cluster_name]) {
    if (!yaml.includes(needle)) throw new Error(`${name}: workflow missing real resource name "${needle}"`);
  }
  log(`${name}: workflow written and references real resources ✓`);
}

const api = getProject('gtl-api');
if (api?.outputs?.api_function) {
  const plan = generateWorkflow(api);
  if (!plan.yaml.includes(api.outputs.api_function)) throw new Error('serverless workflow missing the real Lambda name');
  log(`gtl-api: serverless workflow plan OK (updates ${api.outputs.api_function} + ${api.outputs.worker_function})`);
}
log('D7 COMPLETE.');
stop();
