import { runAwsCli } from './awscli.js';
import { auditLog } from './audit.js';

/**
 * Security posture scan — read-only, so it runs instantly with no approval.
 * Checks the findings that actually breach small companies: storage exposed
 * to the internet, management ports open to 0.0.0.0/0, databases with public
 * addresses, unencrypted disks, root/user accounts without MFA, and access
 * keys old enough to have leaked years ago.
 *
 * Deliberately NOT a compliance framework: every finding names the resource,
 * why it matters in one line, and the fix PlainOps can apply next.
 */

export type Severity = 'critical' | 'high' | 'medium';

export interface Finding {
  severity: Severity;
  resource: string;
  issue: string;
  fix: string;
}

const RISKY_PORTS: Record<number, string> = {
  22: 'SSH',
  3389: 'RDP',
  3306: 'MySQL',
  5432: 'PostgreSQL',
  27017: 'MongoDB',
  6379: 'Redis',
  9200: 'Elasticsearch',
  1433: 'SQL Server',
};

function coversPort(from: number | undefined, to: number | undefined, port: number): boolean {
  if (from === undefined || to === undefined) return false;
  return from <= port && to >= port;
}

/** Rank + render findings (pure, testable). */
export function summarizeFindings(findings: Finding[], region: string): string {
  if (findings.length === 0) {
    return `Security scan of ${region}: no critical exposures found — no public storage, no management ports open to the world, no public databases, no unencrypted disks. 👍\n(This covers the high-impact basics, not a full compliance audit.)`;
  }
  const order: Severity[] = ['critical', 'high', 'medium'];
  const sorted = [...findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const icon = { critical: '🔴', high: '🟠', medium: '🟡' };
  const counts = order
    .map((s) => ({ s, n: findings.filter((f) => f.severity === s).length }))
    .filter((c) => c.n > 0)
    .map((c) => `${c.n} ${c.s}`)
    .join(', ');
  return [
    `Security scan of ${region} — ${counts}:`,
    ...sorted.map((f) => `${icon[f.severity]} ${f.resource}\n   ${f.issue}\n   Fix: ${f.fix}`),
    '',
    'I can fix any of these — each change goes through the normal approval.',
  ].join('\n');
}

async function awsJson<T>(args: string[], region: string, timeoutMs = 60_000): Promise<T> {
  const res = await runAwsCli([...args, '--region', region, '--output', 'json'], timeoutMs);
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split(/\r?\n/).slice(-2).join(' '));
  return JSON.parse(res.stdout || '{}') as T;
}

async function publicBuckets(region: string, findings: Finding[]): Promise<void> {
  const list = await awsJson<{ Buckets: Array<{ Name: string }> }>(['s3api', 'list-buckets'], region);
  for (const b of (list.Buckets ?? []).slice(0, 40)) {
    // A PlainOps static site is public ON PURPOSE — don't cry wolf about it.
    if (/^plainops-site-/.test(b.Name)) continue;
    try {
      const pab = await awsJson<{ PublicAccessBlockConfiguration?: { BlockPublicAcls?: boolean; BlockPublicPolicy?: boolean } }>(
        ['s3api', 'get-public-access-block', '--bucket', b.Name], region, 30_000,
      );
      const cfg = pab.PublicAccessBlockConfiguration;
      if (cfg?.BlockPublicAcls && cfg?.BlockPublicPolicy) continue;
    } catch {
      // No block configuration at all = nothing preventing public access.
    }
    try {
      const status = await awsJson<{ PolicyStatus?: { IsPublic?: boolean } }>(
        ['s3api', 'get-bucket-policy-status', '--bucket', b.Name], region, 30_000,
      );
      if (status.PolicyStatus?.IsPublic) {
        findings.push({
          severity: 'critical',
          resource: `S3 bucket ${b.Name}`,
          issue: 'Readable by anyone on the internet — anything stored here is effectively published.',
          fix: 'Enable Block Public Access (or remove the public policy) unless this is deliberately a website bucket.',
        });
        continue;
      }
    } catch {
      /* no policy = not public via policy */
    }
    findings.push({
      severity: 'medium',
      resource: `S3 bucket ${b.Name}`,
      issue: 'Block Public Access is not fully enabled, so a future policy or ACL change could expose it silently.',
      fix: 'Turn on all four Block Public Access settings.',
    });
  }
}

async function openSecurityGroups(region: string, findings: Finding[]): Promise<void> {
  const sgs = await awsJson<{
    SecurityGroups: Array<{
      GroupId: string;
      GroupName: string;
      IpPermissions: Array<{ FromPort?: number; ToPort?: number; IpProtocol: string; IpRanges: Array<{ CidrIp: string }> }>;
    }>;
  }>(['ec2', 'describe-security-groups'], region);
  for (const sg of sgs.SecurityGroups ?? []) {
    for (const perm of sg.IpPermissions ?? []) {
      const openToWorld = (perm.IpRanges ?? []).some((r) => r.CidrIp === '0.0.0.0/0');
      if (!openToWorld) continue;
      if (perm.IpProtocol === '-1') {
        findings.push({
          severity: 'critical',
          resource: `Security group ${sg.GroupName} (${sg.GroupId})`,
          issue: 'ALL ports are open to the entire internet.',
          fix: 'Restrict to the ports the app actually serves (80/443), or to your own IP for admin access.',
        });
        continue;
      }
      for (const [portStr, name] of Object.entries(RISKY_PORTS)) {
        const port = Number(portStr);
        if (coversPort(perm.FromPort, perm.ToPort, port)) {
          findings.push({
            severity: 'critical',
            resource: `Security group ${sg.GroupName} (${sg.GroupId})`,
            issue: `${name} (port ${port}) is reachable from the entire internet — this is how servers and databases get compromised.`,
            fix: `Limit port ${port} to your own IP address or a VPN/bastion, never 0.0.0.0/0.`,
          });
        }
      }
    }
  }
}

async function publicDatabases(region: string, findings: Finding[]): Promise<void> {
  const dbs = await awsJson<{ DBInstances: Array<{ DBInstanceIdentifier: string; PubliclyAccessible?: boolean; StorageEncrypted?: boolean }> }>(
    ['rds', 'describe-db-instances'], region,
  );
  for (const db of dbs.DBInstances ?? []) {
    if (db.PubliclyAccessible) {
      findings.push({
        severity: 'critical',
        resource: `RDS database ${db.DBInstanceIdentifier}`,
        issue: 'Has a public address — reachable from outside your network, protected only by its password.',
        fix: 'Set it private (publicly-accessible = false) so only your app can reach it.',
      });
    }
    if (db.StorageEncrypted === false) {
      findings.push({
        severity: 'high',
        resource: `RDS database ${db.DBInstanceIdentifier}`,
        issue: 'Storage is not encrypted at rest.',
        fix: 'Encryption must be set at creation — restore a snapshot into a new encrypted instance during a maintenance window.',
      });
    }
  }
}

async function unencryptedVolumes(region: string, findings: Finding[]): Promise<void> {
  const vols = await awsJson<{ Volumes: Array<{ VolumeId: string; Encrypted: boolean }> }>(
    ['ec2', 'describe-volumes', '--filters', 'Name=encrypted,Values=false'], region,
  );
  const ids = (vols.Volumes ?? []).map((v) => v.VolumeId);
  if (ids.length) {
    findings.push({
      severity: 'high',
      resource: `${ids.length} unencrypted EBS volume(s)`,
      issue: `Disk contents are stored unencrypted (${ids.slice(0, 4).join(', ')}${ids.length > 4 ? '…' : ''}).`,
      fix: 'Enable EBS encryption-by-default for the region, then re-create volumes from encrypted snapshots.',
    });
  }
}

async function iamHygiene(region: string, findings: Finding[]): Promise<void> {
  const summary = await awsJson<{ SummaryMap: Record<string, number> }>(['iam', 'get-account-summary'], region);
  if (summary.SummaryMap?.AccountMFAEnabled === 0) {
    findings.push({
      severity: 'critical',
      resource: 'AWS root account',
      issue: 'No MFA on the root account — a single password stands between an attacker and everything you own.',
      fix: 'Turn on MFA for root in the AWS console today (I cannot do this for you — it needs the root login).',
    });
  }
  const users = await awsJson<{ Users: Array<{ UserName: string }> }>(['iam', 'list-users'], region);
  for (const u of (users.Users ?? []).slice(0, 25)) {
    const keys = await awsJson<{ AccessKeyMetadata: Array<{ AccessKeyId: string; CreateDate: string; Status: string }> }>(
      ['iam', 'list-access-keys', '--user-name', u.UserName], region, 30_000,
    );
    for (const k of keys.AccessKeyMetadata ?? []) {
      if (k.Status !== 'Active') continue;
      const ageDays = Math.floor((Date.now() - new Date(k.CreateDate).getTime()) / 86_400_000);
      if (ageDays > 365) {
        findings.push({
          severity: 'medium',
          resource: `IAM user ${u.UserName} — key ${k.AccessKeyId.slice(0, 8)}…`,
          issue: `Access key is ${ageDays} days old; long-lived keys are the most common credential leak.`,
          fix: 'Rotate it (create a new key, update whatever uses it, delete the old one).',
        });
      }
    }
  }
}

export async function scanSecurity(region: string): Promise<string> {
  const findings: Finding[] = [];
  const checks: Array<[string, Promise<void>]> = [
    ['storage', publicBuckets(region, findings)],
    ['network', openSecurityGroups(region, findings)],
    ['databases', publicDatabases(region, findings)],
    ['disks', unencryptedVolumes(region, findings)],
    ['accounts', iamHygiene(region, findings)],
  ];
  const skipped: string[] = [];
  for (const [name, promise] of checks) {
    try {
      await promise;
    } catch (e) {
      skipped.push(`${name} (${(e as Error).message.slice(0, 80)})`);
    }
  }
  auditLog({ type: 'security.scan', summary: `${region}: ${findings.length} finding(s)` });
  const body = summarizeFindings(findings, region);
  return skipped.length ? `${body}\n\nCould not check: ${skipped.join('; ')} — usually missing IAM permissions.` : body;
}
