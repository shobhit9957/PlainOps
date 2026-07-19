// Auto-approver for tool-layer gauntlet runs. Simulates the founder's
// dashboard click at the EXACT seam the HTTP route uses (resolveApproval),
// so approval plumbing is exercised for real. Every card is logged first so
// the transcript records what the founder would have been asked.
import { onBus } from '../../src/bus.ts';
import { resolveApproval, type PendingAction } from '../../src/gate.ts';
import { log } from './common.ts';

export function autoApprove(): () => void {
  return onBus((e) => {
    if (e.type !== 'action.pending') return;
    const a = (e as unknown as { action: PendingAction }).action;
    log(`[APPROVAL CARD → auto-approve] (${a.type}) ${a.summary}${a.costText ? `\n  cost: ${a.costText}` : ''}`);
    setTimeout(() => resolveApproval(a.id, 'approved'), 25);
  });
}
