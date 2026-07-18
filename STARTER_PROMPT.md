# Starter prompts for a new AI session

Paste one of these as your **first message** in a fresh AI agent session
(Claude Code, or any agent with file + shell access) so it understands the project
before it touches anything.

If you're using Claude Code, [CLAUDE.md](CLAUDE.md) is loaded automatically — the
prompt below still helps because it sets the working rules and tells the agent what
to do first.

---

## 1. Main starter prompt (use this one)

```
You're working on PLAINOPS, a local-first, source-available "AI DevOps engineer."
A founder installs it on their own machine, connects their own AWS account and their
own Anthropic API key, and deploys real apps to AWS by typing plain English.
Credentials and secret values never leave the machine, and the AI model never sees a
secret value — that security model IS the product, so never weaken it for convenience.

Before doing anything else, read these files in this order and tell me you've read
them:
  1. CLAUDE.md          — orientation, invariants, and gotchas that already cost us hours
  2. ARCHITECTURE.md    — how the agent loop, approval gate, and 4 blueprints work
  3. TROUBLESHOOTING.md — real failure modes with their real error strings

Key context you must hold onto:
- Stack: TypeScript + ESM, no build step (runs via tsx), Express dashboard on
  localhost:7717, OpenTofu for infrastructure, vitest (76 tests), Windows-first
  (always execFile with an argument array, never a shell string).
- It deploys 4 ways: static (S3), container (ECS Fargate + ALB + optional RDS),
  serverless (API Gateway + Lambda + SQS + DynamoDB), and microservices (Cloud Map +
  optional DocumentDB + Redis). The AI picks a reviewed blueprint — it never writes
  Terraform freehand.
- Every mutating action blocks on a human clicking Approve in the dashboard. That
  gate is enforced in code (an HTTP route), not by prompt convention. You cannot
  approve your own action, and you should never try to route around it.

Hard rules for how you work with me:
- This project spends REAL money in a REAL AWS account. Before creating or deleting
  anything, check what actually exists using the AWS CLI. Never delete an AWS
  resource on a hunch.
- NEVER delete the S3 bucket named plainops-<account>-<region>. It is PLAINOPS's
  bootstrap bucket holding the CodeBuild source zip and Terraform state backups.
  Deleting it makes every future deploy fail with a confusing CodeBuild error.
- Never guess a root cause. If a deploy fails, find the actual "Error:" line in the
  log before proposing anything. If you can't see the real error, say so and ask for
  it — do not start deleting resources hoping something works.
- If two fixes fail, stop and re-investigate instead of trying a third.
- Be honest. Never hand me a command, prompt, or URL you haven't verified. If
  something doesn't work or you're unsure, say that plainly.
- Write a failing test before fixing a bug (tests/orchestrator.test.ts is the model).

Then run `npm test` to confirm the repo is green, and give me a short summary of the
current state and what you'd suggest working on next. Don't change any code until I
tell you what I want.
```

---

## 2. Short version (when you just want to make one change)

```
This is PLAINOPS — a local-first AI DevOps engineer that deploys apps to the user's
own AWS account. Read CLAUDE.md first (invariants + gotchas), then TROUBLESHOOTING.md
if anything is failing.

Rules: real AWS money is involved, so verify with the AWS CLI before creating or
deleting anything; never delete the plainops-<account>-<region> bucket; never guess
a root cause — read the actual error; write a failing test before fixing a bug; be
honest when something doesn't work.

Here's what I want: <describe your task>
```

---

## 3. Operating it (deploying an app, not editing the code)

Use this in the **PLAINOPS dashboard chat** at `http://localhost:7717` — not in a
coding agent. Point it at a folder and describe the outcome; leave the architecture
to PLAINOPS:

```
I run a small team and we're drowning in sticky notes. Someone built us a simple
task manager — a Node app that saves tasks to a database — and the code is at
<full path to your code>. I don't know anything about AWS or servers. Please just
get it live on my AWS account so my team can use it from a link: set up whatever it
needs, show me the monthly cost before you build anything, and give me the URL once
it's working.
```

Swap the path and the description and PLAINOPS selects the right deploy path
automatically. With no code at all, describe the app instead and it will scaffold it
first:

```
I need a simple internal tool where my team can log customer complaints and mark
them resolved. I don't have any code yet. Build it and deploy it to my AWS account,
show me the cost first, and give me a link when it's live.
```

---

## 4. Handing the project to another person

Point them at [README.md](README.md) → [QUICKSTART.md](QUICKSTART.md). They can
explore the whole dashboard with **no AWS account and no API key**:

```bash
npm install
npm run demo
```
