/**
 * AI provider registry. PlainOps speaks two protocols: Anthropic's Messages
 * API (native, the tuned-and-tested default) and the OpenAI-compatible Chat
 * Completions API that nearly every other vendor exposes — OpenAI, OpenRouter,
 * Kimi/Moonshot, DeepSeek, Groq, xAI, Gemini, local Ollama, or any custom
 * endpoint. The founder picks a provider in Settings, pastes that provider's
 * key, and everything else (tools, approvals, scrubbing) works unchanged.
 *
 * Default models are prefills, not locks — the model field in Settings
 * overrides them, so new model names never require an app update.
 */
import type { AppConfig } from '../config.js';

export interface ProviderDef {
  id: string;
  label: string;
  kind: 'anthropic' | 'openai';
  baseUrl?: string;
  defaultModel: string;
  /** Where the founder creates an API key. */
  keysUrl?: string;
  /** True when no API key is needed (local runtimes). */
  keyless?: boolean;
  /** Which token-limit parameter the endpoint expects. */
  tokenParam?: 'max_tokens' | 'max_completion_tokens';
  /** Show an editable base-URL field in the UI. */
  editableBaseUrl?: boolean;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    kind: 'anthropic',
    defaultModel: 'claude-opus-4-8',
    keysUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.1',
    keysUrl: 'https://platform.openai.com/api-keys',
    tokenParam: 'max_completion_tokens',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-opus-4.5',
    keysUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2-thinking',
    keysUrl: 'https://platform.moonshot.ai',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    keysUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    keysUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'xai',
    label: 'Grok (xAI)',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
    keysUrl: 'https://console.x.ai',
  },
  {
    id: 'gemini',
    label: 'Gemini (Google)',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-2.5-pro',
    keysUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.3',
    keyless: true,
    editableBaseUrl: true,
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    kind: 'openai',
    baseUrl: '',
    defaultModel: '',
    editableBaseUrl: true,
  },
];

export function providerById(id: string | undefined): ProviderDef {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

export interface ActiveAI {
  provider: ProviderDef;
  apiKey?: string;
  model: string;
  baseUrl?: string;
}

/** Resolve the active provider + key + model from config (with legacy
 * anthropicApiKey/model fields honored so existing installs keep working). */
export function activeAI(cfg: AppConfig): ActiveAI {
  const provider = providerById(cfg.aiProvider);
  const keys = cfg.aiKeys ?? {};
  const apiKey = keys[provider.id] ?? (provider.id === 'anthropic' ? cfg.anthropicApiKey : undefined);
  const model =
    cfg.aiModels?.[provider.id] ||
    (provider.id === 'anthropic' ? cfg.model : provider.defaultModel) ||
    provider.defaultModel;
  const baseUrl = cfg.aiBaseUrls?.[provider.id] || provider.baseUrl;
  return { provider, apiKey, model, baseUrl };
}

/** Can the active provider be called at all? */
export function aiReady(cfg: AppConfig): { ok: boolean; reason?: string } {
  const ai = activeAI(cfg);
  if (ai.provider.kind === 'openai' && !ai.baseUrl) {
    return { ok: false, reason: `Set the base URL for ${ai.provider.label} in Settings (⚙) first.` };
  }
  if (!ai.provider.keyless && !ai.apiKey && ai.provider.id !== 'custom') {
    return { ok: false, reason: `Add your ${ai.provider.label} API key in Settings (⚙) first — it powers the AI.` };
  }
  if (ai.provider.id === 'custom' && !ai.model) {
    return { ok: false, reason: 'Set a model name for your custom endpoint in Settings (⚙) first.' };
  }
  return { ok: true };
}

/** Wording hints for error messages: who rejected the key, where to make one,
 * which host the network failed to reach. */
export function aiErrorHint(cfg: AppConfig): { label: string; keysUrl?: string; host: string } {
  const ai = activeAI(cfg);
  let host = 'api.anthropic.com';
  if (ai.provider.kind === 'openai' && ai.baseUrl) {
    try {
      host = new URL(ai.baseUrl).host;
    } catch {
      host = ai.baseUrl;
    }
  }
  return { label: ai.provider.label, keysUrl: ai.provider.keysUrl, host };
}
