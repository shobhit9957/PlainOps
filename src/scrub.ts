import { _allSecretsForScrubbing, getSecret, MIN_SECRET_LENGTH } from './vault.js';

export const PLACEHOLDER_RE = /\{\{secret:([A-Z][A-Z0-9_]*)\}\}/g;

/**
 * Defense-in-depth patterns for credentials that were never vaulted, so literal
 * replacement cannot catch them. These are the shapes a cloud CLI can print:
 * `sts assume-role`, `ecr get-login-password`, a leaked deploy key in a log.
 * The classifiers deny those commands, but a secret can still surface in the
 * output of a command nobody thought to deny.
 */
const PATTERNS: Array<[RegExp, string]> = [
  // Long-term (AKIA) and temporary (ASIA) AWS access key ids.
  [/(?:AKIA|ASIA)[0-9A-Z]{16}/g, '{{secret:AWS_ACCESS_KEY_ID}}'],
  // STS / CLI JSON credential payloads: mask the VALUE, keep the field name.
  [
    /("(?:SecretAccessKey|SessionToken|aws_secret_access_key|aws_session_token)"\s*:\s*")[^"]+(")/gi,
    '$1{{secret:AWS_CREDENTIALS}}$2',
  ],
  // Same fields in `key = value` / `key: value` form (credentials file, YAML).
  [
    /\b(aws_secret_access_key|aws_session_token)(\s*[:=]\s*)\S+/gi,
    '$1$2{{secret:AWS_CREDENTIALS}}',
  ],
  // GitHub tokens.
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '{{secret:GITHUB_TOKEN}}'],
  // Google OAuth access tokens.
  [/\bya29\.[A-Za-z0-9._-]{10,}/g, '{{secret:GCP_ACCESS_TOKEN}}'],
  // Any PEM private key block.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '{{secret:PRIVATE_KEY}}'],
];

/** Literal (non-regex) replace-all. Values may contain regex metacharacters. */
function replaceAllLiteral(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement);
}

/**
 * Replace every known secret VALUE with its {{secret:NAME}} placeholder.
 * Applied to ALL text destined for the model, SSE, logs, or the audit trail.
 * Longer values first so overlapping values cannot leave partial leaks.
 */
export function scrub(text: string): string {
  if (!text) return text;
  let out = text;
  const entries = Object.entries(_allSecretsForScrubbing())
    .filter(([, v]) => v && v.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of entries) {
    out = replaceAllLiteral(out, value, `{{secret:${name}}}`);
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Longest value the scrubber could need to see whole to recognise it. */
function longestSecretLength(): number {
  let max = 0;
  for (const v of Object.values(_allSecretsForScrubbing())) {
    if (v && v.length > max) max = v.length;
  }
  return max;
}

export interface DeltaScrubber {
  /** Scrub `chunk` and return the portion that is safe to emit now. */
  push(chunk: string): string;
  /** Emit whatever is still held back. Call once the stream ends. */
  flush(): string;
}

/**
 * Scrub a stream of chunks without letting a secret slip through a chunk
 * boundary. Scrubbing each chunk alone misses a value split across two of them:
 * neither half matches. This holds back a tail long enough to contain any
 * vaulted value (plus the longest pattern-matched shape) until more text
 * arrives, so the value is always scrubbed as a whole before it is emitted.
 */
export function createDeltaScrubber(): DeltaScrubber {
  // Long enough for the longest vaulted value and for a PEM header to be seen.
  const hold = Math.max(longestSecretLength(), 64);
  let buf = '';
  return {
    push(chunk: string): string {
      buf += chunk;
      if (buf.length <= hold) return '';
      const cleaned = scrub(buf);
      // Only emit text that can no longer be extended into a longer match.
      if (cleaned.length <= hold) return '';
      const emit = cleaned.slice(0, cleaned.length - hold);
      buf = cleaned.slice(cleaned.length - hold);
      return emit;
    },
    flush(): string {
      const out = scrub(buf);
      buf = '';
      return out;
    },
  };
}

/**
 * Replace placeholders with real values. ONLY call at the AWS boundary
 * (e.g., just before PutSecretValue). Never call on model-bound text.
 */
export function resolvePlaceholders(text: string): string {
  return text.replace(PLACEHOLDER_RE, (_m, name: string) => {
    const v = getSecret(name);
    if (v === null) throw new Error(`Unknown secret placeholder: ${name}`);
    return v;
  });
}

export function placeholderFor(name: string): string {
  return `{{secret:${name}}}`;
}
