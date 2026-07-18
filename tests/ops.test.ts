import { describe, it, expect } from 'vitest';
import { previousImageTag, parsePlan, summarizeSavings } from '../src/ops.js';

describe('previousImageTag', () => {
  it('picks the second-newest v-tag by numeric order, ignoring :live and junk', () => {
    const pick = previousImageTag([
      { tag: 'live', pushedAt: '2026-07-19T10:00:00Z' },
      { tag: 'v1789000000000', pushedAt: '2026-07-19T10:00:00Z' },
      { tag: 'v1788000000000', pushedAt: '2026-07-18T10:00:00Z' },
      { tag: 'v1787000000000', pushedAt: '2026-07-17T10:00:00Z' },
      { tag: 'latest', pushedAt: '2026-07-16T10:00:00Z' },
    ]);
    expect(pick).toEqual({ current: 'v1789000000000', previous: 'v1788000000000' });
  });

  it('handles numeric ordering where string ordering would lie', () => {
    const pick = previousImageTag([
      { tag: 'v9', pushedAt: 'x' },
      { tag: 'v10', pushedAt: 'x' },
    ]);
    expect(pick).toEqual({ current: 'v10', previous: 'v9' });
  });

  it('returns null when only one build exists', () => {
    expect(previousImageTag([{ tag: 'v1', pushedAt: 'x' }, { tag: 'live', pushedAt: 'x' }])).toBeNull();
    expect(previousImageTag([])).toBeNull();
  });
});

describe('parsePlan', () => {
  it('exit 0 → no drift', () => {
    const r = parsePlan('No changes. Your infrastructure matches the configuration.', 0);
    expect(r.drift).toBe(false);
  });

  it('exit 2 → drift with summary and changed resources', () => {
    const out = [
      'OpenTofu will perform the following actions:',
      '  # aws_security_group.alb will be updated in-place',
      '  # aws_ecs_service.svc["cart"] must be replaced',
      'Plan: 1 to add, 1 to change, 1 to destroy.',
    ].join('\n');
    const r = parsePlan(out, 2);
    expect(r.drift).toBe(true);
    expect(r.summary).toBe('Plan: 1 to add, 1 to change, 1 to destroy.');
    expect(r.changes).toEqual([
      'aws_security_group.alb will be updated in-place',
      'aws_ecs_service.svc["cart"] must be replaced',
    ]);
  });
});

describe('summarizeSavings', () => {
  it('totals the lines and lists each finding', () => {
    const s = summarizeSavings([
      { item: 'Unattached EBS volume vol-1 (100 GB)', monthly: 9 },
      { item: 'Elastic IP 1.2.3.4 not attached', monthly: 3.6 },
    ]);
    expect(s).toContain('$12.6/month');
    expect(s).toContain('vol-1');
    expect(s).toContain('own approval');
  });

  it('celebrates a clean region honestly', () => {
    expect(summarizeSavings([])).toMatch(/No obvious waste/);
  });
});
