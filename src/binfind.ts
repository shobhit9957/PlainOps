import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Cross-platform CLI discovery.
 *
 * PATH lookup alone is NOT enough in real life:
 *  - Windows: the app may launch with a stale PATH (installed a CLI after
 *    login, or launched from the Start menu with a different environment).
 *    This bit us live: a machine-wide gcloud install was invisible to a
 *    fresh shell.
 *  - macOS: GUI-launched apps (Finder/Dock) get a minimal launchd PATH that
 *    does NOT include /opt/homebrew/bin or /usr/local/bin — the founder's
 *    terminal finds the CLI, the desktop app doesn't.
 *
 * So: try PATH first (`where`/`which`), then probe the locations each CLI's
 * OFFICIAL installer actually uses on that platform.
 */

export type KnownTool = 'aws' | 'gcloud' | 'az' | 'tofu' | 'terraform' | 'gh' | 'git';

/** Candidate install locations per tool per platform (order = preference). */
export function wellKnownLocations(
  tool: KnownTool,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string[] {
  if (platform === 'win32') {
    const table: Record<KnownTool, string[]> = {
      aws: [
        'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe',
        'C:\\Program Files (x86)\\Amazon\\AWSCLIV2\\aws.exe',
      ],
      gcloud: [
        'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd',
        'C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd',
        `${home}\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd`,
      ],
      az: [
        'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd',
        'C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd',
      ],
      tofu: [],
      terraform: [],
      gh: ['C:\\Program Files\\GitHub CLI\\gh.exe', 'C:\\Program Files (x86)\\GitHub CLI\\gh.exe'],
      git: ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe'],
    };
    return table[tool];
  }
  if (platform === 'darwin') {
    const table: Record<KnownTool, string[]> = {
      aws: ['/opt/homebrew/bin/aws', '/usr/local/bin/aws'],
      gcloud: [
        '/opt/homebrew/bin/gcloud',
        '/usr/local/bin/gcloud',
        `${home}/google-cloud-sdk/bin/gcloud`,
        '/opt/homebrew/share/google-cloud-sdk/bin/gcloud',
        '/usr/local/share/google-cloud-sdk/bin/gcloud',
      ],
      az: ['/opt/homebrew/bin/az', '/usr/local/bin/az'],
      tofu: ['/opt/homebrew/bin/tofu', '/usr/local/bin/tofu'],
      terraform: ['/opt/homebrew/bin/terraform', '/usr/local/bin/terraform'],
      gh: ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'],
      git: ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'],
    };
    return table[tool];
  }
  const table: Record<KnownTool, string[]> = {
    aws: ['/usr/local/bin/aws', '/usr/bin/aws'],
    gcloud: ['/usr/bin/gcloud', '/usr/lib/google-cloud-sdk/bin/gcloud', `${home}/google-cloud-sdk/bin/gcloud`, '/snap/bin/gcloud'],
    az: ['/usr/bin/az', '/usr/local/bin/az'],
    tofu: ['/usr/local/bin/tofu', '/usr/bin/tofu'],
    terraform: ['/usr/local/bin/terraform', '/usr/bin/terraform'],
    gh: ['/usr/bin/gh', '/usr/local/bin/gh'],
    git: ['/usr/bin/git', '/usr/local/bin/git'],
  };
  return table[tool];
}

export interface FindOptions {
  platform?: NodeJS.Platform;
  home?: string;
  /** Injectable for tests. */
  exists?: (p: string) => boolean;
  /** Windows: prefer the .cmd/.bat shim among PATH hits (gcloud/az are batch files). */
  preferShim?: boolean;
  /** Injectable PATH lookup for tests; defaults to `where`/`which`. */
  pathLookup?: (tool: string) => string[] | null;
}

function defaultPathLookup(tool: string, platform: NodeJS.Platform): string[] | null {
  const finder = platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(finder, [tool], { encoding: 'utf8', shell: false });
  if (res.status === 0 && res.stdout.trim()) return res.stdout.trim().split(/\r?\n/);
  return null;
}

/** PATH first, then the official install locations. Null when truly absent. */
export function findBinary(tool: KnownTool, opts: FindOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? fs.existsSync;
  const lookup = opts.pathLookup ?? ((t: string) => defaultPathLookup(t, platform));

  const hits = lookup(tool);
  if (hits && hits.length) {
    if (opts.preferShim && platform === 'win32') {
      const shim = hits.find((l) => /\.(cmd|bat)$/i.test(l));
      if (shim) return shim;
    }
    return hits[0];
  }
  for (const candidate of wellKnownLocations(tool, platform, opts.home)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}
