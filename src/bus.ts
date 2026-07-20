import { EventEmitter } from 'node:events';

/** Single in-process event bus: agent/orchestrator → SSE clients. */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

export interface BusEvent {
  type: string;
  [key: string]: unknown;
}

export function emitBus(event: BusEvent): void {
  bus.emit('event', event);
}

export function onBus(listener: (e: BusEvent) => void): () => void {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}
