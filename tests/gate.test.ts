import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-gate-'));
  delete process.env.PLAINOPS_DEMO;
});

describe('secret prompts — one form per requested secret, never dropped', () => {
  it('queues several concurrent prompts with distinct ids and resolves each independently', async () => {
    const { requestSecretValue, resolveSecretPrompt } = await import('../src/gate.js');
    const { onBus } = await import('../src/bus.js');

    const events: Array<{ id: string; name: string }> = [];
    onBus((e) => {
      if (e.type === 'secret.request') events.push({ id: e.id as string, name: e.name as string });
    });

    // The agent asks for three secrets in one turn (the STRIPE_KEY /
    // DATABASE_URL / JWT_SECRET case) — all three must be pending at once.
    const p1 = requestSecretValue('shop', 'STRIPE_KEY');
    const p2 = requestSecretValue('shop', 'DATABASE_URL');
    const p3 = requestSecretValue('shop', 'JWT_SECRET');

    expect(events.map((e) => e.name)).toEqual(['STRIPE_KEY', 'DATABASE_URL', 'JWT_SECRET']);
    expect(new Set(events.map((e) => e.id)).size).toBe(3);

    // Resolve out of order: provided, provided, skipped.
    expect(resolveSecretPrompt(events[1].id, true)).toEqual({ projectName: 'shop', name: 'DATABASE_URL' });
    expect(resolveSecretPrompt(events[0].id, true)).toEqual({ projectName: 'shop', name: 'STRIPE_KEY' });
    expect(resolveSecretPrompt(events[2].id, false)).toEqual({ projectName: 'shop', name: 'JWT_SECRET' });

    await expect(p1).resolves.toBe(true);
    await expect(p2).resolves.toBe(true);
    await expect(p3).resolves.toBe(false);
  });

  it('marks prompts for already-saved secrets so the form can say "replaces the stored value"', async () => {
    const { setSecret } = await import('../src/vault.js');
    const { requestSecretValue, resolveSecretPrompt } = await import('../src/gate.js');
    const { onBus } = await import('../src/bus.js');

    setSecret('DATABASE_URL', 'postgres://old');

    const seen: Array<{ name: string; exists: boolean }> = [];
    const ids: string[] = [];
    onBus((e) => {
      if (e.type === 'secret.request') {
        seen.push({ name: e.name as string, exists: e.exists as boolean });
        ids.push(e.id as string);
      }
    });

    void requestSecretValue('shop', 'DATABASE_URL');
    void requestSecretValue('shop', 'BRAND_NEW_KEY');

    expect(seen).toEqual([
      { name: 'DATABASE_URL', exists: true },
      { name: 'BRAND_NEW_KEY', exists: false },
    ]);
    for (const id of ids) resolveSecretPrompt(id, false);
  });

  it('unknown prompt ids resolve nothing (double-submit is harmless)', async () => {
    const { resolveSecretPrompt } = await import('../src/gate.js');
    expect(resolveSecretPrompt('no-such-id', true)).toBeNull();
  });
});

describe('POST /api/secretprompt/:id/skip', () => {
  it('resolves the pending prompt as "no value" so the agent turn continues', async () => {
    const { createServer } = await import('../src/server.js');
    const { requestSecretValue } = await import('../src/gate.js');
    const { onBus } = await import('../src/bus.js');

    let promptId = '';
    onBus((e) => {
      if (e.type === 'secret.request') promptId = e.id as string;
    });
    const pending = requestSecretValue('shop', 'STRIPE_KEY');

    const res = await request(createServer()).post(`/api/secretprompt/${promptId}/skip`).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    await expect(pending).resolves.toBe(false);
  });

  it('returns ok:false for unknown ids', async () => {
    const { createServer } = await import('../src/server.js');
    const res = await request(createServer()).post('/api/secretprompt/nope/skip').send({});
    expect(res.body.ok).toBe(false);
  });
});
