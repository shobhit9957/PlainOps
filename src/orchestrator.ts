import path from 'node:path';
import { getProject, upsertProject, type Project } from './state.js';
import { renderProject, projectTfDir } from './blueprint/render.js';
import { applyProject, destroyProject, readOutputs } from './tofu.js';
import {
  backupState,
  ensureBootstrapBucket,
  getSecretValueRaw,
  putAppSecret,
  redeployService,
  startImageBuild,
  uploadSource,
  waitForBuild,
  waitServiceStable,
  whoAmI,
  zipRepo,
  type EventSink,
} from './aws.js';
import { analyzeRepo, generateDockerfile } from './analyzer.js';
import { deployStaticSite, destroyStaticSite, staticBucketName } from './static-site.js';
import { setSecret } from './vault.js';
import { auditLog } from './audit.js';
import { emitBus } from './bus.js';
import os from 'node:os';
import fs from 'node:fs';

export interface OrchestratorDeps {
  whoAmI: typeof whoAmI;
  ensureBootstrapBucket: typeof ensureBootstrapBucket;
  renderProject: typeof renderProject;
  applyProject: typeof applyProject;
  destroyProject: typeof destroyProject;
  readOutputs: typeof readOutputs;
  backupState: typeof backupState;
  zipRepo: typeof zipRepo;
  uploadSource: typeof uploadSource;
  startImageBuild: typeof startImageBuild;
  waitForBuild: typeof waitForBuild;
  redeployService: typeof redeployService;
  waitServiceStable: typeof waitServiceStable;
  putAppSecret: typeof putAppSecret;
  getSecretValueRaw: typeof getSecretValueRaw;
  deployStaticSite: typeof deployStaticSite;
  healthFetch: (url: string) => Promise<number>;
}

export const defaultDeps: OrchestratorDeps = {
  whoAmI,
  ensureBootstrapBucket,
  renderProject,
  applyProject,
  destroyProject,
  readOutputs,
  backupState,
  zipRepo,
  uploadSource,
  startImageBuild,
  waitForBuild,
  redeployService,
  waitServiceStable,
  putAppSecret,
  getSecretValueRaw,
  deployStaticSite,
  healthFetch: async (url) => {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    return res.status;
  },
};

function requireProject(name: string): Project {
  const p = getProject(name);
  if (!p) throw new Error(`Unknown project: ${name}`);
  return p;
}

function progress(onEvent: EventSink, projectName: string, line: string): void {
  onEvent(line);
  emitBus({ type: 'deploy.log', projectName, line });
}

/** Create/verify account-level prerequisites and remember them on the project. */
export async function ensureProjectSetup(name: string, deps: OrchestratorDeps = defaultDeps): Promise<Project> {
  const project = requireProject(name);
  // The account id is stable, so reuse it when known; otherwise resolve it once.
  const accountId = project.accountId ?? (await deps.whoAmI(project.region)).accountId;
  // ALWAYS (re)ensure the bootstrap bucket — it holds the source zip CodeBuild
  // reads, and it can be deleted out-of-band (a stray cleanup, an account sweep).
  // Trusting a cached bucket name here means a later provision renders a CodeBuild
  // project pointing at a dead bucket and fails with "Bucket ... does not exist".
  // ensureBootstrapBucket is idempotent: a no-op when the bucket exists, a self-heal
  // when it doesn't.
  const bucket = await deps.ensureBootstrapBucket(project.region, accountId);
  if (project.accountId === accountId && project.bootstrapBucket === bucket) return project;
  const updated = { ...project, accountId, bootstrapBucket: bucket };
  upsertProject(updated);
  return updated;
}

/** tofu apply the blueprint, then wire up database credentials if requested. */
export async function provision(name: string, onEvent: EventSink, deps: OrchestratorDeps = defaultDeps): Promise<Record<string, string>> {
  const project = await ensureProjectSetup(name, deps);
  if (!project.blueprint) throw new Error('No infrastructure proposal exists yet — call propose_infrastructure first.');

  const log = (line: string) => progress(onEvent, name, line);
  log('Rendering infrastructure blueprint…');
  const dir = deps.renderProject(project.blueprint, project.bootstrapBucket!);

  log('Creating AWS resources (this typically takes 3–6 minutes)…');
  await deps.applyProject(dir, log);

  const outputs = await deps.readOutputs(dir);
  await deps.backupState(project.region, project.bootstrapBucket!, name, dir);

  if (project.blueprint.withDatabase && outputs.db_master_secret_arn) {
    log('Composing database connection string…');
    const master = JSON.parse(await deps.getSecretValueRaw(project.region, outputs.db_master_secret_arn));
    const dbUrl = `postgresql://${outputs.db_user}:${encodeURIComponent(master.password)}@${outputs.db_endpoint}:5432/${outputs.db_name}`;
    setSecret('DATABASE_URL', dbUrl);
    const secretArns = JSON.parse(outputs.secret_arns || '{}');
    if (secretArns.DATABASE_URL) {
      await deps.putAppSecret(project.region, secretArns.DATABASE_URL, dbUrl);
      log('DATABASE_URL stored in your AWS Secrets Manager (never sent to the AI).');
    } else {
      // render.ts guarantees the shell exists when withDatabase — if this ever
      // fires, say so loudly instead of shipping a silently database-less app.
      log('⚠ The database exists but no DATABASE_URL secret shell came back from the blueprint — the app will NOT get a connection string. Re-provision; if it persists this is a bug.');
    }
  }

  upsertProject({ ...requireProject(name), status: 'provisioned', outputs });
  auditLog({ type: 'provision.done', summary: `Provisioned ${name}`, detail: { app_url: outputs.app_url } });
  emitBus({ type: 'status.update', projectName: name });
  return outputs;
}

/** Zip → S3 → CodeBuild (in the founder's account) → roll ECS → verify. */
export async function deployApp(name: string, onEvent: EventSink, deps: OrchestratorDeps = defaultDeps): Promise<string> {
  const project = requireProject(name);
  if (!project.outputs || project.status === 'new') {
    throw new Error('Infrastructure is not provisioned yet — provision first.');
  }
  if (!project.repoPath) throw new Error('This project has no code attached to deploy.');
  const { outputs, region, repoPath } = project;
  const log = (line: string) => progress(onEvent, name, line);

  const report = analyzeRepo(repoPath);
  if (!report.hasDockerfile) {
    log('No Dockerfile found — generating one…');
    generateDockerfile(report, repoPath);
  }

  log('Packaging source code…');
  const zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'po-src-')), 'source.zip');
  const { bytes, warning } = await deps.zipRepo(repoPath, zipPath);
  if (warning) log(`⚠ ${warning}`);
  log(`Uploading source (${(bytes / 1024).toFixed(0)} KB) to your S3 bucket…`);
  await deps.uploadSource(region, project.bootstrapBucket!, `${name}/source.zip`, zipPath);

  log('Building container image in your AWS account (CodeBuild — no Docker needed on this machine)…');
  const tag = `v${Date.now()}`;
  const buildId = await deps.startImageBuild(region, outputs!.codebuild_project, tag);
  await deps.waitForBuild(region, buildId, log);

  log('Rolling out the new version…');
  await deps.redeployService(region, outputs!.cluster_name, outputs!.service_name);
  await deps.waitServiceStable(region, outputs!.cluster_name, outputs!.service_name, log);

  log('Testing the live URL like a real user (must return HTTP 200 before I call it live)…');
  const url = outputs!.app_url;
  const check = await validateLive(url, deps, log);
  if (!check.ok) {
    // Do NOT mark it live or hand over a broken URL.
    upsertProject({ ...requireProject(name), status: 'provisioned' });
    emitBus({ type: 'status.update', projectName: name });
    throw new Error(
      `The infrastructure is up but the app is not serving requests yet — ${url} returned ${check.detail}. ` +
        `This usually means the container failed to start or its health check is failing. ` +
        `Use get_recent_logs to see why, then redeploy. I did NOT mark this live.`,
    );
  }

  upsertProject({ ...requireProject(name), status: 'live', siteUrl: url, lastDeployAt: new Date().toISOString() });
  auditLog({ type: 'deploy.done', summary: `Deployed ${name} (${tag}) — verified 200`, detail: { url } });
  emitBus({ type: 'status.update', projectName: name });
  return url;
}

export interface LiveCheck {
  ok: boolean;
  status?: number;
  detail: string;
}

/**
 * Real-user validation: hit the URL like a browser would and require a genuine
 * 200–399. A 503 (no healthy targets) or a connection error is NOT "live".
 * Retries because ALB targets take a minute or two to pass health checks.
 */
export async function validateLive(
  url: string,
  deps: OrchestratorDeps = defaultDeps,
  onLine?: (l: string) => void,
  attempts = 18,
  intervalMs = 10_000,
): Promise<LiveCheck> {
  let lastStatus: number | undefined;
  let lastErr = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const status = await deps.healthFetch(url);
      lastStatus = status;
      if (status >= 200 && status < 400) {
        onLine?.(`✓ ${url} returned HTTP ${status} — verified serving.`);
        return { ok: true, status, detail: `HTTP ${status}` };
      }
      if (i % 3 === 0) onLine?.(`Still waiting — ${url} returns HTTP ${status} (not healthy yet)…`);
    } catch (e) {
      lastErr = (e as Error).message;
      if (i % 3 === 0) onLine?.(`Still waiting — ${url} not reachable yet…`);
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return {
    ok: false,
    status: lastStatus,
    detail: lastStatus ? `HTTP ${lastStatus} after ${attempts} checks` : `unreachable (${lastErr})`,
  };
}

/** Deploy a static website (S3 hosting) — lightweight path, no containers. */
export async function deployStatic(
  name: string,
  sourceDir: string,
  onEvent: EventSink,
  deps: OrchestratorDeps = defaultDeps,
  attempts = 18,
  intervalMs = 10_000,
): Promise<string> {
  const project = requireProject(name);
  const { accountId } = await deps.whoAmI(project.region);
  const bucket = staticBucketName(name, accountId);
  const log = (line: string) => progress(onEvent, name, line);
  const res = await deps.deployStaticSite(project.region, bucket, sourceDir, log);

  // Same rule as every other deploy path: "live" is a measured fact. A website
  // bucket can exist and still 404 (no index.html) or 403 (policy not effective
  // yet), and the endpoint takes a moment to start serving after creation.
  log('Testing the live URL like a real user (must return HTTP 200 before I call it live)…');
  const check = await validateLive(res.url, deps, log, attempts, intervalMs);
  if (!check.ok) {
    upsertProject({
      ...requireProject(name),
      accountId,
      status: 'provisioned',
      siteBucket: res.bucket,
      siteUrl: res.url,
    });
    emitBus({ type: 'status.update', projectName: name });
    throw new Error(
      `The bucket is up but the site is not serving yet — ${res.url} returned ${check.detail}. ` +
        `Usually this means index.html is missing at the root, or the public-read policy has not taken ` +
        `effect yet. I did NOT mark this live.`,
    );
  }

  upsertProject({
    ...requireProject(name),
    accountId,
    status: 'live',
    siteBucket: res.bucket,
    siteUrl: res.url,
    lastDeployAt: new Date().toISOString(),
  });
  auditLog({ type: 'static.deploy.done', summary: `Static site live for ${name}`, detail: { url: res.url } });
  emitBus({ type: 'status.update', projectName: name });
  return res.url;
}

/** Tear everything down. */
export async function destroy(name: string, onEvent: EventSink, deps: OrchestratorDeps = defaultDeps): Promise<void> {
  const project = requireProject(name);
  const log = (line: string) => progress(onEvent, name, line);

  if (project.siteBucket) {
    log('Removing the static website…');
    await destroyStaticSite(project.region, project.siteBucket, log);
    upsertProject({ ...requireProject(name), status: 'destroyed', siteBucket: undefined, siteUrl: undefined });
    auditLog({ type: 'destroy.done', summary: `Destroyed static site ${name}` });
    emitBus({ type: 'status.update', projectName: name });
    log('Static website removed.');
    return;
  }

  const dir = projectTfDir(name);
  log('Destroying all AWS resources for this project…');
  await deps.destroyProject(dir, log);
  await deps.backupState(project.region, project.bootstrapBucket ?? '', name, dir).catch(() => {});
  upsertProject({ ...requireProject(name), status: 'destroyed', outputs: undefined });
  auditLog({ type: 'destroy.done', summary: `Destroyed ${name}` });
  emitBus({ type: 'status.update', projectName: name });
  log('All billed resources removed.');
}
