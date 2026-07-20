import type Anthropic from '@anthropic-ai/sdk';
import { getClient } from './client.js';
import { getProject } from '../state.js';
import { loadConfig } from '../config.js';
import { systemPrompt } from './prompt.js';
import { TOOL_DEFINITIONS, dispatchTool, type ToolContext } from './tools.js';
import { scrub } from '../scrub.js';
import { explainError } from '../errors.js';
import { activeAI, aiErrorHint } from './providers.js';
import { runOpenAiCompatTurn } from './openaicompat.js';
import { auditLog } from '../audit.js';
import { emitBus } from '../bus.js';

// Per-project conversation history, kept in memory for the session.
const histories = new Map<string, Anthropic.MessageParam[]>();
// Per-project message queue + active flag. Turns are processed ONE AT A TIME
// per project so a follow-up sent mid-deploy is queued (not spliced between a
// tool_use and its tool_result, which corrupts the conversation).
interface QueuedMessage {
  text: string;
  images?: InboundImage[];
  ctx?: Partial<ToolContext>;
  resolve: () => void;
}
const queues = new Map<string, QueuedMessage[]>();
const active = new Set<string>();

export function resetHistory(projectName: string): void {
  histories.delete(projectName);
}

export function isProjectBusy(projectName: string): boolean {
  return active.has(projectName);
}

const MAX_TURNS = 12;

export interface InboundImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string; // base64, no data-URL prefix
}

function buildUserContent(text: string, images?: InboundImage[]): string | Anthropic.ContentBlockParam[] {
  if (!images || images.length === 0) return scrub(text);
  const blocks: Anthropic.ContentBlockParam[] = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
  }));
  if (text.trim()) blocks.push({ type: 'text', text: scrub(text) });
  return blocks;
}

/**
 * Public entry point. Queues a message for the project and returns a promise
 * that resolves once THAT message has been fully processed. Messages for the
 * same project are processed strictly in order, one at a time — a follow-up
 * sent while a deploy is running waits its turn instead of breaking the loop.
 */
export function runTurn(
  projectName: string,
  userText: string,
  images?: InboundImage[],
  ctx?: Partial<ToolContext>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const q = queues.get(projectName) ?? [];
    q.push({ text: userText, images, ctx, resolve });
    queues.set(projectName, q);
    if (active.has(projectName)) {
      // Something is already running for this project — acknowledge the queue.
      emitBus({ type: 'chat.queued', projectName, depth: q.length });
      return;
    }
    void processProject(projectName);
  });
}

async function processProject(projectName: string): Promise<void> {
  active.add(projectName);
  emitBus({ type: 'chat.busy', projectName });
  try {
    for (;;) {
      const q = queues.get(projectName) ?? [];
      const next = q.shift();
      queues.set(projectName, q);
      if (!next) break;
      try {
        await processOneMessage(projectName, next.text, next.images, next.ctx);
      } catch (e) {
        emitBus({ type: 'chat.message', projectName, text: scrub(explainError(e, aiErrorHint(loadConfig()))) });
      } finally {
        next.resolve();
      }
    }
  } finally {
    active.delete(projectName);
    emitBus({ type: 'chat.idle', projectName });
  }
}

/** Drive one user message through the model + tool loop to completion. */
async function processOneMessage(
  projectName: string,
  userText: string,
  images?: InboundImage[],
  ctx?: Partial<ToolContext>,
): Promise<void> {
  const project = getProject(projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  const cfg = loadConfig();
  const ai = activeAI(cfg);

  const history = histories.get(projectName) ?? [];
  history.push({ role: 'user', content: buildUserContent(userText, images) });
  histories.set(projectName, history);
  auditLog({ type: 'chat.user', summary: userText + (images?.length ? ` [+${images.length} image(s)]` : '') });

  const toolCtx: ToolContext = { projectName, ...ctx };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const system = systemPrompt(getProject(projectName) ?? project);
    let assistantText: string;
    let toolUses: Array<{ id: string; name: string; input: unknown }>;
    let stoppedForTools: boolean;

    if (ai.provider.kind === 'anthropic') {
      const client = getClient();
      const stream = client.messages.stream({
        model: ai.model,
        max_tokens: 16000,
        system,
        tools: TOOL_DEFINITIONS,
        messages: history,
      });

      stream.on('text', (delta: string) => {
        emitBus({ type: 'chat.delta', projectName, text: scrub(delta) });
      });

      const message = await stream.finalMessage();
      history.push({ role: 'assistant', content: message.content });

      assistantText = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      stoppedForTools = message.stop_reason === 'tool_use';
      toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    } else {
      // Every non-Anthropic provider speaks the OpenAI-compatible protocol.
      const r = await runOpenAiCompatTurn({
        ai,
        system,
        history,
        tools: TOOL_DEFINITIONS,
        onDelta: (delta) => emitBus({ type: 'chat.delta', projectName, text: scrub(delta) }),
      });
      history.push({ role: 'assistant', content: r.assistantBlocks });
      assistantText = r.text;
      toolUses = r.toolUses;
      stoppedForTools = r.stoppedForTools;
    }

    if (assistantText) {
      emitBus({ type: 'chat.message', projectName, text: scrub(assistantText) });
      auditLog({ type: 'chat.assistant', summary: assistantText });
    }

    if (!stoppedForTools) {
      emitBus({ type: 'chat.done', projectName });
      return;
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      emitBus({ type: 'chat.tool', projectName, tool: use.name });
      auditLog({ type: 'tool.call', summary: `${use.name}`, detail: use.input });
      let resultText: string;
      try {
        resultText = await dispatchTool(use.name, (use.input ?? {}) as Record<string, unknown>, toolCtx);
      } catch (e) {
        resultText = `Tool error: ${scrub((e as Error).message)}`;
      }
      results.push({ type: 'tool_result', tool_use_id: use.id, content: resultText });
    }
    history.push({ role: 'user', content: results });
  }

  emitBus({ type: 'chat.message', projectName, text: 'I hit my step limit for this turn. Tell me to continue if there is more to do.' });
  emitBus({ type: 'chat.done', projectName });
}
