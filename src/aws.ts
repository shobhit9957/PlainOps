import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  S3Client,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
} from '@aws-sdk/client-s3';
import {
  SecretsManagerClient,
  PutSecretValueCommand,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { CodeBuildClient, StartBuildCommand, BatchGetBuildsCommand } from '@aws-sdk/client-codebuild';
import { ECSClient, UpdateServiceCommand, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient, FilterLogEventsCommand, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';

export type EventSink = (message: string) => void;

const ZIP_EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '__pycache__', '.venv', '.terraform']);
const ZIP_WARN_BYTES = 50 * 1024 * 1024;
const ZIP_MAX_BYTES = 200 * 1024 * 1024;

export async function whoAmI(region: string): Promise<{ accountId: string; arn: string }> {
  const sts = new STSClient({ region });
  const res = await sts.send(new GetCallerIdentityCommand({}));
  if (!res.Account || !res.Arn) throw new Error('Could not resolve AWS identity');
  return { accountId: res.Account, arn: res.Arn };
}

export function bootstrapBucketName(accountId: string, region: string): string {
  return `plainops-${accountId}-${region}`;
}

/** Idempotently create the private, versioned PLAINOPS bucket. */
export async function ensureBootstrapBucket(region: string, accountId: string): Promise<string> {
  const bucket = bootstrapBucketName(accountId, region);
  const s3 = new S3Client({ region });
  try {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        ...(region === 'us-east-1'
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: region as never } }),
      }),
    );
  } catch (e) {
    const name = (e as Error).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw e;
  }
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  );
  return bucket;
}

/** Push a secret VALUE straight from the local vault to Secrets Manager. */
export async function putAppSecret(region: string, secretIdOrArn: string, value: string): Promise<void> {
  const sm = new SecretsManagerClient({ region });
  await sm.send(new PutSecretValueCommand({ SecretId: secretIdOrArn, SecretString: value }));
}

/** Read a secret value (e.g., the AWS-managed RDS master secret). Local use only. */
export async function getSecretValueRaw(region: string, secretIdOrArn: string): Promise<string> {
  const sm = new SecretsManagerClient({ region });
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretIdOrArn }));
  if (!res.SecretString) throw new Error('Secret has no string value');
  return res.SecretString;
}

function shouldExclude(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((seg) => ZIP_EXCLUDED_DIRS.has(seg));
}

/** Zip the repo (source upload for CodeBuild), excluding heavy/sensitive dirs. */
export async function zipRepo(repoPath: string, outFile: string): Promise<{ bytes: number; warning?: string }> {
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outFile);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(output);
    const walk = (dir: string, rel: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const relChild = rel ? `${rel}/${entry.name}` : entry.name;
        if (shouldExclude(relChild)) continue;
        if (entry.isDirectory()) walk(abs, relChild);
        else if (entry.isFile()) archive.file(abs, { name: relChild });
      }
    };
    walk(repoPath, '');
    void archive.finalize();
  });
  const bytes = fs.statSync(outFile).size;
  if (bytes > ZIP_MAX_BYTES) {
    fs.rmSync(outFile, { force: true });
    throw new Error(
      `Source zip is ${(bytes / 1024 / 1024).toFixed(0)} MB (>200 MB). Add build artifacts to the exclude list or clean the repo.`,
    );
  }
  return {
    bytes,
    warning:
      bytes > ZIP_WARN_BYTES
        ? `Source zip is ${(bytes / 1024 / 1024).toFixed(0)} MB — uploads may be slow.`
        : undefined,
  };
}

export async function uploadSource(region: string, bucket: string, key: string, zipPath: string): Promise<void> {
  const s3 = new S3Client({ region });
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: fs.readFileSync(zipPath) }));
}

export async function startImageBuild(region: string, project: string, imageTag: string): Promise<string> {
  const cb = new CodeBuildClient({ region });
  const res = await cb.send(
    new StartBuildCommand({
      projectName: project,
      environmentVariablesOverride: [{ name: 'IMAGE_TAG', value: imageTag, type: 'PLAINTEXT' }],
    }),
  );
  if (!res.build?.id) throw new Error('CodeBuild did not return a build id');
  return res.build.id;
}

async function buildLogTail(region: string, groupName: string, streamName: string): Promise<string> {
  try {
    const logs = new CloudWatchLogsClient({ region });
    const res = await logs.send(
      new GetLogEventsCommand({ logGroupName: groupName, logStreamName: streamName, limit: 30, startFromHead: false }),
    );
    return (res.events ?? []).map((e) => e.message?.trimEnd()).filter(Boolean).join('\n');
  } catch {
    return '(could not fetch build logs)';
  }
}

export async function waitForBuild(
  region: string,
  buildId: string,
  onEvent: EventSink,
  timeoutMs = 900_000,
  pollMs = 10_000,
): Promise<void> {
  const cb = new CodeBuildClient({ region });
  const deadline = Date.now() + timeoutMs;
  let lastPhase = '';
  for (;;) {
    if (Date.now() > deadline) throw new Error('Image build timed out after 15 minutes');
    const res = await cb.send(new BatchGetBuildsCommand({ ids: [buildId] }));
    const build = res.builds?.[0];
    if (!build) throw new Error(`Build ${buildId} not found`);
    const phase = build.currentPhase ?? 'UNKNOWN';
    if (phase !== lastPhase) {
      lastPhase = phase;
      onEvent(`Image build: ${phase}`);
    }
    if (build.buildStatus === 'SUCCEEDED') return;
    if (build.buildStatus && build.buildStatus !== 'IN_PROGRESS') {
      const g = build.logs?.groupName;
      const s = build.logs?.streamName;
      const tail = g && s ? await buildLogTail(region, g, s) : '(no logs)';
      throw new Error(`Image build ${build.buildStatus}.\nLast build log lines:\n${tail}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function redeployService(region: string, cluster: string, service: string): Promise<void> {
  const ecs = new ECSClient({ region });
  await ecs.send(new UpdateServiceCommand({ cluster, service, forceNewDeployment: true }));
}

export async function waitServiceStable(
  region: string,
  cluster: string,
  service: string,
  onEvent: EventSink,
  timeoutMs = 600_000,
  pollMs = 10_000,
): Promise<void> {
  const ecs = new ECSClient({ region });
  const deadline = Date.now() + timeoutMs;
  const seenEvents = new Set<string>();
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error('Service did not stabilize within 10 minutes — check the service events above');
    }
    const res = await ecs.send(new DescribeServicesCommand({ cluster, services: [service] }));
    const svc = res.services?.[0];
    if (!svc) throw new Error(`Service ${service} not found`);
    for (const ev of (svc.events ?? []).slice(0, 3)) {
      if (ev.id && !seenEvents.has(ev.id)) {
        seenEvents.add(ev.id);
        if (ev.message) onEvent(ev.message);
      }
    }
    const primary = (svc.deployments ?? []).find((d) => d.status === 'PRIMARY');
    const single = (svc.deployments ?? []).length === 1;
    if (single && primary && (svc.runningCount ?? 0) >= (svc.desiredCount ?? 1)) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function tailAppLogs(region: string, logGroup: string, minutes: number): Promise<string> {
  const logs = new CloudWatchLogsClient({ region });
  const res = await logs.send(
    new FilterLogEventsCommand({
      logGroupName: logGroup,
      startTime: Date.now() - minutes * 60_000,
      limit: 100,
    }),
  );
  return (res.events ?? [])
    .map((e) => `${new Date(e.timestamp ?? 0).toISOString()} ${e.message?.trimEnd() ?? ''}`)
    .join('\n');
}

export interface DailyCost {
  date: string;
  usd: number;
}

/** Daily actuals for this project's tag. Degrades to [] when CE is unavailable. */
export async function getDailyCosts(projectTag: string, days = 14): Promise<DailyCost[]> {
  try {
    const ce = new CostExplorerClient({ region: 'us-east-1' });
    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const res = await ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: start, End: end },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
        Filter: { Tags: { Key: 'plainops-project', Values: [projectTag] } },
      }),
    );
    return (res.ResultsByTime ?? []).map((r) => ({
      date: r.TimePeriod?.Start ?? '',
      usd: Math.round(parseFloat(r.Total?.UnblendedCost?.Amount ?? '0') * 100) / 100,
    }));
  } catch {
    return [];
  }
}

/** Upload a timestamped copy of the tfstate so a lost laptop is not lost infra. */
export async function backupState(region: string, bucket: string, projectName: string, tfDir: string): Promise<void> {
  const stateFile = path.join(tfDir, 'terraform.tfstate');
  if (!fs.existsSync(stateFile)) return;
  const key = `${projectName}/state-backups/${new Date().toISOString().replace(/[:.]/g, '-')}.tfstate`;
  const s3 = new S3Client({ region });
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: fs.readFileSync(stateFile) }));
}
