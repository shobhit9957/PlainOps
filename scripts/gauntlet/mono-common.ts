// Shared paths + release stamping for the monolith ladder (d1–d6).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const NAME = 'gtl-mono';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');
export const fixtureDir = path.join(here, 'aws-fixtures', 'monolith');
export const exampleDir = path.join(repoRoot, 'examples', 'task-manager');
export const workdir = path.join(repoRoot, '.gauntlet-workdir', 'monolith');

const git = (args: string[]) =>
  execFileSync('git', ['-C', workdir, ...args], { stdio: 'pipe', windowsHide: true });

/** Fresh working copy: task-manager example + gauntlet overlay (marker/bomb
 * server template, node-pg-migrate, expand+contract migrations), git-initialized
 * so deployedCommit pinning and promotion drift checks are real. */
export function prepWorkdir(): void {
  fs.rmSync(workdir, { recursive: true, force: true });
  fs.mkdirSync(workdir, { recursive: true });
  fs.cpSync(exampleDir, workdir, { recursive: true });
  fs.copyFileSync(path.join(fixtureDir, 'package.json'), path.join(workdir, 'package.json'));
  fs.cpSync(path.join(fixtureDir, 'migrations'), path.join(workdir, 'migrations'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: workdir, stdio: 'pipe', windowsHide: true });
  git(['config', 'user.email', 'gauntlet@plainops.local']);
  git(['config', 'user.name', 'PlainOps Gauntlet']);
}

/** Stamp a release (marker + optional time bomb) and commit it. */
export function stampRelease(marker: string, bombMs: number, message: string): void {
  const template = fs.readFileSync(path.join(fixtureDir, 'server.js'), 'utf8');
  fs.writeFileSync(
    path.join(workdir, 'server.js'),
    template.replace(/__MARKER__/g, marker).replace(/__BOMB_MS__/g, String(bombMs)),
  );
  git(['add', '-A']);
  git(['commit', '-q', '-m', message, '--allow-empty']);
}

export function headCommit(): string {
  return execFileSync('git', ['-C', workdir, 'rev-parse', 'HEAD'], { windowsHide: true }).toString().trim();
}
