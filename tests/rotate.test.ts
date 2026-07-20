import { describe, it, expect } from 'vitest';
import { rotatableSecrets } from '../src/rotate.js';
import type { Project } from '../src/state.js';

const base = { name: 'shop', region: 'ap-south-1', status: 'live', createdAt: 'now' } as unknown as Project;

describe('rotatableSecrets', () => {
  it('lists the container stack\'s declared secret names', () => {
    const p = { ...base, outputs: { secret_arns: JSON.stringify({ DATABASE_URL: 'arn:1', STRIPE_KEY: 'arn:2' }) } } as Project;
    expect(rotatableSecrets(p).names.sort()).toEqual(['DATABASE_URL', 'STRIPE_KEY']);
  });
  it('explains honestly when rotation is not wired for the shape', () => {
    const micro = { ...base, outputs: { service_names: '{"gateway":"gateway"}' } } as Project;
    expect(rotatableSecrets(micro).names).toEqual([]);
    expect(rotatableSecrets(micro).reason).toMatch(/microservices/i);

    const gcp = { ...base, cloud: 'gcp', outputs: {} } as Project;
    expect(rotatableSecrets(gcp).names).toEqual([]);
    expect(rotatableSecrets(gcp).reason).toMatch(/GCP\/Azure/i);

    const empty = { ...base, outputs: {} } as Project;
    expect(rotatableSecrets(empty).reason).toMatch(/no managed secrets/i);
  });
});
