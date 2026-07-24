import { execFile } from 'node:child_process';
import { findBinary } from '../binfind.js';

/**
 * Generic gcloud / az CLI runner, mirroring src/awscli.ts. Read-only commands
 * run immediately; mutating commands must be gated by human approval at the
 * call site. Credential/secret-exposing commands are refused outright so
 * secret values never reach the model.
 */

export type CloudId = 'gcp' | 'azure';

const binCache: Partial<Record<CloudId, string>> = {};

function envOverride(cloud: CloudId): string | undefined {
  return cloud === 'gcp' ? process.env.PLAINOPS_GCLOUD_PATH : process.env.PLAINOPS_AZ_PATH;
}

export function resolveCloudBin(cloud: CloudId): string {
  const cached = binCache[cloud];
  if (cached) return cached;
  const override = envOverride(cloud);
  if (override) return (binCache[cloud] = override);
  const name = cloud === 'gcp' ? 'gcloud' : 'az';
  // PATH first, then the official installer locations — a GUI-launched app
  // (Start menu / Finder) often runs with a PATH the founder's terminal
  // doesn't have (Homebrew on macOS, freshly-installed SDKs on Windows).
  const found = findBinary(name, { preferShim: true });
  return (binCache[cloud] = found ?? name);
}

// Verbs that only read state. gcloud/az put the verb after the command group
// (`gcloud run services list`, `az containerapp show`).
const READ_VERBS = [
  'list', 'show', 'describe', 'get', 'check', 'validate', 'test', 'browse',
  'export', 'search', 'query', 'version', 'info', 'help', 'lookup', 'preview',
  'read', 'tail',
];

// Verbs that CHANGE something. Kept disjoint from READ_VERBS, and deliberately
// free of tokens that are also command GROUP names in either CLI (`run`,
// `config`, `compute`, `storage`, `account`, `group`, `secrets`, …) — a group
// name matching here would misclassify every read under that group.
const MUTATE_VERBS = [
  'create', 'delete', 'remove', 'update', 'deploy', 'apply', 'patch', 'replace',
  'add', 'set', 'enable', 'disable', 'start', 'stop', 'restart', 'restore',
  'rollback', 'promote', 'scale', 'resize', 'attach', 'detach', 'grant',
  'revoke', 'import', 'submit', 'push', 'publish', 'install', 'uninstall',
  'upgrade', 'downgrade', 'migrate', 'move', 'clone', 'copy', 'rename', 'reset',
  'rotate', 'renew', 'purge', 'clear', 'unset', 'undeploy', 'cancel', 'abort',
  'kill', 'terminate', 'destroy', 'drain', 'failover', 'swap', 'activate',
  'deactivate', 'suspend', 'resume', 'login', 'logout', 'print', 'download',
  'access', 'generate', 'regenerate', 'refresh', 'send', 'invoke', 'execute',
  'exec', 'ssh', 'scp', 'connect', 'disconnect', 'build', 'init', 'detach-disk',
];

// gcloud/az global options that consume the NEXT token as their value. Stripping
// them keeps a leading `--output json` from shifting the command path.
const GLOBAL_VALUE_FLAGS = new Set([
  '--output', '-o', '--format', '--project', '--subscription', '--query',
  '--verbosity', '--configuration', '--account', '--billing-project',
  '--impersonate-service-account', '--access-token-file', '--flags-file',
]);

/** argv minus flags and the values those global flags consume. */
export function commandPositionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) {
      out.push(a);
      continue;
    }
    if (a.includes('=')) continue;
    if (GLOBAL_VALUE_FLAGS.has(a)) i++;
  }
  return out;
}

function matches(tok: string, verbs: string[]): boolean {
  return verbs.some((v) => tok === v || tok.startsWith(v + '-'));
}

// Anything that would hand the model a credential or secret VALUE. Matched as a
// space-joined prefix of the positional tokens.
const DENIED_SEQUENCES: Record<CloudId, string[]> = {
  gcp: [
    'auth print-access-token',
    'auth print-identity-token',
    'auth print-refresh-token',
    'auth application-default print-access-token',
    'secrets versions access',
    'iam service-accounts keys create',
  ],
  azure: [
    'account get-access-token',
    'keyvault secret show',
    'keyvault secret download',
    'keyvault key download',
    'acr credential show',
    'acr credential renew',
    'acr login',
    'ad sp create-for-rbac',
    'webapp deployment list-publishing-credentials',
    'functionapp deployment list-publishing-credentials',
    'storage account keys list',
    'storage account keys renew',
    'cosmosdb keys list',
    'cosmosdb list-keys',
    'cosmosdb list-connection-strings',
    'redis list-keys',
    'functionapp deployment list-publishing-profiles',
    'webapp deployment list-publishing-profiles',
    'ad sp credential reset',
  ],
};

export interface CloudCommandClass {
  kind: 'read' | 'mutate' | 'denied';
  verb: string;
  group: string;
}

/**
 * Classify a gcloud/az invocation (args after the binary name).
 *
 * This is the ONLY thing between the model and the deny/approve/execute
 * decision, and the model chooses every token, so both checks are written to
 * survive a hostile argument order:
 *
 * - Denials match the sequence ANYWHERE in the command path, not just as a
 *   prefix, so a leading global flag cannot slip past them.
 * - Read/mutate is decided by the FIRST action verb in the path. Both CLIs put
 *   the command path before its arguments, so the first verb is the real one —
 *   a resource merely *named* `test` or `get-orders` can no longer make
 *   `delete` look like a read and skip the approval gate entirely.
 * - Anything with no recognised verb falls through to `mutate` (fail closed).
 */
export function classifyCloud(cloud: CloudId, args: string[]): CloudCommandClass {
  const positional = commandPositionals(args);
  const group = positional[0] ?? '';
  for (const seq of DENIED_SEQUENCES[cloud]) {
    const seqTokens = seq.split(' ');
    for (let i = 0; i + seqTokens.length <= positional.length; i++) {
      if (seqTokens.every((t, j) => positional[i + j] === t)) {
        return { kind: 'denied', verb: seq, group };
      }
    }
  }
  for (const tok of positional) {
    if (matches(tok, READ_VERBS)) return { kind: 'read', verb: tok, group };
    if (matches(tok, MUTATE_VERBS)) return { kind: 'mutate', verb: tok, group };
  }
  return { kind: 'mutate', verb: positional[positional.length - 1] ?? '', group };
}

export interface CloudCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Quote one argument for the Windows cmd shell. Needed because Node's
 * execFile with `shell: true` joins file+args with spaces WITHOUT quoting —
 * a gcloud `logging read "a AND b"` filter would split into four tokens.
 * Only used for the .cmd/.bat shims; plain binaries keep the safe array path.
 */
export function quoteForCmdShell(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^%()]/.test(arg)) return arg;
  // cmd: wrap in double quotes, escape embedded quotes by doubling them.
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Environment for az child processes. Some az command groups live in
 * EXTENSIONS (and what is core vs extension changes across az versions);
 * by default az PROMPTS before installing one — which, run from a non-TTY
 * child process, fails with a confusing "unable to prompt" error (the same
 * failure class as gcloud's "enable API? (y/N)" hang). Install needed
 * extensions automatically and keep warnings out of parsed output.
 */
export function azureChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    AZURE_EXTENSION_USE_DYNAMIC_INSTALL: base.AZURE_EXTENSION_USE_DYNAMIC_INSTALL ?? 'yes_without_prompt',
    AZURE_EXTENSION_RUN_AFTER_DYNAMIC_INSTALL: base.AZURE_EXTENSION_RUN_AFTER_DYNAMIC_INSTALL ?? 'true',
    AZURE_CORE_ONLY_SHOW_ERRORS: base.AZURE_CORE_ONLY_SHOW_ERRORS ?? 'true',
    AZURE_CORE_NO_COLOR: base.AZURE_CORE_NO_COLOR ?? 'true',
  };
}

export function runCloudCli(cloud: CloudId, args: string[], timeoutMs = 120_000): Promise<CloudCliResult> {
  const bin = resolveCloudBin(cloud);
  // gcloud.cmd / az.cmd are batch files — Windows can only exec those through
  // a shell. Under a shell the args are joined into one command line, so any
  // arg with spaces/metacharacters must be quoted for cmd first.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  return new Promise((resolve) => {
    execFile(
      // Under a shell the file becomes the first token of the command line, so
      // a binary path with spaces ("C:\Program Files (x86)\...\gcloud.cmd" —
      // the default install location) must be quoted too, not just the args.
      needsShell ? quoteForCmdShell(bin) : bin,
      needsShell ? args.map(quoteForCmdShell) : args,
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        shell: needsShell,
        windowsHide: true,
        ...(cloud === 'azure' ? { env: azureChildEnv(process.env) } : {}),
      },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );
  });
}

export interface CloudConnection {
  installed: boolean;
  authenticated: boolean;
  detail: string;
  /** GCP project id / Azure subscription name — what deploys will target. */
  target?: string;
}

export interface CloudsStatus {
  gcp: CloudConnection;
  azure: CloudConnection;
}

/** Detect which cloud CLIs exist and are logged in. Never throws. */
export async function detectClouds(): Promise<CloudsStatus> {
  const [gcp, azure] = await Promise.all([detectGcp(), detectAzure()]);
  return { gcp, azure };
}

async function detectGcp(): Promise<CloudConnection> {
  const ver = await runCloudCli('gcp', ['version', '--format=value(core)'], 15_000);
  if (ver.code !== 0) {
    return { installed: false, authenticated: false, detail: 'gcloud CLI not found — install the Google Cloud SDK to deploy to GCP.' };
  }
  const proj = await runCloudCli('gcp', ['config', 'get-value', 'project'], 15_000);
  const project = proj.stdout.trim();
  if (proj.code !== 0 || !project || project === '(unset)') {
    return { installed: true, authenticated: false, detail: 'gcloud is installed but no project is set — run `gcloud init`.' };
  }
  const acct = await runCloudCli('gcp', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], 15_000);
  if (!acct.stdout.trim()) {
    return { installed: true, authenticated: false, detail: 'gcloud has no active login — run `gcloud auth login`.', target: project };
  }
  // OpenTofu's google provider authenticates with Application Default
  // Credentials, NOT the gcloud CLI login — so `gcloud auth login` alone lets
  // a deploy pass preflight and then fail at `tofu apply` with a credentials
  // error. Verify ADC exists too, and name the exact fix if it doesn't.
  const adc = await runCloudCli('gcp', ['auth', 'application-default', 'print-access-token'], 20_000);
  if (adc.code !== 0) {
    return {
      installed: true,
      authenticated: false,
      detail: 'gcloud is logged in but Application Default Credentials are not set — deploys will fail. Run `gcloud auth application-default login` (this is what OpenTofu uses to deploy).',
      target: project,
    };
  }
  return { installed: true, authenticated: true, detail: `project ${project}`, target: project };
}

async function detectAzure(): Promise<CloudConnection> {
  const acct = await runCloudCli('azure', ['account', 'show', '--output', 'json'], 20_000);
  if (acct.code !== 0) {
    const probe = await runCloudCli('azure', ['version', '--output', 'json'], 20_000);
    if (probe.code !== 0) {
      return { installed: false, authenticated: false, detail: 'az CLI not found — install the Azure CLI to deploy to Azure.' };
    }
    return { installed: true, authenticated: false, detail: 'az is installed but not logged in — run `az login`.' };
  }
  try {
    const info = JSON.parse(acct.stdout) as { name?: string; id?: string };
    return { installed: true, authenticated: true, detail: `subscription ${info.name ?? info.id}`, target: info.name ?? info.id };
  } catch {
    return { installed: true, authenticated: true, detail: 'subscription active' };
  }
}
