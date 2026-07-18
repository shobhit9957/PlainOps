import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectTfDir } from './blueprint/render.js';
import { applyProject, readOutputs } from './tofu.js';
import {
  whoAmI,
  ensureBootstrapBucket,
  zipRepo,
  uploadSource,
  startImageBuild,
  waitForBuild,
  redeployService,
  waitServiceStable,
  putAppSecret,
  getSecretValueRaw,
  type EventSink,
} from './aws.js';
import { getProject, upsertProject } from './state.js';
import { setSecret } from './vault.js';
import { auditLog } from './audit.js';
import { emitBus } from './bus.js';
import { validateLive, defaultDeps, type OrchestratorDeps } from './orchestrator.js';

const HCL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'blueprint', 'microservices');
const HCL_FILES = ['main.tf', 'variables.tf', 'outputs.tf'];

export interface ServiceSpec {
  port: number;
  public: boolean;
  needs_db: boolean;
  cpu: number;
  memory: number;
  desired: number;
  max: number;
}
export type ServiceMap = Record<string, ServiceSpec>;

const PUBLIC_NAMES = ['gateway', 'api-gateway', 'bff', 'web', 'frontend', 'api'];

function readExpose(dockerfile: string): number | null {
  const m = dockerfile.match(/^\s*EXPOSE\s+(\d{2,5})/im);
  return m ? parseInt(m[1], 10) : null;
}

function needsMongo(pkgJson: string): boolean {
  try {
    const pkg = JSON.parse(pkgJson);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Boolean(deps.mongoose || deps.mongodb);
  } catch {
    return false;
  }
}

function usesRedis(pkgJson: string): boolean {
  try {
    const pkg = JSON.parse(pkgJson);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Boolean(deps.redis || deps.ioredis);
  } catch {
    return false;
  }
}

/**
 * Detect microservices from a project folder: every immediate subdirectory that
 * contains a Dockerfile is one service. Port comes from the Dockerfile's EXPOSE,
 * whether it needs MongoDB from its package.json, and the public (gateway)
 * service from its name.
 */
export function detectServices(projectDir: string): {
  services: ServiceMap;
  withDatabase: boolean;
  withCache: boolean;
  publicName: string;
} {
  if (!fs.existsSync(projectDir)) throw new Error(`Folder not found: ${projectDir}`);
  const services: ServiceMap = {};
  let withCache = false;
  for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const dir = path.join(projectDir, entry.name);
    const dockerfile = path.join(dir, 'Dockerfile');
    if (!fs.existsSync(dockerfile)) continue;
    const port = readExpose(fs.readFileSync(dockerfile, 'utf8')) ?? 3000;
    const pkgPath = path.join(dir, 'package.json');
    const pkg = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : '';
    const needs_db = Boolean(pkg) && needsMongo(pkg);
    if (pkg && usesRedis(pkg)) withCache = true;
    services[entry.name] = { port, public: false, needs_db, cpu: 256, memory: 512, desired: 1, max: 6 };
  }

  const names = Object.keys(services);
  if (names.length === 0) throw new Error('No microservices found — each service must be a subfolder with a Dockerfile.');

  // Pick the public/gateway service.
  let publicName = names.find((n) => PUBLIC_NAMES.includes(n.toLowerCase()));
  if (!publicName) publicName = names.slice().sort()[0];
  services[publicName].public = true;
  // Give the public entrypoint a bit more headroom by default.
  services[publicName].desired = 2;

  const withDatabase = names.some((n) => services[n].needs_db);
  return { services, withDatabase, withCache, publicName };
}

/** Materialize the multi-service blueprint. */
export function renderMicroservices(
  projectName: string,
  region: string,
  services: ServiceMap,
  withDatabase: boolean,
  bootstrapBucket: string,
  withCache = false,
  healthPath = '/health',
): string {
  const dir = projectTfDir(projectName);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of HCL_FILES) fs.copyFileSync(path.join(HCL_DIR, f), path.join(dir, f));
  const tfvars = {
    project_name: projectName,
    region,
    bootstrap_bucket: bootstrapBucket,
    services,
    with_database: withDatabase,
    with_cache: withCache,
    health_path: healthPath,
  };
  fs.writeFileSync(path.join(dir, 'terraform.tfvars.json'), JSON.stringify(tfvars, null, 2), 'utf8');
  return dir;
}

export function serviceEnvName(name: string): string {
  return `${name.toUpperCase().replace(/-/g, '_')}_URL`;
}

/**
 * Deploy a whole microservices project: detect services → apply the blueprint
 * (VPC, Cloud Map, one autoscaling ECS service each, shared ALB → gateway,
 * DocumentDB) → wire MongoDB → build every service image → roll out → verify.
 */
export async function deployMicroservices(
  name: string,
  projectDir: string,
  onEvent: EventSink,
  deps: OrchestratorDeps = defaultDeps,
): Promise<string> {
  const project = getProject(name);
  if (!project) throw new Error(`Unknown project: ${name}`);
  const log = (line: string) => {
    onEvent(line);
    emitBus({ type: 'deploy.log', projectName: name, line });
  };

  const { services, withDatabase, withCache, publicName } = detectServices(projectDir);
  const serviceNames = Object.keys(services);
  const extras = [withDatabase ? 'MongoDB' : '', withCache ? 'Redis cache' : ''].filter(Boolean).join(' + ');
  log(`Detected ${serviceNames.length} services: ${serviceNames.join(', ')} (public: ${publicName}${extras ? ', + ' + extras : ''}).`);

  const { accountId } = await deps.whoAmI(project.region);
  const bucket = await ensureBootstrapBucket(project.region, accountId);
  upsertProject({ ...getProject(name)!, accountId, bootstrapBucket: bucket });

  log('Rendering the multi-service blueprint…');
  const dir = renderMicroservices(name, project.region, services, withDatabase, bucket, withCache, '/health');

  log(`Creating infrastructure${withDatabase ? ' incl. DocumentDB (MongoDB)' : ''}${withCache ? ' + Redis cache' : ''}${withDatabase ? ' — the database takes ~10 minutes' : ''}…`);
  await applyProject(dir, log);

  const outputs = await readOutputs(dir);
  const codebuildProjects = JSON.parse(outputs.codebuild_projects || '{}');
  const ecsServiceNames = JSON.parse(outputs.service_names || '{}');
  const appUrl = outputs.app_url;

  if (withDatabase && outputs.docdb_endpoint) {
    log('Composing the MongoDB connection string and storing it in your Secrets Manager…');
    const dbName = name.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'app';
    // TLS is disabled on the cluster (see blueprint); the master user lives in `admin`,
    // and DocumentDB doesn't support retryable writes.
    const uri = `mongodb://${outputs.docdb_user}:${encodeURIComponent(outputs.docdb_password)}@${outputs.docdb_endpoint}:27017/${dbName}?authSource=admin&retryWrites=false`;
    setSecret('MONGODB_URI', uri);
    if (outputs.mongodb_secret_arn) await putAppSecret(project.region, outputs.mongodb_secret_arn, uri);
  }

  // Build each service image (sequential — respects CodeBuild concurrency limits).
  for (const svc of serviceNames) {
    log(`Building "${svc}" image…`);
    const zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `po-${svc}-`)), 'source.zip');
    await zipRepo(path.join(projectDir, svc), zipPath);
    await uploadSource(project.region, bucket, `${name}/${svc}/source.zip`, zipPath);
    const buildId = await startImageBuild(project.region, codebuildProjects[svc], `v${Date.now()}`);
    await waitForBuild(project.region, buildId, log);
  }

  log('Rolling out all services…');
  for (const svc of serviceNames) {
    await redeployService(project.region, outputs.cluster_name, ecsServiceNames[svc]);
  }
  // Wait for EVERY service to reach steady state — not just the gateway — so the
  // app is genuinely ready (a hung downstream would otherwise pass a gateway-only check).
  log('Waiting for all services to become healthy…');
  for (const svc of serviceNames) {
    log(`  …${svc}`);
    await waitServiceStable(project.region, outputs.cluster_name, ecsServiceNames[svc], log);
  }

  log('Testing the live site like a real user…');
  const check = await validateLive(appUrl, deps, log);
  if (!check.ok) {
    upsertProject({ ...getProject(name)!, status: 'provisioned', outputs });
    throw new Error(`Deployed, but ${appUrl} did not return 200 (${check.detail}). Check service logs.`);
  }

  upsertProject({ ...getProject(name)!, status: 'live', outputs, siteUrl: appUrl, lastDeployAt: new Date().toISOString() });
  auditLog({ type: 'microservices.deploy.done', summary: `Microservices live for ${name}`, detail: { appUrl, services: serviceNames } });
  emitBus({ type: 'status.update', projectName: name });
  return appUrl;
}
