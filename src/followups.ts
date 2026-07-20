/**
 * Deferred agent work: "check the cert in 15 minutes and finish the job."
 *
 * The agent schedules a follow-up instead of telling the founder to come
 * back later. When it fires, the task text re-enters the normal agent loop
 * exactly like a founder message — so it can drive AWS, GCP, Azure, or
 * GitHub the same way, with every approval gate still in force.
 *
 * Persisted to <appDir>/followups.json and re-armed on app start (overdue
 * ones fire shortly after boot). Like the watchers, follow-ups only run
 * while the app is open — the tool result says so, honestly.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appDir } from './config.js';
import { auditLog } from './audit.js';
import { emitBus } from './bus.js';

export interface Followup {
  id: string;
  projectName: string;
  task: string;
  createdAt: string;
  dueAt: string;
}

export const MAX_PENDING = 20;
export const MIN_DELAY_MS = 60 * 1000; // 1 minute
export const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type Runner = (projectName: string, text: string) => Promise<void>;

let runner: Runner | null = null;
const timers = new Map<string, NodeJS.Timeout>();

function storePath(): string {
  return path.join(appDir(), 'followups.json');
}

function load(): Followup[] {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Followup[];
  } catch {
    return [];
  }
}

function save(items: Followup[]): void {
  fs.writeFileSync(storePath(), JSON.stringify(items, null, 2));
}

export function listFollowups(): Followup[] {
  return load().sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

function arm(f: Followup): void {
  const delay = Math.max(5_000, new Date(f.dueAt).getTime() - Date.now());
  clearTimeout(timers.get(f.id));
  timers.set(
    f.id,
    setTimeout(() => void fire(f.id), delay),
  );
}

async function fire(id: string): Promise<void> {
  const items = load();
  const f = items.find((x) => x.id === id);
  timers.delete(id);
  if (!f) return;
  save(items.filter((x) => x.id !== id)); // remove first — a crash must not re-fire forever
  auditLog({ type: 'followup.fired', summary: `[${f.projectName}] ${f.task.slice(0, 200)}` });
  emitBus({ type: 'followup.fired', id: f.id, projectName: f.projectName, task: f.task });
  if (!runner) return;
  try {
    await runner(
      f.projectName,
      `[Scheduled follow-up — you queued this earlier and it is due now. Complete it without waiting for the founder; use approvals where required and schedule another follow-up if something is still propagating.]\n${f.task}`,
    );
  } catch (e) {
    auditLog({ type: 'followup.error', summary: `${f.id}: ${(e as Error).message.slice(0, 300)}` });
  }
}

export function scheduleFollowup(
  projectName: string,
  task: string,
  delayMs: number,
): { ok: true; followup: Followup } | { ok: false; error: string } {
  const trimmed = task.trim();
  if (!trimmed) return { ok: false, error: 'Task text is required.' };
  if (trimmed.length > 2000) return { ok: false, error: 'Task text is too long (2000 chars max).' };
  if (delayMs < MIN_DELAY_MS || delayMs > MAX_DELAY_MS) {
    return { ok: false, error: 'Delay must be between 1 minute and 7 days.' };
  }
  const items = load();
  if (items.length >= MAX_PENDING) {
    return { ok: false, error: `Too many pending follow-ups (${MAX_PENDING} max). Cancel one first.` };
  }
  const f: Followup = {
    id: crypto.randomUUID().slice(0, 8),
    projectName,
    task: trimmed,
    createdAt: new Date().toISOString(),
    dueAt: new Date(Date.now() + delayMs).toISOString(),
  };
  items.push(f);
  save(items);
  arm(f);
  auditLog({ type: 'followup.scheduled', summary: `[${projectName}] in ${Math.round(delayMs / 60000)}m: ${trimmed.slice(0, 200)}` });
  emitBus({ type: 'followup.scheduled', id: f.id, projectName, task: trimmed, dueAt: f.dueAt });
  return { ok: true, followup: f };
}

export function cancelFollowup(id: string): boolean {
  const items = load();
  const f = items.find((x) => x.id === id);
  if (!f) return false;
  clearTimeout(timers.get(id));
  timers.delete(id);
  save(items.filter((x) => x.id !== id));
  auditLog({ type: 'followup.cancelled', summary: `[${f.projectName}] ${f.task.slice(0, 200)}` });
  emitBus({ type: 'followup.cancelled', id });
  return true;
}

/** Wire the agent runner and re-arm persisted follow-ups. Called once at app
 * start (CLI + desktop). Not called in demo mode or tests unless they opt in. */
export function initFollowups(run: Runner): void {
  runner = run;
  for (const f of load()) arm(f);
}

/** Test hook: drop timers without firing (keeps the store intact). */
export function _disarmAll(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  runner = null;
}
