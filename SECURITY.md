# PLAINOPS Security Model

PLAINOPS's entire promise is that it runs on **your** machine and touches **your**
cloud — so the security model is the product. This document states exactly what the
AI can and cannot see, and how secrets are handled. The code is source-available so
you can verify every claim.

## The one-sentence version

**The AI model writes plans; your machine executes them. Your cloud credentials and
your app's secret values never reach the AI, and never leave your computer except to
go directly to AWS.**

## What the AI model sees — and doesn't

| The AI **sees** (via your Anthropic key) | The AI **never sees** |
|---|---|
| Your chat messages | Your AWS access keys |
| Code/config metadata from your repo (framework, ports, env-var *names*, `package.json`) | Any secret **value** (API keys, DB passwords, tokens) |
| Infrastructure it proposes (resource types, sizes) | The contents of your secret vault |
| Tool results — **after** secret-scrubbing | The raw output of any command, unscrubbed |

If you want *nothing at all* to leave your machine — not even code metadata — that's
what the planned local-model (Ollama) mode is for. On the standard tier, code
snippets are sent to the Anthropic API under your own key; secret values never are.

## How a secret reaches your Lambda/ECS without the AI seeing it

Say you need `DATABASE_URL = postgres://app:SuperSecret@db/prod` set on your service.

1. **Captured at the door.** You paste it into a secure box in the dashboard (the AI
   asked for it *by name* using the `set_app_secret` tool). The real value goes
   straight into an **encrypted local vault** (`~/.plainops/vault.enc`,
   AES-256-GCM, key in `~/.plainops/vault.key`). It never enters the chat.
2. **The AI works with a placeholder.** Everything the AI reads or writes says
   `{{secret:DATABASE_URL}}` — never the value.
3. **Substituted locally, sent straight to AWS.** PLAINOPS (on your machine) writes
   the value directly to **AWS Secrets Manager** via the AWS SDK. Your ECS task reads
   it from there by ARN — the value is never placed in Terraform variables, the plan,
   or the state file.
4. **Scrubbed on the way back.** Every tool result, log line, and audit entry is run
   through a scrubber that replaces any known secret value with its placeholder
   *before* it can reach the AI, the dashboard event stream, or disk. This closes the
   loop in both directions — even if AWS echoes an env var back, the AI sees
   `{{secret:DATABASE_URL}}`.

   Enforced at three chokepoints, so no caller can forget: `dispatchTool()` scrubs
   every tool result, `auditLog()` scrubs both fields of every audit entry, and
   `emitBus()` scrubs every event before any subscriber sees it — which is what
   covers raw OpenTofu and cloud-CLI output streamed to the dashboard as
   `deploy.log`. Streamed model deltas go through a stream scrubber so a value
   split across two chunks is still caught. Beyond exact values, the scrubber also
   masks credential *shapes* it has never seen before — AWS access key ids,
   `SessionToken`/`SecretAccessKey` payloads, GitHub and Google tokens, and PEM
   private keys.

AI-generated secrets (like a new database password) are produced by a local random
generator, vaulted, and handed to the AI as a placeholder — the model never writes
your passwords.

## Human approval on every change

Every action that **creates, changes, or deletes** cloud resources
(`provision`, `deploy`, `destroy`) blocks on a human click in the dashboard. This is
enforced in code (an approval gate the tool call awaits), not by asking the AI
nicely. A prompt-injection attempt hidden in your repo cannot approve its own action.
Approvals auto-reject after 15 minutes, and only one mutating action runs at a time.

## Prompt-injection resistance

Repository contents (file text, names, comments) are treated as **data**, never as
instructions. The system prompt tells the AI to ignore any instructions found in your
code and surface them to you instead.

## State & recovery

After every apply/destroy, a timestamped copy of your Terraform state is uploaded to
a private, versioned S3 bucket in your own account (`plainops-<account>-<region>`),
so a lost laptop doesn't mean lost/orphaned infrastructure.

## Reporting a vulnerability

Found a security issue? Please report it privately (see the project website).
**Security patches are free for everyone, on every release line, forever** — there is
no paywall on a fix, ever.

## What PLAINOPS deliberately does *not* do

- It doesn't upload your AWS credentials anywhere.
- It doesn't run a server that holds your data — there is no PLAINOPS cloud.
- It doesn't store secret values in logs, audit trails, Terraform state, or the AI
  context.
