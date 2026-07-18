import { describe, expect, it } from 'vitest';
import { estimate, type BlueprintParams } from '../src/estimator.js';

const base: BlueprintParams = {
  projectName: 'demo',
  region: 'us-east-1',
  cpu: 256,
  memoryMb: 512,
  desiredCount: 1,
  maxCount: 4,
  withDatabase: false,
  healthPath: '/health',
  containerPort: 3000,
  appSecrets: [],
  budgetMonthlyUsd: 60,
};

describe('estimator', () => {
  it('prices the base no-database stack in a sane range', () => {
    const e = estimate(base);
    expect(e.monthly).toBeGreaterThan(28);
    expect(e.monthly).toBeLessThan(38);
  });

  it('database adds roughly $14/mo', () => {
    const withDb = estimate({ ...base, withDatabase: true });
    const without = estimate(base);
    const delta = withDb.monthly - without.monthly;
    expect(delta).toBeGreaterThan(10);
    expect(delta).toBeLessThan(18);
  });

  it('lines sum to the monthly total', () => {
    const e = estimate({ ...base, withDatabase: true, appSecrets: ['A_KEY', 'B_KEY'] });
    const sum = e.lines.reduce((s, l) => s + l.monthly, 0);
    expect(Math.abs(sum - e.monthly)).toBeLessThan(0.02);
  });

  it('daily and yearly derive from monthly', () => {
    const e = estimate(base);
    expect(e.daily).toBeCloseTo(e.monthly / (730 / 24), 1);
    expect(e.yearly).toBeCloseTo(e.monthly * 12, 1);
  });

  it('secrets are billed per secret', () => {
    const e = estimate({ ...base, appSecrets: ['ONE_KEY', 'TWO_KEY', 'THREE_KEY'] });
    const line = e.lines.find((l) => l.item.includes('Secrets Manager'));
    expect(line?.monthly).toBeCloseTo(1.2, 2);
  });

  it('ap-south-1 pricing is present and slightly higher', () => {
    const us = estimate(base);
    const ap = estimate({ ...base, region: 'ap-south-1' });
    expect(ap.monthly).toBeGreaterThan(us.monthly);
    expect(ap.monthly).toBeLessThan(us.monthly * 1.2);
  });
});
