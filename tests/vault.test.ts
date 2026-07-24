import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-vault-'));
  process.env.PLAINOPS_HOME = dir;
});

describe('vault', () => {
  it('round-trips secrets through encryption', async () => {
    const { setSecret, getSecret, listSecretNames } = await import('../src/vault.js');
    setSecret('DATABASE_URL', 'postgres://u:SuperSecret123@h/db');
    setSecret('STRIPE_KEY', 'sk_live_abcdef123456');
    expect(getSecret('DATABASE_URL')).toBe('postgres://u:SuperSecret123@h/db');
    expect(listSecretNames()).toEqual(['DATABASE_URL', 'STRIPE_KEY']);
    expect(getSecret('MISSING')).toBeNull();
  });

  it('stores only ciphertext on disk', async () => {
    const { setSecret } = await import('../src/vault.js');
    setSecret('DATABASE_URL', 'postgres://u:SuperSecret123@h/db');
    const raw = fs.readFileSync(path.join(process.env.PLAINOPS_HOME!, 'vault.enc'), 'utf8');
    expect(raw).not.toContain('SuperSecret123');
  });

  it('rejects bad names and empty values', async () => {
    const { setSecret } = await import('../src/vault.js');
    expect(() => setSecret('bad-name', 'x'.repeat(10))).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => setSecret('GOOD_NAME', '')).toThrow(/empty/);
  });

  // scrub() ignores values under MIN_SECRET_LENGTH to avoid mangling common short
  // strings. Accepting a shorter value would store something the scrubber can
  // never redact — a permanent leak. Refuse at the door instead.
  it('refuses values too short for the scrubber to ever redact', async () => {
    const { setSecret, getSecret } = await import('../src/vault.js');
    expect(() => setSecret('SHORT_ONE', 'abc')).toThrow(/too short/i);
    expect(getSecret('SHORT_ONE')).toBeNull();
    expect(() => setSecret('LONG_ENOUGH', 'abcdef')).not.toThrow();
  });
});

describe('scrub', () => {
  it('replaces stored secret values in arbitrary multiline text', async () => {
    const { setSecret } = await import('../src/vault.js');
    const { scrub } = await import('../src/scrub.js');
    setSecret('DATABASE_URL', 'postgres://u:SuperSecret123@h/db');
    const dirty = 'line1\nconn=postgres://u:SuperSecret123@h/db ok\nline3';
    expect(scrub(dirty)).toBe('line1\nconn={{secret:DATABASE_URL}} ok\nline3');
  });

  it('handles values containing regex metacharacters', async () => {
    const { setSecret } = await import('../src/vault.js');
    const { scrub } = await import('../src/scrub.js');
    setSecret('WEIRD_TOKEN', 'a+b(c)$[d]*?^|end');
    expect(scrub('token=a+b(c)$[d]*?^|end;')).toBe('token={{secret:WEIRD_TOKEN}};');
  });

  it('masks AWS access key ids even when not vaulted', async () => {
    const { scrub } = await import('../src/scrub.js');
    expect(scrub('key AKIAIOSFODNN7EXAMPLE leaked')).toBe(
      'key {{secret:AWS_ACCESS_KEY_ID}} leaked',
    );
  });

  it('is identity on clean text', async () => {
    const { scrub } = await import('../src/scrub.js');
    expect(scrub('nothing to see here')).toBe('nothing to see here');
  });

  // `aws sts get-session-token` / `ecr get-login-password` output is never
  // vaulted, so literal replacement cannot catch it. Pattern-mask it.
  it('masks temporary STS credentials that were never vaulted', async () => {
    const { scrub } = await import('../src/scrub.js');
    expect(scrub('id ASIAIOSFODNN7EXAMPLE here')).toBe('id {{secret:AWS_ACCESS_KEY_ID}} here');
    const stsJson = '{"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "SessionToken": "FQoGZXIvYXdzEBYaDHRlc3RzZXNzaW9u"}';
    const out = scrub(stsJson);
    expect(out).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(out).not.toContain('FQoGZXIvYXdzEBYaDHRlc3RzZXNzaW9u');
  });

  it('masks common third-party token shapes that were never vaulted', async () => {
    const { scrub } = await import('../src/scrub.js');
    expect(scrub('token ghp_0123456789abcdefghijklmnopqrstuvwx go')).not.toContain('ghp_0123456789');
    expect(scrub('-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----')).not.toContain('MIIEabc');
  });

  // Streamed model output arrives in arbitrary chunks. Scrubbing each chunk in
  // isolation misses a value split across a boundary — the halves match nothing.
  it('createDeltaScrubber redacts a secret split across two streamed chunks', async () => {
    const { setSecret } = await import('../src/vault.js');
    const { createDeltaScrubber } = await import('../src/scrub.js');
    setSecret('STRIPE_KEY', 'sk_live_abcdef123456');
    const s = createDeltaScrubber();
    const emitted = [s.push('your key is sk_live_'), s.push('abcdef123456 ok'), s.flush()].join('');
    expect(emitted).not.toContain('sk_live_abcdef123456');
    expect(emitted).toBe('your key is {{secret:STRIPE_KEY}} ok');
  });

  it('createDeltaScrubber emits every character exactly once on clean text', async () => {
    const { createDeltaScrubber } = await import('../src/scrub.js');
    const s = createDeltaScrubber();
    const chunks = ['Hello ', 'there, ', 'this is fine.'];
    const emitted = [...chunks.map((c) => s.push(c)), s.flush()].join('');
    expect(emitted).toBe('Hello there, this is fine.');
  });

  it('resolvePlaceholders restores values and throws on unknown names', async () => {
    const { setSecret } = await import('../src/vault.js');
    const { resolvePlaceholders } = await import('../src/scrub.js');
    setSecret('API_KEY', 'value-123456');
    expect(resolvePlaceholders('x={{secret:API_KEY}}')).toBe('x=value-123456');
    expect(() => resolvePlaceholders('x={{secret:NOPE}}')).toThrow(/Unknown secret/);
  });
});
