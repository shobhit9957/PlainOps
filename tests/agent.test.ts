import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-agent-'));
  process.env.PLAINOPS_GATE_TIMEOUT_MS = '500';
});

describe('approval gate', () => {
  it('approve resolves to approved; reject to rejected', async () => {
    const { requestApproval, resolveApproval, listPendingActions } = await import('../src/gate.js');
    const p = requestApproval({ type: 'provision', projectName: 'x', summary: 'do it' });
    const pending = listPendingActions();
    expect(pending).toHaveLength(1);
    resolveApproval(pending[0].id, 'approved');
    expect(await p).toBe('approved');
  });

  it('auto-rejects after timeout', async () => {
    const { requestApproval } = await import('../src/gate.js');
    const verdict = await requestApproval({ type: 'deploy', projectName: 'x', summary: 'ship' });
    expect(verdict).toBe('rejected');
  });

  it('serializes actions with the lock', async () => {
    const { withActionLock } = await import('../src/gate.js');
    const order: number[] = [];
    const a = withActionLock(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });
    const b = withActionLock(async () => {
      order.push(2);
    });
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2]);
  });
});

describe('gated tool without approval', () => {
  it('does not call the orchestrator when the founder rejects', async () => {
    const { upsertProject } = await import('../src/state.js');
    upsertProject({
      name: 'demo',
      repoPath: path.join(process.cwd(), 'examples', 'sample-app'),
      region: 'us-east-1',
      status: 'new',
      createdAt: new Date().toISOString(),
      blueprint: {
        projectName: 'demo', region: 'us-east-1', cpu: 256, memoryMb: 512, desiredCount: 1, maxCount: 4,
        withDatabase: false, healthPath: '/health', containerPort: 3000, appSecrets: [], budgetMonthlyUsd: 60,
      },
    });
    const orchestrator = await import('../src/orchestrator.js');
    const spy = vi.spyOn(orchestrator, 'provision');
    const { dispatchTool } = await import('../src/agent/tools.js');
    // Gate times out → rejected → orchestrator never runs.
    const result = await dispatchTool('provision_infrastructure', {}, { projectName: 'demo' });
    expect(result).toMatch(/did not approve/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('simple, no-ceremony behavior', () => {
  it('analyze_repo with a path attaches the code to the project (no re-setup)', async () => {
    const { upsertProject, getProject } = await import('../src/state.js');
    upsertProject({ name: 'p1', region: 'ap-south-1', status: 'new', createdAt: new Date().toISOString() });
    expect(getProject('p1')?.repoPath).toBeUndefined();
    const { dispatchTool } = await import('../src/agent/tools.js');
    const staticSite = path.join(process.cwd(), 'examples', 'static-site');
    const res = await dispatchTool('analyze_repo', { path: staticSite }, { projectName: 'p1' });
    expect(res).toContain('"framework": "static"');
    // The path is now attached — the founder never re-set-up anything.
    expect(getProject('p1')?.repoPath).toBe(staticSite);
  });

  it('scaffold_app writes files and makes the project deployable', async () => {
    const { upsertProject, getProject } = await import('../src/state.js');
    upsertProject({ name: 'p2', region: 'ap-south-1', status: 'new', createdAt: new Date().toISOString() });
    const { dispatchTool } = await import('../src/agent/tools.js');
    const res = await dispatchTool(
      'scaffold_app',
      { files: [{ path: 'index.html', content: '<h1>Coffee shop</h1>' }] },
      { projectName: 'p2' },
    );
    expect(res).toContain('filesWritten');
    const ws = getProject('p2')?.repoPath;
    expect(ws).toBeTruthy();
    const fsMod = await import('node:fs');
    expect(fsMod.existsSync(path.join(ws!, 'index.html'))).toBe(true);
    // Path-escape guard.
    const bad = await dispatchTool('scaffold_app', { files: [{ path: '../evil.txt', content: 'x' }] }, { projectName: 'p2' });
    expect(bad).toMatch(/Refusing to write outside/);
  });

  it('analyze_repo without a path or code guides the founder instead of erroring hard', async () => {
    const { upsertProject } = await import('../src/state.js');
    upsertProject({ name: 'p3', region: 'ap-south-1', status: 'new', createdAt: new Date().toISOString() });
    const { dispatchTool } = await import('../src/agent/tools.js');
    const res = await dispatchTool('analyze_repo', {}, { projectName: 'p3' });
    expect(res).toMatch(/scaffold_app|path/);
  });
});

describe('aws_cli general tool', () => {
  it('runs read-only commands without approval and gates mutations', async () => {
    process.env.PLAINOPS_GATE_TIMEOUT_MS = '400';
    const { upsertProject } = await import('../src/state.js');
    upsertProject({ name: 'awsp', region: 'ap-south-1', status: 'new', createdAt: new Date().toISOString() });
    const { dispatchTool } = await import('../src/agent/tools.js');

    // A denied (secret-exposing) command is refused outright.
    const denied = await dispatchTool(
      'aws_cli',
      { args: ['secretsmanager', 'get-secret-value', '--secret-id', 'x'] },
      { projectName: 'awsp' },
    );
    expect(denied).toMatch(/won't run|security/i);

    // A mutation with no approval (gate times out) must not execute.
    const mutate = await dispatchTool(
      'aws_cli',
      { args: ['ec2', 'stop-instances', '--instance-ids', 'i-000'], reason: 'test' },
      { projectName: 'awsp' },
    );
    expect(mutate).toMatch(/did not approve/i);
  });
});

describe('turn serialization (the mid-deploy crash fix)', () => {
  it('queues a concurrent message instead of corrupting the conversation', async () => {
    const { upsertProject } = await import('../src/state.js');
    upsertProject({ name: 'q', region: 'ap-south-1', status: 'new', createdAt: new Date().toISOString() });

    const historyLengthsSeen: number[] = [];
    const fakeClient = {
      messages: {
        stream(params: { messages: unknown[] }) {
          historyLengthsSeen.push(params.messages.length);
          return {
            on() {},
            finalMessage: async () => {
              await new Promise((r) => setTimeout(r, 25)); // simulate model latency
              return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
            },
          };
        },
      },
    };
    const { setClientForTests } = await import('../src/agent/client.js');
    setClientForTests(fakeClient);

    const { runTurn, isProjectBusy } = await import('../src/agent/loop.js');
    const p1 = runTurn('q', 'first message');
    const p2 = runTurn('q', 'second message (sent while first is in flight)');
    // The second is queued behind the first, not run concurrently.
    expect(isProjectBusy('q')).toBe(true);
    await Promise.all([p1, p2]);
    expect(isProjectBusy('q')).toBe(false);

    // Serialized: first turn saw [user]; second turn saw [user, assistant, user] = 3.
    // If they had raced, the second would have seen a corrupted/short history.
    expect(historyLengthsSeen[0]).toBe(1);
    expect(historyLengthsSeen[1]).toBe(3);
  });
});

describe('runTurn tool loop', () => {
  it('drives a scripted tool_use → tool_result → end_turn and scrubs secrets', async () => {
    const { setSecret } = await import('../src/vault.js');
    setSecret('STRIPE_KEY', 'sk_live_super_secret_value');

    const { upsertProject } = await import('../src/state.js');
    upsertProject({
      name: 'demo',
      repoPath: path.join(process.cwd(), 'examples', 'sample-app'),
      region: 'us-east-1',
      status: 'new',
      createdAt: new Date().toISOString(),
    });

    // Fake Anthropic client: first response calls analyze_repo, second ends the turn.
    let call = 0;
    const fakeClient = {
      messages: {
        stream(_params: unknown) {
          call += 1;
          const isFirst = call === 1;
          const finalMessage =
            isFirst
              ? {
                  stop_reason: 'tool_use',
                  content: [
                    { type: 'text', text: 'Let me look at your code.' },
                    { type: 'tool_use', id: 'tu_1', name: 'analyze_repo', input: {} },
                  ],
                }
              : {
                  stop_reason: 'end_turn',
                  content: [{ type: 'text', text: 'Your app uses the key sk_live_super_secret_value internally.' }],
                };
          return {
            on() {
              /* no text streaming in test */
            },
            finalMessage: async () => finalMessage,
          };
        },
      },
    };
    const { setClientForTests } = await import('../src/agent/client.js');
    setClientForTests(fakeClient);

    const { onBus } = await import('../src/bus.js');
    const messages: string[] = [];
    const off = onBus((e) => {
      if (e.type === 'chat.message') messages.push(String(e.text));
    });

    const { runTurn } = await import('../src/agent/loop.js');
    await runTurn('demo', 'Deploy my app');
    off();

    // analyze_repo ran (framework detection appears nowhere user-facing, but the loop completed with 2 calls)
    expect(call).toBe(2);
    // The secret value must be scrubbed out of the assistant message.
    const joined = messages.join('\n');
    expect(joined).not.toContain('sk_live_super_secret_value');
    expect(joined).toContain('{{secret:STRIPE_KEY}}');
  });
});
