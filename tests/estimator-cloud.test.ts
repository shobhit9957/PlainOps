import { describe, it, expect } from 'vitest';
import { estimateCloud } from '../src/estimator.js';

describe('estimateCloud', () => {
  it('gcp app scale-to-zero is cheap; always-on costs real money', () => {
    const light = estimateCloud('gcp', { archetype: 'app' });
    const warm = estimateCloud('gcp', { archetype: 'app', alwaysOn: true });
    expect(light.monthly).toBeLessThan(10);
    expect(warm.monthly).toBeGreaterThan(50);
    expect(light.daily).toBeGreaterThan(0);
    expect(light.yearly).toBeCloseTo(light.monthly * 12, 1);
  });

  it('adds database and cache lines when requested', () => {
    const est = estimateCloud('gcp', { archetype: 'app', withDatabase: true, withCache: true });
    const items = est.lines.map((l) => l.item).join(' | ');
    expect(items).toMatch(/Cloud SQL/);
    expect(items).toMatch(/Memorystore/);
  });

  it('azure microservices scales with service count and includes Cosmos for Mongo', () => {
    const three = estimateCloud('azure', { archetype: 'microservices', services: 3, withDatabase: true });
    const seven = estimateCloud('azure', { archetype: 'microservices', services: 7, withDatabase: true });
    expect(seven.monthly).toBeGreaterThan(three.monthly);
    expect(three.lines.map((l) => l.item).join(' | ')).toMatch(/Cosmos DB/);
  });

  it('serverless archetypes are near-zero idle on both clouds', () => {
    expect(estimateCloud('gcp', { archetype: 'serverless' }).monthly).toBeLessThan(5);
    expect(estimateCloud('azure', { archetype: 'serverless' }).monthly).toBeLessThan(5);
  });

  it('every estimate carries the honesty disclaimer', () => {
    expect(estimateCloud('azure', { archetype: 'app' }).disclaimer).toMatch(/±20%/);
  });
});
