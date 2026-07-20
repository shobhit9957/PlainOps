import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  CreateBucketCommand,
  PutBucketWebsiteCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';
import { deployStaticSite, destroyStaticSite, staticBucketName } from '../src/static-site.js';

const s3 = mockClient(S3Client);
beforeEach(() => s3.reset());

describe('staticBucketName', () => {
  it('is lowercase, prefixed, and S3-legal length', () => {
    const name = staticBucketName('My-Store', '123456789012');
    expect(name).toBe('plainops-site-my-store-123456789012');
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('deployStaticSite', () => {
  it('creates a public website bucket and uploads files with content types', async () => {
    s3.on(CreateBucketCommand).resolves({});
    s3.on(PutPublicAccessBlockCommand).resolves({});
    s3.on(PutBucketWebsiteCommand).resolves({});
    s3.on(PutBucketPolicyCommand).resolves({});
    s3.on(PutObjectCommand).resolves({});

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-site-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');
    fs.mkdirSync(path.join(dir, 'css'));
    fs.writeFileSync(path.join(dir, 'css', 'style.css'), 'body{}');

    const res = await deployStaticSite('ap-south-1', 'plainops-site-demo-123', dir, () => {});
    expect(res.url).toBe('http://plainops-site-demo-123.s3-website.ap-south-1.amazonaws.com');
    expect(res.fileCount).toBe(2);

    const puts = s3.commandCalls(PutObjectCommand);
    const htmlPut = puts.find((p) => p.args[0].input.Key === 'index.html');
    const cssPut = puts.find((p) => p.args[0].input.Key === 'css/style.css');
    expect(htmlPut?.args[0].input.ContentType).toContain('text/html');
    expect(cssPut?.args[0].input.ContentType).toContain('text/css');

    // The public-read policy must be applied.
    const policy = JSON.parse(s3.commandCalls(PutBucketPolicyCommand)[0].args[0].input.Policy!);
    expect(policy.Statement[0].Action).toBe('s3:GetObject');
  });
});

describe('destroyStaticSite', () => {
  it('empties then deletes the bucket', async () => {
    s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'index.html' }], IsTruncated: false });
    s3.on(DeleteObjectsCommand).resolves({});
    s3.on(DeleteBucketCommand).resolves({});
    await destroyStaticSite('ap-south-1', 'plainops-site-demo-123', () => {});
    expect(s3.commandCalls(DeleteObjectsCommand)).toHaveLength(1);
    expect(s3.commandCalls(DeleteBucketCommand)).toHaveLength(1);
  });
});
