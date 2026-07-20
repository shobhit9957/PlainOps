import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';

let testClient: Anthropic | null = null;

/** Tests inject a fake client here. */
export function setClientForTests(client: unknown): void {
  testClient = client as Anthropic;
}

export function getClient(): Anthropic {
  if (testClient) return testClient;
  const cfg = loadConfig();
  const key = cfg.aiKeys?.anthropic ?? cfg.anthropicApiKey;
  if (!key) {
    throw new Error('No Anthropic API key configured. Add one in the dashboard settings.');
  }
  return new Anthropic({ apiKey: key });
}
