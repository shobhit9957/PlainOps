import { getSecret, setSecret, listSecretNames } from './vault.js';
import { scrub } from './scrub.js';
import { auditLog } from './audit.js';

/**
 * Developer notifications. Destinations are configured BY THE FOUNDER in the
 * Connectors panel and stored in the encrypted vault — the model can choose
 * the message, never the destination. Supports Slack and Discord incoming
 * webhooks plus a generic JSON webhook; all are a single POST, no SDKs.
 */

export const NOTIFY_SLACK = 'SLACK_WEBHOOK_URL';
export const NOTIFY_DISCORD = 'DISCORD_WEBHOOK_URL';
export const NOTIFY_GENERIC = 'NOTIFY_WEBHOOK_URL';

export interface NotifyChannels {
  slack: boolean;
  discord: boolean;
  webhook: boolean;
}

export function configuredChannels(): NotifyChannels {
  const names = new Set(listSecretNames());
  return {
    slack: names.has(NOTIFY_SLACK),
    discord: names.has(NOTIFY_DISCORD),
    webhook: names.has(NOTIFY_GENERIC),
  };
}

export function anyChannelConfigured(): boolean {
  const c = configuredChannels();
  return c.slack || c.discord || c.webhook;
}

export function saveChannel(kind: 'slack' | 'discord' | 'webhook', url: string): void {
  if (!/^https:\/\//.test(url.trim())) throw new Error('Webhook URLs must start with https://');
  const name = kind === 'slack' ? NOTIFY_SLACK : kind === 'discord' ? NOTIFY_DISCORD : NOTIFY_GENERIC;
  setSecret(name, url.trim());
}

async function post(url: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface NotifyResult {
  sent: string[];
  failed: string[];
}

/**
 * Send a notification to every configured channel. `severity` shapes the
 * prefix; the text itself is plain (already scrubbed upstream like all
 * model-originated strings).
 */
export async function notifyDeveloper(projectName: string, severity: 'info' | 'warning' | 'critical', message: string): Promise<NotifyResult> {
  // Watchtower incidents embed app-log evidence, which can contain a secret the
  // app printed itself — scrub here too, not only on model-facing paths.
  message = scrub(message);
  const icon = severity === 'critical' ? '🔴' : severity === 'warning' ? '🟠' : '🟢';
  const text = `${icon} PlainOps · ${projectName}\n${message}`.slice(0, 3500);
  const result: NotifyResult = { sent: [], failed: [] };

  const slack = getSecret(NOTIFY_SLACK);
  if (slack) (await post(slack, { text })) ? result.sent.push('slack') : result.failed.push('slack');

  const discord = getSecret(NOTIFY_DISCORD);
  if (discord) (await post(discord, { content: text.slice(0, 1900) })) ? result.sent.push('discord') : result.failed.push('discord');

  const generic = getSecret(NOTIFY_GENERIC);
  if (generic) {
    (await post(generic, { source: 'plainops', project: projectName, severity, message, at: new Date().toISOString() }))
      ? result.sent.push('webhook')
      : result.failed.push('webhook');
  }

  auditLog({ type: 'notify', summary: `[${severity}] ${projectName}: sent→${result.sent.join(',') || 'none'} failed→${result.failed.join(',') || 'none'}` });
  return result;
}
