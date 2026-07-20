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

const SETTINGS_PATH = 'Settings (⚙, top right) → “Anthropic API key”';

export function explainError(err: unknown): string {
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
      'I couldn’t run this — your Anthropic account is out of credits, so the AI model refused the request. Nothing was deployed or changed.\n\n' +
      fix('add credits at console.anthropic.com → Billing (or switch to a key from an account that has credits), then send your message again.') +
      tail
    );
  }

  if (status === 401 || body.type === 'authentication_error') {
    return (
      'I couldn’t reach the AI model — your Anthropic API key was rejected. It is usually one of three things: the key was pasted with a typo or extra spaces, it was revoked, or it belongs to a deleted workspace.\n\n' +
      fix(`open ${SETTINGS_PATH}, paste a fresh key (create one at console.anthropic.com → API Keys), save, and send your message again. Your cloud credentials are separate and unaffected.`) +
      tail
    );
  }

  if (status === 403 || body.type === 'permission_error') {
    return (
      'Your Anthropic API key works, but it isn’t allowed to do this — the key’s workspace has a policy or model restriction on it.\n\n' +
      fix(`in console.anthropic.com check the key’s workspace limits (or create a key in the default workspace), update it in ${SETTINGS_PATH}, and retry.`) +
      tail
    );
  }

  if (status === 404 || body.type === 'not_found_error') {
    return (
      'Your Anthropic API key doesn’t have access to the AI model PlainOps uses. Some accounts (very new, or with restricted plans) don’t see every model.\n\n' +
      fix('check which models your account can use at console.anthropic.com, or contact Anthropic support to enable access, then retry.') +
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
      'The AI model is rate-limiting your Anthropic account — too many requests in a short window. This happens on new accounts with low limits, or during long busy deploys.\n\n' +
      fix('wait about a minute and send your message again. If it keeps happening, your account’s rate limits at console.anthropic.com → Limits may need a higher tier.') +
      tail
    );
  }

  if (status === 529 || body.type === 'overloaded_error') {
    return (
      'Anthropic’s servers are overloaded right now — this is on their side, not yours, and it usually clears quickly.\n\n' +
      fix('wait a minute or two and send your message again. Nothing on your side needs changing.') +
      tail
    );
  }

  if ((status !== undefined && status >= 500) || body.type === 'api_error') {
    return (
      'Anthropic’s API had an internal error — this is on their side, not yours.\n\n' +
      fix('send your message again in a moment. If it persists, check status.anthropic.com.') +
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
      'No Anthropic API key is configured, so I can’t reach the AI model.\n\n' +
      fix(`open ${SETTINGS_PATH} and paste your key — create one at console.anthropic.com → API Keys.`) +
      tail
    );
  }

  if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) {
    return (
      'I couldn’t look up api.anthropic.com — your machine has no working DNS/internet route right now.\n\n' +
      fix('check your internet connection (and VPN/proxy if you use one), then send your message again.') +
      tail
    );
  }

  if (codes.has('ECONNREFUSED') || codes.has('ECONNRESET') || allText.includes('socket hang up')) {
    return (
      'The connection to api.anthropic.com was refused or dropped mid-request. A firewall, VPN, or proxy on your network is the usual cause.\n\n' +
      fix('check VPN/proxy/firewall settings (api.anthropic.com must be reachable over HTTPS), then send your message again.') +
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
      'I couldn’t get through to the AI model — the connection timed out or failed before Anthropic answered. Usually a flaky network moment.\n\n' +
      fix('check your internet connection and send your message again. If you are on a VPN or proxy, make sure api.anthropic.com is allowed.') +
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
