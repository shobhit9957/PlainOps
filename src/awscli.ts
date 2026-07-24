import { execFile } from 'node:child_process';
import { findBinary } from './binfind.js';

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
  // PATH first, then the official installer locations (Program Files /
  // Homebrew) — GUI-launched apps often run with a minimal PATH.
  cachedBin = findBinary('aws') ?? 'aws';
  return cachedBin;
}

// Operation prefixes that only read state.
const READ_PREFIXES = [
  'describe', 'list', 'get', 'lookup', 'search', 'scan', 'query', 'head',
  'batch-get', 'select', 'view', 'count', 'preview', 'estimate', 'test',
  'validate', 'simulate', 'filter', 'check',
];

// Commands that would leak credentials/secrets into the model — never run these here.
// NOTE: several of these begin with `get-` and would otherwise match READ_PREFIXES
// and run with no approval at all. The deny-list is checked first for that reason.
const DENIED = new Set([
  'get-secret-value',
  'get-password-data',
  'create-access-key',
  'create-login-profile',
  'update-login-profile',
  // Print live, usable credentials.
  'get-login-password',        // ecr — registry password
  'get-authorization-token',   // ecr / codeartifact
  'get-session-token',         // sts
  'get-federation-token',      // sts
  'assume-role',               // sts — returns AccessKeyId/SecretAccessKey/SessionToken
  'assume-role-with-saml',
  'assume-role-with-web-identity',
  'get-role-credentials',      // sso
  'get-cluster-credentials',   // redshift
  'generate-db-auth-token',    // rds
  'get-instance-access-details', // lightsail — returns private key
  'create-key-pair',           // ec2 — returns the private key material
  'get-credentials-for-identity', // cognito-identity
  'get-open-id-token',
  'create-service-specific-credential', // iam
  'reset-service-specific-credential',
  // KMS plaintext.
  'decrypt',
  'generate-data-key',
  'generate-random',
]);

// AWS global options that consume the NEXT argv token as their value. The model
// controls argument order, so `aws ec2 --region get-x terminate-instances` must
// not slide "get-x" into the operation slot and downgrade a mutation to a read.
const GLOBAL_VALUE_FLAGS = new Set([
  '--region', '--profile', '--output', '--endpoint-url', '--query',
  '--ca-bundle', '--cli-read-timeout', '--cli-connect-timeout',
  '--color', '--cli-binary-format',
]);

/** argv minus flags and the values those flags consume. */
export function commandPositionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) {
      out.push(a);
      continue;
    }
    if (a.includes('=')) continue;       // --flag=value: self-contained
    if (GLOBAL_VALUE_FLAGS.has(a)) i++;  // --flag value: skip the value too
  }
  return out;
}

export interface CommandClass {
  kind: 'read' | 'mutate' | 'denied';
  service: string;
  operation: string;
}

/** Classify an AWS CLI invocation (args after `aws`). */
export function classifyAws(args: string[]): CommandClass {
  const positional = commandPositionals(args);
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
  const positional = commandPositionals(args);
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
