// Validates the blueprint HCL with `tofu validate` when a binary is available.
// Usage: node scripts/validate-blueprint.mjs
import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const filesDir = path.join(root, 'src', 'blueprint', 'files');

function findBinary() {
  if (process.env.PLAINOPS_TOFU_PATH && fs.existsSync(process.env.PLAINOPS_TOFU_PATH)) {
    return process.env.PLAINOPS_TOFU_PATH;
  }
  const home = path.join(os.homedir(), '.plainops', 'bin');
  for (const name of ['tofu', 'terraform']) {
    try {
      execFileSync(name, ['version'], { stdio: 'ignore', shell: process.platform === 'win32' });
      return name;
    } catch { /* keep looking */ }
  }
  if (fs.existsSync(home)) {
    for (const f of fs.readdirSync(home)) {
      if (f.startsWith('tofu')) return path.join(home, f);
    }
  }
  return null;
}

const bin = findBinary();
if (!bin) {
  console.log('SKIP: no tofu/terraform binary found (PLAINOPS will auto-download one at runtime).');
  process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'po-validate-'));
for (const f of ['main.tf', 'variables.tf', 'outputs.tf']) {
  fs.copyFileSync(path.join(filesDir, f), path.join(work, f));
}

const opts = { cwd: work, shell: process.platform === 'win32', encoding: 'utf8' };
try {
  execFileSync(bin, ['init', '-backend=false', '-input=false', '-no-color'], opts);
  const out = execFileSync(bin, ['validate', '-no-color'], opts);
  console.log(out.toString().trim());
  console.log('PASS: blueprint is valid HCL.');
} catch (e) {
  console.error('FAIL: blueprint validation failed');
  console.error(e.stdout?.toString() ?? '');
  console.error(e.stderr?.toString() ?? e.message);
  process.exit(1);
}
