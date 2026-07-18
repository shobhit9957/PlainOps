# PLAINOPS Quick Start

Deploy your first app to your own AWS account in about five minutes.

## Before you begin

You need three things:

1. **Node.js 20+** — check with `node --version`.
2. **An AWS account you're OK testing in.** A fresh account is perfect. Configure
   credentials so the AWS CLI/SDK can find them:
   ```bash
   aws configure
   ```
   Use an IAM user (or SSO role) with permissions to create ECS, RDS, VPC, ALB,
   S3, ECR, CodeBuild, IAM roles, Secrets Manager, and Budgets. On a personal
   test account, an admin user is simplest. **These credentials stay on your
   machine — PLAINOPS reads them from your local AWS config, never uploads them.**
3. **An Anthropic API key** from https://console.anthropic.com — this powers the
   AI. You pay Anthropic directly for usage; PLAINOPS never sees your bill.

> You do **not** need Docker installed. Images build inside your AWS account.
> You do **not** need OpenTofu/Terraform — PLAINOPS auto-downloads OpenTofu the
> first time it deploys.

## 1. Install and start

```bash
npm install
npm start
```

The dashboard opens at **http://localhost:7717**. The onboarding screen shows a
preflight check (Node, git, AWS credentials, OpenTofu). Paste your Anthropic key.

## 2. Create a project

In onboarding (or the top bar), give it:

- **A name** — lowercase, e.g. `my-app`.
- **A path to your code** — a folder containing your app. To try it immediately,
  use the bundled sample:
  ```
  <this repo>/examples/sample-app
  ```

PLAINOPS analyzes the code and tells you what it found.

## 3. Chat to deploy

Type something like:

> Deploy this app.

You don't have to know *how* it should be deployed. PLAINOPS reads your code and
picks one of four reviewed paths — a **static site** (S3), a **container** (ECS
Fargate + load balancer + optional PostgreSQL), **serverless** (API Gateway + Lambda
+ SQS + DynamoDB), or **microservices** (shared load balancer + service discovery).

**No code yet?** Describe the app instead and it will build it first:

> I need a simple tool where my team can log customer complaints and mark them
> resolved. I don't have any code yet — build it and deploy it.

PLAINOPS will:

1. Ask a couple of plain-English questions (database? expected traffic? a budget
   cap? an email for billing alerts?).
2. **Show you the cost** — daily / monthly / yearly — before creating anything.
3. Put an **Approve** button in the dashboard. Nothing is created until you click it.
4. Create the infrastructure (3–6 minutes), then build and deploy your code.
5. Give you the **live URL**.

If your app needs secrets (API keys), PLAINOPS opens a secure box for each one.
The value goes straight to your AWS Secrets Manager — the AI only ever sees a
placeholder.

## 4. Clean up (important on a test account)

When you're done, tell PLAINOPS:

> Tear down this deployment.

Approve the teardown and **every billed resource is removed**. You can also keep
it running — the budget alert you set will email you if spend approaches your cap.

> **⚠️ One thing never to delete by hand:** the S3 bucket named
> `plainops-<your-account-id>-<region>`. It looks like leftover junk but it's
> PLAINOPS's working bucket — it holds the source code your image builds from and
> your infrastructure state backups. Deleting it makes your next deploy fail with a
> confusing CodeBuild error. It costs a few cents a month. Leave it alone.

Generally, **let PLAINOPS do the teardown** rather than deleting resources in the
AWS console. Manual deletions desynchronize its infrastructure state and turn a
clean teardown into a debugging session.

## Explore with no AWS or key

Want to see the dashboard first?

```bash
npm run demo
```

This runs a scripted walkthrough (a seeded "acme-store" project, a cost estimate,
an approval banner) with no AWS or Anthropic calls.

## Troubleshooting

Common cases below. For real error messages and their actual causes, see
**[TROUBLESHOOTING.md](TROUBLESHOOTING.md)**.

| Symptom | Fix |
|---|---|
| `Bucket plainops-...-... does not exist` during deploy | You (or a cleanup script) deleted the bootstrap bucket. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for the exact recreate commands. |
| Deploy finishes but the URL shows 503 | Expected safety behavior — PLAINOPS won't call it "live." Your container isn't passing its health check; ask for the recent logs. |
| Onboarding shows "AWS credentials NOT FOUND" | Run `aws configure`; confirm with `aws sts get-caller-identity`. |
| "Could not download OpenTofu" | Install OpenTofu or Terraform yourself and set `PLAINOPS_TOFU_PATH` to the binary, or put it on your PATH. |
| Deploy fails during image build | Open the build log in the chat; usually a missing dependency in your app's Dockerfile. PLAINOPS writes a Dockerfile only if you don't have one — add your own for full control. |
| Costs panel says "No billing data yet" | Normal — AWS billing data can lag up to ~24 hours after resources start. |
| Wrong region | Set the region when you create the project (default `us-east-1`). One region per project. |
