import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import { projectsDir } from './config.js';
import { projectTfDir } from './blueprint/render.js';
import { applyProject, readOutputs } from './tofu.js';
import { whoAmI, type EventSink } from './aws.js';
import { getProject, upsertProject } from './state.js';
import { auditLog } from './audit.js';
import { emitBus } from './bus.js';
import { validateLive, defaultDeps, type OrchestratorDeps } from './orchestrator.js';

const SERVERLESS_HCL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'blueprint', 'serverless');
const HCL_FILES = ['main.tf', 'variables.tf', 'outputs.tf'];

/** Zip the Lambda handler files at the archive ROOT (so "api.handler" resolves). */
export async function zipLambdas(sourceDir: string, outFile: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outFile);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(output);
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.js') || entry.name === 'package.json') {
        archive.file(path.join(sourceDir, entry.name), { name: entry.name });
      }
    }
    void archive.finalize();
  });
}

/** Materialize the serverless blueprint for a project. */
export function renderServerless(projectName: string, region: string, zipPath: string): string {
  const dir = projectTfDir(projectName);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of HCL_FILES) {
    fs.copyFileSync(path.join(SERVERLESS_HCL_DIR, f), path.join(dir, f));
  }
  const tfvars = {
    project_name: projectName,
    region,
    api_zip_path: zipPath,
    worker_zip_path: zipPath, // one zip holds both handlers
    api_handler: 'api.handler',
    worker_handler: 'worker.handler',
  };
  fs.writeFileSync(path.join(dir, 'terraform.tfvars.json'), JSON.stringify(tfvars, null, 2), 'utf8');
  return dir;
}

export function requireApiWorker(sourceDir: string): void {
  for (const f of ['api.js', 'worker.js']) {
    if (!fs.existsSync(path.join(sourceDir, f))) {
      throw new Error(`Serverless source is missing ${f}. A serverless project needs api.js (API handler) and worker.js (SQS worker).`);
    }
  }
}

/**
 * Deploy the serverless order-pipeline blueprint: package Lambdas → tofu apply
 * (API Gateway + Lambdas + SQS + DynamoDB) → validate the live API.
 */
export async function deployServerless(
  name: string,
  sourceDir: string,
  onEvent: EventSink,
  deps: OrchestratorDeps = defaultDeps,
): Promise<string> {
  const project = getProject(name);
  if (!project) throw new Error(`Unknown project: ${name}`);
  requireApiWorker(sourceDir);

  const log = (line: string) => {
    onEvent(line);
    emitBus({ type: 'deploy.log', projectName: name, line });
  };

  const { accountId } = await deps.whoAmI(project.region);

  log('Packaging Lambda functions…');
  const workDir = path.join(projectsDir(), name);
  fs.mkdirSync(workDir, { recursive: true });
  const zipPath = path.join(workDir, 'lambda.zip');
  await zipLambdas(sourceDir, zipPath);

  log('Rendering the serverless blueprint (API Gateway, Lambda, SQS, DynamoDB)…');
  const dir = renderServerless(name, project.region, zipPath);

  log('Creating serverless resources in your AWS account (usually 1–3 minutes)…');
  await applyProject(dir, log);

  const outputs = await readOutputs(dir);
  const apiUrl = outputs.api_url;

  log('Testing the live API like a real user…');
  const check = await validateLive(apiUrl, deps, log);
  if (!check.ok) {
    upsertProject({ ...getProject(name)!, status: 'provisioned', accountId, outputs });
    throw new Error(`Serverless stack deployed but the API did not respond with 200 (${check.detail}). Check the Lambda logs.`);
  }

  upsertProject({
    ...getProject(name)!,
    status: 'live',
    accountId,
    outputs,
    siteUrl: apiUrl,
    lastDeployAt: new Date().toISOString(),
  });
  auditLog({ type: 'serverless.deploy.done', summary: `Serverless pipeline live for ${name}`, detail: { apiUrl } });
  emitBus({ type: 'status.update', projectName: name });
  return apiUrl;
}
