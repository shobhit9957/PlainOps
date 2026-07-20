import { _allSecretsForScrubbing, getSecret } from './vault.js';

export const PLACEHOLDER_RE = /\{\{secret:([A-Z][A-Z0-9_]*)\}\}/g;

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
    .filter(([, v]) => v && v.length >= 6)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of entries) {
    out = replaceAllLiteral(out, value, `{{secret:${name}}}`);
  }
  // Defense-in-depth: mask anything that looks like an AWS access key id.
  out = out.replace(/AKIA[0-9A-Z]{16}/g, '{{secret:AWS_ACCESS_KEY_ID}}');
  return out;
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
