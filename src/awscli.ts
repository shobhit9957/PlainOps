import { execFile, spawnSync } from 'node:child_process';

/**
 * General AWS CLI runner. Lets PLAINOPS do anything in AWS beyond the built-in
 * blueprints. Read-only commands run immediately; mutating commands must be
 * gated by human approval at the call site. A few credential/secret-exposing
 * commands are refused outright so secrets never reach the model.
 */

let cachedBin: string | null = null;

function resolveAwsBin(): string {
  if (cachedBin) return cachedBin;
  if (process.env.PLAINOPS_AWS_PATH) return (cachedBin = process.env.PLAINOPS_AWS_PATH);
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(finder, ['aws'], { encoding: 'utf8', shell: false });
  if (res.status === 0 && res.stdout.trim()) {
    cachedBin = res.stdout.trim().split(/\r?\n/)[0];
    return cachedBin;
  }
  // Fall back to the bare name and hope it's on PATH.
  cachedBin = 'aws';
  return cachedBin;
}

// Operation prefixes that only read state.
const READ_PREFIXES = [
  'describe', 'list', 'get', 'lookup', 'search', 'scan', 'query', 'head',
  'batch-get', 'select', 'view', 'count', 'preview', 'estimate', 'test',
  'validate', 'simulate', 'filter', 'check',
];

// Commands that would leak credentials/secrets into the model — never run these here.
const DENIED = new Set([
  'get-secret-value',
  'get-password-data',
  'create-access-key',
  'create-login-profile',
  'update-login-profile',
]);

export interface CommandClass {
  kind: 'read' | 'mutate' | 'denied';
  service: string;
  operation: string;
}

/** Classify an AWS CLI invocation (args after `aws`). */
export function classifyAws(args: string[]): CommandClass {
  const positional = args.filter((a) => !a.startsWith('-'));
  const service = positional[0] ?? '';
  const operation = positional[1] ?? '';

  if (DENIED.has(operation)) return { kind: 'denied', service, operation };
  // get-parameter(s) with decryption exposes secret values.
  if ((operation === 'get-parameter' || operation === 'get-parameters') && args.includes('--with-decryption')) {
    return { kind: 'denied', service, operation };
  }

  // High-level s3: only `ls` is read.
  if (service === 's3') {
    return { kind: operation === 'ls' ? 'read' : 'mutate', service, operation };
  }

  const isRead = READ_PREFIXES.some((p) => operation === p || operation.startsWith(p + '-'));
  return { kind: isRead ? 'read' : 'mutate', service, operation };
}

/** Ensure a --region is present; default to the project's region. */
export function withRegion(args: string[], region: string): string[] {
  if (args.includes('--region') || args.some((a) => a.startsWith('--region='))) return args;
  // Don't force a region on genuinely global services.
  const positional = args.filter((a) => !a.startsWith('-'));
  const globalServices = new Set(['s3', 's3api', 'iam', 'sts', 'route53', 'cloudfront', 'organizations', 'budgets']);
  if (globalServices.has(positional[0] ?? '')) return args;
  return [...args, '--region', region];
}

export interface AwsResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runAwsCli(args: string[], timeoutMs = 60_000): Promise<AwsResult> {
  const bin = resolveAwsBin();
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: false, windowsHide: true },
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
