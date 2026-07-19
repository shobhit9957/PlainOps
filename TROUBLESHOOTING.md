# Troubleshooting

Real failure modes with their real error text, so you can search for the message
you're staring at. Each entry says what actually causes it — not a guess.

---

## Provisioning fails at the very end: `Bucket ... does not exist`

```
Error: creating CodeBuild Project (po-<project>): InvalidInputException:
Bucket plainops-<account>-<region>/<project>/source.zip does not exist
```

**This is the most misleading failure in the system.** Everything succeeds — VPC,
load balancer, the 6-minute RDS instance — and then the *last* resource fails, so it
reads like a random infrastructure problem. It isn't.

**Cause:** the **bootstrap bucket** `plainops-<account>-<region>` is missing.
CodeBuild validates its S3 source at `CreateProject` time, and that bucket is where
PLAINOPS stages your `source.zip` (and your tfstate backups). Almost always it was
deleted by a well-meaning "clean up my AWS account" sweep — the name looks like
orphaned junk, and it is not.

**Fix — recreate it exactly as PLAINOPS does (private + versioned):**

```bash
BKT=plainops-<account>-<region>; REGION=<region>
aws s3api create-bucket --bucket "$BKT" --region "$REGION" \
  --create-bucket-configuration LocationConstraint="$REGION"
aws s3api put-public-access-block --bucket "$BKT" \
  --public-access-block-configuration \
  BlockPublicAcls=true,BlockPublicPolicy=true,IgnorePublicAcls=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$BKT" --versioning-configuration Status=Enabled
```

Then provision again.

**Prevention:** `ensureProjectSetup()` now calls the idempotent
`ensureBootstrapBucket()` on **every** provision instead of trusting the cached
`bootstrapBucket` in `state.json`, so a deleted bucket self-heals. Covered by
`tests/orchestrator.test.ts`. Don't reintroduce the "already recorded, skip it"
short-circuit.

> **⚠️ Never delete `plainops-<account>-<region>`.** It is infrastructure, not
> leftovers. It holds your build source and your Terraform state backups.

---

## `tofu apply failed — see log above` and nothing else

The tool surface returns a generic message; the real cause is in the **streamed
log**, in the dashboard chat.

**Do not pattern-match a cause from resource names.** Scroll to the `Error:` line
and read it. Every hour lost on this project was lost by guessing a cause instead of
reading one. If you genuinely cannot see the log, say so and ask for it rather than
deleting resources on a hypothesis.

---

## Repeated failures after you deleted AWS resources by hand

Symptoms: `already exists` clashes, phantom resources, teardowns that leave things
behind, applies that recreate things you just removed.

**Cause:** deleting resources out-of-band while OpenTofu manages them desynchronizes
state from reality.

**Fix:** let OpenTofu reconcile. A plain `tofu apply` (provision again) refreshes
state, notices what's gone, and recreates it — that is the designed recovery path.
For a genuine clean slate use `destroy_infrastructure`, not manual deletion.

**Reading the state directly:**

```bash
# what tofu believes exists
cat ~/.plainops/projects/<name>/tf/terraform.tfstate | python -c \
 "import sys,json;d=json.load(sys.stdin);[print(r['type']+'.'+r['name']) for r in d['resources']]"
```

An empty `terraform.tfstate` (~283 bytes, `"resources":[]`) alongside a large
`terraform.tfstate.backup` means a `destroy` completed successfully.

---

## Deploy says infrastructure is up, but the URL returns 503

Expected and handled. `validateLive` requires a real 200–399, so PLAINOPS leaves the
project as `provisioned` rather than `live` and tells you to check logs.

**Cause:** the container isn't passing its ALB health check — usually it crashed on
boot, listens on the wrong port, or its health path 404s.

```
(service po-x) was unable to place a task / task stopped
essential container in task exited
```

Use `get_recent_logs`. Common culprits: the app reads an env var that is empty, binds
`127.0.0.1` instead of `0.0.0.0`, or has no `/health` route while the target group
expects one.

**Note:** `draining connections` / `deregistered targets` / `stopped running tasks`
during a deploy is **normal** — that's the old task handing over to the new one.
Check for `has reached a steady state.` before assuming something broke.

---

## RDS blocks everything for 6–10 minutes

Databases are the slowest resource to create *and* delete, and you cannot create one
while another of the same identifier is still deleting.

```
DBInstanceAlreadyExists / status: deleting
```

Wait for `DBInstanceNotFound` before re-provisioning:

```bash
aws rds describe-db-instances --db-instance-identifier po-<project> \
  --query 'DBInstances[0].DBInstanceStatus' --region <region>
```

Deletion cannot be cancelled. Budget ~6 minutes to create, up to ~10 to delete.

---

## Migrations fail with `FATAL 28000` / `ClientAuthentication` (exit code 1)

**Signature** (from the one-off migration task's logs):

```
severity: 'FATAL', code: '28000', file: 'auth.c', routine: 'ClientAuthentication'
```

**Cause:** RDS PostgreSQL 15+ defaults `rds.force_ssl = 1`. The app connects
fine because it sets `ssl` explicitly, but migration CLIs read the plain
`DATABASE_URL` and get rejected for connecting without TLS.

**Fix (already in `run_migrations`):** node-postgres-based tools
(node-pg-migrate, Knex, Sequelize, TypeORM) get `PGSSLMODE=no-verify` injected
into the one-off task, which makes them use TLS the way the app does. If you
run a migration by hand through `aws_cli`, add that env var yourself. Python/
Ruby tools use libpq, which rejects `no-verify` — use `PGSSLMODE=require`
there instead.

Diagnosed live 2026-07-19: the snapshot taken before the failed run was the
restore point, production never deployed — the ordering held.

---

## Safe deploy reverted a release that "worked when I tested it"

`safe_deploy`'s health gate is a **sustained watch**, not a single ping: it
probes the URL every 10 s for the whole watch window and reverts on two
consecutive failures. A release that serves its first request and dies two
minutes later (memory leak, connection-pool exhaustion, time-bomb config) is
exactly what it exists to catch. Read the gate log lines — they show the
precise check number where the release went bad; `run_diagnosis` collects the
matching container logs.

---

## DocumentDB: `Unsupported mechanism [-301]`

**Cause:** DocumentDB requires TLS by default and the driver/URI combination fails.

**Fix (already in the blueprint):** a `docdb5.0` cluster parameter group with
`tls = disabled`, and a URI with `authSource=admin&retryWrites=false`. Setting
`tls=true`/`tlsInsecure` on the URI alone does not work.

---

## Microservices: gateway is up but calls downstream time out

**Cause:** the deploy declared success when only the gateway was stable, while
dependencies were still starting.

**Fix (already in `src/microservices.ts`):** wait for **all** services to reach a
steady state before validating. If you refactor the deploy path, keep that.

---

## Can't deploy ~50 microservices

```
Fargate vCPU limit exceeded / unable to place task
```

**Cause:** the default Fargate vCPU service quota (often ~6) — not a PLAINOPS bug.
50 services also costs roughly $500/month. Request a quota increase, or deploy fewer,
larger services. `scripts/generate-services.mjs` will happily generate more than your
account can run.

---

## `spawn ...tofu.exe ENOENT`

**Cause:** a **relative** `PLAINOPS_HOME`. The tofu binary path breaks once the
process spawns with a different working directory.

**Fix:** already handled — `config.ts` wraps it in `path.resolve()`. If you set
`PLAINOPS_HOME` yourself, use an absolute path. Regression-tested in
`tests/config.test.ts`.

---

## API 400 crash when typing during a deploy

```
messages: tool_use ids were found without tool_result blocks immediately after
```

**Cause:** a second message was processed while a `tool_use`/`tool_result` pair was
open.

**Fix:** the per-project FIFO queue in `src/agent/loop.ts`. Messages typed mid-deploy
are queued (`chat.queued`) and answered afterwards. Don't remove it.

---

## git-bash mangles CloudWatch log group names

`/plainops/my-site` becomes `C:/Program Files/Git/plainops/my-site`.

```bash
export MSYS_NO_PATHCONV=1
```

Set it before any AWS command containing a `/`-prefixed argument.

---

## Approval button never appears / action seems stuck

Approvals auto-**reject** after `PLAINOPS_GATE_TIMEOUT_MS` (default 15 minutes), and
only one mutating action runs at a time (`withActionLock`). If a deploy is running,
a second mutating action waits.

**This is deliberate:** nothing mutates without a human click, so an unapproved
action waiting forever is the safe failure mode. To cancel a queued destructive
action, click **Reject** — never approve "just to clear it."

---

## Onboarding: "AWS credentials NOT FOUND"

```bash
aws configure
aws sts get-caller-identity   # must succeed
```

PLAINOPS reads your local AWS config; it never uploads credentials.

---

## "Could not download OpenTofu"

Install OpenTofu or Terraform yourself and point at it:

```bash
export PLAINOPS_TOFU_PATH=/path/to/tofu
```

Pinned versions attempted: `1.9.1`, then `1.9.0`, then `1.8.1`.

---

## Costs panel shows $0 / "No billing data yet"

Normal. AWS billing data lags up to ~24 hours. The **estimate** is immediate; the
**actuals** (`get_costs`, Cost Explorer, filtered by the `plainops-project` tag)
take a day to appear.

---

## Verifying you're actually clean after teardown

Idle infrastructure is the expensive kind — an ALB + RDS left running is ~$35/month
for nothing.

```bash
export MSYS_NO_PATHCONV=1; REGION=<region>
aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerName' --region $REGION
aws rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier' --region $REGION
aws ecs list-clusters --region $REGION
aws ec2 describe-vpcs --filters "Name=tag:managed-by,Values=plainops" --region $REGION
aws elasticache describe-cache-clusters --region $REGION
aws docdb describe-db-clusters --region $REGION
```

An ECS cluster reporting `INACTIVE` is a harmless deleted-cluster shell; it does not
bill and does not block recreating a cluster of the same name.

**Keep the `plainops-<account>-<region>` bucket.** It costs cents and deleting it
breaks your next deploy (see the top of this file).
