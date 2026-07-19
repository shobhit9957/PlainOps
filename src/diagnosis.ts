import fs from 'node:fs';
import path from 'node:path';
import { getProject, type Project } from './state.js';
import { readAudit } from './audit.js';
import { tailAppLogs } from './aws.js';
import { runCloudCli } from './clouds/cloudcli.js';
import { validateLive, defaultDeps } from './orchestrator.js';
import { cloudTfDir } from './multicloud.js';
import { scanAwsEstate } from './adopt.js';
import { scanGcpEstate, scanAzureEstate } from './clouds/estate.js';

/**
 * Evidence collector for run_diagnosis. PlainOps' diagnosis model is:
 * this module gathers FACTS (read-only, best-effort, scrubbed upstream),
 * and the agent reasons over them using the playbook in its system prompt.
 * We never guess a root cause in code — we hand the model real logs and state.
 */

const ITEM_CAP = 2600;
const TOTAL_CAP = 14_000;

function cap(s: string, n = ITEM_CAP): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n) + '\n…(truncated)' : t;
}

interface EvidenceItem {
  source: string;
  content: string;
}

async function tryItem(source: string, fn: () => Promise<string>): Promise<EvidenceItem> {
  try {
    const content = cap(await fn());
    return { source, content: content || '(empty)' };
  } catch (e) {
    return { source, content: `(could not collect: ${(e as Error).message})` };
  }
}

async function cloudRead(cloud: 'gcp' | 'azure', args: string[]): Promise<string> {
  // --quiet keeps gcloud from prompting (e.g. "enable API? (y/N)") which could
  // hang on a TTY or pollute the evidence with prompt text.
  const res = await runCloudCli(cloud, cloud === 'gcp' ? [...args, '--quiet'] : args, 60_000);
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split(/\r?\n/).slice(-4).join(' '));
  return res.stdout;
}

/**
 * Cloud Run service names for a project. A microservices stack has one service
 * PER microservice (po-<project>-<svc>) and no `service_name` output — guessing
 * `po-<project>` there made the evidence collector describe a service that
 * doesn't exist and filter logs down to nothing.
 */
export function gcpServiceNames(p: Pick<Project, 'name' | 'outputs'>): string[] {
  if (p.outputs?.service_name) return [p.outputs.service_name];
  if (p.outputs?.service_urls) {
    try {
      return Object.keys(JSON.parse(p.outputs.service_urls)).map((s) => `po-${p.name}-${s}`);
    } catch {
      /* fall through to the single-service guess */
    }
  }
  return [`po-${p.name}`];
}

/** Azure Container App names — microservices apps are named after the service itself. */
export function azureAppNames(p: Pick<Project, 'name' | 'outputs' | 'archetype'>): string[] {
  if (p.archetype === 'microservices' && p.outputs?.service_urls) {
    try {
      return Object.keys(JSON.parse(p.outputs.service_urls));
    } catch {
      /* fall through */
    }
  }
  return [`po-${p.name}`];
}

function projectFacts(p: Project): string {
  return JSON.stringify(
    {
      name: p.name,
      cloud: p.cloud ?? 'aws',
      region: p.region,
      archetype: p.archetype ?? (p.siteBucket ? 'static' : 'unknown'),
      status: p.status,
      url: p.siteUrl ?? p.outputs?.app_url ?? p.outputs?.gateway_url ?? p.outputs?.api_url ?? null,
      lastDeployAt: p.lastDeployAt ?? null,
      outputKeys: Object.keys(p.outputs ?? {}),
    },
    null,
    2,
  );
}

/**
 * Collect a diagnosis evidence bundle for a project (or a pasted error with no
 * deploy context). Read-only everywhere; every item is best-effort.
 */
export async function collectDiagnosis(projectName: string, errorText?: string, scope?: 'project' | 'account'): Promise<string> {
  const p = getProject(projectName);
  if (!p) return `Error: project ${projectName} not found.`;
  const cloud = p.cloud ?? 'aws';
  const items: EvidenceItem[] = [];

  // Adopted infrastructure: when the founder's app was NOT deployed by
  // PlainOps (no outputs, no site) — or they ask for the whole account —
  // sweep the region/project/subscription instead of only our own records.
  const adopted = !p.outputs && !p.siteBucket;
  const accountScope = scope === 'account' || adopted;

  if (errorText?.trim()) items.push({ source: 'error reported by the founder', content: cap(errorText, 3500) });
  items.push({ source: 'project record', content: projectFacts(p) });

  // 1. Is it actually serving? (single quick probe, not the long retry loop)
  const url = p.siteUrl ?? p.outputs?.app_url ?? p.outputs?.gateway_url ?? p.outputs?.api_url;
  if (url) {
    items.push(
      await tryItem(`live probe ${url}`, async () => {
        const res = await validateLive(url, defaultDeps, undefined, 1, 0);
        return res.ok ? `Serving: ${res.detail}` : `NOT serving: ${res.detail}`;
      }),
    );
  } else {
    items.push({ source: 'live probe', content: 'No URL exists yet — nothing has been deployed for this project.' });
  }

  // 2. Rendered infrastructure + state on disk.
  items.push(
    await tryItem('infrastructure on disk', async () => {
      const dir = cloudTfDir(p.name);
      if (!fs.existsSync(dir)) return 'No rendered blueprint — provisioning has never run.';
      const files = fs.readdirSync(dir);
      const hasState = files.includes('terraform.tfstate');
      let resources = '';
      if (hasState) {
        try {
          const state = JSON.parse(fs.readFileSync(path.join(dir, 'terraform.tfstate'), 'utf8'));
          const list = (state.resources ?? []).map((r: { type: string; name: string }) => `${r.type}.${r.name}`);
          resources = `\nResources in state (${list.length}): ${list.slice(0, 40).join(', ')}`;
        } catch {
          resources = '\n(terraform.tfstate exists but could not be parsed)';
        }
      }
      return `Rendered files: ${files.join(', ')}${hasState ? resources : '\nNo tfstate — apply has not completed here.'}`;
    }),
  );

  // 3. Recent audit trail (already scrubbed when written).
  items.push(
    await tryItem('recent PlainOps actions (audit log)', async () => {
      const entries = readAudit(25) as Array<Record<string, unknown>>;
      if (entries.length === 0) return '(no audit entries)';
      return entries.map((e) => `${String(e.at ?? '')} ${String(e.type ?? '')}: ${String(e.summary ?? '')}`).join('\n');
    }),
  );

  // 4. Cloud-side service state + recent logs.
  if (cloud === 'aws') {
    if (p.outputs?.log_group) {
      items.push(await tryItem('application logs (CloudWatch, last 30 min)', () => tailAppLogs(p.region, p.outputs!.log_group, 30).then((l) => l || '(no entries)')));
    }
    if (p.outputs?.cluster_name && p.outputs?.service_name) {
      items.push(
        await tryItem('ECS service state', async () => {
          const { inspectAws } = await import('./inspect.js');
          const inv = await inspectAws(p.region);
          return JSON.stringify(inv.ecsServices, null, 2);
        }),
      );
    }
  } else if (cloud === 'gcp') {
    const gcpProject = p.cloudTarget;
    if (gcpProject) {
      // Microservices stacks have one Cloud Run service per microservice.
      for (const svc of gcpServiceNames(p).slice(0, 4)) {
        items.push(
          await tryItem(`Cloud Run state (${svc})`, () =>
            cloudRead('gcp', ['run', 'services', 'describe', svc, '--region', p.region, '--project', gcpProject, '--format=json(status)']),
          ),
        );
      }
      items.push(
        await tryItem('Cloud Run logs (last 50 lines)', () =>
          cloudRead('gcp', [
            'logging', 'read',
            // Substring match (:) covers every service of a micro stack.
            `resource.type=cloud_run_revision AND resource.labels.service_name:"po-${p.name}"`,
            '--project', gcpProject, '--limit', '50',
            '--format=value(resource.labels.service_name,severity,firstof(textPayload,jsonPayload.message,httpRequest.requestUrl))',
            '--freshness=1h',
          ]),
        ),
      );
    }
  } else if (cloud === 'azure') {
    const rg = p.outputs?.resource_group ?? `po-${p.name}`;
    items.push(await tryItem(`Azure resources in ${rg}`, () => cloudRead('azure', ['resource', 'list', '--resource-group', rg, '--output', 'table'])));
    if (p.archetype === 'serverless' && p.outputs?.function_app_name) {
      items.push(
        await tryItem('Function App state', () =>
          cloudRead('azure', ['functionapp', 'show', '--name', p.outputs!.function_app_name, '--resource-group', rg, '--query', '{state:state,hostNames:defaultHostName}', '--output', 'json']),
        ),
      );
    } else {
      // Microservices: one Container App per service, named after the service.
      for (const appName of azureAppNames(p).slice(0, 4)) {
        items.push(
          await tryItem(`Container App state (${appName})`, () =>
            cloudRead('azure', ['containerapp', 'show', '--name', appName, '--resource-group', rg, '--query', '{running:properties.runningStatus,fqdn:properties.configuration.ingress.fqdn,provisioning:properties.provisioningState}', '--output', 'json']),
          ),
        );
        items.push(
          await tryItem('Container App logs (last 40 lines)', () =>
            cloudRead('azure', ['containerapp', 'logs', 'show', '--name', appName, '--resource-group', rg, '--type', 'console', '--tail', '40']),
          ),
        );
      }
    }
  }

  if (accountScope) {
    const suffix = adopted ? ' — this infrastructure was not deployed by PlainOps' : '';
    if (cloud === 'aws') {
      items.push(await tryItem(`full AWS estate scan (${p.region})${suffix}`, () => scanAwsEstate(p.region)));
    } else if (cloud === 'gcp') {
      items.push(
        await tryItem(`full GCP estate scan (${p.cloudTarget ?? 'no project set'}, ${p.region})${suffix}`, async () => {
          if (!p.cloudTarget) throw new Error('this project has no GCP project id recorded — cloud_status shows what gcloud is targeting');
          return scanGcpEstate(p.cloudTarget, p.region);
        }),
      );
    } else {
      items.push(await tryItem(`full Azure estate scan (subscription)${suffix}`, () => scanAzureEstate()));
    }
  }

  let bundle = items.map((i) => `### ${i.source}\n${i.content}`).join('\n\n');
  const totalCap = accountScope ? TOTAL_CAP * 2 : TOTAL_CAP; // estate sweeps carry more evidence
  if (bundle.length > totalCap) bundle = bundle.slice(0, totalCap) + '\n…(evidence truncated)';
  return (
    `DIAGNOSIS EVIDENCE for "${p.name}" (${cloud}). Analyze per your diagnosis playbook: ` +
    `state the most likely root cause ONLY if the evidence shows it, otherwise say what is missing and collect it with the read-only CLI tools.\n\n` +
    bundle
  );
}
