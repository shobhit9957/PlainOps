import { resolveTofu, tofuRun } from '../src/tofu.ts';
import { renderProject } from '../src/blueprint/render.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-validate-'));
const params = {
  projectName: 'validate-test', region: 'us-east-1', cpu: 256, memoryMb: 512,
  desiredCount: 1, maxCount: 4, withDatabase: true, healthPath: '/health',
  containerPort: 3000, appSecrets: ['STRIPE_KEY'], budgetMonthlyUsd: 60, budgetEmail: 'a@b.com',
};
const dir = renderProject(params, 'plainops-123-us-east-1');
console.log('Rendered to', dir);
console.log('Resolving OpenTofu (may download)...');
const bin = await resolveTofu();
console.log('Using', bin);
const init = await tofuRun(bin, dir, ['init', '-backend=false', '-input=false'], () => {});
console.log('init exit', init.code);
if (init.code !== 0) { console.log(init.stdout); process.exit(init.code); }
const val = await tofuRun(bin, dir, ['validate'], (l) => console.log('  ', l));
console.log('validate exit', val.code);
process.exit(val.code);
