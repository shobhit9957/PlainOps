import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-demo-'));
});

describe('replayDemoChat', () => {
  it('does not re-emit the user message — the dashboard already renders it locally on submit', async () => {
    vi.useFakeTimers();
    const { replayDemoChat } = await import('../src/demo.js');
    const { onBus } = await import('../src/bus.js');

    const events: string[] = [];
    const off = onBus((e) => events.push(e.type));
    replayDemoChat();
    await vi.runAllTimersAsync();
    off();
    vi.useRealTimers();

    // A second bubble for the same message is a visible dupe in the chat UI.
    expect(events).not.toContain('chat.usermsg');

    // The scripted sequence itself must still play out.
    expect(events).toContain('chat.message');
    expect(events).toContain('cost.estimate');
    expect(events).toContain('action.pending');
    expect(events).toContain('chat.done');
  });
});
