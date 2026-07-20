/**
 * OpenAI-compatible Chat Completions driver. One implementation covers every
 * provider that speaks the de-facto standard protocol (OpenAI, OpenRouter,
 * Kimi/Moonshot, DeepSeek, Groq, xAI, Gemini's compat endpoint, Ollama,
 * custom endpoints).
 *
 * The agent loop keeps its history in Anthropic block format — this module
 * converts outbound (history/tools → OpenAI shape) and inbound (completion →
 * Anthropic-shaped blocks) so loop.ts stays single-track. Scrubbing and
 * approvals live in the loop/tools layers and are protocol-independent.
 */
import OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import type { ActiveAI } from './providers.js';

let testClient: OpenAI | null = null;

/** Tests inject a fake client here. */
export function setOpenAiClientForTests(client: unknown): void {
  testClient = client as OpenAI;
}

function getOpenAiClient(ai: ActiveAI): OpenAI {
  if (testClient) return testClient;
  return new OpenAI({
    // Keyless local runtimes (Ollama) still need a non-empty string.
    apiKey: ai.apiKey || 'plainops-local',
    baseURL: ai.baseUrl,
  });
}

// ------------------------------------------------------------- conversions

type OaMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type OaTool = OpenAI.Chat.Completions.ChatCompletionTool;

export function toOpenAiTools(tools: Anthropic.Tool[]): OaTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? (b as { text: string }).text : ''))
      .join('');
  }
  return '';
}

/** Convert Anthropic-format history into OpenAI chat messages. */
export function toOpenAiMessages(system: string, history: Anthropic.MessageParam[]): OaMessage[] {
  const out: OaMessage[] = [{ role: 'system', content: system }];

  for (const msg of history) {
    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'assistant', content: msg.content });
        continue;
      }
      const text = msg.content
        .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolCalls = msg.content
        .filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // User message: tool_results become role:"tool" messages (they must
    // directly follow the assistant's tool_calls); text/images stay a user turn.
    if (typeof msg.content === 'string') {
      out.push({ role: 'user', content: msg.content });
      continue;
    }
    const rest: Array<OpenAI.Chat.Completions.ChatCompletionContentPart> = [];
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: blockText(block.content) || '(no output)',
        });
      } else if (block.type === 'text') {
        rest.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && block.source.type === 'base64') {
        rest.push({
          type: 'image_url',
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
        });
      }
    }
    if (rest.length) {
      const onlyText = rest.every((p) => p.type === 'text');
      out.push({
        role: 'user',
        content: onlyText ? rest.map((p) => (p as { text: string }).text).join('') : rest,
      });
    }
  }
  return out;
}

export interface CompatToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface CompatTurn {
  text: string;
  toolUses: CompatToolUse[];
  /** Anthropic-shaped blocks to append to the shared history. */
  assistantBlocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam>;
  stoppedForTools: boolean;
}

/** Map a finished OpenAI completion message back into the loop's shape. */
export function fromOpenAiMessage(message: {
  content?: string | null;
  tool_calls?: Array<{ id: string; type?: string; function?: { name: string; arguments: string } }> | null;
}): CompatTurn {
  const text = message.content ?? '';
  const toolUses: CompatToolUse[] = [];
  for (const call of message.tool_calls ?? []) {
    if (call.type && call.type !== 'function') continue;
    if (!call.function) continue;
    let input: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(call.function.arguments || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
    } catch {
      // Malformed arguments from a weaker model — dispatch with empty input;
      // the tool's own validation reports what's missing.
    }
    toolUses.push({ id: call.id, name: call.function.name, input });
  }
  const assistantBlocks: CompatTurn['assistantBlocks'] = [];
  if (text) assistantBlocks.push({ type: 'text', text });
  for (const u of toolUses) assistantBlocks.push({ type: 'tool_use', id: u.id, name: u.name, input: u.input });
  return { text, toolUses, assistantBlocks, stoppedForTools: toolUses.length > 0 };
}

// ------------------------------------------------------------------ runner

export async function runOpenAiCompatTurn(opts: {
  ai: ActiveAI;
  system: string;
  history: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  onDelta: (text: string) => void;
}): Promise<CompatTurn> {
  const client = getOpenAiClient(opts.ai);
  const tokenLimit =
    opts.ai.provider.tokenParam === 'max_completion_tokens'
      ? { max_completion_tokens: 16000 }
      : { max_tokens: 16000 };

  const stream = client.chat.completions.stream({
    model: opts.ai.model,
    messages: toOpenAiMessages(opts.system, opts.history),
    tools: toOpenAiTools(opts.tools),
    ...tokenLimit,
  });
  stream.on('content', (delta: string) => {
    if (delta) opts.onDelta(delta);
  });
  const completion = await stream.finalChatCompletion();
  const message = completion.choices[0]?.message;
  if (!message) throw new Error(`${opts.ai.provider.label} returned no choices — check the model name in Settings.`);
  return fromOpenAiMessage(message);
}
