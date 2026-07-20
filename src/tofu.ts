import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { binDir } from './config.js';
import { findBinary } from './binfind.js';

/** Pinned candidates, newest first. Any one that downloads wins. */
const TOFU_VERSIONS = ['1.9.1', '1.9.0', '1.8.1'];

export type LineSink = (line: string) => void;

function platformAsset(version: string): { url: string; exe: string } {
  const plat = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const exe = process.platform === 'win32' ? 'tofu.exe' : 'tofu';
  return {
    url: `https://github.com/opentofu/opentofu/releases/download/v${version}/tofu_${version}_${plat}_${arch}.zip`,
    exe,
  };
}

async function downloadTofu(): Promise<string> {
  const errors: string[] = [];
  for (const version of TOFU_VERSIONS) {
    const { url, exe } = platformAsset(version);
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) {
        errors.push(`v${version}: HTTP ${res.status}`);
        continue;
      }
      const zipPath = path.join(binDir(), `tofu-${version}.zip`);
      fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
      const zip = new AdmZip(zipPath);
      const entry = zip.getEntries().find((e) => e.entryName === exe || e.entryName.endsWith(`/${exe}`));
      if (!entry) {
        errors.push(`v${version}: ${exe} not in archive`);
        continue;
      }
      const outPath = path.join(binDir(), exe);
      fs.writeFileSync(outPath, entry.getData(), { mode: 0o755 });
      fs.rmSync(zipPath, { force: true });
      return outPath;
    } catch (e) {
      errors.push(`v${version}: ${(e as Error).message}`);
    }
  }
  throw new Error(
    `Could not download OpenTofu (${errors.join('; ')}).\n` +
      `Fix: install OpenTofu or Terraform yourself (https://opentofu.org) and either put it on PATH ` +
      `or set PLAINOPS_TOFU_PATH to the binary.`,
  );
}

/** Resolve the IaC binary: env override → PATH + official install locations
 * (tofu, terraform) → cached → download. */
export async function resolveTofu(): Promise<string> {
  const override = process.env.PLAINOPS_TOFU_PATH;
  if (override && fs.existsSync(override)) return override;

  for (const cmd of ['tofu', 'terraform'] as const) {
    const found = findBinary(cmd);
    if (found) return found;
  }

  const cachedExe = path.join(binDir(), process.platform === 'win32' ? 'tofu.exe' : 'tofu');
  if (fs.existsSync(cachedExe)) return cachedExe;

  return downloadTofu();
}

/** Run the binary with streamed line output. Never uses a shell. */
export function tofuRun(
  bin: string,
  dir: string,
  args: string[],
  onLine: LineSink,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args, '-no-color'], {
      cwd: dir,
      shell: false,
      env: { ...process.env, TF_IN_AUTOMATION: '1', TF_INPUT: '0' },
    });
    let stdout = '';
    let pending = '';
    const feed = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) onLine(l);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => {
      if (pending.trim()) onLine(pending);
      resolve({ code: code ?? 1, stdout });
    });
  });
}

export async function applyProject(dir: string, onLine: LineSink): Promise<void> {
  const bin = await resolveTofu();
  const init = await tofuRun(bin, dir, ['init', '-input=false'], onLine);
  if (init.code !== 0) throw new Error('tofu init failed — see log above');
  const apply = await tofuRun(bin, dir, ['apply', '-auto-approve', '-input=false'], onLine);
  if (apply.code !== 0) throw new Error('tofu apply failed — see log above');
}

export async function destroyProject(dir: string, onLine: LineSink): Promise<void> {
  const bin = await resolveTofu();
  const init = await tofuRun(bin, dir, ['init', '-input=false'], onLine);
  if (init.code !== 0) throw new Error('tofu init failed — see log above');
  const destroy = await tofuRun(bin, dir, ['destroy', '-auto-approve', '-input=false'], onLine);
  if (destroy.code !== 0) throw new Error('tofu destroy failed — see log above');
}

/** Pure parser so it can be unit-tested without a binary. */
export function parseOutputs(outputJson: string): Record<string, string> {
  const raw = JSON.parse(outputJson) as Record<string, { value: unknown }>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = typeof v.value === 'string' ? v.value : JSON.stringify(v.value);
  }
  return out;
}

export async function readOutputs(dir: string): Promise<Record<string, string>> {
  const bin = await resolveTofu();
  const res = await tofuRun(bin, dir, ['output', '-json'], () => {});
  if (res.code !== 0) throw new Error('tofu output failed');
  return parseOutputs(res.stdout);
}
