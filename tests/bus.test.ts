import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-bus-'));
});

// SECURITY.md promises the scrubber runs before a value can reach the AI, the
// dashboard event stream, or disk. Raw OpenTofu/CLI output is piped onto the bus
// as `deploy.log` lines and written straight to the SSE stream, so the bus is
// the chokepoint that has to enforce the "event stream" half of that promise.
describe('emitBus scrubs every event before subscribers see it', () => {
  it('redacts a secret value carried on a deploy.log line', async () => {
    const { setSecret } = await import('../src/vault.js');
    const { emitBus, onBus } = await import('../src/bus.js');
    setSecret('DATABASE_URL', 'postgres://u:SuperSecret123@h/db');

    const seen: unknown[] = [];
    const off = onBus((e) => seen.push(e));
    emitBus({ type: 'deploy.log', line: 'conn=postgres://u:SuperSecret123@h/db' });
    off();

    expect(JSON.stringify(seen)).not.toContain('SuperSecret123');
    expect(JSON.stringify(seen)).toContain('{{secret:DATABASE_URL}}');
  });

  it('redacts values nested inside objects and arrays', async () => {
    const { setSecret } = await import('../src/vault.js');
    const { emitBus, onBus } = await import('../src/bus.js');
    setSecret('API_KEY', 'tok_abcdef123456');

    const seen: unknown[] = [];
    const off = onBus((e) => seen.push(e));
    emitBus({
      type: 'action.pending',
      action: { id: '1', summary: 'uses tok_abcdef123456', tags: ['tok_abcdef123456'] },
    });
    off();

    expect(JSON.stringify(seen)).not.toContain('tok_abcdef123456');
  });

  it('leaves non-string payload shapes intact', async () => {
    const { emitBus, onBus } = await import('../src/bus.js');
    const seen: Record<string, unknown>[] = [];
    const off = onBus((e) => seen.push(e as Record<string, unknown>));
    emitBus({ type: 'cost.estimate', monthly: 41.2, ok: true, items: [1, 2], nothing: null });
    off();

    expect(seen[0]).toEqual({ type: 'cost.estimate', monthly: 41.2, ok: true, items: [1, 2], nothing: null });
  });
});
