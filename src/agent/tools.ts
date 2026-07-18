import type Anthropic from '@anthropic-ai/sdk';
import { getProject, upsertProject } from '../state.js';
import { projectsDir } from '../config.js';
import { analyzeRepo } from '../analyzer.js';
import { estimate, type BlueprintParams, type Region } from '../estimator.js';
import { scrub } from '../scrub.js';
import { tailAppLogs, getDailyCosts } from '../aws.js';
import { requestApproval, requestSecretValue, withActionLock } from '../gate.js';
import * as orchestrator from '../orchestrator.js';
import { deployServerless, requireApiWorker } from '../serverless.js';
import { deployMicroservices, detectServices } from '../microservices.js';
import { inspectAws } from '../inspect.js';
import { classifyAws, withRegion, runAwsCli } from '../awscli.js';
import { classifyCloud, runCloudCli, detectClouds, type CloudId } from '../clouds/cloudcli.js';
import { deployGcp, deployAzure, destroyCloud, type Archetype } from '../multicloud.js';
import { estimateCloud } from '../estimator.js';
import { collectDiagnosis } from '../diagnosis.js';
import { generateDockerfile } from '../analyzer.js';
import { whoAmI } from '../aws.js';
import { auditLog } from '../audit.js';
import { emitBus } from '../bus.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const EXAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples');
const BUNDLED_STATIC_SITE = path.join(EXAMPLES_DIR, 'static-site');
const BUNDLED_ORDER_PIPELINE = path.join(EXAMPLES_DIR, 'order-pipeline');

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'analyze_repo',
    description:
      "Inspect code to detect framework, port, needed env vars, and Dockerfile. If the founder gives you a folder path in chat, pass it as `path` — this attaches that code to the project (no re-setup needed) and analyzes it. Call this first whenever the founder points you at code.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a folder of code the founder gave you. Attaches it to the project.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'scaffold_app',
    description:
      "Write source files for the founder from scratch when they describe what they want (a problem statement) instead of giving code. Provide the complete file set; each file is written into this project's workspace and the project is then ready to deploy. Use for static sites, simple Node/Express APIs, etc. After scaffolding, use analyze_repo (no path — it reads the workspace) then the deploy flow. Keep it minimal and working; don't invent secrets.",
    input_schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Every file the app needs, including a Dockerfile for container apps or an index.html for static sites.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path, e.g. "index.html" or "src/server.js".' },
              content: { type: 'string', description: 'Full text content of the file.' },
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_infrastructure',
    description:
      'Design the AWS infrastructure and return a cost estimate (daily/monthly/yearly). Does NOT create anything. Present the cost to the founder and wait for approval before provisioning.',
    input_schema: {
      type: 'object',
      properties: {
        withDatabase: { type: 'boolean', description: 'Whether the app needs a PostgreSQL database.' },
        size: {
          type: 'string',
          enum: ['small', 'medium', 'large'],
          description: 'small = 0.25 vCPU/512MB (hobby/MVP), medium = 0.5 vCPU/1GB, large = 1 vCPU/2GB.',
        },
        budgetMonthlyUsd: { type: 'number', description: 'Monthly budget cap for the billing alert (e.g. 60).' },
        budgetEmail: { type: 'string', description: "Founder's email for budget alerts. Optional." },
        expectedConcurrentUsers: {
          type: 'number',
          description: 'Peak simultaneous users the founder expects (e.g. 20000). Drives how many containers run and the autoscaling ceiling. Omit for a small default.',
        },
      },
      required: ['withDatabase', 'size', 'budgetMonthlyUsd'],
      additionalProperties: false,
    },
  },
  {
    name: 'provision_infrastructure',
    description: 'Create the proposed AWS infrastructure. REQUIRES founder click-approval (shown in dashboard). Only call after propose_infrastructure and the founder agreeing.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'set_app_secret',
    description:
      'Securely collect a secret VALUE (API key, token) from the founder and store it in their AWS Secrets Manager. Opens a secure form in the dashboard. You only provide the NAME; you never see the value. Use for any env var that holds a secret.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'UPPER_SNAKE_CASE secret name, e.g. STRIPE_KEY.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'deploy_application',
    description: "Build the founder's code into a container (in their AWS account) and deploy it live. REQUIRES founder click-approval. Infrastructure must be provisioned first.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'inspect_aws',
    description:
      "Read-only: list what's already running in the founder's AWS account for this region — EC2 instances, ECS services, and existing PLAINOPS static sites. Use this when the founder asks what's deployed or running. Creates/changes nothing.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'aws_cli',
    description:
      "Do ANYTHING in the founder's AWS account by running an AWS CLI command — for anything the built-in deploy flows (static/container/serverless) don't cover: start/stop EC2, create or delete any resource, empty a bucket, check billing, manage DNS, tweak a security group, etc. Provide the arguments AFTER `aws` as a string array, e.g. ['ec2','describe-instances'] or ['ec2','stop-instances','--instance-ids','i-0abc']. Read-only commands (describe/list/get/ls…) run immediately; anything that creates, changes, or deletes requires the founder's click-approval. Region defaults to the project's region. Uses the founder's local credentials. Do NOT use this to read secret values — it will refuse. Prefer the built-in deploy tools for standard web-app deploys; use this for everything else.",
    input_schema: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: "AWS CLI arguments after 'aws', each as a separate array element.",
        },
        reason: { type: 'string', description: 'One short plain-English line explaining what this does (shown to the founder on the approval).' },
      },
      required: ['args'],
      additionalProperties: false,
    },
  },
  {
    name: 'deploy_static_website',
    description:
      "Deploy a static website (HTML/CSS/JS) to the founder's AWS via S3 static hosting — cheap (~$1/mo), fast, no server. Use this for landing pages, marketing sites, docs, or any site with no backend. REQUIRES founder click-approval. If the founder gave a folder of files, pass sourcePath; otherwise a PLAINOPS starter page is deployed so they can see it work.",
    input_schema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: 'Absolute path to a folder of static files (must contain index.html). Omit to deploy the PLAINOPS starter page.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'deploy_microservices',
    description:
      "Deploy a MULTI-SERVICE / microservices app to the founder's AWS. Use when the project folder contains multiple services, each a subfolder with its own Dockerfile (e.g. gateway + users + products + orders). PLAINOPS auto-detects every service, stands up one autoscaling ECS service each behind a shared load balancer with service discovery (Cloud Map), and automatically provisions a managed MongoDB (Amazon DocumentDB) AND a Redis cache (ElastiCache, REDIS_URL injected into every service) whenever the code needs them — no separate steps. Point sourcePath at the folder that CONTAINS the service subfolders. REQUIRES founder click-approval. This is a bigger, pricier deploy than a single app — always present the cost note.",
    input_schema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: 'Absolute path to the folder that contains the microservice subfolders (each with a Dockerfile).' },
      },
      required: ['sourcePath'],
      additionalProperties: false,
    },
  },
  {
    name: 'deploy_serverless',
    description:
      "Deploy a SERVERLESS, event-driven architecture (API Gateway + Lambda + SQS + DynamoDB) to the founder's AWS. Use this — NOT the container flow — when the app is serverless: Lambda functions, queues, event processing, no long-running server. The source folder must contain api.js (API Lambda, exports.handler, API GW payload v2.0) and worker.js (SQS worker, exports.handler); the blueprint injects TABLE_NAME (DynamoDB, hash key 'id') and QUEUE_URL; use only runtime-bundled @aws-sdk v3 clients, no node_modules. REQUIRES founder click-approval. Near-zero idle cost. If the founder describes the app, scaffold_app api.js + worker.js to that contract FIRST, then call this with no sourcePath — it automatically deploys the project's attached/scaffolded code, falling back to the bundled order-pipeline example only when the project has no code at all.",
    input_schema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: 'Absolute path to a folder containing api.js and worker.js. Omit to deploy the bundled order-pipeline example.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_status',
    description: 'Report the current status and live URL of the project.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_recent_logs',
    description: 'Fetch recent application logs (scrubbed of secrets) to help debug.',
    input_schema: {
      type: 'object',
      properties: { minutes: { type: 'number', description: 'How many minutes back to look (default 15).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_costs',
    description: 'Report actual daily AWS spend for this project over the last 14 days (may lag ~24h).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'destroy_infrastructure',
    description: 'Delete ALL cloud resources for this project (whichever cloud it lives on). REQUIRES founder click-approval. Irreversible. Only when the founder asks to tear down.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cloud_status',
    description:
      "Read-only: check which clouds this machine can deploy to right now — AWS credentials, Google Cloud (gcloud CLI + login + project), and Azure (az CLI + login + subscription). Call this when the founder asks what's connected, mentions GCP/Azure, or a cloud deploy fails with an auth-looking error. Returns exact fix-it commands for anything missing.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'deploy_gcp',
    description:
      "Deploy this project to the founder's GOOGLE CLOUD project. archetype='app' → Cloud Run container (+ optional Cloud SQL Postgres); 'serverless' → Cloud Functions + Pub/Sub + Firestore (needs api/index.js and worker/index.js folders, or omit sourcePath to ship the bundled example); 'microservices' → one Cloud Run service per Dockerfile subfolder. Images build in THEIR GCP project via Cloud Build (no local Docker). REQUIRES founder click-approval; shows a cost estimate first. Note: GCP has no cheap managed MongoDB — Mongo microservices fit AWS/Azure better; I inject Cloud SQL instead and say so.",
    input_schema: {
      type: 'object',
      properties: {
        archetype: { type: 'string', enum: ['app', 'serverless', 'microservices'], description: 'Which shape to deploy.' },
        sourcePath: { type: 'string', description: 'Folder to deploy (microservices: the parent folder of the service subfolders). Defaults to the attached repo / bundled example.' },
        withDatabase: { type: 'boolean', description: "app only: create a Cloud SQL PostgreSQL and inject DATABASE_URL." },
        alwaysOn: { type: 'boolean', description: 'Keep at least one instance warm (no cold starts, costs more). Default false = scale to zero.' },
      },
      required: ['archetype'],
      additionalProperties: false,
    },
  },
  {
    name: 'deploy_azure',
    description:
      "Deploy this project to the founder's AZURE subscription. archetype='app' → Container Apps (+ optional PostgreSQL Flexible Server); 'serverless' → Azure Functions + Storage queue/table (source needs host.json + one folder per function, or omit sourcePath for the bundled example); 'microservices' → one Container App per Dockerfile subfolder with built-in service discovery (services reach each other at http://<name>), plus Cosmos DB (Mongo API — drop-in MONGODB_URI) when the code uses Mongo. Images build in THEIR subscription via ACR Tasks (no local Docker). REQUIRES founder click-approval; shows a cost estimate first.",
    input_schema: {
      type: 'object',
      properties: {
        archetype: { type: 'string', enum: ['app', 'serverless', 'microservices'], description: 'Which shape to deploy.' },
        sourcePath: { type: 'string', description: 'Folder to deploy (microservices: the parent folder of the service subfolders). Defaults to the attached repo / bundled example.' },
        withDatabase: { type: 'boolean', description: 'app only: create a PostgreSQL Flexible Server and inject DATABASE_URL.' },
        alwaysOn: { type: 'boolean', description: 'Keep at least one replica warm. Default false = scale to zero.' },
      },
      required: ['archetype'],
      additionalProperties: false,
    },
  },
  {
    name: 'gcloud_cli',
    description:
      "Do ANYTHING in the founder's Google Cloud project by running a gcloud command — whatever the deploy flows don't cover: list services, read logs, manage DNS, resize things, enable APIs, delete resources. Args AFTER `gcloud` as a string array, e.g. ['run','services','list']. Read-only commands run instantly; anything that creates/changes/deletes needs the founder's click-approval. Refuses commands that would print credentials or secret values. The project's GCP project id is added automatically.",
    input_schema: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' }, description: "gcloud arguments, each as a separate array element." },
        reason: { type: 'string', description: 'One short plain-English line shown to the founder on the approval.' },
      },
      required: ['args'],
      additionalProperties: false,
    },
  },
  {
    name: 'az_cli',
    description:
      "Do ANYTHING in the founder's Azure subscription by running an az command — whatever the deploy flows don't cover: list resources, read logs, scale apps, manage DNS, delete resource groups. Args AFTER `az` as a string array, e.g. ['containerapp','list','--output','table']. Read-only commands run instantly; anything that creates/changes/deletes needs the founder's click-approval. Refuses commands that would print keys, connection strings, or secret values.",
    input_schema: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' }, description: "az arguments, each as a separate array element." },
        reason: { type: 'string', description: 'One short plain-English line shown to the founder on the approval.' },
      },
      required: ['args'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_diagnosis',
    description:
      "Collect hard evidence about why this project is broken or misbehaving, on WHATEVER cloud it runs on: live URL probe, service state, recent application logs, infrastructure state, and recent PlainOps actions — all read-only. Call this FIRST whenever the founder reports an error, a down site, a failed deploy, or pastes an error message (pass it as errorText). Then analyze the returned evidence per your diagnosis playbook. Never guess a root cause without running this.",
    input_schema: {
      type: 'object',
      properties: {
        errorText: { type: 'string', description: 'The error message / stack trace the founder pasted, verbatim, if any.' },
      },
      additionalProperties: false,
    },
  },
];

const SIZE_MAP: Record<string, { cpu: 256 | 512 | 1024; memoryMb: 512 | 1024 | 2048 }> = {
  small: { cpu: 256, memoryMb: 512 },
  medium: { cpu: 512, memoryMb: 1024 },
  large: { cpu: 1024, memoryMb: 2048 },
};

/** Where scaffold_app writes generated code for a project. */
function projectWorkspace(projectName: string): string {
  return path.join(projectsDir(), projectName, 'workspace');
}

/**
 * Turn a concurrent-user target into a container count + autoscaling ceiling.
 * Rough planning heuristic (~2,500 concurrent per small task); real capacity
 * needs a load test, which the proposal note makes clear.
 */
function sizeForConcurrency(users?: number): { desiredCount: number; maxCount: number; note: string } {
  if (!users || users <= 0) return { desiredCount: 1, maxCount: 4, note: 'Default sizing (no traffic target given).' };
  const desiredCount = Math.min(10, Math.max(2, Math.ceil(users / 2500)));
  const maxCount = Math.min(30, desiredCount * 3);
  return {
    desiredCount,
    maxCount,
    note: `Sized for ~${users.toLocaleString()} concurrent users: starts at ${desiredCount} containers, autoscales up to ${maxCount} under load. This is a planning estimate — confirm with a load test before a big launch. For very high traffic on STATIC content, a CDN (CloudFront) or S3 is cheaper and scales further than containers.`,
  };
}

/** Copy the bundled starter page to a temp dir, stamping the real region in. */
function materializeStarter(region: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-starter-'));
  let html = fs.readFileSync(path.join(BUNDLED_STATIC_SITE, 'index.html'), 'utf8');
  html = html.replace(/id="region">[^<]*</, `id="region">${region}<`);
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  return dir;
}

export interface ToolContext {
  projectName: string;
  deps?: orchestrator.OrchestratorDeps;
}

/** Execute a tool call and return a string result for the model (always scrubbed). */
export async function dispatchTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const deps = ctx.deps ?? orchestrator.defaultDeps;
  const raw = await dispatchRaw(name, input, ctx, deps);
  return scrub(raw);
}

async function dispatchRaw(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
  deps: orchestrator.OrchestratorDeps,
): Promise<string> {
  const project = getProject(ctx.projectName);
  if (!project) return `Error: project ${ctx.projectName} not found.`;
  const emitLog = (line: string) => emitBus({ type: 'deploy.log', projectName: ctx.projectName, line });

  switch (name) {
    case 'analyze_repo': {
      // If the founder gave a path in chat, attach it now — no re-setup needed.
      if (input.path) {
        const p = String(input.path).trim();
        if (!fs.existsSync(p)) return `That path does not exist on this machine: ${p}. Ask the founder to double-check the folder path.`;
        if (!fs.statSync(p).isDirectory()) return `That path is a file, not a folder: ${p}. Point me at the folder that contains the app.`;
        upsertProject({ ...project, repoPath: p });
      }
      const attached = getProject(ctx.projectName)!.repoPath;
      if (!attached) {
        return 'No code is attached yet. If the founder gave you a folder path, call analyze_repo with that `path`. If they described what they want built instead, use scaffold_app to write the code first.';
      }
      const report = analyzeRepo(attached);
      return JSON.stringify({ path: attached, ...report }, null, 2);
    }

    case 'scaffold_app': {
      const files = Array.isArray(input.files) ? (input.files as Array<{ path: string; content: string }>) : [];
      if (files.length === 0) return 'No files provided to scaffold.';
      const dir = path.join(projectWorkspace(project.name));
      fs.mkdirSync(dir, { recursive: true });
      const written: string[] = [];
      for (const f of files) {
        if (!f.path || typeof f.content !== 'string') continue;
        // Prevent path escapes.
        const rel = f.path.replace(/^[/\\]+/, '');
        const dest = path.resolve(dir, rel);
        if (!dest.startsWith(path.resolve(dir))) return `Refusing to write outside the workspace: ${f.path}`;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, f.content, 'utf8');
        written.push(rel);
      }
      upsertProject({ ...project, repoPath: dir });
      return JSON.stringify({ workspace: dir, filesWritten: written, next: 'Call analyze_repo (no path) to detect how to deploy this, then propose_infrastructure or deploy_static_website.' }, null, 2);
    }

    case 'propose_infrastructure': {
      if (!project.repoPath) return 'This project has no code attached, so there is nothing to containerize. Give me a folder path (analyze_repo with path), describe what to build (scaffold_app), or deploy a static website instead.';
      const size = SIZE_MAP[String(input.size)] ?? SIZE_MAP.small;
      const report = analyzeRepo(project.repoPath);
      const appSecrets = report.envVarsReferenced.filter((v) => v !== 'DATABASE_URL' || !input.withDatabase);
      if (input.withDatabase && !appSecrets.includes('DATABASE_URL')) appSecrets.unshift('DATABASE_URL');
      const scale = sizeForConcurrency(input.expectedConcurrentUsers ? Number(input.expectedConcurrentUsers) : undefined);
      const params: BlueprintParams = {
        projectName: project.name,
        region: project.region as Region,
        cpu: size.cpu,
        memoryMb: size.memoryMb,
        desiredCount: scale.desiredCount,
        maxCount: scale.maxCount,
        withDatabase: Boolean(input.withDatabase),
        healthPath: report.healthPath,
        containerPort: report.containerPort,
        appSecrets,
        budgetMonthlyUsd: Number(input.budgetMonthlyUsd) || 60,
        budgetEmail: input.budgetEmail ? String(input.budgetEmail) : undefined,
      };
      upsertProject({ ...project, blueprint: params });
      const est = estimate(params);
      emitBus({ type: 'cost.estimate', projectName: project.name, estimate: est });
      return JSON.stringify(
        {
          proposal: {
            appType: report.framework,
            size: input.size,
            containers: `${params.desiredCount} (autoscales to ${params.maxCount})`,
            database: params.withDatabase,
            appSecretsNeeded: appSecrets,
            region: params.region,
          },
          scaling: scale.note,
          cost: { daily: est.daily, monthly: est.monthly, yearly: est.yearly, breakdown: est.lines, note: est.disclaimer },
          nextStep: 'Present the cost AND the scaling note to the founder. If they approve, call provision_infrastructure.',
        },
        null,
        2,
      );
    }

    case 'provision_infrastructure': {
      if (!project.blueprint) return 'Error: call propose_infrastructure first.';
      const est = estimate(project.blueprint);
      const verdict = await requestApproval({
        type: 'provision',
        projectName: project.name,
        summary: `Create AWS infrastructure for "${project.name}" (${project.blueprint.withDatabase ? 'with' : 'no'} database) in ${project.region}.`,
        costText: `~$${est.daily}/day · ~$${est.monthly}/month · ~$${est.yearly}/year`,
      });
      if (verdict !== 'approved') return 'The founder did not approve provisioning. Do not proceed; ask what they would like to change.';
      return withActionLock(async () => {
        try {
          const outputs = await orchestrator.provision(project.name, emitLog, deps);
          return `Infrastructure created successfully. App URL (not live until you deploy): ${outputs.app_url}`;
        } catch (e) {
          return `Provisioning failed: ${(e as Error).message}`;
        }
      });
    }

    case 'set_app_secret': {
      const secretName = String(input.name);
      const ok = await requestSecretValue(project.name, secretName);
      return ok
        ? `Secret ${secretName} was stored securely in the founder's AWS Secrets Manager. You only ever see {{secret:${secretName}}}.`
        : `The founder did not provide a value for ${secretName}.`;
    }

    case 'deploy_application': {
      const verdict = await requestApproval({
        type: 'deploy',
        projectName: project.name,
        summary: `Build and deploy the latest code for "${project.name}" live.`,
      });
      if (verdict !== 'approved') return 'The founder did not approve the deployment.';
      return withActionLock(async () => {
        try {
          const url = await orchestrator.deployApp(project.name, emitLog, deps);
          return `Deployed successfully. The app is LIVE at ${url}`;
        } catch (e) {
          return `Deployment failed: ${(e as Error).message}`;
        }
      });
    }

    case 'inspect_aws': {
      try {
        const inv = await inspectAws(project.region);
        const running = inv.ec2.filter((i) => i.state === 'running');
        return JSON.stringify(
          {
            region: inv.region,
            ec2Summary: `${inv.ec2.length} instance(s), ${running.length} running`,
            ec2: inv.ec2,
            ecsServices: inv.ecsServices,
            plainopsStaticSites: inv.staticSites,
            note: 'This is read-only. PLAINOPS deploys into this same account.',
          },
          null,
          2,
        );
      } catch (e) {
        return `Could not read AWS inventory: ${(e as Error).message}. Check that AWS credentials are configured (aws configure) and the region is correct.`;
      }
    }

    case 'deploy_static_website': {
      let sourceDir = input.sourcePath ? String(input.sourcePath) : BUNDLED_STATIC_SITE;
      if (input.sourcePath && !fs.existsSync(path.join(sourceDir, 'index.html'))) {
        return `The folder ${sourceDir} has no index.html. A static website needs an index.html at its root.`;
      }
      const usingStarter = !input.sourcePath;
      const verdict = await requestApproval({
        type: 'deploy',
        projectName: project.name,
        summary: `Deploy a static website for "${project.name}" to S3 in ${project.region}${usingStarter ? ' (PLAINOPS starter page)' : ''}.`,
        costText: '~$0.02/day · ~$0.50/month (S3 storage + requests, tiny site)',
      });
      if (verdict !== 'approved') return 'The founder did not approve the static site deployment.';
      return withActionLock(async () => {
        try {
          // Personalize the starter page with the project's region.
          if (usingStarter) sourceDir = materializeStarter(project.region);
          const url = await orchestrator.deployStatic(project.name, sourceDir, emitLog);
          return `Static website is LIVE at ${url}`;
        } catch (e) {
          return `Static site deployment failed: ${(e as Error).message}`;
        }
      });
    }

    case 'aws_cli': {
      const args = Array.isArray(input.args) ? (input.args as unknown[]).map(String) : [];
      if (args.length === 0) return 'No AWS CLI arguments provided.';
      const cls = classifyAws(args);
      if (cls.kind === 'denied') {
        return `For your security I won't run "aws ${cls.service} ${cls.operation}" through this tool — it would expose secret values or credentials to me. Use set_app_secret for secrets, or run that command yourself.`;
      }
      const finalArgs = withRegion(args, project.region);
      const pretty = `aws ${finalArgs.join(' ')}`;
      if (cls.kind === 'mutate') {
        const verdict = await requestApproval({
          type: 'action',
          projectName: project.name,
          summary: `Run an AWS command that changes your account:\n${pretty}${input.reason ? `\n\n(${input.reason})` : ''}`,
        });
        if (verdict !== 'approved') return 'The founder did not approve this AWS command. Nothing was run.';
      }
      emitLog(`$ ${pretty}`);
      auditLog({ type: 'aws.cli', summary: pretty });
      const res = await runAwsCli(finalArgs);
      const out = (res.stdout || res.stderr || '(no output)').trim();
      const capped = out.length > 6000 ? out.slice(0, 6000) + '\n…(truncated)' : out;
      if (res.code !== 0) return `Command exited with code ${res.code}:\n${capped}`;
      return capped;
    }

    case 'deploy_microservices': {
      const sourceDir = input.sourcePath ? String(input.sourcePath) : '';
      if (!sourceDir) return 'Provide sourcePath — the folder that contains the microservice subfolders.';
      let detected;
      try {
        detected = detectServices(sourceDir);
      } catch (e) {
        return (e as Error).message;
      }
      const svcList = Object.keys(detected.services);
      const monthly = svcList.length * 9 + 21 + (detected.withDatabase ? 60 : 0);
      const verdict = await requestApproval({
        type: 'provision',
        projectName: project.name,
        summary: `Deploy ${svcList.length} microservices (${svcList.join(', ')}) for "${project.name}"${detected.withDatabase ? ' with a managed MongoDB (DocumentDB)' : ''}, behind one load balancer with service discovery, in ${project.region}.`,
        costText: `~$${monthly}/month baseline: ${svcList.length} Fargate services + load balancer${detected.withDatabase ? ' + DocumentDB (~$60)' : ''}. Each service autoscales under load. Takes ~20–30 min (DocumentDB is slow to create).`,
      });
      if (verdict !== 'approved') return 'The founder did not approve the microservices deployment.';
      return withActionLock(async () => {
        try {
          const url = await deployMicroservices(project.name, sourceDir, emitLog);
          return `The microservices app is LIVE at ${url}`;
        } catch (e) {
          return `Microservices deployment failed: ${(e as Error).message}`;
        }
      });
    }

    case 'deploy_serverless': {
      // Priority: explicit path → the project's own (possibly scaffolded) code →
      // bundled example. Without this, "scaffold then deploy" silently shipped
      // the example instead of the code the agent just wrote for the founder.
      let sourceDir = input.sourcePath ? String(input.sourcePath) : '';
      if (!sourceDir && project.repoPath && fs.existsSync(path.join(project.repoPath, 'api.js')) && fs.existsSync(path.join(project.repoPath, 'worker.js'))) {
        sourceDir = project.repoPath;
      }
      if (!sourceDir) sourceDir = BUNDLED_ORDER_PIPELINE;
      const usingBundled = sourceDir === BUNDLED_ORDER_PIPELINE;
      try {
        requireApiWorker(sourceDir);
      } catch (e) {
        return (e as Error).message;
      }
      const verdict = await requestApproval({
        type: 'deploy',
        projectName: project.name,
        summary: `Deploy a serverless pipeline for "${project.name}" — API Gateway + Lambda (api & worker) + SQS + dead-letter queue + DynamoDB, in ${project.region}.${usingBundled ? ' (bundled example app)' : ''}`,
        costText: '~$0/month idle · pay-per-request (Lambda + DynamoDB + SQS free tiers cover light traffic)',
      });
      if (verdict !== 'approved') return 'The founder did not approve the serverless deployment.';
      return withActionLock(async () => {
        try {
          const url = await deployServerless(project.name, sourceDir, emitLog);
          return `Serverless pipeline is LIVE at ${url}`;
        } catch (e) {
          return `Serverless deployment failed: ${(e as Error).message}`;
        }
      });
    }

    case 'get_status': {
      const p = getProject(ctx.projectName)!;
      const url = p.siteUrl ?? p.outputs?.app_url ?? p.outputs?.gateway_url ?? p.outputs?.api_url ?? null;
      // Actually hit the URL like a real user so we never claim "live" when it 503s.
      let liveCheck: { ok: boolean; detail: string } | null = null;
      if (url && (p.status === 'live' || p.status === 'provisioned')) {
        const res = await orchestrator.validateLive(url, deps, undefined, 1, 0);
        liveCheck = { ok: res.ok, detail: res.detail };
      }
      return JSON.stringify({
        status: p.status,
        url,
        reallyServing: liveCheck ? liveCheck.ok : null,
        urlCheck: liveCheck ? liveCheck.detail : 'not deployed yet',
        lastDeployAt: p.lastDeployAt ?? null,
        note:
          p.status === 'provisioned'
            ? 'Infrastructure exists but the app is NOT deployed/serving yet. Run deploy_application to build and ship the code, then it goes live.'
            : undefined,
      });
    }

    case 'get_recent_logs': {
      if (!project.outputs?.log_group) return 'No logs yet — the app has not been deployed.';
      const minutes = Number(input.minutes) || 15;
      const logs = await tailAppLogs(project.region, project.outputs.log_group, minutes);
      return logs || '(no log entries in that window)';
    }

    case 'get_costs': {
      const costs = await getDailyCosts(project.name);
      if (costs.length === 0) return 'No billing data yet. AWS cost data can lag up to 24 hours after resources start running.';
      const total = costs.reduce((s, c) => s + c.usd, 0);
      return JSON.stringify({ dailyCosts: costs, total14d: Math.round(total * 100) / 100 });
    }

    case 'destroy_infrastructure': {
      const cloudLabel = (project.cloud ?? 'aws').toUpperCase();
      const verdict = await requestApproval({
        type: 'destroy',
        projectName: project.name,
        summary: `PERMANENTLY DELETE all ${cloudLabel} resources for "${project.name}". This cannot be undone.`,
      });
      if (verdict !== 'approved') return 'The founder did not approve teardown. Nothing was deleted.';
      return withActionLock(async () => {
        try {
          if (project.cloud === 'gcp' || project.cloud === 'azure') {
            await destroyCloud(project.name, emitLog);
          } else {
            await orchestrator.destroy(project.name, emitLog, deps);
          }
          return `All ${cloudLabel} resources for this project have been deleted.`;
        } catch (e) {
          return `Teardown failed: ${(e as Error).message}`;
        }
      });
    }

    case 'cloud_status': {
      const clouds = await detectClouds();
      let aws: { connected: boolean; detail: string };
      try {
        const w = await whoAmI('us-east-1');
        aws = { connected: true, detail: `account ${w.accountId}` };
      } catch {
        aws = { connected: false, detail: 'No AWS credentials found — run `aws configure` (or set AWS_PROFILE).' };
      }
      return JSON.stringify(
        {
          aws,
          gcp: { connected: clouds.gcp.installed && clouds.gcp.authenticated, detail: clouds.gcp.detail },
          azure: { connected: clouds.azure.installed && clouds.azure.authenticated, detail: clouds.azure.detail },
          thisProject: `targets ${(project.cloud ?? 'aws')} in ${project.region}`,
        },
        null,
        2,
      );
    }

    case 'deploy_gcp':
    case 'deploy_azure': {
      const cloud: CloudId = name === 'deploy_gcp' ? 'gcp' : 'azure';
      const cloudPretty = cloud === 'gcp' ? 'Google Cloud' : 'Azure';
      const archetype = String(input.archetype) as Archetype;
      if (!['app', 'serverless', 'microservices'].includes(archetype)) return 'archetype must be app, serverless, or microservices.';
      const clouds = await detectClouds();
      const conn = cloud === 'gcp' ? clouds.gcp : clouds.azure;
      if (!conn.installed || !conn.authenticated) {
        return `${cloudPretty} is not connected on this machine yet: ${conn.detail} Then try again — I'll take it from there.`;
      }

      let sourcePath = input.sourcePath ? String(input.sourcePath) : undefined;
      let services = 1;
      let withDatabase = Boolean(input.withDatabase);
      let withCache = false;
      let containerPort: number | undefined;
      let extraSummary = '';

      if (archetype === 'microservices') {
        const src = sourcePath ?? project.repoPath;
        if (!src) return 'Provide sourcePath — the folder that contains the microservice subfolders (each with a Dockerfile).';
        let detected;
        try {
          detected = detectServices(src);
        } catch (e) {
          return (e as Error).message;
        }
        sourcePath = src;
        services = Object.keys(detected.services).length;
        withDatabase = detected.withDatabase;
        withCache = detected.withCache;
        extraSummary = ` — ${services} services (${Object.keys(detected.services).join(', ')})${withDatabase ? ' + database' : ''}${withCache ? ' + Redis' : ''}`;
      }
      if (archetype === 'app') {
        const src = sourcePath ?? project.repoPath;
        if (!src) return 'This project has no code attached. Give me a folder path (analyze_repo with path) or describe the app (scaffold_app) first.';
        const report = analyzeRepo(src);
        if (!report.hasDockerfile) {
          emitLog('No Dockerfile found — generating one…');
          generateDockerfile(report, src);
        }
        containerPort = report.containerPort;
        if (sourcePath && sourcePath !== project.repoPath) upsertProject({ ...project, repoPath: sourcePath });
      }

      const est = estimateCloud(cloud, { archetype, services, withDatabase, withCache, alwaysOn: Boolean(input.alwaysOn) });
      const target = conn.target ? ` (${cloud === 'gcp' ? 'project' : 'subscription'} ${conn.target})` : '';
      const verdict = await requestApproval({
        type: 'provision',
        projectName: project.name,
        summary: `Deploy "${project.name}" to ${cloudPretty}${target} as ${archetype}${extraSummary}, region ${project.region}. Image builds run inside your ${cloudPretty} account.`,
        costText: `~$${est.daily}/day · ~$${est.monthly}/month · ~$${est.yearly}/year — ${est.lines.map((l) => `${l.item}: $${l.monthly}`).join(' · ')}`,
      });
      if (verdict !== 'approved') return `The founder did not approve the ${cloudPretty} deployment. Nothing was created.`;

      return withActionLock(async () => {
        try {
          const opts = {
            sourcePath,
            withDatabase,
            withCache,
            containerPort,
            minInstances: input.alwaysOn ? 1 : 0,
          };
          const url =
            cloud === 'gcp'
              ? await deployGcp(project.name, archetype, opts, emitLog)
              : await deployAzure(project.name, archetype, opts, emitLog);
          return `Deployed to ${cloudPretty} — LIVE and verified at ${url}`;
        } catch (e) {
          return `${cloudPretty} deployment failed: ${(e as Error).message}`;
        }
      });
    }

    case 'gcloud_cli':
    case 'az_cli': {
      const cloud: CloudId = name === 'gcloud_cli' ? 'gcp' : 'azure';
      const binName = cloud === 'gcp' ? 'gcloud' : 'az';
      const args = Array.isArray(input.args) ? (input.args as unknown[]).map(String) : [];
      if (args.length === 0) return 'No CLI arguments provided.';
      const cls = classifyCloud(cloud, args);
      if (cls.kind === 'denied') {
        return `For your security I won't run "${binName} ${cls.verb}" through this tool — it would expose credentials or secret values to me. If it's genuinely needed, the founder can run it themselves in a terminal.`;
      }
      let finalArgs = args;
      if (cloud === 'gcp' && project.cloudTarget) {
        const positional = args.filter((a) => !a.startsWith('-'));
        const noProjectGroups = new Set(['config', 'auth', 'components', 'version', 'info', 'help', 'init']);
        if (!noProjectGroups.has(positional[0] ?? '') && !args.some((a) => a === '--project' || a.startsWith('--project='))) {
          finalArgs = [...args, '--project', project.cloudTarget];
        }
      }
      const pretty = `${binName} ${finalArgs.join(' ')}`;
      if (cls.kind === 'mutate') {
        const verdict = await requestApproval({
          type: 'action',
          projectName: project.name,
          summary: `Run a ${cloud === 'gcp' ? 'Google Cloud' : 'Azure'} command that changes your account:\n${pretty}${input.reason ? `\n\n(${input.reason})` : ''}`,
        });
        if (verdict !== 'approved') return 'The founder did not approve this command. Nothing was run.';
      }
      emitLog(`$ ${pretty}`);
      auditLog({ type: `${cloud}.cli`, summary: pretty });
      const res = await runCloudCli(cloud, finalArgs);
      const out = (res.stdout || res.stderr || '(no output)').trim();
      const capped = out.length > 6000 ? out.slice(0, 6000) + '\n…(truncated)' : out;
      if (res.code !== 0) return `Command exited with code ${res.code}:\n${capped}`;
      return capped;
    }

    case 'run_diagnosis': {
      return await collectDiagnosis(project.name, input.errorText ? String(input.errorText) : undefined);
    }

    default:
      return `Error: unknown tool ${name}.`;
  }
}
