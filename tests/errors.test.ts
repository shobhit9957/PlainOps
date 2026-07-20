import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-err-'));
});

/** Shape of an @anthropic-ai/sdk APIError, duck-typed the way errors.ts reads it. */
function sdkError(status: number, type: string, message: string) {
  return {
    status,
    message: `${status} ${JSON.stringify({ type: 'error', error: { type, message }, request_id: null })}`,
    error: { type: 'error', error: { type, message } },
  };
}

describe('explainError — every failure gets a plain-English message with a fix', () => {
  it('401 invalid API key → names the problem, points at Settings and console.anthropic.com, never dumps raw JSON', async () => {
    const { explainError } = await import('../src/errors.js');
    const text = explainError(sdkError(401, 'authentication_error', 'API key is invalid.'));
    expect(text).toMatch(/API key was rejected/);
    expect(text).toMatch(/Settings/);
    expect(text).toMatch(/console\.anthropic\.com/);
    expect(text).toMatch(/authentication_error/); // technical tail kept, one line
    expect(text).not.toMatch(/request_id/); // raw JSON body never shown
    expect(text).not.toMatch(/"type":"error"/);
  });

  it('credit balance too low → billing guidance, and reassures nothing was deployed', async () => {
    const { explainError } = await import('../src/errors.js');
    const text = explainError(
      sdkError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'),
    );
    expect(text).toMatch(/out of credits/);
    expect(text).toMatch(/Billing/);
    expect(text).toMatch(/Nothing was deployed/);
  });

  it('429 rate limit → wait-and-retry guidance', async () => {
    const { explainError } = await import('../src/errors.js');
    const text = explainError(sdkError(429, 'rate_limit_error', 'Rate limit exceeded'));
    expect(text).toMatch(/rate-limiting/);
    expect(text).toMatch(/wait about a minute/i);
  });

  it('529 overloaded → says it is Anthropic-side and transient', async () => {
    const { explainError } = await import('../src/errors.js');
    const text = explainError(sdkError(529, 'overloaded_error', 'Overloaded'));
    expect(text).toMatch(/overloaded/i);
    expect(text).toMatch(/their side/);
  });

  it('500 api_error → Anthropic-side with status page pointer', async () => {
    const { explainError } = await import('../src/errors.js');
    const text = explainError(sdkError(500, 'api_error', 'Internal server error'));
    expect(text).toMatch(/internal error/i);
    expect(text).toMatch(/status\.anthropic\.com/);
  });

  it('403 permission and 404 model access each get their own explanation', async () => {
    const { explainError } = await import('../src/errors.js');
    expect(explainError(sdkError(403, 'permission_error', 'forbidden'))).toMatch(/isn’t allowed|workspace/);
    expect(explainError(sdkError(404, 'not_found_error', 'model not found'))).toMatch(/access to the AI model/);
  });

  it('DNS failure (ENOTFOUND in the cause chain) → internet/VPN guidance', async () => {
    const { explainError } = await import('../src/errors.js');
    const err = Object.assign(new Error('Connection error.'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), { code: 'ENOTFOUND' }),
    });
    const text = explainError(err);
    expect(text).toMatch(/api\.anthropic\.com/);
    expect(text).toMatch(/internet connection/);
  });

  it('generic connection error / timeout → retry guidance', async () => {
    const { explainError } = await import('../src/errors.js');
    expect(explainError(new Error('Connection error.'))).toMatch(/timed out or failed/);
    expect(explainError(new Error('Request timed out.'))).toMatch(/timed out or failed/);
  });

  it('missing API key (SDK auth-method error) → points at Settings', async () => {
    const { explainError } = await import('../src/errors.js');
    const text = explainError(
      new Error('Could not resolve authentication method. Expected either apiKey or authToken to be set.'),
    );
    expect(text).toMatch(/No Anthropic API key is configured/);
    expect(text).toMatch(/Settings/);
  });

  it('unknown errors fall back to a calm generic message that keeps the detail', async () => {
    const { explainError } = await import('../src/errors.js');
    const text = explainError(new Error('boom: something exotic'));
    expect(text).toMatch(/Something unexpected went wrong/);
    expect(text).toMatch(/boom: something exotic/);
    expect(text).toMatch(/only happen after you approve/);
  });

  it('never returns the bare old format for API errors', async () => {
    const { explainError } = await import('../src/errors.js');
    const text = explainError(sdkError(401, 'authentication_error', 'API key is invalid.'));
    expect(text.startsWith('Something went wrong:')).toBe(false);
  });
});
