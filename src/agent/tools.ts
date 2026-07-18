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
import { generateWorkflow, writeWorkflow, setMonitoring, setAutoDeploy, isGitRepo, watchtowerRequiresChannel, createStagingTwin, stagingNameFor, redeployProject, recordDeployedCommit, gitHead } from '../cicd.js';
import { verifyBackups, backupNow, runDrDrill, datastoreOf } from '../backup.js';
import { setupCustomDomain, isValidDomain } from '../dns.js';
import { rollbackDeployment, checkDrift, findSavings } from '../ops.js';
import { scanSecurity } from '../security.js';
import { safeDeploy, releasePreview } from '../release.js';
import { enableCloudMonitoring } from '../cloudmon.js';
import { detectMigrations, scanMigrationRisks, describeRisks, runMigrations } from '../migrate.js';
import { notifyDeveloper, anyChannelConfigured, configuredChannels } from '../notify.js';
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
      "Collect hard evidence about why this project is broken or misbehaving, on WHATEVER cloud it runs on: live URL probe, service state, recent application logs, infrastructure state, and recent PlainOps actions — all read-only. On AWS it can also sweep infrastructure PLAINOPS DID NOT DEPLOY (the founder's pre-existing app): every ECS service's desired-vs-running, AUTOSCALING LIMITS (min/MAX — the classic 'stuck at max capacity' bottleneck), load-balancer target health, firing CloudWatch alarms, and recent error-level log lines. That sweep runs automatically when the project has no PlainOps-deployed stack; force it with scope='account'. Call this FIRST whenever the founder reports an error, a down site, a failed deploy, or pastes an error message (pass it as errorText). Then analyze per your diagnosis playbook. Never guess a root cause without running this.",
    input_schema: {
      type: 'object',
      properties: {
        errorText: { type: 'string', description: 'The error message / stack trace the founder pasted, verbatim, if any.' },
        scope: { type: 'string', enum: ['project', 'account'], description: "'account' sweeps the whole AWS region (adopted/pre-existing infrastructure), not just this project's stack." },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'setup_cicd',
    description:
      "Set up deploy-on-push CI/CD on ANY of the three clouds: writes a GitHub Actions workflow into the project's repo, generated from the REAL deployed resource names (AWS: ECR/cluster/service, Lambdas, or site bucket · GCP: Cloud Build → Cloud Run / Cloud Functions · Azure: ACR Tasks → Container Apps / Function App zip-deploy). After the founder pushes it and adds the cloud credential secret(s) to the GitHub repo, every push to main ships automatically via GitHub's cloud — no laptop needed. REQUIRES founder click-approval (it writes into their repo). The project must be deployed once first.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'verify_backups',
    description:
      "Read-only backup audit for this project's datastore: is automated backup ON, what's the retention, how recent is the latest snapshot/restore point (RDS Postgres, DocumentDB, DynamoDB PITR, S3 versioning; Cloud SQL on GCP; PostgreSQL flexible on Azure). Call when the founder asks 'am I backed up?', before a risky change, and as part of any production-readiness review.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'backup_now',
    description:
      "Take an on-demand backup of the project's datastore right now (RDS/DocumentDB snapshot, DynamoDB backup + ensure point-in-time recovery, S3 versioning on, Cloud SQL backup on GCP; Azure PG runs continuous backups automatically — the tool explains that). REQUIRES founder click-approval. Use before deploys the founder is nervous about, schema changes, or teardown.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_dr_drill',
    description:
      "Disaster-recovery DRILL — the test most teams never run: restore the LATEST snapshot/backup into a TEMPORARY instance, prove it actually comes up ('available'/'ACTIVE'), then delete the temporary copy. Verifies backups are restorable, not just present. Costs cents (minutes of the smallest instance); RDS/DocumentDB drills take 10–30 min, DynamoDB a few minutes. AWS projects only in this version. REQUIRES founder click-approval. Run backup_now first if no snapshot exists yet.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'setup_environments',
    description:
      "Create a STAGING twin of this project (same cloud/region/repo/shape, its own isolated stack named <name>-stg). Flow the founder gets: deploy to staging → test the staging URL → promote_to_production ships the exact validated commit. Creates only a project record — nothing is billed until staging is deployed. Free.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'promote_to_production',
    description:
      "Promote what staging validated to PRODUCTION: verifies the staging twin is live, confirms the repo's current commit matches the one staging deployed (warns plainly if the repo moved ahead — promotion then ships current HEAD), and redeploys production through the same verified pipeline. REQUIRES founder click-approval. Call from the PRODUCTION project (the one without -stg). Production must be provisioned/deployed once before its first promotion.",
    input_schema: {
      type: 'object',
      properties: {
        acceptNewerCommit: { type: 'boolean', description: 'Set true only after the founder explicitly accepts promoting a commit newer than what staging tested.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'enable_auto_deploy',
    description:
      "Standing rule (while the PlainOps app is open): watch the project's git remote and automatically pull + redeploy whenever new commits land — the local, zero-setup alternative to GitHub Actions. Enabling REQUIRES founder click-approval because future deploys then run without a per-deploy click (each one is still audited and sends a notification). Requires the attached folder to be a git repo with an upstream, and a completed first deploy. Pass enabled=false to turn it off (no approval needed).",
    input_schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true to enable (default), false to disable.' },
        intervalMinutes: { type: 'number', description: 'How often to check the remote (default 3, min 1).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'enable_monitoring',
    description:
      "Watchtower for this project's live URL (while the PlainOps app is open): probe it on an interval; after 2 consecutive failures it automatically collects a full diagnosis AND notifies the developer on the configured channels — the 3am-incident feature. Free to enable/disable (read-only probes). Works best with a notification channel configured in Settings → Connectors. Pass enabled=false to turn off.",
    input_schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true to enable (default), false to disable.' },
        intervalMinutes: { type: 'number', description: 'Probe interval (default 2, min 1).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'safe_deploy',
    description:
      "The SAFEST way to ship: deploy, then watch the live URL, and AUTOMATICALLY roll back to the previous build if it stops serving. Optionally runs database migrations first (snapshot → migrate → deploy → health gate). Prefer this over the plain deploy tools for any app already serving real users — the founder approves once, and the revert-on-failure is part of what they approved. Report the health-gate result honestly, including error lines found in the logs after a successful deploy. AWS container/microservices stacks get automatic revert; other shapes still get the health gate and honest guidance.",
    input_schema: {
      type: 'object',
      properties: {
        migrate: { type: 'boolean', description: 'Run database migrations before deploying (a snapshot is always taken first). Default false.' },
        service: { type: 'string', description: 'Microservices: which service to revert if the gate fails.' },
        watchSeconds: { type: 'number', description: 'How long to watch the URL before declaring success (default 120, minimum 30).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'run_migrations',
    description:
      "Run the app's database migrations safely: detect the tool from the repo (Prisma, Knex, Sequelize, TypeORM, node-pg-migrate, Django, Alembic, Rails, Flyway), LINT the pending migrations for destructive statements (dropped columns/tables, type changes, NOT NULL, renames), SNAPSHOT the database, then run the command as a one-off task inside the founder's cloud using the running service's own image, credentials, and network. REQUIRES founder click-approval — and the approval shows the destructive-change warnings first. Use before or during a deploy that needs a schema change; for the combined flow use safe_deploy with migrate=true. AWS container/microservices stacks.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'rollback_deployment',
    description:
      "Roll a broken deploy BACK to the previous build — the fastest incident fix there is. Every PlainOps build pushes an immutable v<timestamp> image, so on AWS container/microservices stacks this repoints the service at the previous image, waits for stability, and verifies the URL serves. For microservices pass the service name (or 'all'). REQUIRES founder click-approval. Serverless/static get honest git-based guidance instead (no retained artifacts). Use IMMEDIATELY when a fresh deploy broke production — roll back first, debug after.",
    input_schema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: "Microservices only: which service to roll back, or 'all'." },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'check_drift',
    description:
      "Infrastructure drift detection: compare what's REALLY in the cloud against the reviewed blueprint (read-only `tofu plan`). Finds manual console edits, out-of-band changes, and deleted resources before they bite. Free and read-only — run it when the founder says 'someone changed something', before promotions, and in production-readiness reviews. If drift exists I report exactly which resources changed and offer to restore the blueprint (that re-apply needs approval).",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'find_savings',
    description:
      "Cost-waste hunt (read-only) across this project's AWS region: unattached EBS volumes, orphaned Elastic IPs, load balancers with zero healthy targets, stopped instances still billing storage, forgotten NAT gateways — each with an estimated monthly cost. Run when the founder asks 'why is my bill high?' or wants to save money. Cleanups I propose afterwards each get their own approval.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'enable_cloud_monitoring',
    description:
      "Set up monitoring that KEEPS RUNNING WITH PLAINOPS CLOSED — inside the founder's own AWS account: a Route 53 health check probing the live URL every 30s from AWS's global network, a CloudWatch alarm that emails them when it fails twice in a row (and again on recovery), plus load-balancer alarms for unhealthy containers and 5xx bursts. Needs an email address for the alerts (SNS sends a confirmation link they must click). REQUIRES founder click-approval; costs about $0.50/month plus ~$0.10 per alarm. This is the always-on complement to enable_monitoring (which only watches while the app is open) — offer BOTH after any incident, and be explicit about which one survives a closed laptop.",
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Where AWS should send the alerts. Ask the founder for it if you do not have one.' },
      },
      required: ['email'],
      additionalProperties: false,
    },
  },
  {
    name: 'security_scan',
    description:
      "Read-only security posture scan of this project's AWS region: storage buckets exposed to the internet, management/database ports (SSH, RDP, MySQL, Postgres, Mongo, Redis) open to 0.0.0.0/0, publicly-addressable databases, unencrypted disks, missing root MFA, and access keys over a year old. Each finding names the resource, why it matters in one line, and the fix. Free and instant. Run when the founder asks 'is this secure?', before a launch, and in any production-readiness review. Fixes are proposed afterwards through the normal approval.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'setup_custom_domain',
    description:
      "Connect the founder's own domain to this project WITH HTTPS, on the cloud's native DNS — one guided pipeline. AWS: Route 53 zone → ACM certificate (DNS-validated) → HTTPS :443 listener on the load balancer → alias record (container/microservices stacks). GCP: Cloud Run domain mapping with a Google-managed certificate + Cloud DNS records. Azure: Container Apps hostname + free managed certificate + Azure DNS records. Hard precondition: the domain's DNS zone must be hosted in that cloud's DNS service (Route 53 / Cloud DNS / Azure DNS) or its nameservers delegated there — the tool detects this and returns the exact records/steps when it isn't, instead of failing blind. REQUIRES founder click-approval. Certificates and DNS need minutes to propagate — the result says so honestly. For one-off record changes (an MX, a TXT, a subdomain pointer) use the cloud CLIs directly instead.",
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'The full domain to connect, e.g. app.mydatingapp.com or mydatingapp.com.' },
      },
      required: ['domain'],
      additionalProperties: false,
    },
  },
  {
    name: 'notify_developer',
    description:
      "Send a message to the founder's configured developer channels (Slack / Discord / webhook — set up in Settings → Connectors; you choose the message, never the destination). Use after diagnosing an incident the developer must act on (a code bug, a crash they need to fix), after an important automated action, or when the founder asks you to alert someone. Keep it short and actionable: what broke, the evidence line, the next step.",
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Plain-language notification text.' },
        severity: { type: 'string', enum: ['info', 'warning', 'critical'], description: 'Default info.' },
      },
      required: ['message'],
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
          await recordDeployedCommit(project.name);
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
          await recordDeployedCommit(project.name);
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
          await recordDeployedCommit(project.name);
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
          await recordDeployedCommit(project.name);
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
          await recordDeployedCommit(project.name);
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
      const scope = input.scope === 'account' ? 'account' : input.scope === 'project' ? 'project' : undefined;
      return await collectDiagnosis(project.name, input.errorText ? String(input.errorText) : undefined, scope);
    }

    case 'setup_cicd': {
      if (!project.repoPath) return 'This project has no code folder attached — attach the repo first (analyze_repo with the path).';
      let plan;
      try {
        plan = generateWorkflow(project);
      } catch (e) {
        return (e as Error).message;
      }
      const verdict = await requestApproval({
        type: 'action',
        projectName: project.name,
        summary: `Write a GitHub Actions deploy pipeline into your repo:\n${project.repoPath}\\.github\\workflows\\${plan.fileName}\n\n${plan.note} Nothing runs until you push it and add the GitHub secrets.`,
      });
      if (verdict !== 'approved') return 'The founder did not approve writing the workflow. Nothing was written.';
      let dest: string;
      try {
        dest = writeWorkflow(project, plan);
      } catch (e) {
        return (e as Error).message;
      }
      auditLog({ type: 'cicd.workflow', summary: `Workflow written for ${project.name}: ${dest}` });
      return JSON.stringify(
        {
          written: dest,
          pipeline: plan.note,
          nextSteps: [
            `Commit and push the workflow file (git add .github && git commit -m "ci: plainops deploy pipeline" && git push).`,
            `In the GitHub repo: Settings → Secrets and variables → Actions → add ${plan.secretsNeeded.join(' and ')} (an IAM user scoped to this app).`,
            'Every push to main then deploys automatically in GitHub\'s cloud — the laptop can be off.',
            'Alternative that needs zero GitHub setup: enable_auto_deploy makes PlainOps itself redeploy on new commits while the app is open.',
          ],
        },
        null,
        2,
      );
    }

    case 'enable_auto_deploy': {
      const enable = input.enabled !== false;
      const interval = Number(input.intervalMinutes) || 3;
      if (!enable) {
        setAutoDeploy(project.name, false);
        return 'Auto-deploy is OFF for this project.';
      }
      if (!project.repoPath) return 'Attach the code folder first — auto-deploy watches its git remote.';
      if (!(await isGitRepo(project.repoPath))) return `${project.repoPath} is not a git repository (or git is not installed). Auto-deploy needs a repo with an upstream remote.`;
      if (project.status === 'new') return 'Deploy this project once first — auto-deploy reuses the existing deploy pipeline for the project\'s shape.';
      const verdict = await requestApproval({
        type: 'action',
        projectName: project.name,
        summary: `STANDING RULE — Auto-deploy for "${project.name}":\nWhile PlainOps is open, check the repo's git remote every ${interval} min and automatically pull + redeploy new commits.\nFuture deploys will NOT ask for a per-deploy click; every run is audited and sends a notification.`,
      });
      if (verdict !== 'approved') return 'The founder did not approve the standing rule. Auto-deploy stays off.';
      setAutoDeploy(project.name, true, interval);
      const channelHint = anyChannelConfigured() ? '' : ' Heads-up: no notification channel is configured yet (Settings → Connectors), so deploy results only appear in the app.';
      return `Auto-deploy is ON: checking the remote every ${interval} min while the app is open; new commits are pulled and shipped through the same verified pipeline.${channelHint}`;
    }

    case 'enable_monitoring': {
      const enable = input.enabled !== false;
      const interval = Number(input.intervalMinutes) || 2;
      if (!enable) {
        setMonitoring(project.name, false);
        return 'Monitoring is OFF for this project.';
      }
      const url = project.siteUrl ?? project.outputs?.app_url ?? project.outputs?.gateway_url ?? project.outputs?.api_url;
      if (!url) return 'Nothing to monitor yet — this project has no live URL. Deploy first.';
      setMonitoring(project.name, true, interval);
      const hint = watchtowerRequiresChannel();
      return `Watchtower is ON: probing ${url} every ${interval} min while the app is open. After 2 consecutive failures I automatically collect a full diagnosis and notify the developer.${hint ? `\n${hint}` : ''}`;
    }

    case 'verify_backups': {
      return await verifyBackups(project);
    }

    case 'backup_now': {
      const ds = datastoreOf(project);
      if (ds.kind === 'none') return 'Nothing to snapshot — this project has no datastore (the git repo is the source of truth).';
      const verdict = await requestApproval({
        type: 'action',
        projectName: project.name,
        summary: `Take an on-demand backup of "${project.name}"'s datastore now (${ds.kind === 's3' ? 'enable S3 versioning' : ds.kind.toUpperCase() + ' snapshot'}).`,
        costText: 'Backup storage beyond the free allowance bills at cents/GB-month.',
      });
      if (verdict !== 'approved') return 'The founder did not approve the backup. Nothing was created.';
      try {
        return await backupNow(project);
      } catch (e) {
        return `Backup failed: ${(e as Error).message}`;
      }
    }

    case 'run_dr_drill': {
      const verdict = await requestApproval({
        type: 'action',
        projectName: project.name,
        summary: `DISASTER-RECOVERY DRILL for "${project.name}": restore the latest backup into a TEMPORARY instance, verify it comes up, then delete it. Proves your backups actually restore.`,
        costText: 'A few cents (smallest instance for minutes). RDS/DocumentDB drills take 10–30 min.',
      });
      if (verdict !== 'approved') return 'The founder did not approve the drill. Nothing was created.';
      return withActionLock(async () => {
        try {
          return await runDrDrill(project, emitLog);
        } catch (e) {
          return `DR drill errored: ${(e as Error).message}. Any temporary restore resources may need manual cleanup — I can check with aws_cli.`;
        }
      });
    }

    case 'setup_environments': {
      if (project.name.endsWith('-stg')) return 'This IS the staging project. Switch to the production project to manage environments.';
      const twin = createStagingTwin(project);
      return JSON.stringify(
        {
          staging: twin.name,
          status: twin.status,
          flow: [
            `1. Deploy to staging: switch to project "${twin.name}" (project picker, top bar) and deploy there — or tell me and I'll run it.`,
            '2. Test the staging URL until you are happy.',
            `3. Back on "${project.name}", say "promote to production" — I verify staging is live and ship the exact commit it validated.`,
          ],
          note: 'Staging runs a full isolated copy of the infrastructure — roughly doubles the monthly cost while it exists; destroy it any time.',
        },
        null,
        2,
      );
    }

    case 'promote_to_production': {
      if (project.name.endsWith('-stg')) return 'Run promotion from the PRODUCTION project (without -stg) — it pulls from this staging twin.';
      const staging = getProject(stagingNameFor(project.name));
      if (!staging) return `No staging twin exists yet — run setup_environments first (it creates "${stagingNameFor(project.name)}").`;
      const stagingUrl = staging.siteUrl ?? staging.outputs?.app_url ?? staging.outputs?.gateway_url ?? staging.outputs?.api_url;
      if (!stagingUrl || staging.status !== 'live') return `Staging ("${staging.name}") is not live yet — deploy and verify it there first.`;
      const probe = await orchestrator.validateLive(stagingUrl, deps, undefined, 2, 3000);
      if (!probe.ok) return `Staging is marked live but ${stagingUrl} is NOT serving right now (${probe.detail}). Fix staging before promoting — I can run_diagnosis on it.`;

      // Promote the commit staging validated — flag drift honestly.
      let drift = '';
      if (project.repoPath && staging.deployedCommit) {
        const head = await gitHead(project.repoPath).catch(() => null);
        if (head && head !== staging.deployedCommit) {
          if (!input.acceptNewerCommit) {
            return `The repo has moved past what staging tested: staging validated ${staging.deployedCommit.slice(0, 10)}, but the repo is now at ${head.slice(0, 10)}. Either redeploy staging first (safest), or ask the founder if they want to promote the newer commit anyway — then call again with acceptNewerCommit=true.`;
          }
          drift = ` (promoting ${head.slice(0, 10)}, NEWER than the staging-tested ${staging.deployedCommit.slice(0, 10)} — founder accepted)`;
        }
      }
      if (project.status === 'new' && !project.siteBucket && (project.cloud ?? 'aws') === 'aws' && (project.archetype ?? staging.archetype) === 'app') {
        return 'Production has never been provisioned. For an AWS container app, run propose_infrastructure + provision_infrastructure on production once; after that, promotions are one step.';
      }
      const verdict = await requestApproval({
        type: 'deploy',
        projectName: project.name,
        summary: `PROMOTE staging → production for "${project.name}"${drift}: staging is verified serving (${probe.detail}); production now redeploys through the same pipeline.`,
      });
      if (verdict !== 'approved') return 'The founder did not approve the promotion. Production is unchanged.';
      return withActionLock(async () => {
        try {
          const prod = getProject(project.name)!;
          const url = await redeployProject({ ...prod, archetype: prod.archetype ?? staging.archetype, repoPath: prod.repoPath ?? staging.repoPath }, emitLog);
          await recordDeployedCommit(project.name);
          auditLog({ type: 'promote.done', summary: `${staging.name} → ${project.name} promoted — verified at ${url}` });
          return `Promoted to production — LIVE and verified at ${url}${drift}`;
        } catch (e) {
          return `Promotion failed: ${(e as Error).message}. Production may be mid-rollout — run_diagnosis will show its real state.`;
        }
      });
    }

    case 'safe_deploy': {
      if (!project.repoPath) return 'This project has no code attached. Give me the folder path (analyze_repo with path) or describe the app (scaffold_app) first.';
      if (project.status === 'new') return 'Nothing is deployed yet, so there is no previous build to fall back to — use the normal deploy flow for the first release, then safe_deploy from then on.';
      const migrate = input.migrate === true;
      const preview = releasePreview(project, migrate);
      const verdict = await requestApproval({
        type: 'deploy',
        projectName: project.name,
        summary: `SAFE DEPLOY of "${project.name}"${migrate ? ' WITH database migrations' : ''}:\n${preview}`,
      });
      if (verdict !== 'approved') return 'The founder did not approve the release. Nothing was deployed.';
      return withActionLock(async () => {
        try {
          return await safeDeploy(project.name, {
            migrate,
            service: input.service ? String(input.service) : undefined,
            watchSeconds: input.watchSeconds ? Number(input.watchSeconds) : undefined,
          }, emitLog);
        } catch (e) {
          return `Release stopped: ${(e as Error).message}`;
        }
      });
    }

    case 'run_migrations': {
      if (!project.repoPath) return 'This project has no code attached — migrations are detected from the repo.';
      const plan = detectMigrations(project.repoPath);
      if (!plan) return 'No migration tool detected in this repo (looked for Prisma, Knex, Sequelize, TypeORM, node-pg-migrate, Django, Alembic, Rails, Flyway). If migrations run some other way, tell me the command and I can run it as a one-off task.';
      const risks = scanMigrationRisks(project.repoPath);
      const ds = datastoreOf(project);
      const verdict = await requestApproval({
        type: 'action',
        projectName: project.name,
        summary: `Run database migrations for "${project.name}":\n${plan.tool} — ${plan.command}\n\n${describeRisks(risks)}\n\n${ds.kind === 'none' ? 'No datastore snapshot is possible for this project.' : `A ${ds.kind.toUpperCase()} snapshot is taken first.`}`,
      });
      if (verdict !== 'approved') return 'The founder did not approve running migrations. The database is untouched.';
      return withActionLock(async () => {
        try {
          const notes: string[] = [];
          if (ds.kind !== 'none') {
            emitLog('Snapshotting the database before migrating…');
            notes.push(await backupNow(project));
          }
          notes.push(await runMigrations(project, plan, emitLog));
          return notes.join('\n');
        } catch (e) {
          return `Migration failed: ${(e as Error).message}`;
        }
      });
    }

    case 'rollback_deployment': {
      const verdict = await requestApproval({
        type: 'deploy',
        projectName: project.name,
        summary: `ROLL BACK "${project.name}" to the previous build${input.service ? ` (service: ${String(input.service)})` : ''} and verify it serves.`,
      });
      if (verdict !== 'approved') return 'The founder did not approve the rollback. Nothing was changed.';
      return withActionLock(async () => {
        try {
          return await rollbackDeployment(project, input.service ? String(input.service) : undefined, emitLog);
        } catch (e) {
          return `Rollback failed: ${(e as Error).message}`;
        }
      });
    }

    case 'check_drift': {
      try {
        return await checkDrift(project, emitLog);
      } catch (e) {
        return `Drift check failed: ${(e as Error).message}`;
      }
    }

    case 'find_savings': {
      try {
        return await findSavings(project.region);
      } catch (e) {
        return `Savings scan failed: ${(e as Error).message}`;
      }
    }

    case 'enable_cloud_monitoring': {
      const email = String(input.email ?? '').trim();
      const url = project.siteUrl ?? project.outputs?.app_url ?? project.outputs?.gateway_url ?? project.outputs?.api_url;
      if (!url) return 'Nothing to monitor yet — deploy the project first.';
      const verdict = await requestApproval({
        type: 'action',
        projectName: project.name,
        summary: `Set up ALWAYS-ON monitoring in your AWS account for "${project.name}":\nRoute 53 health check on ${url} (every 30s, globally) + CloudWatch alarms (site down, unhealthy containers, 5xx burst) emailing ${email}.\nThis keeps watching when PlainOps is closed.`,
        costText: '~$0.50/month for the health check + ~$0.10 per alarm.',
      });
      if (verdict !== 'approved') return 'The founder did not approve cloud monitoring. Nothing was created.';
      return withActionLock(async () => {
        try {
          return await enableCloudMonitoring(project, email, emitLog);
        } catch (e) {
          return `Cloud monitoring setup failed: ${(e as Error).message}`;
        }
      });
    }

    case 'security_scan': {
      if ((project.cloud ?? 'aws') !== 'aws') {
        return `The built-in posture scan covers AWS today. For ${project.cloud === 'gcp' ? 'Google Cloud' : 'Azure'} I can run targeted read-only checks with the CLI (public buckets, open firewall rules, public database IPs) — say the word and I'll do that now.`;
      }
      try {
        return await scanSecurity(project.region);
      } catch (e) {
        return `Security scan failed: ${(e as Error).message}`;
      }
    }

    case 'setup_custom_domain': {
      const domain = String(input.domain ?? '').trim().toLowerCase();
      if (!isValidDomain(domain)) return `"${input.domain}" doesn't look like a valid domain — expected something like app.example.com.`;
      const url = project.siteUrl ?? project.outputs?.app_url ?? project.outputs?.gateway_url ?? project.outputs?.api_url;
      if (!url) return 'Deploy the project first — a domain needs something live to point at.';
      const cloudLabel = (project.cloud ?? 'aws') === 'gcp' ? 'Google Cloud' : (project.cloud ?? 'aws') === 'azure' ? 'Azure' : 'AWS';
      const verdict = await requestApproval({
        type: 'action',
        projectName: project.name,
        summary: `Connect https://${domain} to "${project.name}" on ${cloudLabel}: create the TLS certificate, DNS records, and (on AWS) an HTTPS :443 listener on your load balancer.`,
        costText: 'Certificates are free on all three clouds; a Route 53 hosted zone bills $0.50/month if one has to exist.',
      });
      if (verdict !== 'approved') return 'The founder did not approve the domain setup. Nothing was changed.';
      return withActionLock(async () => {
        try {
          return await setupCustomDomain(project, domain, emitLog);
        } catch (e) {
          return `Domain setup stopped: ${(e as Error).message}`;
        }
      });
    }

    case 'notify_developer': {
      const message = String(input.message ?? '').trim();
      if (!message) return 'No message provided.';
      if (!anyChannelConfigured()) {
        return 'No notification channel is configured. Ask the founder to open Settings → Connectors and add a Slack, Discord, or webhook URL — then I can notify their team.';
      }
      const severity = input.severity === 'critical' ? 'critical' : input.severity === 'warning' ? 'warning' : 'info';
      const res = await notifyDeveloper(project.name, severity, message);
      const ch = configuredChannels();
      return `Notification ${res.sent.length ? `sent via ${res.sent.join(', ')}` : 'FAILED on every channel'}${res.failed.length ? ` (failed: ${res.failed.join(', ')})` : ''}. Configured channels: ${Object.entries(ch).filter(([, v]) => v).map(([k]) => k).join(', ')}.`;
    }

    default:
      return `Error: unknown tool ${name}.`;
  }
}
