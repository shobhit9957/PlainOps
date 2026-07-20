/**
 * GitHub operations through the founder's own logged-in `gh` CLI — the same
 * trust model as the cloud CLIs: read commands run instantly, anything that
 * changes GitHub waits for the founder's click, and commands that would print
 * credentials are refused outright. Secret VALUES for repos flow founder →
 * secure box → gh stdin; they never pass through the model.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { findBinary } from './binfind.js';

export function resolveGhBin(): string | null {
  const override = process.env.PLAINOPS_GH_PATH;
  if (override && fs.existsSync(override)) return override;
  return findBinary('gh');
}

export function resolveGitBin(): string | null {
  const override = process.env.PLAINOPS_GIT_PATH;
  if (override && fs.existsSync(override)) return override;
  return findBinary('git');
}

// ------------------------------------------------------------ classification

export interface GhClass {
  kind: 'read' | 'mutate' | 'denied';
  pretty: string;
  reason?: string;
}

/** Verbs that only look at things, per gh command group. */
const READ_VERBS = new Set(['list', 'view', 'status', 'watch', 'download', 'diff', 'checks', 'get']);

/** Command groups refused outright: they print or persist credentials/key
 * material, install code, or need an interactive terminal. */
const DENIED_GROUPS: Record<string, string> = {
  config: 'it can reveal or change CLI credentials/config',
  extension: 'it installs third-party code into the CLI',
  alias: 'it persists commands into the founder’s CLI config',
  'ssh-key': 'it manages key material',
  'gpg-key': 'it manages key material',
};

export function classifyGh(args: string[]): GhClass {
  const pretty = `gh ${args.join(' ')}`;
  const [group, verb] = [args[0] ?? '', args[1] ?? ''];

  if (group === 'auth') {
    if (verb === 'status') return { kind: 'read', pretty };
    return { kind: 'denied', pretty, reason: 'auth commands print tokens or need an interactive login' };
  }
  if (group in DENIED_GROUPS) return { kind: 'denied', pretty, reason: DENIED_GROUPS[group] };
  if (group === 'secret' || group === 'variable') {
    if (verb === 'list') return { kind: 'read', pretty };
    if (verb === 'set') {
      return { kind: 'denied', pretty, reason: 'secret values must come via the secure box — use set_github_secret' };
    }
    return { kind: 'mutate', pretty }; // delete
  }
  if (group === 'api') {
    // Plain GET api calls are reads; any method/field flag makes it a write.
    const writeFlags = ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'];
    const isWrite = args.some((a, i) => writeFlags.includes(a) && !(a === '-X' && args[i + 1] === 'GET') && !(a === '--method' && args[i + 1] === 'GET'));
    return { kind: isWrite ? 'mutate' : 'read', pretty };
  }
  if (group === 'search' || group === 'browse') return { kind: 'read', pretty };
  if (READ_VERBS.has(verb)) return { kind: 'read', pretty };
  return { kind: 'mutate', pretty };
}

// ------------------------------------------------------------------- runners

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], opts?: { cwd?: string; input?: string }): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { cwd: opts?.cwd, maxBuffer: 10 * 1024 * 1024, timeout: 120_000, windowsHide: true },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const c = (err as NodeJS.ErrnoException).code;
          code = typeof c === 'number' ? c : 1;
        }
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (opts?.input !== undefined) {
      child.stdin?.write(opts.input);
    }
    child.stdin?.end();
  });
}

export async function runGh(args: string[], opts?: { cwd?: string; input?: string }): Promise<CmdResult> {
  const bin = resolveGhBin();
  if (!bin) {
    return {
      code: 127,
      stdout: '',
      stderr: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com and run `gh auth login` once.',
    };
  }
  return run(bin, args, opts);
}

export async function runGit(args: string[], cwd: string): Promise<CmdResult> {
  const bin = resolveGitBin();
  if (!bin) return { code: 127, stdout: '', stderr: 'git is not installed or not findable.' };
  return run(bin, args, { cwd });
}

export function buildNoreplyEmail(id: number | string, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

// ------------------------------------------------------------- push project

export interface PushPlan {
  dir: string;
  owner: string;
  repo: string;
  createRepo: boolean;
  visibility: 'private' | 'public';
  fileCount: number;
  commitMessage: string;
}

export interface GhUser {
  login: string;
  id: number;
  name: string | null;
}

export async function ghUser(): Promise<GhUser | null> {
  const res = await runGh(['api', 'user', '--jq', '{login: .login, id: .id, name: .name}']);
  if (res.code !== 0) return null;
  try {
    return JSON.parse(res.stdout) as GhUser;
  } catch {
    return null;
  }
}

function countFiles(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      if (e.isDirectory()) walk(`${d}/${e.name}`);
      else n++;
    }
  };
  walk(dir);
  return n;
}

/** Read-only preflight: who's logged in, does the repo exist, what would be pushed. */
export async function planPush(
  dir: string,
  repoInput: string | undefined,
  visibility: 'private' | 'public',
  commitMessage: string,
  fallbackName: string,
): Promise<{ plan?: PushPlan; error?: string }> {
  if (!fs.existsSync(dir)) return { error: `Folder not found: ${dir}` };
  const user = await ghUser();
  if (!user) {
    return { error: 'GitHub CLI is not logged in. Run `gh auth login` once in a terminal, then try again.' };
  }
  let owner = user.login;
  let repo = (repoInput ?? '').trim() || fallbackName;
  if (repo.includes('/')) [owner, repo] = repo.split('/', 2);
  const exists = (await runGh(['repo', 'view', `${owner}/${repo}`, '--json', 'name'])).code === 0;
  return {
    plan: {
      dir,
      owner,
      repo,
      createRepo: !exists,
      visibility,
      fileCount: countFiles(dir),
      commitMessage,
    },
  };
}

/** Execute an approved push plan. Returns a plain-English report. */
export async function executePush(plan: PushPlan): Promise<string> {
  const { dir } = plan;
  const full = `${plan.owner}/${plan.repo}`;
  const steps: string[] = [];

  if (!fs.existsSync(`${dir}/.git`)) {
    const init = await runGit(['init', '-b', 'main'], dir);
    if (init.code !== 0) {
      const fallback = await runGit(['init'], dir);
      if (fallback.code !== 0) return `git init failed: ${fallback.stderr || init.stderr}`;
    }
    steps.push('initialized git');
  }

  // Commit identity + credentials: pin THIS repo to the gh login so pushes
  // attribute and authenticate as the founder's active GitHub account, even
  // when the machine's global git identity is someone else.
  const user = await ghUser();
  if (user) {
    const email = (await runGit(['config', 'user.email'], dir)).stdout.trim();
    if (!email) {
      await runGit(['config', 'user.name', user.name || user.login], dir);
      await runGit(['config', 'user.email', buildNoreplyEmail(user.id, user.login)], dir);
      steps.push(`commit identity set to ${user.login}`);
    }
  }
  await runGit(['config', 'credential.helper', ''], dir);
  await runGit(['config', '--add', 'credential.helper', '!gh auth git-credential'], dir);

  if (plan.createRepo) {
    const create = await runGh(['repo', 'create', full, plan.visibility === 'public' ? '--public' : '--private']);
    if (create.code !== 0) return `Could not create the repo: ${create.stderr || create.stdout}`;
    steps.push(`created ${plan.visibility} repo ${full}`);
  }

  await runGit(['add', '-A'], dir);
  const commit = await runGit(['commit', '-m', plan.commitMessage], dir);
  if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
    return `git commit failed: ${commit.stderr || commit.stdout}`;
  }
  steps.push(commit.code === 0 ? 'committed changes' : 'nothing new to commit');

  await runGit(['branch', '-M', 'main'], dir);
  const url = `https://github.com/${full}.git`;
  const remoteSet = await runGit(['remote', 'set-url', 'origin', url], dir);
  if (remoteSet.code !== 0) await runGit(['remote', 'add', 'origin', url], dir);

  const push = await runGit(['push', '-u', 'origin', 'main'], dir);
  if (push.code !== 0) return `git push failed:\n${push.stderr || push.stdout}`;
  steps.push('pushed main');

  return `Done: ${steps.join(' → ')}. Repo: https://github.com/${full}`;
}
