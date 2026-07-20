#!/usr/bin/env node
// tofu-validate every blueprint (AWS + GCP + Azure) in isolated temp dirs.
// No cloud credentials needed; providers download once into the plugin cache.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const bpRoot = path.join(repo, 'src', 'blueprint');

function resolveTofu() {
  if (process.env.PLAINOPS_TOFU_PATH) return process.env.PLAINOPS_TOFU_PATH;
  for (const name of ['tofu', 'terraform']) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  }
  const dir = path.join(os.homedir(), '.plainops', 'bin');
  const p = path.join(dir, process.platform === 'win32' ? 'tofu.exe' : 'tofu');
  if (fs.existsSync(p)) return p;
  throw new Error('No tofu/terraform binary found.');
}

const tofu = resolveTofu();
const cache = path.join(os.homedir(), '.plainops', 'plugin-cache');
fs.mkdirSync(cache, { recursive: true });

const blueprints = fs
  .readdirSync(bpRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(bpRoot, e.name, 'main.tf')))
  .map((e) => e.name);

let failed = 0;
for (const bp of blueprints) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `po-val-${bp}-`));
  fs.cpSync(path.join(bpRoot, bp), work, { recursive: true });
  try {
    execFileSync(tofu, ['init', '-backend=false', '-input=false'], {
      cwd: work,
      stdio: 'pipe',
      env: { ...process.env, TF_PLUGIN_CACHE_DIR: cache },
    });
    const out = execFileSync(tofu, ['validate'], { cwd: work, stdio: 'pipe', encoding: 'utf8' });
    console.log(`✓ ${bp}: ${out.trim().split('\n')[0]}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${bp} FAILED:\n${e.stdout ?? ''}${e.stderr ?? e.message}`);
  }
}
console.log(failed === 0 ? `\nAll ${blueprints.length} blueprints valid.` : `\n${failed} blueprint(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
