#!/usr/bin/env node
// Build the desktop bundle: compile TS to dist/src, then copy the runtime
// assets (dashboard, blueprints, bundled examples) so every relative path in
// the compiled code resolves exactly as it does under tsx.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const repo = path.join(root, '..');
const dist = path.join(repo, 'dist');

fs.rmSync(dist, { recursive: true, force: true });

console.log('compiling TypeScript…');
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '-p', 'tsconfig.build.json'], {
  cwd: repo,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

console.log('copying dashboard + examples…');
fs.cpSync(path.join(repo, 'web'), path.join(dist, 'web'), { recursive: true });
fs.cpSync(path.join(repo, 'examples'), path.join(dist, 'examples'), { recursive: true });

console.log('copying blueprints…');
const bpRoot = path.join(repo, 'src', 'blueprint');
for (const entry of fs.readdirSync(bpRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const from = path.join(bpRoot, entry.name);
  const to = path.join(dist, 'src', 'blueprint', entry.name);
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) {
    if (f.endsWith('.tf') || f.endsWith('.tpl') || f.endsWith('.json')) {
      fs.copyFileSync(path.join(from, f), path.join(to, f));
    }
  }
}

console.log('generating icon…');
execFileSync(process.execPath, [path.join(root, 'make-icon.mjs')], { cwd: repo, stdio: 'inherit' });

console.log('dist/ ready.');
