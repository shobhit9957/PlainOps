import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-notify-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notification channels', () => {
  it('reports nothing configured on a fresh install', async () => {
    const { anyChannelConfigured, configuredChannels } = await import('../src/notify.js');
    expect(anyChannelConfigured()).toBe(false);
    expect(configuredChannels()).toEqual({ slack: false, discord: false, webhook: false });
  });

  it('rejects non-https webhook URLs', async () => {
    const { saveChannel } = await import('../src/notify.js');
    expect(() => saveChannel('slack', 'http://insecure.example')).toThrow(/https/);
    expect(() => saveChannel('slack', 'notaurl')).toThrow(/https/);
  });

  it('stores channels in the vault and sends to every configured one', async () => {
    const { saveChannel, notifyDeveloper, anyChannelConfigured } = await import('../src/notify.js');
    saveChannel('slack', 'https://hooks.slack.example/T/B/x');
    saveChannel('webhook', 'https://ops.example/hook');
    expect(anyChannelConfigured()).toBe(true);

    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url: String(url), body: init.body });
      return { ok: true } as Response;
    });

    const res = await notifyDeveloper('dating-app', 'critical', 'Gateway is DOWN (HTTP 503).');
    expect(res.sent.sort()).toEqual(['slack', 'webhook']);
    expect(res.failed).toEqual([]);
    expect(calls).toHaveLength(2);
    const slackBody = JSON.parse(calls.find((c) => c.url.includes('slack'))!.body);
    expect(slackBody.text).toContain('🔴');
    expect(slackBody.text).toContain('dating-app');
    const hookBody = JSON.parse(calls.find((c) => c.url.includes('ops.example'))!.body);
    expect(hookBody).toMatchObject({ source: 'plainops', project: 'dating-app', severity: 'critical' });
  });

  it('reports failures per channel instead of throwing', async () => {
    const { saveChannel, notifyDeveloper } = await import('../src/notify.js');
    saveChannel('discord', 'https://discord.example/api/webhooks/x');
    vi.stubGlobal('fetch', async () => ({ ok: false }) as Response);
    const res = await notifyDeveloper('p', 'info', 'hello');
    expect(res.sent).toEqual([]);
    expect(res.failed).toEqual(['discord']);
  });
});
