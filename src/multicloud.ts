import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectsDir } from './config.js';
import { getProject, upsertProject, type Project } from './state.js';
import { applyProject, destroyProject, readOutputs } from './tofu.js';
import { zipRepo, type EventSink } from './aws.js';
import { runCloudCli, detectClouds, type CloudId } from './clouds/cloudcli.js';
import { detectServices } from './microservices.js';
import { validateLive, defaultDeps } from './orchestrator.js';
import { auditLog } from './audit.js';
import { emitBus } from './bus.js';

/**
 * GCP + Azure deploy orchestration. Same philosophy as the AWS paths:
 * reviewed blueprints (the AI never authors HCL), human approval happens at
 * the tool layer before we're called, container images build REMOTELY in the
 * user's own cloud (Cloud Build / ACR Tasks — no local Docker), and nothing
 * is called live without a real HTTP 2xx/3xx.
 */

const BLUEPRINT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'blueprint');
const HCL_FILES = ['main.tf', 'variables.tf', 'outputs.tf'];
const EXAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');

export type Archetype = 'app' | 'serverless' | 'microservices';

export interface MultiCloudDeps {
  runCli: typeof runCloudCli;
  applyProject: typeof applyProject;
  destroyProject: typeof destroyProject;
  readOutputs: typeof readOutputs;
  zipRepo: typeof zipRepo;
  healthFetch: (url: string) => Promise<number>;
}

export const defaultMcDeps: MultiCloudDeps = {
  runCli: runCloudCli,
  applyProject,
  destroyProject,
  readOutputs,
  zipRepo,
  healthFetch: defaultDeps.healthFetch,
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

/** Where a cloud blueprint gets rendered for a project (same tf dir the AWS paths use). */
export function cloudTfDir(projectName: string): string {
  return path.join(projectsDir(), projectName, 'tf');
}

/** Copy a blueprint trio + write tfvars. Secret VALUES are never rendered. */
export function renderCloudBlueprint(blueprint: string, projectName: string, tfvars: Record<string, unknown>): string {
  const src = path.join(BLUEPRINT_ROOT, blueprint);
  if (!fs.existsSync(path.join(src, 'main.tf'))) throw new Error(`Blueprint not found: ${blueprint}`);
  const dir = cloudTfDir(projectName);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of HCL_FILES) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'terraform.tfvars.json'), JSON.stringify(tfvars, null, 2), 'utf8');
  return dir;
}

async function requireGcpReady(deps: MultiCloudDeps): Promise<string> {
  const status = await detectClouds();
  if (!status.gcp.installed || !status.gcp.authenticated || !status.gcp.target) {
    throw new Error(`GCP is not connected: ${status.gcp.detail}`);
  }
  return status.gcp.target;
}

async function requireAzureReady(): Promise<string> {
  const status = await detectClouds();
  if (!status.azure.installed || !status.azure.authenticated) {
    throw new Error(`Azure is not connected: ${status.azure.detail}`);
  }
  return status.azure.target ?? 'active subscription';
}

/**
 * Resource providers each Azure archetype needs. A FRESH subscription has
 * none of them registered, and the blueprints deliberately register nothing
 * (`resource_provider_registrations = "none"` keeps plans deterministic) —
 * so the deploy registers them explicitly, exactly like the GCP blueprints
 * enable their own APIs (the same first-deploy failure class we fixed live
 * on GCP: PERMISSION_DENIED there, MissingSubscriptionRegistration here).
 */
export function azureProvidersFor(archetype: Archetype, withDatabase: boolean): string[] {
  if (archetype === 'serverless') return ['Microsoft.Web', 'Microsoft.Storage'];
  const base = ['Microsoft.App', 'Microsoft.ContainerRegistry', 'Microsoft.OperationalInsights'];
  if (archetype === 'microservices') return withDatabase ? [...base, 'Microsoft.DocumentDB'] : base;
  return withDatabase ? [...base, 'Microsoft.DBforPostgreSQL'] : base;
}

/** Register any unregistered provider (idempotent; part of the approved deploy). */
export async function ensureAzureProviders(
  namespaces: string[],
  log: (l: string) => void,
  deps: MultiCloudDeps = defaultMcDeps,
): Promise<void> {
  for (const ns of namespaces) {
    const q = await deps.runCli('azure', ['provider', 'show', '--namespace', ns, '--query', 'registrationState', '--output', 'tsv'], 30_000);
    if (q.code === 0 && q.stdout.trim() === 'Registered') continue;
    log(`Registering the Azure resource provider ${ns} (first use on this subscription — one-time)…`);
    const r = await deps.runCli('azure', ['provider', 'register', '--namespace', ns, '--wait'], 600_000);
    if (r.code !== 0) {
      log(`⚠ Could not register ${ns} automatically. If the deploy fails with MissingSubscriptionRegistration, run: az provider register --namespace ${ns}`);
    }
  }
}

async function cli(deps: MultiCloudDeps, cloud: CloudId, args: string[], log: (l: string) => void, timeoutMs: number, failMsg: string): Promise<string> {
  const res = await deps.runCli(cloud, args, timeoutMs);
  if (res.code !== 0) {
    const tail = (res.stderr || res.stdout).trim().split(/\r?\n/).slice(-12).join('\n');
    log(tail);
    throw new Error(`${failMsg}. Last output:\n${tail}`);
  }
  return res.stdout;
}

export interface CloudDeployOptions {
  sourcePath?: string;
  withDatabase?: boolean;
  withCache?: boolean;
  cpu?: string;      // gcp cloud run cpu ("1") / azure cpu number as string
  memory?: string;   // "512Mi" / "1Gi"
  minInstances?: number;
  maxInstances?: number;
  containerPort?: number;
}

/* ------------------------------------------------------------------ GCP -- */

export async function deployGcp(
  name: string,
  archetype: Archetype,
  opts: CloudDeployOptions,
  onEvent: EventSink,
  deps: MultiCloudDeps = defaultMcDeps,
): Promise<string> {
  const project = requireProject(name);
  const log = (l: string) => progress(onEvent, name, l);
  const gcpProject = project.cloudTarget ?? (await requireGcpReady(deps));
  upsertProject({ ...requireProject(name), cloud: 'gcp', cloudTarget: gcpProject, archetype });

  let url: string;
  if (archetype === 'app') url = await gcpApp(name, gcpProject, opts, log, deps);
  else if (archetype === 'serverless') url = await gcpServerless(name, gcpProject, opts, log, deps);
  else url = await gcpMicroservices(name, gcpProject, opts, log, deps);

  upsertProject({ ...requireProject(name), status: 'live', siteUrl: url, lastDeployAt: new Date().toISOString() });
  auditLog({ type: 'deploy.done', summary: `Deployed ${name} to GCP (${archetype}) — verified live`, detail: { url } });
  emitBus({ type: 'status.update', projectName: name });
  return url;
}

async function gcpApp(name: string, gcpProject: string, opts: CloudDeployOptions, log: (l: string) => void, deps: MultiCloudDeps): Promise<string> {
  const project = requireProject(name);
  if (!project.repoPath) throw new Error('This project has no code attached to deploy.');
  const baseVars = {
    project_name: name,
    gcp_project: gcpProject,
    region: project.region,
    container_port: opts.containerPort ?? 8080,
    cpu: opts.cpu ?? '1',
    memory: opts.memory ?? '512Mi',
    min_instances: opts.minInstances ?? 0,
    max_instances: opts.maxInstances ?? 4,
    with_database: Boolean(opts.withDatabase),
    app_secrets: [] as string[],
  };

  // Phase 1: stand up the platform (registry, service on the hello image, db).
  log('Creating GCP resources (Cloud Run, Artifact Registry' + (baseVars.with_database ? ', Cloud SQL — the database takes ~10 min' : '') + ')…');
  let dir = renderCloudBlueprint('gcp-app', name, baseVars);
  await deps.applyProject(dir, log);
  let outputs = await deps.readOutputs(dir);

  // Phase 2: build the real image remotely with Cloud Build, then point the service at it.
  const tag = `v${Date.now()}`;
  const image = `${outputs.artifact_repo_url}/app:${tag}`;
  log('Building your container image in YOUR GCP project (Cloud Build — no local Docker needed)…');
  await cli(deps, 'gcp', ['builds', 'submit', '--tag', image, '--project', gcpProject, '--region', project.region, '--quiet', project.repoPath], log, 1_800_000, 'Cloud Build failed');
  log('Rolling the service onto your image…');
  dir = renderCloudBlueprint('gcp-app', name, { ...baseVars, image });
  await deps.applyProject(dir, log);
  outputs = await deps.readOutputs(dir);
  upsertProject({ ...requireProject(name), outputs, status: 'provisioned' });

  return await mustBeLive(outputs.app_url, log, deps);
}

/**
 * Cloud Functions gen2 deploys create an underlying Cloud Run service + an
 * Eventarc trigger that run AS the Compute Engine default service account, and
 * GCP requires the DEPLOYING identity to have iam.serviceAccounts.actAs on that
 * SA. `roles/owner` deliberately does NOT include actAs, so on a fresh project
 * the deploy fails with a 403 ("Permission iam.serviceAccounts.actAs denied").
 * Grant the deploying account serviceAccountUser on the compute SA (idempotent)
 * so the first serverless deploy just works. Best-effort: if we can't read the
 * account/number we let the deploy proceed and surface the real error.
 */
async function ensureDeployerActsAsComputeSa(gcpProject: string, log: (l: string) => void, deps: MultiCloudDeps): Promise<void> {
  const acct = (await deps.runCli('gcp', ['config', 'get-value', 'account'], 15_000)).stdout.trim();
  const numRes = await deps.runCli('gcp', ['projects', 'describe', gcpProject, '--format=value(projectNumber)'], 20_000);
  const projectNumber = numRes.stdout.trim();
  if (!acct || !projectNumber || acct === '(unset)') return;
  const computeSa = `${projectNumber}-compute@developer.gserviceaccount.com`;
  const res = await deps.runCli('gcp', [
    'iam', 'service-accounts', 'add-iam-policy-binding', computeSa,
    '--member', `user:${acct}`, '--role', 'roles/iam.serviceAccountUser',
    '--project', gcpProject, '--quiet',
  ], 40_000);
  if (res.code === 0) log(`Granted your account permission to deploy functions as the runtime service account (one-time).`);
  // A non-zero here (e.g. the member is a service account, not a user) is not
  // fatal — the deploy proceeds and any real actAs error surfaces with its fix.
}

async function gcpServerless(name: string, gcpProject: string, opts: CloudDeployOptions, log: (l: string) => void, deps: MultiCloudDeps): Promise<string> {
  const project = requireProject(name);
  const source = opts.sourcePath ?? path.join(EXAMPLES_DIR, 'gcp-order-pipeline');
  for (const part of ['api', 'worker']) {
    if (!fs.existsSync(path.join(source, part, 'index.js'))) {
      throw new Error(`A GCP serverless deploy needs ${part}/index.js (exporting "handler") in ${source}.`);
    }
  }
  await ensureDeployerActsAsComputeSa(gcpProject, log, deps).catch(() => {});
  log('Packaging your functions…');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'po-gcpfn-'));
  const apiZip = path.join(tmp, 'api.zip');
  const workerZip = path.join(tmp, 'worker.zip');
  await deps.zipRepo(path.join(source, 'api'), apiZip);
  await deps.zipRepo(path.join(source, 'worker'), workerZip);

  log('Creating GCP resources (Cloud Functions, Pub/Sub, Firestore — first run takes ~5–8 min)…');
  const dir = renderCloudBlueprint('gcp-serverless', name, {
    project_name: name,
    gcp_project: gcpProject,
    region: project.region,
    // tofu on Windows wants forward slashes in file paths inside tfvars.
    api_zip_path: apiZip.replace(/\\/g, '/'),
    worker_zip_path: workerZip.replace(/\\/g, '/'),
  });
  await deps.applyProject(dir, log);
  const outputs = await deps.readOutputs(dir);
  upsertProject({ ...requireProject(name), outputs, status: 'provisioned' });

  return await mustBeLive(outputs.api_url, log, deps);
}

async function gcpMicroservices(name: string, gcpProject: string, opts: CloudDeployOptions, log: (l: string) => void, deps: MultiCloudDeps): Promise<string> {
  const project = requireProject(name);
  if (!opts.sourcePath) throw new Error('Provide sourcePath — the folder that contains the microservice subfolders.');
  const detected = detectServices(opts.sourcePath);
  const svcNames = Object.keys(detected.services);
  log(`Detected ${svcNames.length} services: ${svcNames.join(', ')} (public entrypoint: ${detected.publicName}).`);
  if (detected.withDatabase) {
    log('Heads-up: these services use MongoDB. GCP has no small managed MongoDB; I will provision Cloud SQL Postgres and inject DATABASE_URL instead — services reading MONGODB_URI need a code change, or deploy to AWS (DocumentDB) / Azure (Cosmos DB) for drop-in Mongo.');
  }

  const servicesVar: Record<string, { image: string; port: number; public: boolean; env: Record<string, string> }> = {};
  const hello = 'us-docker.pkg.dev/cloudrun/container/hello';
  for (const svc of svcNames) {
    servicesVar[svc] = { image: hello, port: detected.services[svc].port, public: detected.services[svc].public, env: {} };
  }
  const baseVars = {
    project_name: name,
    gcp_project: gcpProject,
    region: project.region,
    services: servicesVar,
    with_database: detected.withDatabase,
    with_cache: detected.withCache,
  };

  log('Creating the platform (Artifact Registry + one Cloud Run service per microservice)…');
  let dir = renderCloudBlueprint('gcp-microservices', name, baseVars);
  await deps.applyProject(dir, log);
  let outputs = await deps.readOutputs(dir);

  const tag = `v${Date.now()}`;
  for (const svc of svcNames) {
    const image = `${outputs.artifact_repo_url}/${svc}:${tag}`;
    log(`Building ${svc} in your GCP project (Cloud Build)…`);
    await cli(deps, 'gcp', ['builds', 'submit', '--tag', image, '--project', gcpProject, '--region', project.region, '--quiet', path.join(opts.sourcePath, svc)], log, 1_800_000, `Cloud Build failed for ${svc}`);
    servicesVar[svc].image = image;
  }
  log('Rolling every service onto its image…');
  dir = renderCloudBlueprint('gcp-microservices', name, { ...baseVars, services: servicesVar });
  await deps.applyProject(dir, log);
  outputs = await deps.readOutputs(dir);
  upsertProject({ ...requireProject(name), outputs, status: 'provisioned' });

  return await mustBeLive(outputs.gateway_url, log, deps);
}

/* ---------------------------------------------------------------- Azure -- */

export async function deployAzure(
  name: string,
  archetype: Archetype,
  opts: CloudDeployOptions,
  onEvent: EventSink,
  deps: MultiCloudDeps = defaultMcDeps,
): Promise<string> {
  const project = requireProject(name);
  const log = (l: string) => progress(onEvent, name, l);
  const subscription = project.cloudTarget ?? (await requireAzureReady());
  upsertProject({ ...requireProject(name), cloud: 'azure', cloudTarget: subscription, archetype });

  let url: string;
  if (archetype === 'app') url = await azureApp(name, opts, log, deps);
  else if (archetype === 'serverless') url = await azureServerless(name, opts, log, deps);
  else url = await azureMicroservices(name, opts, log, deps);

  upsertProject({ ...requireProject(name), status: 'live', siteUrl: url, lastDeployAt: new Date().toISOString() });
  auditLog({ type: 'deploy.done', summary: `Deployed ${name} to Azure (${archetype}) — verified live`, detail: { url } });
  emitBus({ type: 'status.update', projectName: name });
  return url;
}

async function azureApp(name: string, opts: CloudDeployOptions, log: (l: string) => void, deps: MultiCloudDeps): Promise<string> {
  const project = requireProject(name);
  if (!project.repoPath) throw new Error('This project has no code attached to deploy.');
  const baseVars = {
    project_name: name,
    region: project.region,
    container_port: opts.containerPort ?? 80,
    cpu: Number(opts.cpu ?? 0.5),
    memory: opts.memory ?? '1Gi',
    min_replicas: opts.minInstances ?? 0,
    max_replicas: opts.maxInstances ?? 4,
    with_database: Boolean(opts.withDatabase),
    app_secrets: [] as string[],
  };

  await ensureAzureProviders(azureProvidersFor('app', baseVars.with_database), log, deps);
  log('Creating Azure resources (Container Apps, Container Registry' + (baseVars.with_database ? ', PostgreSQL — the database takes ~10 min' : '') + ')…');
  let dir = renderCloudBlueprint('azure-app', name, baseVars);
  await deps.applyProject(dir, log);
  let outputs = await deps.readOutputs(dir);

  const tag = `v${Date.now()}`;
  log('Building your container image in YOUR Azure subscription (ACR Tasks — no local Docker needed)…');
  await cli(deps, 'azure', ['acr', 'build', '--registry', outputs.acr_name, '--image', `app:${tag}`, project.repoPath], log, 1_800_000, 'ACR build failed');
  log('Rolling the app onto your image…');
  dir = renderCloudBlueprint('azure-app', name, { ...baseVars, image: `${outputs.acr_login_server}/app:${tag}` });
  await deps.applyProject(dir, log);
  outputs = await deps.readOutputs(dir);
  upsertProject({ ...requireProject(name), outputs, status: 'provisioned' });

  return await mustBeLive(outputs.app_url, log, deps);
}

async function azureServerless(name: string, opts: CloudDeployOptions, log: (l: string) => void, deps: MultiCloudDeps): Promise<string> {
  const project = requireProject(name);
  const source = opts.sourcePath ?? path.join(EXAMPLES_DIR, 'azure-order-pipeline');
  if (!fs.existsSync(path.join(source, 'host.json'))) {
    throw new Error(`An Azure Functions deploy needs a host.json at the root of ${source} (plus one folder per function with function.json + index.js).`);
  }

  await ensureAzureProviders(azureProvidersFor('serverless', false), log, deps);
  log('Creating Azure resources (Function App, Storage queue + table — ~2–4 min)…');
  const dir = renderCloudBlueprint('azure-serverless', name, { project_name: name, region: project.region });
  await deps.applyProject(dir, log);
  const outputs = await deps.readOutputs(dir);

  log('Packaging and deploying your functions…');
  const zip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'po-azfn-')), 'functions.zip');
  await deps.zipRepo(source, zip);
  await cli(
    deps,
    'azure',
    ['functionapp', 'deployment', 'source', 'config-zip', '--resource-group', outputs.resource_group, '--name', outputs.function_app_name, '--src', zip],
    log,
    600_000,
    'Function deployment failed',
  );
  upsertProject({ ...requireProject(name), outputs, status: 'provisioned' });

  // The api function is exposed at /api/<function-name> with anonymous auth.
  return await mustBeLive(`${outputs.api_base_url}/api/api`, log, deps);
}

async function azureMicroservices(name: string, opts: CloudDeployOptions, log: (l: string) => void, deps: MultiCloudDeps): Promise<string> {
  const project = requireProject(name);
  if (!opts.sourcePath) throw new Error('Provide sourcePath — the folder that contains the microservice subfolders.');
  const detected = detectServices(opts.sourcePath);
  const svcNames = Object.keys(detected.services);
  log(`Detected ${svcNames.length} services: ${svcNames.join(', ')} (public entrypoint: ${detected.publicName}).`);
  if (detected.withDatabase) log('MongoDB needed → provisioning Cosmos DB (Mongo API): drop-in MONGODB_URI, serverless billing.');

  const hello = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest';
  const servicesVar: Record<string, { image: string; port: number; public: boolean; env: Record<string, string> }> = {};
  for (const svc of svcNames) {
    servicesVar[svc] = { image: hello, port: detected.services[svc].port, public: detected.services[svc].public, env: {} };
  }
  const baseVars = {
    project_name: name,
    region: project.region,
    services: servicesVar,
    with_database: detected.withDatabase,
    with_cache: detected.withCache,
  };

  await ensureAzureProviders(azureProvidersFor('microservices', detected.withDatabase), log, deps);
  log('Creating the platform (Container Apps environment + registry' + (detected.withDatabase ? ' + Cosmos DB' : '') + ')…');
  let dir = renderCloudBlueprint('azure-microservices', name, baseVars);
  await deps.applyProject(dir, log);
  let outputs = await deps.readOutputs(dir);

  const tag = `v${Date.now()}`;
  for (const svc of svcNames) {
    log(`Building ${svc} in your Azure subscription (ACR Tasks)…`);
    await cli(deps, 'azure', ['acr', 'build', '--registry', outputs.acr_name, '--image', `${svc}:${tag}`, path.join(opts.sourcePath, svc)], log, 1_800_000, `ACR build failed for ${svc}`);
    servicesVar[svc].image = `${outputs.acr_login_server}/${svc}:${tag}`;
  }
  log('Rolling every service onto its image…');
  dir = renderCloudBlueprint('azure-microservices', name, { ...baseVars, services: servicesVar });
  await deps.applyProject(dir, log);
  outputs = await deps.readOutputs(dir);
  upsertProject({ ...requireProject(name), outputs, status: 'provisioned' });

  return await mustBeLive(outputs.gateway_url, log, deps);
}

/* -------------------------------------------------------------- shared -- */

/** Same non-negotiable as AWS: never claim live without a real 2xx/3xx. */
async function mustBeLive(url: string, log: (l: string) => void, deps: MultiCloudDeps): Promise<string> {
  if (!url) throw new Error('The deploy finished but produced no URL output — treat this as failed.');
  log('Testing the live URL like a real user (must return HTTP 200 before I call it live)…');
  const check = await validateLive(url, { ...defaultDeps, healthFetch: deps.healthFetch }, log);
  if (!check.ok) {
    throw new Error(
      `The infrastructure is up but ${url} returned ${check.detail}. The container/function likely failed to start. ` +
        `Use run_diagnosis to collect the evidence, then fix and redeploy. I did NOT mark this live.`,
    );
  }
  return url;
}

/** Tear down a GCP/Azure project (tofu destroy on its rendered dir). */
export async function destroyCloud(name: string, onEvent: EventSink, deps: MultiCloudDeps = defaultMcDeps): Promise<void> {
  const project = requireProject(name);
  const log = (l: string) => progress(onEvent, name, l);
  const dir = cloudTfDir(name);
  if (!fs.existsSync(path.join(dir, 'terraform.tfvars.json'))) {
    throw new Error('Nothing to destroy — no rendered infrastructure found for this project.');
  }
  log(`Destroying all ${project.cloud?.toUpperCase()} resources for this project…`);
  await deps.destroyProject(dir, log);
  upsertProject({ ...requireProject(name), status: 'destroyed', outputs: undefined, siteUrl: undefined });
  auditLog({ type: 'destroy.done', summary: `Destroyed ${name} (${project.cloud})` });
  emitBus({ type: 'status.update', projectName: name });
  log('All billed resources removed.');
}
