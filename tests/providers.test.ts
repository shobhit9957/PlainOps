import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-prov-'));
});

describe('AI provider registry — pick a provider, paste its key, everything else unchanged', () => {
  it('ships the expected providers, Claude first as the tuned default', async () => {
    const { PROVIDERS } = await import('../src/agent/providers.js');
    const ids = PROVIDERS.map((p) => p.id);
    expect(ids[0]).toBe('anthropic');
    for (const id of ['openai', 'openrouter', 'kimi', 'deepseek', 'groq', 'xai', 'gemini', 'ollama', 'custom']) {
      expect(ids).toContain(id);
    }
    // Everyone except Anthropic speaks the OpenAI-compatible protocol.
    for (const p of PROVIDERS) expect(p.kind).toBe(p.id === 'anthropic' ? 'anthropic' : 'openai');
  });

  it('legacy anthropicApiKey installs keep working untouched', async () => {
    const { activeAI, aiReady } = await import('../src/agent/providers.js');
    const cfg = { anthropicApiKey: 'sk-ant-legacy', model: 'claude-opus-4-8', port: 7717 };
    const ai = activeAI(cfg);
    expect(ai.provider.id).toBe('anthropic');
    expect(ai.apiKey).toBe('sk-ant-legacy');
    expect(ai.model).toBe('claude-opus-4-8');
    expect(aiReady(cfg).ok).toBe(true);
  });

  it('selecting Kimi uses the Moonshot endpoint, its default model, and its own stored key', async () => {
    const { activeAI } = await import('../src/agent/providers.js');
    const cfg = {
      model: 'claude-opus-4-8',
      port: 7717,
      aiProvider: 'kimi',
      aiKeys: { kimi: 'sk-kimi-123', anthropic: 'sk-ant-xyz' },
    };
    const ai = activeAI(cfg);
    expect(ai.provider.label).toContain('Kimi');
    expect(ai.baseUrl).toContain('api.moonshot.ai');
    expect(ai.model).toBe(ai.provider.defaultModel);
    expect(ai.apiKey).toBe('sk-kimi-123');
  });

  it('model overrides beat defaults; switching providers never loses keys', async () => {
    const { activeAI } = await import('../src/agent/providers.js');
    const cfg = {
      model: 'claude-opus-4-8',
      port: 7717,
      aiProvider: 'openrouter',
      aiKeys: { openrouter: 'sk-or-1', openai: 'sk-oa-2' },
      aiModels: { openrouter: 'moonshotai/kimi-k2-thinking' },
    };
    expect(activeAI(cfg).model).toBe('moonshotai/kimi-k2-thinking');
    expect(activeAI({ ...cfg, aiProvider: 'openai' }).apiKey).toBe('sk-oa-2');
  });

  it('readiness: missing key blocks with a clear reason; Ollama is keyless; custom needs base URL + model', async () => {
    const { aiReady } = await import('../src/agent/providers.js');
    const base = { model: 'claude-opus-4-8', port: 7717 };
    expect(aiReady({ ...base, aiProvider: 'openai' }).ok).toBe(false);
    expect(aiReady({ ...base, aiProvider: 'openai' }).reason).toContain('OpenAI');
    expect(aiReady({ ...base, aiProvider: 'ollama' }).ok).toBe(true);
    expect(aiReady({ ...base, aiProvider: 'custom' }).ok).toBe(false);
    expect(
      aiReady({ ...base, aiProvider: 'custom', aiBaseUrls: { custom: 'http://10.0.0.5:8000/v1' }, aiModels: { custom: 'my-model' } }).ok,
    ).toBe(true);
  });

  it('error hints name the active provider and its real API host', async () => {
    const { aiErrorHint } = await import('../src/agent/providers.js');
    const hint = aiErrorHint({ model: 'x', port: 7717, aiProvider: 'kimi', aiKeys: { kimi: 'k' } });
    expect(hint.label).toContain('Kimi');
    expect(hint.host).toBe('api.moonshot.ai');
    const def = aiErrorHint({ model: 'x', port: 7717 });
    expect(def.host).toBe('api.anthropic.com');
  });
});
