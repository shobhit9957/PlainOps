import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-oa-'));
});

describe('OpenAI-compatible conversion — Anthropic-format history in, standard protocol out', () => {
  it('converts a full agent exchange: system, user, assistant tool_use, tool_result', async () => {
    const { toOpenAiMessages } = await import('../src/agent/openaicompat.js');
    const history: Anthropic.MessageParam[] = [
      { role: 'user', content: 'deploy my store' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Analyzing the repo first.' },
          { type: 'tool_use', id: 'call_1', name: 'analyze_repo', input: { path: 'C:\\code\\store' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'framework: node, port 3000' }],
      },
    ];
    const out = toOpenAiMessages('You are PlainOps.', history);

    expect(out[0]).toEqual({ role: 'system', content: 'You are PlainOps.' });
    expect(out[1]).toEqual({ role: 'user', content: 'deploy my store' });
    expect(out[2].role).toBe('assistant');
    expect((out[2] as { content: string }).content).toBe('Analyzing the repo first.');
    const calls = (out[2] as { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> }).tool_calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('call_1');
    expect(calls[0].function.name).toBe('analyze_repo');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: 'C:\\code\\store' });
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'framework: node, port 3000' });
  });

  it('assistant-only tool calls get null content; user images become data URLs', async () => {
    const { toOpenAiMessages } = await import('../src/agent/openaicompat.js');
    const history: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'here is my architecture' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c2', name: 'get_status', input: {} }],
      },
    ];
    const out = toOpenAiMessages('sys', history);
    const user = out[1] as { role: string; content: Array<{ type: string; image_url?: { url: string } }> };
    expect(user.role).toBe('user');
    expect(user.content[1].type).toBe('image_url');
    expect(user.content[1].image_url?.url).toBe('data:image/png;base64,AAAA');
    const asst = out[2] as { content: string | null; tool_calls: unknown[] };
    expect(asst.content).toBeNull();
    expect(asst.tool_calls).toHaveLength(1);
  });

  it('converts the tool schemas unchanged (same JSON Schema both sides)', async () => {
    const { toOpenAiTools } = await import('../src/agent/openaicompat.js');
    const tools = [
      { name: 'get_costs', description: 'Costs.', input_schema: { type: 'object', properties: { days: { type: 'number' } } } },
    ] as unknown as Anthropic.Tool[];
    const out = toOpenAiTools(tools);
    const tool = out[0] as { type: string; function: { name: string; parameters: unknown } };
    expect(tool.type).toBe('function');
    expect(tool.function.name).toBe('get_costs');
    expect(tool.function.parameters).toEqual({ type: 'object', properties: { days: { type: 'number' } } });
  });

  it('maps a completion back: text, parsed tool calls, Anthropic-shaped history blocks', async () => {
    const { fromOpenAiMessage } = await import('../src/agent/openaicompat.js');
    const turn = fromOpenAiMessage({
      content: 'Deploying now.',
      tool_calls: [{ id: 'x1', type: 'function', function: { name: 'deploy_application', arguments: '{"confirm":true}' } }],
    });
    expect(turn.text).toBe('Deploying now.');
    expect(turn.stoppedForTools).toBe(true);
    expect(turn.toolUses).toEqual([{ id: 'x1', name: 'deploy_application', input: { confirm: true } }]);
    expect(turn.assistantBlocks).toEqual([
      { type: 'text', text: 'Deploying now.' },
      { type: 'tool_use', id: 'x1', name: 'deploy_application', input: { confirm: true } },
    ]);
  });

  it('malformed tool arguments from weaker models degrade to empty input, never a crash', async () => {
    const { fromOpenAiMessage } = await import('../src/agent/openaicompat.js');
    const turn = fromOpenAiMessage({
      content: null,
      tool_calls: [{ id: 'b1', type: 'function', function: { name: 'get_status', arguments: '{oops' } }],
    });
    expect(turn.toolUses).toEqual([{ id: 'b1', name: 'get_status', input: {} }]);
    expect(turn.stoppedForTools).toBe(true);
    expect(turn.text).toBe('');
  });

  it('plain text answer means the turn is done — no tool stop', async () => {
    const { fromOpenAiMessage } = await import('../src/agent/openaicompat.js');
    const turn = fromOpenAiMessage({ content: 'All healthy.' });
    expect(turn.stoppedForTools).toBe(false);
    expect(turn.assistantBlocks).toEqual([{ type: 'text', text: 'All healthy.' }]);
  });
});

describe('reasoning-model + tools compatibility (every OpenAI-compatible provider)', () => {
  // Reasoning models (OpenAI gpt-5.x, the same models proxied via OpenRouter,
  // etc.) reject function tools + their default reasoning_effort on
  // /v1/chat/completions. The server's own remedy is reasoning_effort:'none'.
  // PlainOps must recover automatically — it drives EVERYTHING through tools.
  const REASONING_400 = Object.assign(
    new Error(
      "Function tools with reasoning_effort are not supported for gpt-5.6-sol in " +
        "/v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
    ),
    { status: 400 },
  );

  function fakeClient(streamFactory: (params: Record<string, unknown>) => unknown) {
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      chat: {
        completions: {
          stream(params: Record<string, unknown>) {
            calls.push(params);
            return streamFactory(params);
          },
        },
      },
    };
    return { client, calls };
  }
  const openaiAI = () => ({
    provider: { id: 'openai', label: 'OpenAI', kind: 'openai' as const, defaultModel: 'gpt-5.1', tokenParam: 'max_completion_tokens' as const },
    apiKey: 'k',
    model: 'gpt-5.6-sol',
    baseUrl: 'https://api.openai.com/v1',
  });

  it('detects the reasoning_effort/tools 400 the server tells us to fix with none', async () => {
    const { isReasoningToolConflict } = await import('../src/agent/openaicompat.js');
    expect(isReasoningToolConflict(REASONING_400)).toBe(true);
    // Nested SDK error body shape must work too.
    expect(isReasoningToolConflict({ status: 400, error: { message: "set reasoning_effort to 'none'" } })).toBe(true);
    // An unrelated 400 must NOT trigger the retry.
    expect(isReasoningToolConflict(Object.assign(new Error('400 messages: array too long'), { status: 400 }))).toBe(false);
  });

  it('transparently retries once with reasoning_effort:"none", still sending the tools', async () => {
    const { runOpenAiCompatTurn, setOpenAiClientForTests } = await import('../src/agent/openaicompat.js');
    const { client, calls } = fakeClient((_params) =>
      calls.length === 1
        ? { on() {}, finalChatCompletion: () => Promise.reject(REASONING_400) }
        : { on() {}, finalChatCompletion: () => Promise.resolve({ choices: [{ message: { content: 'All healthy.' } }] }) },
    );
    setOpenAiClientForTests(client);
    try {
      const r = await runOpenAiCompatTurn({
        ai: openaiAI() as never,
        system: 'sys',
        history: [{ role: 'user', content: 'is my project healthy?' }],
        tools: [{ name: 'run_diagnosis', description: 'x', input_schema: { type: 'object', properties: {} } }] as unknown as Anthropic.Tool[],
        onDelta() {},
      });
      expect(calls).toHaveLength(2);
      expect(calls[0].reasoning_effort).toBeUndefined();
      expect(calls[1].reasoning_effort).toBe('none');
      expect(calls[1].tools).toBeDefined(); // tools still sent — that's the point
      expect(r.text).toBe('All healthy.');
    } finally {
      setOpenAiClientForTests(null);
    }
  });

  it('does not retry unrelated 400s — surfaces them for the loop to explain', async () => {
    const { runOpenAiCompatTurn, setOpenAiClientForTests } = await import('../src/agent/openaicompat.js');
    const otherErr = Object.assign(new Error('400 model not found'), { status: 400 });
    const { client, calls } = fakeClient(() => ({ on() {}, finalChatCompletion: () => Promise.reject(otherErr) }));
    setOpenAiClientForTests(client);
    try {
      await expect(
        runOpenAiCompatTurn({
          ai: openaiAI() as never,
          system: 'sys',
          history: [{ role: 'user', content: 'hi' }],
          tools: [] as unknown as Anthropic.Tool[],
          onDelta() {},
        }),
      ).rejects.toThrow('model not found');
      expect(calls).toHaveLength(1); // no retry
    } finally {
      setOpenAiClientForTests(null);
    }
  });
});

describe('provider-aware error wording', () => {
  it('names the active provider and its host instead of Anthropic', async () => {
    const { explainError } = await import('../src/errors.js');
    const hint = { label: 'Kimi (Moonshot)', keysUrl: 'https://platform.moonshot.ai', host: 'api.moonshot.ai' };
    const auth = explainError(
      { status: 401, message: '401', error: { type: 'error', error: { type: 'authentication_error', message: 'bad key' } } },
      hint,
    );
    expect(auth).toContain('Kimi (Moonshot) API key was rejected');
    expect(auth).toContain('platform.moonshot.ai');
    expect(auth).not.toContain('console.anthropic.com');

    const net = explainError(
      Object.assign(new Error('Connection error.'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.moonshot.ai'), { code: 'ENOTFOUND' }),
      }),
      hint,
    );
    expect(net).toContain('api.moonshot.ai');
    expect(net).not.toContain('api.anthropic.com');
  });

  it('a reasoning-model tool conflict tells the user to switch models, not "PlainOps bug"', async () => {
    const { explainError } = await import('../src/errors.js');
    const msg = explainError(
      {
        status: 400,
        message:
          "Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. " +
          "To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
      },
      { label: 'OpenAI', keysUrl: 'https://platform.openai.com/api-keys', host: 'api.openai.com' },
    );
    expect(msg.toLowerCase()).toContain('reasoning');
    expect(msg).toMatch(/switch|gpt-5\.1|different model/i);
    expect(msg).not.toContain('usually a PlainOps bug');
  });
});
