#!/usr/bin/env tsx
// tofu-validate every blueprint (AWS + GCP + Azure) in isolated temp dirs.
// No cloud credentials needed; providers download once into the plugin cache.
// Uses the product's own resolveTofu(), which falls back to downloading a
// real OpenTofu binary — so this passes on a bare CI runner with nothing
// preinstalled, exercising the per-OS download + executable-bit path.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveTofu } from '../src/tofu.js';
import { appDir } from '../src/config.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bpRoot = path.join(repo, 'src', 'blueprint');

const tofu = await resolveTofu();
console.log(`using ${tofu}`);
const cache = process.env.TF_PLUGIN_CACHE_DIR ?? path.join(appDir(), 'plugin-cache');
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
    const err = e as { stdout?: string; stderr?: string; message: string };
    console.error(`✗ ${bp} FAILED:\n${err.stdout ?? ''}${err.stderr ?? err.message}`);
  }
}
console.log(failed === 0 ? `\nAll ${blueprints.length} blueprints valid.` : `\n${failed} blueprint(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
