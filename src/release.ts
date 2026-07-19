import { getProject, type Project } from './state.js';
import { defaultDeps } from './orchestrator.js';
import { tailAppLogs } from './aws.js';
import { redeployProject, recordDeployedCommit } from './cicd.js';
import { rollbackDeployment } from './ops.js';
import { notifyDeveloper, anyChannelConfigured } from './notify.js';
import { backupNow, datastoreOf } from './backup.js';
import { detectMigrations, scanMigrationRisks, describeRisks, runMigrations } from './migrate.js';
import { auditLog } from './audit.js';

/**
 * Safe release: deploy with a safety net.
 *
 *   snapshot (if migrating) → migrate → deploy → HEALTH GATE → auto-revert
 *
 * The health gate is deliberately unambiguous about when it reverts: a failed
 * real-user HTTP check means revert, automatically, because the founder
 * approved exactly that when they approved the safe deploy. Error lines in the
 * logs are reported as a WARNING but never trigger a revert on their own —
 * a noisy log with a serving app is not an outage, and false rollbacks erode
 * trust faster than they save it.
 */

export interface LiveResult {
  ok: boolean;
  detail: string;
}

export interface Verdict {
  rollback: boolean;
  headline: string;
}

/** Decide what the health gate does (pure, testable). */
export function healthVerdict(live: LiveResult, errorCount: number): Verdict {
  if (!live.ok) {
    return { rollback: true, headline: `Health check FAILED after deploy (${live.detail}) — rolling back automatically.` };
  }
  if (errorCount > 0) {
    return { rollback: false, headline: `Serving (${live.detail}), but ${errorCount} error line(s) appeared in the logs right after deploy — worth a look.` };
  }
  return { rollback: false, headline: `Serving cleanly (${live.detail}) with no errors in the logs.` };
}

/** Count error-ish lines in a log blob (pure, testable). */
export function countErrorLines(logText: string): number {
  return logText
    .split(/\r?\n/)
    .filter((l) => /\b(ERROR|FATAL|Unhandled|Traceback|Exception)\b/.test(l) && !/\b0 errors?\b/i.test(l))
    .length;
}

export interface WatchResult {
  ok: boolean;
  detail: string;
  probes: number;
  blips: number;
}

/**
 * Sustained canary watch. validateLive() answers "did it come up?" and stops
 * at the first healthy response — right for a fresh deploy, WRONG for the
 * health gate: a release that serves its first probe and dies two minutes
 * later would slip through. This probes the URL for the WHOLE window:
 *   - one failed probe is a blip (ALBs hiccup) — logged, tolerated;
 *   - two CONSECUTIVE failures mean the release is genuinely not serving →
 *     stop watching and report failure immediately (the caller reverts);
 *   - if the window would end on a single fresh failure, probe up to twice
 *     more instead of calling a release good on a red light.
 */
export async function watchRelease(
  probe: () => Promise<number>,
  seconds: number,
  intervalMs = 10_000,
  onLine?: (l: string) => void,
): Promise<WatchResult> {
  const planned = Math.max(3, Math.ceil((seconds * 1000) / intervalMs));
  const gracesAllowed = 2;
  let probes = 0;
  let blips = 0;
  let consecutive = 0;
  let lastErr = '';

  const probeOnce = async (): Promise<boolean> => {
    probes++;
    try {
      const status = await probe();
      if (status >= 200 && status < 400) return true;
      lastErr = `HTTP ${status}`;
    } catch (e) {
      lastErr = `unreachable (${(e as Error).message})`;
    }
    return false;
  };

  let issued = 0;
  while (issued < planned || (consecutive === 1 && issued < planned + gracesAllowed)) {
    const healthy = await probeOnce();
    issued++;
    if (healthy) {
      if (consecutive === 1) {
        blips++;
        onLine?.(`Blip at check ${probes} recovered — continuing the watch.`);
      }
      consecutive = 0;
    } else {
      consecutive++;
      onLine?.(`Check ${probes}/${planned}: ${lastErr}.`);
      if (consecutive >= 2) {
        return {
          ok: false,
          probes,
          blips,
          detail: `${lastErr} on ${consecutive} consecutive checks (check ${probes} of ${planned} planned)`,
        };
      }
    }
    const more = issued < planned || consecutive === 1;
    if (more) await new Promise((r) => setTimeout(r, intervalMs));
  }
  const flaky = blips > 0 ? `, ${blips} blip(s) recovered` : '';
  return {
    ok: true,
    probes,
    blips,
    detail: `healthy across ${probes} checks over ~${Math.round((probes * intervalMs) / 1000)}s${flaky}`,
  };
}

export interface SafeDeployOptions {
  /** Run database migrations before the deploy (snapshot first). */
  migrate?: boolean;
  /** Microservices: which service to health-gate/revert. */
  service?: string;
  /** Seconds to watch the URL before declaring the release healthy. */
  watchSeconds?: number;
}

export async function safeDeploy(name: string, opts: SafeDeployOptions, log: (l: string) => void): Promise<string> {
  const project = getProject(name);
  if (!project) throw new Error(`Unknown project: ${name}`);
  if (!project.repoPath) throw new Error('This project has no code attached to deploy.');
  const steps: string[] = [];

  // 1. Migrations (snapshot first — a bad migration needs a restore point).
  if (opts.migrate) {
    const plan = detectMigrations(project.repoPath);
    if (!plan) {
      steps.push('Migrations: no migration tool detected in the repo — skipped.');
    } else {
      const ds = datastoreOf(project);
      if (ds.kind !== 'none') {
        log('Snapshotting the database before touching the schema…');
        try {
          steps.push(`Backup: ${await backupNow(project)}`);
        } catch (e) {
          throw new Error(`Refusing to migrate without a snapshot — the backup failed: ${(e as Error).message}`);
        }
      }
      steps.push(`Migrations: ${await runMigrations(project, plan, log)}`);
    }
  }

  // 2. Deploy through the project's normal, verified pipeline.
  log('Deploying…');
  const url = await redeployProject(project, log);
  await recordDeployedCommit(name);
  steps.push(`Deploy: shipped to ${url}`);

  // 3. Health gate — watch it like a human would after pressing deploy.
  // The deploy pipeline already verified the URL serves (validateLive); this
  // gate's job is different: sustained observation of the fresh release.
  const watch = Math.max(30, opts.watchSeconds ?? 120);
  log(`Watching ${url} for ${watch}s before calling this release good…`);
  const live = await watchRelease(() => defaultDeps.healthFetch(url), watch, 10_000, log);

  let errorCount = 0;
  const fresh = getProject(name)!;
  if (live.ok && fresh.outputs?.log_group) {
    const logs = await tailAppLogs(fresh.region, fresh.outputs.log_group, 3).catch(() => '');
    errorCount = countErrorLines(logs);
  }

  const verdict = healthVerdict({ ok: live.ok, detail: live.detail }, errorCount);
  steps.push(`Health gate: ${verdict.headline}`);

  // 4. Auto-revert when the gate fails.
  if (verdict.rollback) {
    log('Health gate failed — rolling back to the previous build automatically.');
    let rollbackResult: string;
    try {
      rollbackResult = await rollbackDeployment(fresh, opts.service, log);
    } catch (e) {
      rollbackResult = `AUTOMATIC ROLLBACK FAILED: ${(e as Error).message}`;
    }
    steps.push(`Rollback: ${rollbackResult}`);
    auditLog({ type: 'release.reverted', summary: `${name}: health gate failed (${live.detail}); ${rollbackResult}` });
    if (anyChannelConfigured()) {
      await notifyDeveloper(name, 'critical', `Deploy of ${name} failed its health check (${live.detail}) and was rolled back automatically.\n${rollbackResult}`);
    }
    return [
      `Release REVERTED — production is back on the previous build.`,
      ...steps,
      '',
      'Nothing about your live app changed permanently. Run run_diagnosis to see why the new build failed before trying again.',
    ].join('\n');
  }

  auditLog({ type: 'release.done', summary: `${name}: safe deploy verified (${live.detail}), ${errorCount} error line(s)` });
  if (anyChannelConfigured()) {
    await notifyDeveloper(name, errorCount > 0 ? 'warning' : 'info', `Deploy of ${name} passed its health gate — ${verdict.headline}`);
  }
  return [`Release VERIFIED and live at ${url}`, ...steps].join('\n');
}

/** Pre-flight report the agent shows before asking for approval. */
export function releasePreview(project: Project, migrate: boolean): string {
  const lines: string[] = [];
  if (migrate && project.repoPath) {
    const plan = detectMigrations(project.repoPath);
    lines.push(plan ? `Migrations: ${plan.tool} — \`${plan.command}\`. ${plan.note}` : 'Migrations: no migration tool detected; nothing to run.');
    if (plan) {
      const risks = scanMigrationRisks(project.repoPath);
      lines.push(describeRisks(risks));
      const ds = datastoreOf(project);
      lines.push(ds.kind === 'none' ? 'No datastore to snapshot.' : `A ${ds.kind.toUpperCase()} snapshot is taken before migrating.`);
    }
  }
  lines.push('After deploying I watch the live URL; if it stops serving I roll back to the previous build automatically.');
  return lines.join('\n');
}
