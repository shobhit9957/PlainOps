/**
 * Turns raw failures from the agent loop into calm, actionable plain-English
 * chat messages. These are exactly the failures the AI model cannot explain
 * itself — the call to the model is what failed — so the product has to
 * speak clearly on its own here.
 *
 * Every branch answers three things: what happened, how to fix it, and the
 * one-line technical detail for anyone debugging. Never dump raw JSON at
 * the user.
 */

interface ApiErrorShape {
  status?: number;
  code?: string;
  message?: string;
  cause?: unknown;
  error?: unknown;
}

/** Walk an error's `cause` chain collecting Node error codes + messages. */
function collectDeep(err: unknown, depth = 0): { codes: string[]; text: string } {
  if (!err || typeof err !== 'object' || depth > 5) return { codes: [], text: '' };
  const e = err as ApiErrorShape;
  const nested = collectDeep(e.cause, depth + 1);
  return {
    codes: [e.code, ...nested.codes].filter((c): c is string => typeof c === 'string'),
    text: [e.message, nested.text].filter(Boolean).join(' | '),
  };
}

/** Pull the Anthropic error body ({type, message}) out of an SDK error, if present. */
function apiBody(err: ApiErrorShape): { type?: string; message?: string } {
  const outer = err.error as { type?: string; message?: string; error?: { type?: string; message?: string } } | undefined;
  if (outer?.error && typeof outer.error === 'object') return outer.error;
  if (outer?.type && outer.type !== 'error') return outer;
  return {};
}

function fix(lines: string): string {
  return `How to fix: ${lines}`;
}

const SETTINGS_PATH = 'Settings (⚙, top right) → “AI provider & API key”';

export interface ProviderHint {
  /** e.g. "Claude (Anthropic)", "OpenAI", "Kimi (Moonshot)". */
  label?: string;
  /** Where the founder creates a key for this provider. */
  keysUrl?: string;
  /** The API host, for network-failure wording. */
  host?: string;
}

export function explainError(err: unknown, hint?: ProviderHint): string {
  const label = hint?.label ?? 'Anthropic';
  const keysUrl = hint?.keysUrl ?? 'console.anthropic.com → API Keys';
  const host = hint?.host ?? 'api.anthropic.com';
  const isAnthropic = label.includes('Anthropic');
  const e = (err ?? {}) as ApiErrorShape;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const body = apiBody(e);
  const deep = collectDeep(e);
  const allText = `${e.message ?? ''} | ${body.message ?? ''} | ${deep.text}`.toLowerCase();
  const codes = new Set(deep.codes.map((c) => c.toUpperCase()));
  const detail = [status, body.type, body.message ?? e.message]
    .filter(Boolean)
    .join(' ')
    .slice(0, 300);
  const tail = `\n\n(technical detail: ${detail || 'no further detail available'})`;

  // --- Anthropic API responses, most specific first -----------------------

  if (allText.includes('credit balance is too low')) {
    return (
      `I couldn’t run this — your ${label} account is out of credits, so the AI model refused the request. Nothing was deployed or changed.\n\n` +
      fix(
        `add credits at ${isAnthropic ? 'console.anthropic.com → Billing' : `your ${label} billing console`} (or switch to a key from an account that has credits), then send your message again.`,
      ) +
      tail
    );
  }

  if (status === 401 || body.type === 'authentication_error') {
    return (
      `I couldn’t reach the AI model — your ${label} API key was rejected. It is usually one of three things: the key was pasted with a typo or extra spaces, it was revoked, or it belongs to a deleted workspace.\n\n` +
      fix(`open ${SETTINGS_PATH}, paste a fresh key (create one at ${keysUrl}), save, and send your message again. Your cloud credentials are separate and unaffected.`) +
      tail
    );
  }

  if (status === 403 || body.type === 'permission_error') {
    return (
      `Your ${label} API key works, but it isn’t allowed to do this — the key has a workspace policy or model restriction on it.\n\n` +
      fix(`in your ${label} console check the key’s limits (or create an unrestricted key), update it in ${SETTINGS_PATH}, and retry.`) +
      tail
    );
  }

  if (status === 404 || body.type === 'not_found_error') {
    return (
      `Your ${label} API key doesn’t have access to the AI model PlainOps is configured to use — or the model name is mistyped, which looks exactly the same.\n\n` +
      fix(`check the model name in ${SETTINGS_PATH} first (blank = the provider default), then check which models your ${label} account can use, and retry.`) +
      tail
    );
  }

  if (status === 413 || body.type === 'request_too_large' || allText.includes('request_too_large')) {
    return (
      'This conversation has grown too large for a single request to the AI model.\n\n' +
      fix('send a shorter message, or start again in a fresh project chat — your infrastructure and deployments are untouched by chat history.') +
      tail
    );
  }

  if (status === 429 || body.type === 'rate_limit_error') {
    return (
      `The AI model is rate-limiting your ${label} account — too many requests in a short window. This happens on new accounts with low limits, or during long busy deploys.\n\n` +
      fix(
        `wait about a minute and send your message again. If it keeps happening, your account’s rate limits ${isAnthropic ? 'at console.anthropic.com → Limits ' : `in your ${label} console `}may need a higher tier.`,
      ) +
      tail
    );
  }

  if (status === 529 || body.type === 'overloaded_error') {
    return (
      `${label}’s servers are overloaded right now — this is on their side, not yours, and it usually clears quickly.\n\n` +
      fix('wait a minute or two and send your message again. Nothing on your side needs changing.') +
      tail
    );
  }

  if ((status !== undefined && status >= 500) || body.type === 'api_error') {
    return (
      `${label}’s API had an internal error — this is on their side, not yours.\n\n` +
      fix(`send your message again in a moment. If it persists, check ${isAnthropic ? 'status.anthropic.com' : `${label}’s status page`}.`) +
      tail
    );
  }

  if (allText.includes('reasoning_effort') || (status === 400 && allText.includes('/v1/responses'))) {
    return (
      `The model you picked is a reasoning model, and ${label} won’t let it use PlainOps’s tools with reasoning left on. PlainOps automatically retried with reasoning turned off — if you’re still seeing this, that model can’t do tool-calling here, and PlainOps needs tools for everything it does.\n\n` +
      fix(
        `open ${SETTINGS_PATH} and switch to a tool-capable model — ${isAnthropic ? 'e.g. claude-opus-4-8' : 'e.g. OpenAI gpt-5.1 or gpt-4.1, or a different model that supports function calling'} — or switch back to Claude (Anthropic). Then send your message again.`,
      ) +
      tail
    );
  }

  if (status === 400 || body.type === 'invalid_request_error') {
    return (
      'The AI model rejected the request as malformed. This is usually a PlainOps bug rather than something you did.\n\n' +
      fix('try sending the message again (rephrased if it was very long). If it keeps failing the same way, please report it — the technical detail below is what we need.') +
      tail
    );
  }

  // --- No HTTP response at all: network / local problems ------------------

  if (allText.includes('apikey') && allText.includes('authtoken')) {
    return (
      `No ${label} API key is configured, so I can’t reach the AI model.\n\n` +
      fix(`open ${SETTINGS_PATH} and paste your key — create one at ${keysUrl}.`) +
      tail
    );
  }

  if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) {
    return (
      `I couldn’t look up ${host} — your machine has no working DNS/internet route right now.\n\n` +
      fix('check your internet connection (and VPN/proxy if you use one), then send your message again.') +
      tail
    );
  }

  if (codes.has('ECONNREFUSED') || codes.has('ECONNRESET') || allText.includes('socket hang up')) {
    return (
      `The connection to ${host} was refused or dropped mid-request. A firewall, VPN, or proxy on your network is the usual cause.\n\n` +
      fix(`check VPN/proxy/firewall settings (${host} must be reachable), then send your message again.`) +
      tail
    );
  }

  if (
    codes.has('ETIMEDOUT') ||
    codes.has('UND_ERR_CONNECT_TIMEOUT') ||
    allText.includes('timed out') ||
    allText.includes('connection error') ||
    allText.includes('fetch failed')
  ) {
    return (
      `I couldn’t get through to the AI model — the connection timed out or failed before ${label} answered. Usually a flaky network moment.\n\n` +
      fix(`check your internet connection and send your message again. If you are on a VPN or proxy, make sure ${host} is allowed.`) +
      tail
    );
  }

  if (allText.includes('aborted')) {
    return (
      'The request to the AI model was cancelled before it finished.\n\n' +
      fix('just send your message again.') +
      tail
    );
  }

  // --- Fallback ------------------------------------------------------------

  return (
    'Something unexpected went wrong while working on this. Your infrastructure was not changed by this failure — deploys only happen after you approve them.\n\n' +
    fix('try sending the message again. If it keeps failing the same way, the technical detail below is what to report.') +
    tail
  );
}
