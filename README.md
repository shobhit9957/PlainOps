# >_ PlainOps

**Type English. Deploy to your own cloud.**

PlainOps is a local-first AI DevOps engineer you install on your own machine. Connect
your own AWS / Google Cloud / Azure account and your own Anthropic API key, then deploy
real applications by describing them in plain English. Your cloud credentials and secret
values **never leave your machine**, and the AI **never sees a secret value**.

Not a SaaS. There is no PlainOps server. Everything runs on localhost.

## What it does

| | AWS | Google Cloud | Azure |
|---|---|---|---|
| **Monolith / app** | ECS Fargate + ALB + RDS Postgres | Cloud Run + Cloud SQL | Container Apps + PostgreSQL Flexible |
| **Serverless** | API Gateway + Lambda + SQS + DynamoDB | Cloud Functions + Pub/Sub + Firestore | Functions + Storage queue/table |
| **Microservices** | ECS per service + Cloud Map + DocumentDB (Mongo) + Redis | Cloud Run per service + Cloud SQL/Memorystore | Container Apps per service + Cosmos DB (Mongo) + Redis |
| **Static site** | S3 website hosting | — | — |

Plus, on every cloud:

- **Answers any question** about your infra, architecture, or bill — grounded in your
  real account via read-only CLI access (`aws` / `gcloud` / `az`), not guesses.
- **Cost dashboard** — a monthly estimate for every project before anything is created,
  portfolio totals per cloud, and real AWS spend (Cost Explorer).
- **Diagnosis** — one click (or "something's broken") collects the live URL probe,
  service state, real application logs, infra state, and recent actions, then explains
  the root cause in plain English with a concrete fix.
- **Do-anything CLI access** with guardrails: read-only commands run instantly; anything
  mutating needs your click; commands that would expose credentials are refused.
- **Day-2 operations** — the work a DevOps engineer actually does after launch: safe
  deploys with automatic rollback, database migrations (linted, snapshot-first),
  one-command rollback to the previous build, secret rotation end-to-end, cron jobs on
  your own infra, backups + restore drills, drift detection, cost-waste sweeps, security
  posture scans, launch preflight (quota/scaling/connection math), EOL version watch,
  custom domains + HTTPS, staging→production promotion, CI/CD generation, and always-on
  cloud-resident monitoring that keeps alerting with your laptop closed.
- **Adopted infrastructure**: point a project at a cloud where your app already runs —
  even if PlainOps never deployed it — and diagnosis sweeps the whole
  region/project/subscription: unhealthy services flagged, error logs, failing operations.

## The security model (the product promise)

1. **Credentials stay home.** Deploys use your local `aws`/`gcloud`/`az` auth. Nothing
   is uploaded anywhere except calls to your own cloud and your own Anthropic key.
2. **The AI never sees a secret value.** Secrets go into an AES-256-GCM local vault and
   straight to your cloud's secret store. The model only ever sees `{{secret:NAME}}`.
   Every model-facing string is scrubbed first.
3. **The AI proposes; you approve; the machine executes.** Every mutating action waits
   for a real click in the dashboard — an approval is a code path, not a prompt rule.
4. **The AI never authors Terraform.** It parameterizes reviewed OpenTofu blueprints
   (all 9 validate in CI), so what gets created is predictable.
5. **"Live" is measured.** No deploy is called live until the URL returns a real
   HTTP 200 — never a hopeful status.
6. **Container images build in *your* cloud** (CodeBuild / Cloud Build / ACR Tasks) —
   no local Docker required.

## Install

**Desktop app (recommended):** run `PlainOps-Setup-<version>.exe` (Windows). macOS
builds come from `npm run dist:mac` on a Mac (or the GitHub Actions workflow).

**From source:**

```bash
npm install
npm start          # dashboard at http://localhost:7717
npm run demo       # scripted walkthrough — no cloud accounts or API key needed
```

Prerequisites: Node 20+, plus the CLI of each cloud you want to use. The one-time
per-cloud setup — including GCP's two-step login (CLI **and** Application Default
Credentials) that's easy to miss — is spelled out in **[CLOUD_SETUP.md](CLOUD_SETUP.md)**.
OpenTofu auto-downloads on first use.

## First five minutes

1. Open PlainOps → pick a cloud → name a project (region is pre-picked per cloud).
2. Paste your Anthropic API key (stored locally).
3. Type: *"deploy C:\code\my-app"* — or just *describe* the app and PlainOps writes it.
4. Read the cost estimate, click **Approve**.
5. Get a verified live URL. Ask "how much is this costing me?" or "run a diagnosis" any time.

## Honest status

- **AWS paths are battle-tested** — static, container, serverless, and microservices have
  all been deployed live, verified, and torn down on a real account.
- **GCP and Azure paths are new**: every blueprint passes `tofu validate` and the full
  pipeline is unit-tested, but they have not yet been proven against live GCP/Azure
  accounts. First live runs may surface provider quirks — the diagnosis tool and honest
  error surfaces are there for exactly that.
- GCP/Azure **billing actuals** aren't wired yet (estimates + on-demand CLI lookups are).
- Static-site hosting is AWS-only for now.

## Develop

```bash
npm test                     # vitest — 29 files, 179 tests
npm run typecheck
npm run validate:all-blueprints   # tofu-validates all 9 blueprints
npm run build                # compile + assets for the desktop shell
npm run dist:win             # Windows installer (NSIS) into release/
```

Architecture, security details, and failure modes: [ARCHITECTURE.md](ARCHITECTURE.md) ·
[SECURITY.md](SECURITY.md) · [TROUBLESHOOTING.md](TROUBLESHOOTING.md) · agents start at
[CLAUDE.md](CLAUDE.md).
