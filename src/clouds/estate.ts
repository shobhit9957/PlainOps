import { runCloudCli } from './cloudcli.js';

/**
 * Adopted-infrastructure scanners for GCP and Azure — the same "3am story"
 * adopt.ts gives AWS: evidence about EVERYTHING running in the founder's
 * project/subscription, not just stacks PlainOps deployed. Service states with
 * the unhealthy ones flagged, recent error-level logs, database states, and
 * cluster health. Read-only, best-effort throughout; every section degrades to
 * "(could not collect)" instead of failing the diagnosis.
 *
 * The section builders are pure and unit-tested; the scan functions only
 * fetch JSON and hand it to them.
 */

const SECTION_CAP = 2800;

function cap(s: string, n = SECTION_CAP): string {
  return s.length > n ? s.slice(0, n) + '\n…(truncated)' : s;
}

interface Section {
  title: string;
  body: string;
}

async function trySection(title: string, fn: () => Promise<string>): Promise<Section> {
  try {
    return { title, body: cap((await fn()).trim() || '(none found)') };
  } catch (e) {
    return { title, body: `(could not collect: ${(e as Error).message})` };
  }
}

async function cloudJson<T>(cloud: 'gcp' | 'azure', args: string[], fallback: T, timeoutMs = 60_000): Promise<T> {
  // --quiet stops gcloud from PROMPTING ("API not enabled — enable? (y/N)")
  // which would otherwise pollute error text and, on a TTY, could hang.
  const full = cloud === 'gcp' ? [...args, '--quiet'] : args;
  const res = await runCloudCli(cloud, full, timeoutMs);
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split(/\r?\n/).slice(-2).join(' '));
  try {
    return JSON.parse(res.stdout || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

/* ---------------------------------------------------------------- GCP pure */

export interface GcpRunService {
  metadata?: { name?: string };
  status?: { url?: string; conditions?: Array<{ type?: string; status?: string; message?: string }> };
}

export function gcpRunSection(services: GcpRunService[]): string {
  if (!services.length) return 'No Cloud Run services in this region.';
  const lines: string[] = [];
  for (const s of services) {
    const name = s.metadata?.name ?? '?';
    const ready = s.status?.conditions?.find((c) => c.type === 'Ready');
    const ok = ready?.status === 'True';
    lines.push(`${name}: ${ok ? 'Ready' : `NOT READY ⚠${ready?.message ? ` — ${ready.message.slice(0, 160)}` : ''}`}${s.status?.url ? `  (${s.status.url})` : ''}`);
  }
  return lines.join('\n');
}

export function gcpFunctionsSection(fns: Array<{ name?: string; state?: string; status?: string }>): string {
  if (!fns.length) return 'No Cloud Functions in this region.';
  return fns
    .map((f) => {
      const name = (f.name ?? '?').split('/').pop();
      const state = f.state ?? f.status ?? '?';
      return `${name}: ${state}${state === 'ACTIVE' ? '' : ' ⚠'}`;
    })
    .join('\n');
}

export function gcpSqlSection(instances: Array<{ name?: string; state?: string }>): string {
  if (!instances.length) return 'No Cloud SQL instances.';
  return instances.map((i) => `${i.name}: ${i.state}${i.state === 'RUNNABLE' ? '' : ' ⚠ (not RUNNABLE)'}`).join('\n');
}

export function gcpGkeSection(clusters: Array<{ name?: string; status?: string; currentNodeCount?: number }>): string {
  if (!clusters.length) return 'No GKE clusters.';
  return clusters
    .map((c) => `${c.name}: ${c.status}${c.status === 'RUNNING' ? '' : ' ⚠'}${c.currentNodeCount != null ? `, ${c.currentNodeCount} node(s)` : ''}`)
    .join('\n');
}

/* --------------------------------------------------------------- GCP fetch */

/** Full-project evidence sweep for GCP infrastructure PlainOps did not deploy. */
export async function scanGcpEstate(gcpProject: string, region: string): Promise<string> {
  const sections = await Promise.all([
    trySection('Cloud Run services (ready state)', async () =>
      gcpRunSection(await cloudJson('gcp', ['run', 'services', 'list', '--project', gcpProject, '--region', region, '--format=json'], [])),
    ),
    trySection('Cloud Functions (state)', async () =>
      gcpFunctionsSection(await cloudJson('gcp', ['functions', 'list', '--project', gcpProject, '--regions', region, '--format=json(name,state,status)'], [])),
    ),
    trySection('Cloud SQL instances', async () =>
      gcpSqlSection(await cloudJson('gcp', ['sql', 'instances', 'list', '--project', gcpProject, '--format=json(name,state)'], [])),
    ),
    trySection('GKE clusters', async () =>
      gcpGkeSection(await cloudJson('gcp', ['container', 'clusters', 'list', '--project', gcpProject, '--format=json(name,status,currentNodeCount)'], [])),
    ),
    trySection('Error-level log lines (last hour, Cloud Run + Functions)', async () => {
      const res = await runCloudCli('gcp', [
        'logging', 'read',
        'severity>=ERROR AND (resource.type="cloud_run_revision" OR resource.type="cloud_function")',
        '--project', gcpProject, '--freshness=1h', '--limit', '30',
        '--format=value(resource.labels.service_name,severity,textPayload)', '--quiet',
      ], 60_000);
      if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split(/\r?\n/).slice(-2).join(' '));
      return res.stdout.trim() || 'No error-level log lines in the last hour.';
    }),
  ]);
  return sections.map((s) => `### ${s.title}\n${s.body}`).join('\n\n');
}

/* -------------------------------------------------------------- Azure pure */

export interface AzureContainerApp {
  name?: string;
  rg?: string;
  running?: string;
  fqdn?: string | null;
}

export function azureContainerAppsSection(apps: AzureContainerApp[]): string {
  if (!apps.length) return 'No Container Apps in this subscription.';
  return apps
    .map((a) => `${a.name} (rg ${a.rg}): ${a.running}${a.running === 'Running' ? '' : ' ⚠'}${a.fqdn ? `  (https://${a.fqdn})` : ''}`)
    .join('\n');
}

export function azureFunctionAppsSection(apps: Array<{ name?: string; state?: string; rg?: string }>): string {
  if (!apps.length) return 'No Function Apps in this subscription.';
  return apps.map((a) => `${a.name} (rg ${a.rg}): ${a.state}${a.state === 'Running' ? '' : ' ⚠'}`).join('\n');
}

export function azurePostgresSection(servers: Array<{ name?: string; state?: string }>): string {
  if (!servers.length) return 'No PostgreSQL flexible servers.';
  return servers.map((s) => `${s.name}: ${s.state}${s.state === 'Ready' ? '' : ' ⚠ (not Ready)'}`).join('\n');
}

export function azureAksSection(clusters: Array<{ name?: string; status?: string; power?: string }>): string {
  if (!clusters.length) return 'No AKS clusters.';
  return clusters
    .map((c) => `${c.name}: ${c.status}${c.status === 'Succeeded' ? '' : ' ⚠'}${c.power ? `, power ${c.power}${c.power === 'Running' ? '' : ' ⚠'}` : ''}`)
    .join('\n');
}

export function azureActivityFailuresSection(events: Array<{ op?: string; res?: string; at?: string }>): string {
  if (!events.length) return 'No failed operations in the activity log (last hour).';
  return events
    .slice(0, 15)
    .map((e) => {
      const res = (e.res ?? '').split('/').slice(-2).join('/');
      return `${e.at ?? ''}  ${e.op ?? '?'}  →  ${res || '?'}  FAILED ⚠`;
    })
    .join('\n');
}

/* ------------------------------------------------------------- Azure fetch */

/** Full-subscription evidence sweep for Azure infrastructure PlainOps did not deploy. */
export async function scanAzureEstate(): Promise<string> {
  const sections = await Promise.all([
    trySection('Container Apps (running state)', async () =>
      azureContainerAppsSection(
        await cloudJson('azure', ['containerapp', 'list', '--query', '[].{name:name,rg:resourceGroup,running:properties.runningStatus,fqdn:properties.configuration.ingress.fqdn}', '--output', 'json'], []),
      ),
    ),
    trySection('Function Apps (state)', async () =>
      azureFunctionAppsSection(
        await cloudJson('azure', ['functionapp', 'list', '--query', '[].{name:name,state:state,rg:resourceGroup}', '--output', 'json'], []),
      ),
    ),
    trySection('PostgreSQL flexible servers', async () =>
      azurePostgresSection(
        await cloudJson('azure', ['postgres', 'flexible-server', 'list', '--query', '[].{name:name,state:state}', '--output', 'json'], []),
      ),
    ),
    trySection('AKS clusters', async () =>
      azureAksSection(
        await cloudJson('azure', ['aks', 'list', '--query', '[].{name:name,status:provisioningState,power:powerState.code}', '--output', 'json'], []),
      ),
    ),
    trySection('Failed operations (activity log, last hour)', async () =>
      azureActivityFailuresSection(
        await cloudJson('azure', ['monitor', 'activity-log', 'list', '--offset', '1h', '--status', 'Failed', '--max-events', '25', '--query', '[].{op:operationName.value,res:resourceId,at:eventTimestamp}', '--output', 'json'], []),
      ),
    ),
  ]);
  return sections.map((s) => `### ${s.title}\n${s.body}`).join('\n\n');
}
