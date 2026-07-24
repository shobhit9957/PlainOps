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

// Invariant 4: never claim "live" without an HTTP check. Every other deploy path
// gates on validateLive; deployStatic used to mark status:'live' unconditionally,
// so a bucket that 404s (missing index.html, policy not yet effective) still
// handed the founder a URL described as live.
describe('deployStatic never claims live without an HTTP check', () => {
  it('probes the site URL and marks the project live on a 200', async () => {
    const { deployStatic } = await import('../src/orchestrator.js');
    const { upsertProject, getProject } = await import('../src/state.js');
    upsertProject({ name: 'site', region: 'ap-south-1', status: 'new', createdAt: new Date().toISOString() });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-site-ok-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');

    const healthFetch = vi.fn(async () => 200);
    const url = await deployStatic('site', dir, () => {}, {
      whoAmI: async () => ({ accountId: '123', arn: 'arn:aws:iam::123:user/x' }),
      deployStaticSite: async () => ({ bucket: 'b', url: 'http://b.s3-website.ap-south-1.amazonaws.com', fileCount: 1 }),
      healthFetch,
    } as never);

    expect(healthFetch).toHaveBeenCalledWith('http://b.s3-website.ap-south-1.amazonaws.com');
    expect(url).toBe('http://b.s3-website.ap-south-1.amazonaws.com');
    expect(getProject('site')?.status).toBe('live');
  });

  it('refuses to mark live when the site never serves a good status', async () => {
    const { deployStatic } = await import('../src/orchestrator.js');
    const { upsertProject, getProject } = await import('../src/state.js');
    upsertProject({ name: 'bad', region: 'ap-south-1', status: 'new', createdAt: new Date().toISOString() });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-site-bad-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');

    await expect(
      deployStatic('bad', dir, () => {}, {
        whoAmI: async () => ({ accountId: '123', arn: 'arn:aws:iam::123:user/x' }),
        deployStaticSite: async () => ({ bucket: 'b', url: 'http://b.s3-website.ap-south-1.amazonaws.com', fileCount: 1 }),
        healthFetch: async () => 404,
      } as never, 2, 1),
    ).rejects.toThrow(/404/);

    expect(getProject('bad')?.status).not.toBe('live');
  });
});
