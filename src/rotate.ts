import { runAwsCli } from './awscli.js';
import { validateLive, defaultDeps } from './orchestrator.js';
import { auditLog } from './audit.js';
import type { Project } from './state.js';

/**
 * Secret rotation — the day-2 task founders postpone until a key leaks.
 *
 * The flow keeps the security model intact end to end: the model proposes the
 * rotation and names the secret; the founder types the NEW value into the same
 * amber secure box as always (vault + Secrets Manager via the server route —
 * the model never sees it); then this module bounces the service so running
 * containers pick the new value up, and verifies the app still serves.
 * ECS injects secrets at task START, so without the bounce a rotation
 * silently does nothing until the next deploy — that trap is the reason
 * this tool exists.
 */

async function awsJson<T>(args: string[], region: string, timeoutMs = 60_000): Promise<T> {
  const res = await runAwsCli([...args, '--region', region, '--output', 'json'], timeoutMs);
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split(/\r?\n/).slice(-3).join(' '));
  return JSON.parse(res.stdout || '{}') as T;
}

/** Which secret names can actually be rotated on this project (pure, testable). */
export function rotatableSecrets(p: Project): { names: string[]; reason?: string } {
  if ((p.cloud ?? 'aws') !== 'aws') {
    return { names: [], reason: 'Rotation is wired for AWS today. On GCP/Azure I can rotate via the gated CLI (update the secret version, then roll the service) — ask and I\'ll walk it.' };
  }
  const out = p.outputs ?? {};
  if (!out.secret_arns) {
    if (out.service_names) return { names: [], reason: 'This microservices stack manages its own MONGODB_URI secret; app-level named secrets live on the container archetype. I can still rotate the database password via the gated CLI if you need that.' };
    return { names: [], reason: 'This project has no managed secrets to rotate (secrets are declared on the container archetype).' };
  }
  try {
    return { names: Object.keys(JSON.parse(out.secret_arns)) };
  } catch {
    return { names: [], reason: 'Could not read this project\'s secret list.' };
  }
}

/**
 * Force the ECS service onto fresh tasks so they read the NEW secret value,
 * wait for stability, and verify the app still serves. Call only after the
 * founder stored the new value through the secure box.
 */
export async function bounceService(p: Project, log: (l: string) => void): Promise<string> {
  const out = p.outputs ?? {};
  if (!out.cluster_name || !out.service_name) {
    throw new Error('No ECS service to restart on this project.');
  }
  log('Restarting the service so new tasks pick up the rotated value…');
  await awsJson(['ecs', 'update-service', '--cluster', out.cluster_name, '--service', out.service_name, '--force-new-deployment'], p.region, 60_000);
  log('Waiting for the service to stabilize on fresh tasks…');
  const stable = await runAwsCli(['ecs', 'wait', 'services-stable', '--cluster', out.cluster_name, '--services', out.service_name, '--region', p.region], 600_000);
  if (stable.code !== 0) {
    throw new Error('The service did not stabilize after the restart — the new value may be wrong for the app. run_diagnosis will show the container logs.');
  }
  const url = p.siteUrl ?? out.app_url;
  if (url) {
    log('Verifying the live URL with the rotated secret…');
    const live = await validateLive(url, defaultDeps, log, 6, 10_000);
    if (!live.ok) {
      return `Rotated and restarted, but ${url} returns ${live.detail} ⚠ — the app may reject the new value. run_diagnosis shows the logs; the old value is gone from the store, so fix forward (enter a corrected value and I restart again).`;
    }
  }
  auditLog({ type: 'secret.rotated', summary: `${p.name}: service restarted onto the new secret value, verified serving` });
  return 'Rotation complete: new value stored, service restarted onto fresh tasks, live URL verified serving. Remember to revoke the OLD credential at its source (database user / API dashboard) now that nothing uses it.';
}
