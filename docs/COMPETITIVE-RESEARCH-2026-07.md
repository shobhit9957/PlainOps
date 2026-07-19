# Competitive research — is "type English → deploy across AWS/GCP/Azure" unique?

**Date:** 2026-07-20 · **Method:** 103-agent deep-research harness — 5 search angles,
21 sources fetched, 105 claims extracted, top 25 adversarially verified (3 votes each,
2/3 refutes kill). 21 confirmed · 4 refuted · 0 unverified.

## Verdict

**The raw capability is NOT unique anymore.** As of July 2026, "type plain English →
real resources created in AWS, GCP, or Azure" ships in at least two GA products:

- **Spacelift Intent** — GA **March 18, 2026**. Natural language in any MCP client
  (Claude Code, ChatGPT, Cursor, VS Code) or Spacelift's web assistant → provisions by
  calling Terraform/OpenTofu **provider APIs directly** (no IaC code written). Official
  credential setup docs for AWS, Azure, and GCP. Verified 12-0.
  Also ships an **experimental Apache-2.0 local variant** (v0.2.0, Apr 2026): MCP stdio
  server, SQLite state, user-held env-var credentials, user's own AI client.
- **Pulumi Neo** — GA, 4,500+ orgs claimed (May 2026). Plain-English tasks via web/CLI/
  Slack/GitHub; executes gated changes (PR-based, Review/Balanced/Auto modes) across
  AWS, Azure, GCP via the Pulumi engine. Verified 9-0.

**The PLAINOPS combination IS unique among verified shipping products.** Nothing found
matches: local-first + user-held credentials + BYO model key + cost-before-create +
approval-as-code-path + verified-HTTP-200-or-refuse + deploy-AND-full-day-2 + source-available.

### Three properties found in NO verified shipping competitor
1. **Cost estimate BEFORE anything is created** (Neo: only post-hoc cost optimization —
   raw-HTML grep zero hits; Intent: none claimed).
2. **Refuse to report success without a live HTTP 200** (deployment verification absent
   from every competitor's docs).
3. **Deploy + full day-2 in ONE agent** (canary auto-revert, snapshot-first migrations,
   DR drills, teardown residue proof). Microsoft ships these as TWO products (Deployment
   Agent, preview; SRE Agent, GA); Neo's day-2 is partial (failure diagnosis, compliance).

Rare but not unique: local-first with user-held creds (only Spacelift's *experimental*
OSS Intent); BYO model key (functionally approximated by OSS Intent's bring-your-own-
MCP-client architecture — thinner differentiator than it looks).

Commodity (do NOT market these as differentiators): chat/NL interface, human approval
gates, pre-apply preview, IaC-engine multi-cloud reach.

## The evidence-backed one-liner

> "The only agent that runs on your own machine with your own credentials and API key,
> shows you the cost before creating anything, waits for your click, deploys to your
> own AWS, GCP, or Azure account, refuses to claim success without a live HTTP 200 —
> and then operates what it built."

**No longer defensible:** "first/only English-to-cloud agent" · "only multi-cloud
natural-language provisioning" (Intent and Neo both falsify these).

## Key competitor facts (all cited in the run)

| Product | Status | What it does | What it lacks vs PLAINOPS |
|---|---|---|---|
| Spacelift Intent | GA 03/2026 | NL → provider-API provisioning, tri-cloud | SaaS control plane; self-positioned "purpose-built for **non-critical** infrastructure… OpenTofu/Terraform remains king for production"; no cost preview, no verification, no day-2 |
| Spacelift Intent OSS | experimental v0.2.0 | Local MCP, SQLite state, own creds | Explicitly experimental; no approvals/policies/cost/verify/day-2; "delete the DB, lose all state" |
| Pulumi Neo | GA | NL → gated execution, enterprise scale | No cost-before-create, no BYO key, no local-first, no rollback (pulumi/pulumi #96, #15370 open); SaaS |
| Azure SRE Agent | GA 03/10/2026 | Day-2 ops on existing Azure resources; 35k+ incidents mitigated | Day-2 only; provisioning is a SEPARATE preview product (Azure Deployment Agent); Azure-native integrations (strict "Azure-only" was refuted 0-3 — hooks can run any Azure CLI op, treat as unproven either way) |
| AWS (Q console chat + CloudWatch investigations) | GA | Read-path introspection ("get, list, describe"), investigation agent | AWS-only (verified 3-0); no NL-provisioning; "cannot execute fixes" claim REFUTED 0-3 — don't assume either way |
| Gemini Cloud Assist | Preview | Generates gcloud/kubectl/Terraform for human review | GCP-only (0 AWS/Azure hits in 2.2MB page grep); proactive agents "don't modify your environment" per Google's own release notes |
| CloudAgents.uk | UNVERIFIED | Claims the exact PLAINOPS pitch, $30-60/user/mo | FAILED verification 0-3: no screenshots/demo/customers/changelog/team; "CloudAgents Ltd" absent from Companies House (parent shell inc. 06/2025); inconsistent pricing. Likely facade — but run the 3-day trial to falsify |

## Top 3 threats
1. **Spacelift Intent** — already GA on the NL-tri-cloud axis with an OSS local seed
   (actively pushed as of 2026-07-16). One roadmap cycle (production positioning + cost
   preview + day-2) from overlapping most of PLAINOPS.
2. **Pulumi Neo** — enterprise distribution + resources to close the cost-estimate gap
   quickly; the brand threat for the same buyer.
3. **Hyperscaler pincer** — Microsoft already ships both halves separately; per-cloud
   English ops is being commoditized. Single-cloud each, but squeezes any single-cloud
   slice of the value.

## Watch items (falsification list)
- CloudAgents.uk 3-day trial (cheapest falsification test available)
- Spacelift OSS local Intent graduating from "experimental"
- Microsoft Azure Deployment Agent (preview) fusing with SRE Agent (GA)
- Neo closing cost-preview/rollback via existing Pulumi Cloud pieces

## Caveats (from the run, verbatim-condensed)
July 2026 snapshot of a fast market (Neo: launch→GA <1yr; Intent: EA→GA in 5 months).
Absence findings rest on vendor pages/docs — strong evidence a capability isn't claimed,
weaker that it's impossible. Universal negatives unprovable; a stealth entrant could
exist. Pulumi's tri-cloud wording is "visibility" across the three; deployment to all
three is implied via the engine, not stated. No independent hands-on demo of Intent
provisioning Azure/GCP was found (official setup docs only).

## Marketing implications
- Kill any "first/only English-to-deploy" copy. Lead with the **receipts + combination**.
- The Runbook Console's PROVEN-stamp design is exactly the right story: competitors
  claim autonomy; PLAINOPS shows verified executions with dates.
- "Purpose-built for non-critical workflows" (Spacelift, about their own product) is a
  gift — PLAINOPS's pitch is the opposite: production discipline (snapshot-first,
  sustained gate, auto-revert) proven live on 2026-07-19.
