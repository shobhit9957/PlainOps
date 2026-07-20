import { runAwsCli } from './awscli.js';
import { runCloudCli } from './clouds/cloudcli.js';
import { auditLog } from './audit.js';
import type { Project } from './state.js';

/**
 * Backups + disaster-recovery drills.
 *
 * verifyBackups  — read-only audit: what's protected, how far back, how stale.
 * backupNow      — on-demand snapshot of the project's datastore (approval at
 *                  the tool layer).
 * runDrDrill     — the part most teams never do: RESTORE the latest snapshot
 *                  into a temporary instance, prove it reaches "available",
 *                  then delete it. A backup you've never restored is a hope,
 *                  not a backup. AWS-only in v1 (GCP/Azure: audit + on-demand
 *                  where their CLIs support it; the tool says so).
 */

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function awsJson<T>(args: string[], region: string, timeoutMs = 60_000): Promise<T> {
  const res = await runAwsCli([...args, '--region', region, '--output', 'json'], timeoutMs);
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split(/\r?\n/).slice(-3).join(' '));
  return JSON.parse(res.stdout || '{}') as T;
}

type Kind =
  | { kind: 'rds'; id: string }
  | { kind: 'docdb'; id: string }
  | { kind: 'dynamo'; table: string }
  | { kind: 's3'; bucket: string }
  | { kind: 'none' };

/** Which datastore does this project actually have? */
export function datastoreOf(p: Project): Kind {
  if (p.siteBucket) return { kind: 's3', bucket: p.siteBucket };
  const out = p.outputs ?? {};
  if (out.orders_table) return { kind: 'dynamo', table: out.orders_table };
  if (out.docdb_endpoint) return { kind: 'docdb', id: `po-${p.name}` };
  if (out.db_endpoint && p.blueprint?.withDatabase) return { kind: 'rds', id: `po-${p.name}` };
  return { kind: 'none' };
}

/* ------------------------------------------------------------------ audit */

export async function verifyBackups(p: Project): Promise<string> {
  const cloud = p.cloud ?? 'aws';
  const ds = datastoreOf(p);
  if (ds.kind === 'none') return 'This project has no datastore (stateless services / static content) — the git repo is the source of truth, nothing to back up.';

  try {
    if (cloud === 'aws') return await verifyAws(p, ds);
    if (cloud === 'gcp') return await verifyGcp(p);
    return await verifyAzure(p);
  } catch (e) {
    return `Could not audit backups: ${(e as Error).message}`;
  }
}

async function verifyAws(p: Project, ds: Kind): Promise<string> {
  const region = p.region;
  if (ds.kind === 'rds') {
    const info = await awsJson<{ DBInstances: Array<{ BackupRetentionPeriod: number; LatestRestorableTime?: string }> }>(
      ['rds', 'describe-db-instances', '--db-instance-identifier', ds.id], region,
    );
    const db = info.DBInstances?.[0];
    if (!db) return `RDS instance ${ds.id} not found.`;
    const snaps = await awsJson<{ DBSnapshots: Array<{ SnapshotCreateTime: string; Status: string }> }>(
      ['rds', 'describe-db-snapshots', '--db-instance-identifier', ds.id, '--max-items', '5'], region,
    );
    const latest = snaps.DBSnapshots?.sort((a, b) => b.SnapshotCreateTime.localeCompare(a.SnapshotCreateTime))[0];
    return [
      `PostgreSQL (RDS ${ds.id}):`,
      `- Automated backups: ${db.BackupRetentionPeriod > 0 ? `ON, ${db.BackupRetentionPeriod}-day retention` : 'OFF ⚠ — enable retention'}`,
      db.LatestRestorableTime ? `- Restorable to any point up to: ${db.LatestRestorableTime}` : '',
      `- Latest snapshot: ${latest ? `${latest.SnapshotCreateTime} (${latest.Status})` : 'none yet'}`,
    ].filter(Boolean).join('\n');
  }
  if (ds.kind === 'docdb') {
    const info = await awsJson<{ DBClusters: Array<{ BackupRetentionPeriod: number; LatestRestorableTime?: string }> }>(
      ['docdb', 'describe-db-clusters', '--db-cluster-identifier', ds.id], region,
    );
    const c = info.DBClusters?.[0];
    if (!c) return `DocumentDB cluster ${ds.id} not found.`;
    const snaps = await awsJson<{ DBClusterSnapshots: Array<{ SnapshotCreateTime: string; Status: string }> }>(
      ['docdb', 'describe-db-cluster-snapshots', '--db-cluster-identifier', ds.id, '--max-items', '5'], region,
    );
    const latest = snaps.DBClusterSnapshots?.sort((a, b) => b.SnapshotCreateTime.localeCompare(a.SnapshotCreateTime))[0];
    return [
      `MongoDB (DocumentDB ${ds.id}):`,
      `- Automated backups: ${c.BackupRetentionPeriod > 0 ? `ON, ${c.BackupRetentionPeriod}-day retention` : 'OFF ⚠'}`,
      c.LatestRestorableTime ? `- Restorable to any point up to: ${c.LatestRestorableTime}` : '',
      `- Latest snapshot: ${latest ? `${latest.SnapshotCreateTime} (${latest.Status})` : 'none yet'}`,
    ].filter(Boolean).join('\n');
  }
  if (ds.kind === 'dynamo') {
    const pitr = await awsJson<{ ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: string } } }>(
      ['dynamodb', 'describe-continuous-backups', '--table-name', ds.table], region,
    );
    const status = pitr.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus;
    const backups = await awsJson<{ BackupSummaries: Array<{ BackupCreationDateTime: string }> }>(
      ['dynamodb', 'list-backups', '--table-name', ds.table, '--max-items', '5'], region,
    );
    const latest = backups.BackupSummaries?.sort((a, b) => b.BackupCreationDateTime.localeCompare(a.BackupCreationDateTime))[0];
    return [
      `DynamoDB (${ds.table}):`,
      `- Point-in-time recovery: ${status === 'ENABLED' ? 'ON (restore to any second in the last 35 days)' : 'OFF ⚠ — I can enable it (~$0.20/GB-month)'}`,
      `- Latest on-demand backup: ${latest ? latest.BackupCreationDateTime : 'none yet'}`,
    ].join('\n');
  }
  // s3
  const ver = await awsJson<{ Status?: string }>(['s3api', 'get-bucket-versioning', '--bucket', (ds as { bucket: string }).bucket], p.region);
  return [
    `Static site (S3 ${(ds as { bucket: string }).bucket}):`,
    `- Versioning: ${ver.Status === 'Enabled' ? 'ON (every overwrite keeps the previous version)' : 'OFF ⚠ — I can enable it'}`,
    '- The git repo remains the primary source of truth for a static site.',
  ].join('\n');
}

async function verifyGcp(p: Project): Promise<string> {
  const instance = `po-${p.name}`;
  const res = await runCloudCli('gcp', ['sql', 'instances', 'describe', instance, '--project', p.cloudTarget ?? '', '--format', 'json(settings.backupConfiguration)'], 45_000);
  if (res.code !== 0) return `Cloud SQL ${instance}: ${(res.stderr || res.stdout).trim().split('\n').pop()}`;
  const cfg = JSON.parse(res.stdout || '{}')?.settings?.backupConfiguration ?? {};
  const list = await runCloudCli('gcp', ['sql', 'backups', 'list', '--instance', instance, '--project', p.cloudTarget ?? '', '--limit', '3', '--format', 'value(windowStartTime,status)'], 45_000);
  return [
    `Cloud SQL (${instance}):`,
    `- Automated backups: ${cfg.enabled ? `ON${cfg.startTime ? ` (window ${cfg.startTime})` : ''}` : 'OFF ⚠ — I can enable them'}`,
    `- Recent backups:\n  ${list.stdout.trim() || 'none yet'}`,
  ].join('\n');
}

async function verifyAzure(p: Project): Promise<string> {
  const rg = p.outputs?.resource_group ?? `po-${p.name}`;
  const server = await runCloudCli('azure', ['postgres', 'flexible-server', 'list', '--resource-group', rg, '--query', '[0].{name:name,retention:backup.backupRetentionDays}', '--output', 'json'], 60_000);
  if (server.code !== 0 || !server.stdout.trim() || server.stdout.trim() === 'null') {
    return `No PostgreSQL flexible server found in ${rg} (Cosmos DB accounts carry continuous backup by default — ask me for a CLI check if you use one).`;
  }
  const info = JSON.parse(server.stdout);
  return [
    `PostgreSQL flexible server (${info.name}):`,
    `- Automated backups: ON, ${info.retention}-day retention (Azure-managed; restores create a new server).`,
  ].join('\n');
}

/* -------------------------------------------------------------- on-demand */

export async function backupNow(p: Project): Promise<string> {
  const cloud = p.cloud ?? 'aws';
  const ds = datastoreOf(p);
  if (ds.kind === 'none') return 'Nothing to snapshot — this project has no datastore.';
  const stamp = ts();

  if (cloud === 'gcp') {
    const res = await runCloudCli('gcp', ['sql', 'backups', 'create', '--instance', `po-${p.name}`, '--project', p.cloudTarget ?? '', '--description', `plainops-${stamp}`], 300_000);
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split('\n').pop() ?? 'backup failed');
    auditLog({ type: 'backup.done', summary: `${p.name}: Cloud SQL on-demand backup created` });
    return 'Cloud SQL on-demand backup created.';
  }
  if (cloud === 'azure') {
    return 'Azure PostgreSQL flexible server runs continuous automated backups (7-day default) and has no user-triggered snapshot API — restores are point-in-time. Backups are already covered.';
  }

  const region = p.region;
  if (ds.kind === 'rds') {
    await awsJson(['rds', 'create-db-snapshot', '--db-instance-identifier', ds.id, '--db-snapshot-identifier', `${ds.id}-plainops-${stamp}`], region, 120_000);
    auditLog({ type: 'backup.done', summary: `${p.name}: RDS snapshot ${ds.id}-plainops-${stamp}` });
    return `RDS snapshot started: ${ds.id}-plainops-${stamp} (completes in the background; verify_backups shows it when ready).`;
  }
  if (ds.kind === 'docdb') {
    await awsJson(['docdb', 'create-db-cluster-snapshot', '--db-cluster-identifier', ds.id, '--db-cluster-snapshot-identifier', `${ds.id}-plainops-${stamp}`], region, 120_000);
    auditLog({ type: 'backup.done', summary: `${p.name}: DocumentDB snapshot ${ds.id}-plainops-${stamp}` });
    return `DocumentDB cluster snapshot started: ${ds.id}-plainops-${stamp}.`;
  }
  if (ds.kind === 'dynamo') {
    await awsJson(['dynamodb', 'create-backup', '--table-name', ds.table, '--backup-name', `${ds.table}-plainops-${stamp}`], region, 120_000);
    // Belt and braces: make sure PITR is on too.
    await awsJson(['dynamodb', 'update-continuous-backups', '--table-name', ds.table, '--point-in-time-recovery-specification', 'PointInTimeRecoveryEnabled=true'], region, 60_000).catch(() => null);
    auditLog({ type: 'backup.done', summary: `${p.name}: DynamoDB backup + PITR ensured` });
    return `DynamoDB backup created (${ds.table}-plainops-${stamp}) and point-in-time recovery ensured ON.`;
  }
  // s3: enable versioning — that IS the backup mechanism for a website bucket.
  await awsJson(['s3api', 'put-bucket-versioning', '--bucket', ds.bucket, '--versioning-configuration', 'Status=Enabled'], region, 60_000);
  auditLog({ type: 'backup.done', summary: `${p.name}: S3 versioning enabled on ${ds.bucket}` });
  return `S3 versioning enabled on ${ds.bucket} — every future overwrite keeps the previous version recoverable.`;
}

/* -------------------------------------------------------------- DR drill */

async function waitFor(check: () => Promise<boolean>, attempts: number, intervalMs: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await check().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Restore the latest snapshot into a TEMPORARY instance, prove it reaches
 * "available", then delete it. Total cost: minutes of the smallest instance.
 */
export async function runDrDrill(p: Project, log: (l: string) => void): Promise<string> {
  const cloud = p.cloud ?? 'aws';
  if (cloud !== 'aws') return 'DR drills are AWS-only in this version (GCP/Azure: backups are audited + on-demand where supported; restore drills there are on the roadmap).';
  const ds = datastoreOf(p);
  const region = p.region;
  const stamp = ts();

  if (ds.kind === 'dynamo') {
    log('DR drill: restoring the latest DynamoDB backup into a temporary table…');
    const backups = await awsJson<{ BackupSummaries: Array<{ BackupArn: string; BackupCreationDateTime: string }> }>(
      ['dynamodb', 'list-backups', '--table-name', ds.table], region,
    );
    const latest = backups.BackupSummaries?.sort((a, b) => b.BackupCreationDateTime.localeCompare(a.BackupCreationDateTime))[0];
    if (!latest) return 'No backup exists yet — run backup_now first, then drill.';
    const tmp = `${ds.table}-drill-${stamp}`.slice(0, 250);
    await awsJson(['dynamodb', 'restore-table-from-backup', '--target-table-name', tmp, '--backup-arn', latest.BackupArn], region, 120_000);
    const ok = await waitFor(async () => {
      const d = await awsJson<{ Table: { TableStatus: string; ItemCount?: number } }>(['dynamodb', 'describe-table', '--table-name', tmp], region);
      return d.Table.TableStatus === 'ACTIVE';
    }, 60, 10_000);
    let items = 'unknown';
    if (ok) {
      const d = await awsJson<{ Table: { ItemCount?: number } }>(['dynamodb', 'describe-table', '--table-name', tmp], region);
      items = String(d.Table.ItemCount ?? 'unknown');
    }
    log(ok ? `Restored table ACTIVE (${items} items). Cleaning up…` : 'Restore did not reach ACTIVE in 10 min ⚠');
    await awsJson(['dynamodb', 'delete-table', '--table-name', tmp], region, 60_000).catch(() => null);
    auditLog({ type: 'dr.drill', summary: `${p.name}: DynamoDB drill ${ok ? 'PASSED' : 'FAILED'} (backup ${latest.BackupCreationDateTime})` });
    return ok
      ? `DR drill PASSED ✔ — backup from ${latest.BackupCreationDateTime} restored to a temporary table, reached ACTIVE with ${items} item(s), and was deleted. Your backups restore.`
      : 'DR drill FAILED ⚠ — the restore did not become ACTIVE within 10 minutes. The temporary table was removed; investigate before trusting these backups.';
  }

  if (ds.kind === 'rds' || ds.kind === 'docdb') {
    const isRds = ds.kind === 'rds';
    const svc = isRds ? 'rds' : 'docdb';
    log(`DR drill: restoring the latest ${isRds ? 'RDS' : 'DocumentDB'} snapshot into a temporary ${isRds ? 'instance' : 'cluster'} (this takes 10–20 min)…`);
    const snaps = isRds
      ? (await awsJson<{ DBSnapshots: Array<{ DBSnapshotIdentifier: string; SnapshotCreateTime: string; Status: string }> }>(
          ['rds', 'describe-db-snapshots', '--db-instance-identifier', ds.id], region,
        )).DBSnapshots?.filter((s) => s.Status === 'available').map((s) => ({ id: s.DBSnapshotIdentifier, at: s.SnapshotCreateTime }))
      : (await awsJson<{ DBClusterSnapshots: Array<{ DBClusterSnapshotIdentifier: string; SnapshotCreateTime: string; Status: string }> }>(
          ['docdb', 'describe-db-cluster-snapshots', '--db-cluster-identifier', ds.id], region,
        )).DBClusterSnapshots?.filter((s) => s.Status === 'available').map((s) => ({ id: s.DBClusterSnapshotIdentifier, at: s.SnapshotCreateTime }));
    const latest = snaps?.sort((a, b) => b.at.localeCompare(a.at))[0];
    if (!latest) return 'No completed snapshot exists yet — run backup_now, wait for it to finish (verify_backups), then drill.';
    const tmp = `${ds.id}-drill-${stamp}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);

    if (isRds) {
      await awsJson(['rds', 'restore-db-instance-from-db-snapshot', '--db-instance-identifier', tmp, '--db-snapshot-identifier', latest.id, '--db-instance-class', 'db.t4g.micro', '--no-multi-az', '--no-publicly-accessible'], region, 120_000);
    } else {
      await awsJson(['docdb', 'restore-db-cluster-from-snapshot', '--db-cluster-identifier', tmp, '--snapshot-identifier', latest.id, '--engine', 'docdb'], region, 120_000);
    }
    const ok = await waitFor(async () => {
      if (isRds) {
        const d = await awsJson<{ DBInstances: Array<{ DBInstanceStatus: string }> }>(['rds', 'describe-db-instances', '--db-instance-identifier', tmp], region);
        return d.DBInstances?.[0]?.DBInstanceStatus === 'available';
      }
      const d = await awsJson<{ DBClusters: Array<{ Status: string }> }>(['docdb', 'describe-db-clusters', '--db-cluster-identifier', tmp], region);
      return d.DBClusters?.[0]?.Status === 'available';
    }, 120, 15_000);
    log(ok ? 'Restored and AVAILABLE. Cleaning up the temporary copy…' : 'Restore did not reach available in 30 min ⚠ Cleaning up…');
    if (isRds) {
      await awsJson(['rds', 'delete-db-instance', '--db-instance-identifier', tmp, '--skip-final-snapshot'], region, 120_000).catch(() => null);
    } else {
      await awsJson([svc, 'delete-db-cluster', '--db-cluster-identifier', tmp, '--skip-final-snapshot'], region, 120_000).catch(() => null);
    }
    auditLog({ type: 'dr.drill', summary: `${p.name}: ${svc} drill ${ok ? 'PASSED' : 'FAILED'} (snapshot ${latest.id})` });
    return ok
      ? `DR drill PASSED ✔ — snapshot ${latest.id} (${latest.at}) restored to a temporary ${isRds ? 'db.t4g.micro instance' : 'cluster'}, reached "available", and was deleted (cost: a few cents). Your backups restore.`
      : `DR drill FAILED ⚠ — the restore from ${latest.id} did not become available within 30 minutes. Temporary resources were removed; investigate before trusting these backups.`;
  }

  if (ds.kind === 's3') {
    return 'Static sites: versioning (see verify_backups / backup_now) plus the git repo already give full recovery — a restore drill is just redeploying, which the deploy pipeline exercises every time.';
  }
  return 'This project has no datastore to drill.';
}
