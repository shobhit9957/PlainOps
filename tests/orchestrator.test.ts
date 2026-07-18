import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-orch-'));
});

describe('ensureProjectSetup', () => {
  it('re-ensures the bootstrap bucket even when the project already records one', async () => {
    // Regression: the bootstrap bucket holds the source zip CodeBuild reads. It
    // can be deleted out-of-band (a stray cleanup, an account sweep). If setup
    // trusts the cached bootstrapBucket and skips ensureBootstrapBucket, the next
    // provision renders a CodeBuild project pointing at a dead bucket and fails
    // with "Bucket ... does not exist". Setup must self-heal by (idempotently)
    // ensuring the bucket every time.
    const { ensureProjectSetup } = await import('../src/orchestrator.js');
    const { upsertProject, getProject } = await import('../src/state.js');

    upsertProject({
      name: 'p',
      region: 'ap-south-1',
      status: 'destroyed',
      createdAt: new Date().toISOString(),
      accountId: '123',
      bootstrapBucket: 'plainops-123-ap-south-1',
    });

    const ensureBootstrapBucket = vi.fn(async () => 'plainops-123-ap-south-1');
    const whoAmI = vi.fn(async () => ({ accountId: '123', arn: 'arn:aws:iam::123:user/x' }));

    await ensureProjectSetup('p', { ensureBootstrapBucket, whoAmI } as never);

    expect(ensureBootstrapBucket).toHaveBeenCalledWith('ap-south-1', '123');
    // Cached accountId means we should not need an extra STS round-trip.
    expect(whoAmI).not.toHaveBeenCalled();
    expect(getProject('p')?.bootstrapBucket).toBe('plainops-123-ap-south-1');
  });

  it('resolves the account and creates the bucket on a first-time project', async () => {
    const { ensureProjectSetup } = await import('../src/orchestrator.js');
    const { upsertProject } = await import('../src/state.js');

    upsertProject({
      name: 'fresh',
      region: 'us-east-1',
      status: 'new',
      createdAt: new Date().toISOString(),
    });

    const ensureBootstrapBucket = vi.fn(async () => 'plainops-999-us-east-1');
    const whoAmI = vi.fn(async () => ({ accountId: '999', arn: 'arn:aws:iam::999:user/x' }));

    const result = await ensureProjectSetup('fresh', { ensureBootstrapBucket, whoAmI } as never);

    expect(whoAmI).toHaveBeenCalledWith('us-east-1');
    expect(ensureBootstrapBucket).toHaveBeenCalledWith('us-east-1', '999');
    expect(result.accountId).toBe('999');
    expect(result.bootstrapBucket).toBe('plainops-999-us-east-1');
  });
});
