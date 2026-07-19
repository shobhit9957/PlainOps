# Connecting your cloud to PlainOps

PlainOps deploys to **your own** cloud account using **your own** local CLI
credentials. Nothing is uploaded anywhere except calls to your cloud and to your
Anthropic key. This guide is the one-time setup for each cloud — do it once per
machine, then PlainOps handles everything else.

The onboarding screen runs a live preflight for every cloud and tells you exactly
which step below is missing, so you never have to guess. You only need to set up
the cloud(s) you actually want to deploy to.

> **You never need Docker** (images build in your cloud) or **OpenTofu/Terraform**
> (PlainOps auto-downloads it). You only need the cloud's own CLI.

---

## Amazon Web Services (AWS)

**1. Install the AWS CLI** — https://aws.amazon.com/cli/ then confirm:
```bash
aws --version
```

**2. Sign in.** Use an IAM user or SSO role that can create ECS, RDS, VPC, ALB,
S3, ECR, CodeBuild, IAM roles, Secrets Manager, EventBridge Scheduler, and
Budgets. On a personal test account an admin user is simplest.
```bash
aws configure           # paste Access Key ID + Secret, set a default region
```

**3. Verify** — PlainOps expects both of these to succeed:
```bash
aws sts get-caller-identity      # who am I
aws configure get region         # my default region (e.g. ap-south-1)
```

That's it. AWS is ready. If `aws` isn't on your PATH, set `PLAINOPS_AWS_PATH` to
the binary.

---

## Google Cloud (GCP)

GCP needs **two** logins — the CLI login *and* Application Default Credentials.
This trips people up: `gcloud auth login` alone lets deploys pass preflight and
then fail at apply time, because OpenTofu authenticates with ADC, not the CLI
login. Do both.

**1. Install the Google Cloud SDK** — https://cloud.google.com/sdk/docs/install
then **open a new terminal** (the installer adds `gcloud` to PATH) and confirm:
```bash
gcloud version
```

**2. Log in the CLI:**
```bash
gcloud auth login
```

**3. Pick the project to deploy into.** List what you have, then set one — use a
project you're OK creating test infrastructure in, **not** one already running
something you care about:
```bash
gcloud projects list
gcloud config set project YOUR_PROJECT_ID
```

**4. Set up Application Default Credentials** (this is what OpenTofu uses — the
step people miss):
```bash
gcloud auth application-default login
```

**5. Make sure billing is enabled** on that project (Cloud Run, Cloud Build, and
Artifact Registry require it):
```bash
gcloud billing projects describe YOUR_PROJECT_ID --format="value(billingEnabled)"
# want: True   — if False, enable it in the console: Billing → Link a billing account
```

**You do NOT need to enable APIs by hand** (Cloud Run, Cloud Build, Artifact
Registry, etc.) — the blueprints enable exactly what they need on first deploy.

**Verify** — the onboarding preflight should show GCP connected. From the CLI:
```bash
gcloud auth application-default print-access-token >/dev/null && echo "ADC OK"
gcloud config get-value project
```

If `gcloud` isn't on your PATH, set `PLAINOPS_GCLOUD_PATH` to the `gcloud.cmd`
(Windows) or `gcloud` binary — the default Windows install path
(`C:\Program Files (x86)\Google\Cloud SDK\...`) works fine, spaces and all.

---

## Microsoft Azure

**1. Install the Azure CLI** — https://learn.microsoft.com/cli/azure/install-azure-cli
then confirm:
```bash
az version
```

**2. Log in** (opens a browser):
```bash
az login
```

**3. Pick the subscription** to deploy into (if you have more than one):
```bash
az account list --output table
az account set --subscription "YOUR_SUBSCRIPTION_NAME_OR_ID"
```

**You do NOT need to pre-create resource groups or enable resource providers** —
the blueprints create the resource group and everything in it.

**Verify:**
```bash
az account show --output table
```

If `az` isn't on your PATH, set `PLAINOPS_AZ_PATH` to the binary.

---

## What "connected" means (and what still never leaves your machine)

Once a cloud shows connected, PlainOps deploys through **your** local CLI/SDK
session. It never sees or stores your cloud password, access keys, or tokens —
it shells out to the CLI you already authenticated, exactly as you would by hand.
Secret *values* your app needs (database URLs, API keys) go into a local
encrypted vault and straight to the cloud's secret store; the AI only ever sees
`{{secret:NAME}}`.

## Quick reference — the preflight check per cloud

| Cloud | Installed | Logged in | Ready to deploy |
|---|---|---|---|
| **AWS** | `aws --version` | `aws sts get-caller-identity` | default region set (`aws configure get region`) |
| **GCP** | `gcloud version` | `gcloud auth login` | project set **+** `gcloud auth application-default login` **+** billing enabled |
| **Azure** | `az version` | `az login` | subscription selected (`az account show`) |
