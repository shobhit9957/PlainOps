import { EventEmitter } from 'node:events';
import { scrub } from './scrub.js';

/** Single in-process event bus: agent/orchestrator → SSE clients. */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

export interface BusEvent {
  type: string;
  [key: string]: unknown;
}

/** Scrub every string in an event, preserving its shape. */
function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubDeep(v);
    return out;
  }
  return value;
}

/**
 * Every event is scrubbed HERE, at the one chokepoint every subscriber shares.
 * `deploy.log` carries raw OpenTofu and cloud-CLI output straight to the SSE
 * stream, which is exactly where SECURITY.md promises no secret value appears.
 */
export function emitBus(event: BusEvent): void {
  bus.emit('event', scrubDeep(event) as BusEvent);
}

export function onBus(listener: (e: BusEvent) => void): () => void {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}
