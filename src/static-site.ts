import fs from 'node:fs';
import path from 'node:path';
import {
  S3Client,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketWebsiteCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';
import type { EventSink } from './aws.js';
import { auditLog } from './audit.js';

/**
 * Lightweight static-website deploy: S3 static website hosting.
 * Right-sized for landing pages / marketing sites — near-zero cost, deploys in
 * seconds, no containers. Distinct from the ECS blueprint (for dynamic apps).
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

const IGNORED = new Set(['.git', 'node_modules', '.DS_Store']);

export function staticBucketName(projectName: string, accountId: string): string {
  return `plainops-site-${projectName}-${accountId}`.toLowerCase().slice(0, 63);
}

function websiteUrl(bucket: string, region: string): string {
  // ap-south-1 and most modern regions use the dot form.
  return `http://${bucket}.s3-website.${region}.amazonaws.com`;
}

function* walk(dir: string, base = dir): Generator<{ abs: string; key: string }> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(abs, base);
    else if (entry.isFile()) yield { abs, key: path.relative(base, abs).split(path.sep).join('/') };
  }
}

export interface StaticSiteResult {
  bucket: string;
  url: string;
  fileCount: number;
}

/** Create the bucket, enable website hosting + public read, upload all files. */
export async function deployStaticSite(
  region: string,
  bucket: string,
  sourceDir: string,
  onEvent: EventSink,
): Promise<StaticSiteResult> {
  const s3 = new S3Client({ region });

  onEvent(`Creating website bucket ${bucket}…`);
  try {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        ...(region === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: region as never } }),
      }),
    );
  } catch (e) {
    const name = (e as Error).name;
    if (name !== 'BucketAlreadyOwnedByYou') throw e;
    onEvent('Bucket already exists — reusing it.');
  }

  // Static sites are public by design — turn off the bucket's block-public-access.
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        BlockPublicPolicy: false,
        IgnorePublicAcls: false,
        RestrictPublicBuckets: false,
      },
    }),
  );

  await s3.send(
    new PutBucketWebsiteCommand({
      Bucket: bucket,
      WebsiteConfiguration: {
        IndexDocument: { Suffix: 'index.html' },
        ErrorDocument: { Key: 'index.html' },
      },
    }),
  );

  await s3.send(
    new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'PublicReadForStaticSite',
            Effect: 'Allow',
            Principal: '*',
            Action: 's3:GetObject',
            Resource: `arn:aws:s3:::${bucket}/*`,
          },
        ],
      }),
    }),
  );

  let fileCount = 0;
  for (const { abs, key } of walk(sourceDir)) {
    const ext = path.extname(key).toLowerCase();
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: fs.readFileSync(abs),
        ContentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
      }),
    );
    fileCount++;
  }
  onEvent(`Uploaded ${fileCount} file${fileCount === 1 ? '' : 's'}.`);

  const url = websiteUrl(bucket, region);
  auditLog({ type: 'static.deploy', summary: `Static site deployed to ${bucket}`, detail: { url, fileCount } });
  return { bucket, url, fileCount };
}

/** Empty and delete the bucket — full teardown, zero residual cost. */
export async function destroyStaticSite(region: string, bucket: string, onEvent: EventSink): Promise<void> {
  const s3 = new S3Client({ region });
  onEvent(`Emptying ${bucket}…`);
  for (;;) {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    if (!listed.Contents || listed.Contents.length === 0) break;
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: listed.Contents.map((o) => ({ Key: o.Key! })) },
      }),
    );
    if (!listed.IsTruncated) break;
  }
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  onEvent(`Deleted bucket ${bucket}.`);
  auditLog({ type: 'static.destroy', summary: `Static site ${bucket} deleted` });
}
