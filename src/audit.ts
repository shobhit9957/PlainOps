import fs from 'node:fs';
import path from 'node:path';
import { appDir } from './config.js';
import { scrub } from './scrub.js';

export interface AuditEvent {
  type: string;
  summary: string;
  detail?: unknown;
}

function auditPath(): string {
  return path.join(appDir(), 'audit.log');
}

/** Append-only, scrubbed audit trail. The founder can always see what happened. */
export function auditLog(event: AuditEvent): void {
  const entry = {
    at: new Date().toISOString(),
    type: event.type,
    summary: scrub(event.summary),
    detail: event.detail === undefined ? undefined : JSON.parse(scrub(JSON.stringify(event.detail))),
  };
  fs.appendFileSync(auditPath(), JSON.stringify(entry) + '\n', 'utf8');
}

export function readAudit(limit = 100): Array<Record<string, unknown>> {
  try {
    const lines = fs.readFileSync(auditPath(), 'utf8').trim().split('\n');
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
