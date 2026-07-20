import { describe, it, expect } from 'vitest';
import { summarizeFindings, type Finding } from '../src/security.js';

describe('summarizeFindings', () => {
  it('reports a clean region honestly, without overclaiming completeness', () => {
    const s = summarizeFindings([], 'ap-south-1');
    expect(s).toMatch(/no critical exposures/i);
    expect(s).toMatch(/not a full compliance audit/i);
  });

  it('ranks critical before high before medium and counts them', () => {
    const findings: Finding[] = [
      { severity: 'medium', resource: 'IAM user bob', issue: 'old key', fix: 'rotate' },
      { severity: 'critical', resource: 'SG sg-1', issue: 'SSH open to world', fix: 'restrict' },
      { severity: 'high', resource: 'RDS db-1', issue: 'unencrypted', fix: 'encrypt' },
      { severity: 'critical', resource: 'S3 leaky', issue: 'public', fix: 'block' },
    ];
    const s = summarizeFindings(findings, 'us-east-1');
    expect(s).toContain('2 critical, 1 high, 1 medium');
    const order = ['SG sg-1', 'S3 leaky', 'RDS db-1', 'IAM user bob'].map((r) => s.indexOf(r));
    expect(order[0]).toBeLessThan(order[2]); // criticals before the high
    expect(order[2]).toBeLessThan(order[3]); // high before the medium
    expect(s).toContain('normal approval');
  });

  it('includes the fix line for every finding', () => {
    const s = summarizeFindings([{ severity: 'critical', resource: 'r', issue: 'i', fix: 'do the thing' }], 'r1');
    expect(s).toContain('Fix: do the thing');
  });
});
