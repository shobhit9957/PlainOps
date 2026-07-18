# PLAINOPS Architecture

How the system actually works, end to end. For the security guarantees see
[SECURITY.md](SECURITY.md); for failure modes see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Design constraints

Every structural decision follows from four constraints:

1. **Nothing leaves the user's machine except calls to their own AWS and their own
   Anthropic key.** There is no PLAINOPS backend to deploy, operate, or breach.
2. **The AI proposes; the human approves; the machine executes.** The model never
   holds the authority to change infrastructure.
3. **The AI must not be able to see a secret value**, even by accident, even in an
   echoed log line.
4. **A founder must never be handed a broken URL.** "Live" is a measured fact, not
   an optimistic status.

## Process model

One Node process. No database, no queue, no daemon.

```
┌──────────────────────────── your laptop ───────────────────────────┐
│                                                                    │
│  web/  ──fetch/SSE──►  src/server.ts (Express, localhost:7717)      │
│                              │                                     │
│                              ▼                                     │
│                     src/agent/loop.ts                              │
│                     per-project FIFO queue                          │
│                     tool loop, MAX_TURNS 12                         │
│                              │                                     │
│                    ┌─────────┴─────────┐                           │
│                    ▼                   ▼                           │
│              src/gate.ts        src/agent/tools.ts (15 tools)      │
│           approval + lock              │                           │
│                                        ▼                           │
│         orchestrator · tofu · aws · awscli · vault · scrub         │
│                                        │                           │
└────────────────────────────────────────┼───────────────────────────┘
                                         ▼
                          Anthropic API          YOUR AWS ACCOUNT
                        (plans only, scrubbed)   (all real resources)
```

State is files under `~/.plainops/` (override with `PLAINOPS_HOME`):

```
config.json                  model, port, Anthropic key
state.json                   Project records (status, region, blueprint, outputs)
audit.log                    append-only scrubbed JSONL
vault.key / vault.enc        AES-256-GCM secret vault (0600)
projects/<name>/tf/          rendered HCL + terraform.tfstate
projects/<name>/workspace/   code written by scaffold_app
bin/                         auto-downloaded OpenTofu
```

## The turn loop and why it queues

`src/agent/loop.ts` maintains **one FIFO queue per project**. Only one message is
processed at a time; anything typed mid-deploy is queued and answered after.

This is load-bearing, not politeness. The Anthropic Messages API requires every
`tool_use` block to be immediately followed by its matching `tool_result`. Handling
a second message concurrently spliced a user turn into that pair and hard-failed the
API with a 400, killing an in-flight deploy. The queue makes that structurally
impossible. `chat.busy` / `chat.queued` / `chat.idle` events drive the dashboard's
"Working…" state so the UI never offers a Run button during a deploy.

Every streamed delta and assistant message passes through `scrub()` before it
reaches the bus.

## The 15 tools

| Tool | Effect | Gate |
|---|---|---|
| `analyze_repo` | Detect framework/port/env vars; optionally attach a code path | free |
| `scaffold_app` | Write a generated file set into the project workspace | free (local writes only) |
| `propose_infrastructure` | Size the stack and return a cost estimate; creates nothing | free |
| `provision_infrastructure` | `tofu apply` the container blueprint | **approval** + lock |
| `set_app_secret` | Open the dashboard's secure box for one secret NAME | **human-in-loop** |
| `deploy_application` | zip → S3 → CodeBuild → roll ECS → HTTP-verify | **approval** + lock |
| `deploy_static_website` | S3 static website deploy | **approval** + lock |
| `deploy_serverless` | Apply the serverless blueprint and verify the API URL | **approval** + lock |
| `deploy_microservices` | Multi-service blueprint, build each image, verify | **approval** + lock |
| `inspect_aws` | Read-only inventory (EC2, ECS, site buckets) | free |
| `aws_cli` | Arbitrary `aws` CLI | **conditional** (see below) |
| `get_status` | Stored status **plus a live HTTP probe** | free |
| `get_recent_logs` | CloudWatch log events for the project | free |
| `get_costs` | Cost Explorer actuals, last 14 days, by project tag | free |
| `destroy_infrastructure` | `tofu destroy` / static teardown | **approval** + lock |

Every tool result is passed through `scrub()` before returning to the model.

## Approval gate

`src/gate.ts` is the enforcement point.

- `requestApproval()` creates a `PendingAction` with a UUID, writes an audit entry,
  emits `action.pending`, and returns a promise.
- That promise resolves **only** via `POST /api/action/:id/:verdict` — a human click
  in the dashboard — or auto-**rejects** after `PLAINOPS_GATE_TIMEOUT_MS`
  (default 15 minutes).
- The model has no tool that resolves a gate. Approval is an HTTP code path, so a
  prompt-injection payload hidden in a user's repository cannot approve itself.
- `withActionLock()` serializes mutating pipelines so two deploys can't interleave.

**Known nuance:** `aws_cli` is gated but is *not* wrapped in `withActionLock`, so an
approved mutating CLI command can run concurrently with a deploy.

## Raw AWS access (`src/awscli.ts`)

So the agent can do things no blueprint covers, without becoming a blank cheque.
`classifyAws(args)` reads `positional[0]` as service and `positional[1]` as operation:

- **denied** — `get-secret-value`, `get-password-data`, `create-access-key`,
  `create-login-profile`, `update-login-profile`, and `get-parameter(s)` with
  `--with-decryption`. These are refused outright; they are the commands that would
  hand the model a credential.
- **read** — operation matches a read prefix (`describe`, `list`, `get`, `head`,
  `query`, `scan`, `search`, `lookup`, `batch-get`, `select`, `view`, `count`,
  `preview`, `estimate`, `test`, `validate`, `simulate`, `filter`, `check`). Runs
  immediately, no approval. **Special case:** for `s3`, only `ls` counts as read.
- **mutate** — everything else. Requires approval.

`withRegion()` appends the project's `--region` unless present, skipping global
services (`s3`, `s3api`, `iam`, `sts`, `route53`, `cloudfront`, `organizations`,
`budgets`). Execution is `execFile` with `shell: false`, a 60s timeout and an 8 MB
buffer; output is truncated to 6000 chars before it reaches the model.

*The read prefixes are deliberately broad and slightly over-permissive — an
operation like `test-failover` classifies as read. Tighten if that matters to you.*

## Secret pipeline

Three modules cooperate:

- **`src/vault.ts`** — AES-256-GCM. `vault.key` is 32 random bytes (mode `0600`);
  `vault.enc` stores `{iv, tag, data}` with a 12-byte random IV. Names must match
  `/^[A-Z][A-Z0-9_]*$/`. `_allSecretsForScrubbing()` is the only full-map accessor
  and is never exposed over HTTP.
- **`src/scrub.ts`** — reads the vault map, keeps values ≥6 chars, sorts
  **longest-first** (so an overlapping shorter value can't leave a partial leak),
  and literal-replaces each with `{{secret:NAME}}`. Also regex-masks
  `AKIA[0-9A-Z]{16}`.
- **`src/gate.ts`** — `requestSecretValue()` emits `secret.request` and resolves a
  **boolean**. The value never transits the gate.

Flow: the model calls `set_app_secret("DATABASE_URL")` → the dashboard opens a
secure box → `POST /api/secret` puts the value in the vault and writes it straight
to AWS Secrets Manager via the SDK → the blueprint references the secret **ARN**, so
ECS injects it at runtime and the value never appears in tfvars, plan, or state.

## Infrastructure execution

`src/tofu.ts` resolves an OpenTofu binary in this order: `PLAINOPS_TOFU_PATH` →
`PATH` → auto-download (pinned `1.9.1`, falling back `1.9.0`, `1.8.1`) into
`~/.plainops/bin`. It streams every output line to the dashboard and parses
`output -json`.

`src/blueprint/render.ts` copies reviewed HCL and writes `terraform.tfvars.json`.
**The AI never authors Terraform.** It chooses a blueprint and its parameters; the
HCL itself is fixed and reviewed. This is what makes the output predictable.

### Container blueprint (`src/blueprint/files/main.tf`)

VPC + multi-AZ public subnets + IGW + route table; three security groups (alb /
service / rds); ALB + target group + HTTP listener; ECR; CloudWatch log group;
CodeBuild project (+ IAM role) that builds the image **inside the user's account**
so no local Docker is needed; ECS cluster, task-execution and task roles, task
definition (Fargate/awsvpc), service; application autoscaling target + CPU-70
target-tracking policy; one Secrets Manager shell per declared secret name;
optionally a DB subnet group + `aws_db_instance` (Postgres 16, `db.t4g.micro`, 20 GB
gp3, AWS-managed master password); and a monthly `aws_budgets_budget` with 80% /
100% email alerts.

No NAT gateway — tasks run in public subnets with public IPs, which removes ~$32/mo.

### Serverless blueprint

DynamoDB (PAY_PER_REQUEST, hash key `id`); SQS processing queue (60s visibility,
redrive at 3 receives) + DLQ (14-day retention); two `nodejs20.x` Lambdas (api
15s/256MB, worker 30s/256MB) with their own roles and log groups; SQS→worker event
source mapping (batch 5); API Gateway **HTTP** API with a `$default` route and
auto-deploy stage plus the invoke permission.

### Microservices blueprint

One shared ALB routing to the gateway service; **Cloud Map** private DNS namespace
`<project>.internal` giving each service a stable internal address injected as
`<NAME>_URL`; per service (`for_each`) an ECR repo, log group, CodeBuild project,
task definition, ECS service and autoscaling pair. Optional Amazon DocumentDB
(5.0, `db.t3.medium`) with a cluster parameter group setting **`tls = disabled`**,
a generated password in Secrets Manager, and a composed `MONGODB_URI`. Optional
ElastiCache Redis (`cache.t3.micro`) injected as `REDIS_URL`.

Services are auto-detected by `src/microservices.ts`: every subfolder with a
Dockerfile is a service, the port comes from `EXPOSE`, a Mongo/Redis dependency in
`package.json` sets `needs_db` / `withCache`, and a name like `gateway` marks the
public entrypoint.

### Static site

No Terraform at all — direct SDK calls creating one bucket
`plainops-site-<project>-<account>`, disabling block-public-access, setting the
website config, applying a public-read policy, and uploading with correct content
types. Teardown empties then deletes.

## Live validation

`orchestrator.validateLive()` polls the URL (default 18 attempts, 10s apart) and
requires a real **200–399**. A deploy that provisions cleanly but serves 503 is
*not* marked live: the project stays `provisioned`, and the error explains how to
read the logs. `get_status` re-probes on every call so the agent cannot report
"live" from stale state.

## Cost estimation

`src/estimator.ts` is a hand-maintained price table (currently `us-east-1` and
`ap-south-1`) producing per-line monthly costs, plus daily/yearly derivations and an
explicit ±15% disclaimer. It is deliberately *not* an AWS API call — the estimate
must be instant and available before anything exists. `get_costs` reports **actuals**
from Cost Explorer, filtered by the `plainops-project` tag.

## Testing

15 files, 76 tests, `vitest`. AWS is faked with `aws-sdk-client-mock`; the
orchestrator exposes an injectable `OrchestratorDeps`; the agent loop accepts a fake
Anthropic client. Every test points `PLAINOPS_HOME` at a fresh temp dir.

The suite covers the security-critical paths directly: vault round-trips and
ciphertext-on-disk, scrubbing of multiline and regex-metacharacter values, approval
approve/reject/timeout, the action lock, `aws_cli` classification, and that the
orchestrator is **not** called when a human rejects.

## Scripts

| Script | Purpose |
|---|---|
| `validate-blueprint.mjs` | `tofu validate` the container blueprint |
| `validate-microservices.mjs` | Render ShopFlow, then `tofu init -backend=false` + validate |
| `validate-real.mjs` | Render a container blueprint with DB + secret into a temp home, validate |
| `deploy-static-demo.mjs` | Real S3 static deploy/destroy |
| `deploy-fargate-demo.mjs` | Real Fargate deploy/destroy |
| `deploy-serverless-demo.mjs` | Real serverless deploy/destroy |
| `deploy-microservices-demo.mjs` | Real multi-service deploy/destroy |
| `generate-services.mjs` | Generate N (1–200) microservices + gateway + test frontend |
| `destroy-project.mjs` | Tear down any stored project by name |

The `deploy-*` scripts create **real, billable** AWS resources.

## Deliberate non-goals

- No PLAINOPS-hosted control plane, ever.
- The AI does not author Terraform freehand — it selects reviewed blueprints.
- No auto-approval mode. The human click is the product.
- No secret value in logs, audit, Terraform state, or model context.
