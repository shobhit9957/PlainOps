import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, CreateBucketCommand, PutBucketVersioningCommand, PutPublicAccessBlockCommand } from '@aws-sdk/client-s3';
import { CodeBuildClient, BatchGetBuildsCommand, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { ECSClient, DescribeServicesCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import {
  ensureBootstrapBucket,
  getDailyCosts,
  startImageBuild,
  waitForBuild,
  waitServiceStable,
  redeployService,
  zipRepo,
} from '../src/aws.js';

const s3Mock = mockClient(S3Client);
const cbMock = mockClient(CodeBuildClient);
const ecsMock = mockClient(ECSClient);
const ceMock = mockClient(CostExplorerClient);

beforeEach(() => {
  s3Mock.reset();
  cbMock.reset();
  ecsMock.reset();
  ceMock.reset();
});

describe('ensureBootstrapBucket', () => {
  it('creates, locks down, and versions the bucket', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutPublicAccessBlockCommand).resolves({});
    s3Mock.on(PutBucketVersioningCommand).resolves({});
    const name = await ensureBootstrapBucket('us-east-1', '123456789012');
    expect(name).toBe('plainops-123456789012-us-east-1');
    expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(1);
  });

  it('is idempotent when the bucket already exists', async () => {
    const err = new Error('exists');
    err.name = 'BucketAlreadyOwnedByYou';
    s3Mock.on(CreateBucketCommand).rejects(err);
    s3Mock.on(PutPublicAccessBlockCommand).resolves({});
    s3Mock.on(PutBucketVersioningCommand).resolves({});
    await expect(ensureBootstrapBucket('us-east-1', '123456789012')).resolves.toBeTruthy();
  });
});

describe('image builds', () => {
  it('startImageBuild passes the tag and returns the id', async () => {
    cbMock.on(StartBuildCommand).resolves({ build: { id: 'b-1' } });
    const id = await startImageBuild('us-east-1', 'po-demo', 'v123');
    expect(id).toBe('b-1');
    const call = cbMock.commandCalls(StartBuildCommand)[0].args[0].input;
    expect(call.environmentVariablesOverride?.[0]).toMatchObject({ name: 'IMAGE_TAG', value: 'v123' });
  });

  it('waitForBuild resolves on success and reports phases', async () => {
    cbMock
      .on(BatchGetBuildsCommand)
      .resolvesOnce({ builds: [{ id: 'b-1', currentPhase: 'BUILD', buildStatus: 'IN_PROGRESS' }] })
      .resolvesOnce({ builds: [{ id: 'b-1', currentPhase: 'COMPLETED', buildStatus: 'SUCCEEDED' }] });
    const events: string[] = [];
    await waitForBuild('us-east-1', 'b-1', (e) => events.push(e), 5000, 10);
    expect(events).toContain('Image build: BUILD');
  });

  it('waitForBuild throws with status on failure', async () => {
    cbMock.on(BatchGetBuildsCommand).resolves({
      builds: [{ id: 'b-1', currentPhase: 'COMPLETED', buildStatus: 'FAILED' }],
    });
    await expect(waitForBuild('us-east-1', 'b-1', () => {}, 5000, 10)).rejects.toThrow(/FAILED/);
  });
});

describe('service stability', () => {
  it('redeployService forces a new deployment', async () => {
    ecsMock.on(UpdateServiceCommand).resolves({});
    await redeployService('us-east-1', 'c', 's');
    expect(ecsMock.commandCalls(UpdateServiceCommand)[0].args[0].input.forceNewDeployment).toBe(true);
  });

  it('waitServiceStable resolves when a single primary deployment is running', async () => {
    ecsMock
      .on(DescribeServicesCommand)
      .resolvesOnce({
        services: [{
          deployments: [{ status: 'PRIMARY' }, { status: 'ACTIVE' }],
          runningCount: 0,
          desiredCount: 1,
          events: [{ id: 'e1', message: 'starting task' }],
        }],
      })
      .resolvesOnce({
        services: [{
          deployments: [{ status: 'PRIMARY' }],
          runningCount: 1,
          desiredCount: 1,
          events: [],
        }],
      });
    const events: string[] = [];
    await waitServiceStable('us-east-1', 'c', 's', (e) => events.push(e), 5000, 10);
    expect(events).toContain('starting task');
  });
});

describe('getDailyCosts', () => {
  it('maps results and degrades to [] on error', async () => {
    ceMock.on(GetCostAndUsageCommand).resolves({
      ResultsByTime: [
        { TimePeriod: { Start: '2026-07-15', End: '2026-07-16' }, Total: { UnblendedCost: { Amount: '1.2345', Unit: 'USD' } } },
      ],
    });
    expect(await getDailyCosts('demo')).toEqual([{ date: '2026-07-15', usd: 1.23 }]);

    ceMock.on(GetCostAndUsageCommand).rejects(new Error('AccessDenied'));
    expect(await getDailyCosts('demo')).toEqual([]);
  });
});

describe('zipRepo', () => {
  it('excludes node_modules and .git', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-zip-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'big.js'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref');
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');

    const out = path.join(dir, 'out.zip');
    const res = await zipRepo(dir, out);
    expect(res.bytes).toBeGreaterThan(0);

    const AdmZip = (await import('adm-zip')).default;
    const names = new AdmZip(out).getEntries().map((e) => e.entryName);
    expect(names).toContain('src/index.js');
    expect(names).toContain('package.json');
    expect(names.some((n) => n.includes('node_modules'))).toBe(false);
    expect(names.some((n) => n.includes('.git'))).toBe(false);
  });
});
