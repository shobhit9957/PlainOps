import { execFile, spawnSync } from 'node:child_process';

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
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(finder, [name], { encoding: 'utf8', shell: false });
  if (res.status === 0 && res.stdout.trim()) {
    // On Windows prefer the .cmd shim (gcloud/az are batch scripts there).
    const lines = res.stdout.trim().split(/\r?\n/);
    const cmd = lines.find((l) => /\.(cmd|bat)$/i.test(l)) ?? lines[0];
    return (binCache[cloud] = cmd);
  }
  return (binCache[cloud] = name);
}

// Verbs that only read state. gcloud/az put the verb LAST among positionals
// (`gcloud run services list`, `az containerapp show`), so we scan all
// positionals rather than assuming a fixed slot.
const READ_VERBS = [
  'list', 'show', 'describe', 'get', 'check', 'validate', 'test', 'browse',
  'export', 'search', 'query', 'version', 'info', 'help', 'lookup', 'preview',
  'read', 'tail',
];

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
    'acr login',
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

/** Classify a gcloud/az invocation (args after the binary name). */
export function classifyCloud(cloud: CloudId, args: string[]): CloudCommandClass {
  const positional = args.filter((a) => !a.startsWith('-'));
  const joined = positional.join(' ');
  for (const seq of DENIED_SEQUENCES[cloud]) {
    if (joined === seq || joined.startsWith(seq + ' ')) {
      return { kind: 'denied', verb: seq, group: positional[0] ?? '' };
    }
  }
  // The action verb is the last positional that looks like a verb; commands
  // like `az vm list --output table` or `gcloud compute instances describe x`
  // put resource names after the verb, so scan every positional.
  const isRead = positional.some((tok) =>
    READ_VERBS.some((v) => tok === v || tok.startsWith(v + '-')),
  );
  const verb = positional[positional.length - 1] ?? '';
  return { kind: isRead ? 'read' : 'mutate', verb, group: positional[0] ?? '' };
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

export function runCloudCli(cloud: CloudId, args: string[], timeoutMs = 120_000): Promise<CloudCliResult> {
  const bin = resolveCloudBin(cloud);
  // gcloud.cmd / az.cmd are batch files — Windows can only exec those through
  // a shell. Under a shell the args are joined into one command line, so any
  // arg with spaces/metacharacters must be quoted for cmd first.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  return new Promise((resolve) => {
    execFile(
      bin,
      needsShell ? args.map(quoteForCmdShell) : args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: needsShell, windowsHide: true },
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
