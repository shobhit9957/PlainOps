import crypto from 'node:crypto';
import { emitBus } from './bus.js';
import { auditLog } from './audit.js';
import { listSecretNames } from './vault.js';

/**
 * Human-approval gate. Mutating actions BLOCK here until the founder clicks
 * Approve/Reject in the dashboard. The model cannot bypass this — approval is
 * an HTTP code path, not a prompt convention.
 */

export type ActionType = 'provision' | 'deploy' | 'destroy' | 'action';
export type Verdict = 'approved' | 'rejected';

export interface PendingAction {
  id: string;
  type: ActionType;
  projectName: string;
  summary: string;
  costText?: string;
  createdAt: string;
}

const TIMEOUT_MS = Number(process.env.PLAINOPS_GATE_TIMEOUT_MS ?? 15 * 60 * 1000);

const pendingActions = new Map<string, { action: PendingAction; resolve: (v: Verdict) => void }>();
const pendingSecrets = new Map<string, { projectName: string; name: string; resolve: (ok: boolean) => void }>();

export function listPendingActions(): PendingAction[] {
  return [...pendingActions.values()].map((p) => p.action);
}

export function requestApproval(input: Omit<PendingAction, 'id' | 'createdAt'>): Promise<Verdict> {
  const action: PendingAction = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  auditLog({ type: 'approval.requested', summary: `${action.type}: ${action.summary}` });
  return new Promise<Verdict>((resolve) => {
    const timer = setTimeout(() => {
      if (pendingActions.delete(action.id)) {
        auditLog({ type: 'approval.timeout', summary: `${action.type} auto-rejected after timeout` });
        emitBus({ type: 'action.update', id: action.id, verdict: 'rejected', reason: 'timeout' });
        resolve('rejected');
      }
    }, TIMEOUT_MS);
    pendingActions.set(action.id, {
      action,
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
    });
    emitBus({ type: 'action.pending', action });
  });
}

export function resolveApproval(id: string, verdict: Verdict): boolean {
  const entry = pendingActions.get(id);
  if (!entry) return false;
  pendingActions.delete(id);
  auditLog({ type: `approval.${verdict}`, summary: `${entry.action.type}: ${entry.action.summary}` });
  emitBus({ type: 'action.update', id, verdict });
  entry.resolve(verdict);
  return true;
}

/** Ask the dashboard for a secret VALUE (secure modal). The value never passes through here — the server route stores it (vault + AWS) and then resolves this promise with success/failure only. */
export function requestSecretValue(projectName: string, name: string): Promise<boolean> {
  const id = crypto.randomUUID();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (pendingSecrets.delete(id)) resolve(false);
    }, TIMEOUT_MS);
    pendingSecrets.set(id, {
      projectName,
      name,
      resolve: (ok) => {
        clearTimeout(timer);
        resolve(ok);
      },
    });
    // `exists` lets the dashboard say "saving replaces the stored value" —
    // updating a secret is a normal flow, never a reason to skip the form.
    emitBus({ type: 'secret.request', id, projectName, name, exists: listSecretNames().includes(name) });
  });
}

export function resolveSecretPrompt(id: string, ok: boolean): { projectName: string; name: string } | null {
  const entry = pendingSecrets.get(id);
  if (!entry) return null;
  pendingSecrets.delete(id);
  entry.resolve(ok);
  return { projectName: entry.projectName, name: entry.name };
}

/** The secret NAME a pending prompt is waiting on, without resolving it. */
export function pendingSecretName(id: string): string | null {
  return pendingSecrets.get(id)?.name ?? null;
}

/** One mutating pipeline at a time — concurrent applies corrupt state. */
let actionLock: Promise<unknown> = Promise.resolve();
let lockBusy = false;

export function isActionLocked(): boolean {
  return lockBusy;
}

export function withActionLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = actionLock.then(async () => {
    lockBusy = true;
    try {
      return await fn();
    } finally {
      lockBusy = false;
    }
  });
  actionLock = run.catch(() => {});
  return run;
}
