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

  it('resolvePlaceholders restores values and throws on unknown names', async () => {
    const { setSecret } = await import('../src/vault.js');
    const { resolvePlaceholders } = await import('../src/scrub.js');
    setSecret('API_KEY', 'value-123456');
    expect(resolvePlaceholders('x={{secret:API_KEY}}')).toBe('x=value-123456');
    expect(() => resolvePlaceholders('x={{secret:NOPE}}')).toThrow(/Unknown secret/);
  });
});
