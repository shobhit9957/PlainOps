import { runAwsCli } from './awscli.js';
import { runCloudCli } from './clouds/cloudcli.js';
import { auditLog } from './audit.js';
import type { Project } from './state.js';

/**
 * Custom domains, first-class: "connect mydatingapp.com to this app, with
 * HTTPS" as one guided pipeline on each cloud's NATIVE stack:
 *
 *   AWS   — Route 53 zone → ACM certificate (DNS-validated) → HTTPS :443
 *           listener on the ALB → alias record. Fully orchestrated.
 *   GCP   — Cloud Run domain mapping (Google-managed cert) + Cloud DNS
 *           records when the zone is hosted there.
 *   Azure — Container Apps hostname + managed certificate bind + Azure DNS
 *           records when the zone is hosted there.
 *
 * Hard precondition everywhere: the domain's DNS zone must be HOSTED in that
 * cloud's DNS service (or its nameservers delegated there). We detect that
 * and explain exactly what to do when it isn't — never guess-and-fail.
 */

export function isValidDomain(domain: string): boolean {
  return /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain.trim());
}

/** Longest-suffix zone match: app.shop.example.com → shop.example.com. over example.com. */
export function bestZoneMatch<T extends { name: string }>(domain: string, zones: T[]): T | null {
  const d = domain.toLowerCase().replace(/\.$/, '');
  let best: T | null = null;
  for (const z of zones) {
    const zn = z.name.toLowerCase().replace(/\.$/, '');
    if ((d === zn || d.endsWith('.' + zn)) && (!best || zn.length > best.name.replace(/\.$/, '').length)) best = z;
  }
  return best;
}

/** Route 53 change-batch for a single UPSERT (pure, testable). */
export function r53Change(name: string, type: string, value: string, aliasZoneId?: string): string {
  const rr = aliasZoneId
    ? { Name: name, Type: type, AliasTarget: { HostedZoneId: aliasZoneId, DNSName: value, EvaluateTargetHealth: false } }
    : { Name: name, Type: type, TTL: 300, ResourceRecords: [{ Value: value }] };
  return JSON.stringify({ Changes: [{ Action: 'UPSERT', ResourceRecordSet: rr }] });
}

async function awsJson<T>(args: string[], region: string, timeoutMs = 60_000): Promise<T> {
  const res = await runAwsCli([...args, '--region', region, '--output', 'json'], timeoutMs);
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split(/\r?\n/).slice(-3).join(' '));
  return JSON.parse(res.stdout || '{}') as T;
}

async function waitUntil(check: () => Promise<boolean>, attempts: number, intervalMs: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await check().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/* -------------------------------------------------------------------- AWS */

async function setupAws(p: Project, domain: string, log: (l: string) => void): Promise<string> {
  const region = p.region;

  // 1. The zone must live in Route 53.
  const zones = await awsJson<{ HostedZones: Array<{ Id: string; Name: string }> }>(
    ['route53', 'list-hosted-zones-by-name', '--dns-name', domain.split('.').slice(-2).join('.')], region,
  );
  const zone = bestZoneMatch(domain, (zones.HostedZones ?? []).map((z) => ({ ...z, name: z.Name })));
  if (!zone) {
    throw new Error(
      `No Route 53 hosted zone covers ${domain}. Create one (aws route53 create-hosted-zone) and point the domain's nameservers at it from your registrar — then run this again. I can create the zone for you with approval.`,
    );
  }
  const zoneId = zone.Id.replace('/hostedzone/', '');
  log(`Found Route 53 zone ${zone.Name} (${zoneId}).`);

  // 2. This flow terminates TLS on the ALB — container/microservices stacks.
  const albName = `po-${p.name}`;
  const lbs = await awsJson<{ LoadBalancers: Array<{ LoadBalancerArn: string; DNSName: string; CanonicalHostedZoneId: string; SecurityGroups: string[] }> }>(
    ['elbv2', 'describe-load-balancers', '--names', albName], region,
  );
  const lb = lbs.LoadBalancers?.[0];
  if (!lb) throw new Error(`No load balancer named ${albName} — this flow covers the container/microservices stacks. Static sites need CloudFront (ask me and I'll walk that path with the CLI), and serverless API Gateway domains are a separate one-liner I can run.`);

  // 3. Request a DNS-validated certificate.
  log('Requesting a TLS certificate (ACM, DNS-validated)…');
  const cert = await awsJson<{ CertificateArn: string }>(
    ['acm', 'request-certificate', '--domain-name', domain, '--validation-method', 'DNS'], region, 60_000,
  );
  const certArn = cert.CertificateArn;

  // 4. Publish the validation record.
  let rr: { Name: string; Type: string; Value: string } | undefined;
  await waitUntil(async () => {
    const d = await awsJson<{ Certificate: { DomainValidationOptions?: Array<{ ResourceRecord?: { Name: string; Type: string; Value: string } }> } }>(
      ['acm', 'describe-certificate', '--certificate-arn', certArn], region,
    );
    rr = d.Certificate.DomainValidationOptions?.[0]?.ResourceRecord;
    return Boolean(rr);
  }, 12, 5_000);
  if (!rr) throw new Error('ACM did not publish a validation record in time — try again in a minute.');
  await awsJson(
    ['route53', 'change-resource-record-sets', '--hosted-zone-id', zoneId, '--change-batch', r53Change(rr.Name, rr.Type, rr.Value)],
    region, 60_000,
  );
  log('Validation record published. Waiting for the certificate to be ISSUED (usually 1–5 min)…');
  const issued = await waitUntil(async () => {
    const d = await awsJson<{ Certificate: { Status: string } }>(['acm', 'describe-certificate', '--certificate-arn', certArn], region);
    return d.Certificate.Status === 'ISSUED';
  }, 60, 10_000);
  if (!issued) throw new Error('Certificate not ISSUED after 10 minutes — DNS may still be propagating. Run this again shortly; everything done so far is reused.');
  log('Certificate ISSUED ✔');

  // 5. Open :443 on the ALB security group (idempotent) and add the HTTPS listener.
  for (const sg of lb.SecurityGroups.slice(0, 1)) {
    const r = await runAwsCli(
      ['ec2', 'authorize-security-group-ingress', '--group-id', sg, '--protocol', 'tcp', '--port', '443', '--cidr', '0.0.0.0/0', '--region', region, '--output', 'json'],
      60_000,
    );
    if (r.code !== 0 && !/Duplicate/i.test(r.stderr)) throw new Error(`Could not open port 443: ${r.stderr.split('\n').pop()}`);
  }
  const tgs = await awsJson<{ TargetGroups: Array<{ TargetGroupArn: string }> }>(
    ['elbv2', 'describe-target-groups', '--load-balancer-arn', lb.LoadBalancerArn], region,
  );
  const tg = tgs.TargetGroups?.[0];
  if (!tg) throw new Error('The load balancer has no target group — is the stack healthy?');
  const listeners = await awsJson<{ Listeners: Array<{ Port: number; ListenerArn: string }> }>(
    ['elbv2', 'describe-listeners', '--load-balancer-arn', lb.LoadBalancerArn], region,
  );
  const https = listeners.Listeners?.find((l) => l.Port === 443);
  if (https) {
    await awsJson(['elbv2', 'add-listener-certificates', '--listener-arn', https.ListenerArn, '--certificates', `CertificateArn=${certArn}`], region).catch(() => null);
    log('HTTPS listener already exists — certificate attached.');
  } else {
    await awsJson(
      ['elbv2', 'create-listener', '--load-balancer-arn', lb.LoadBalancerArn, '--protocol', 'HTTPS', '--port', '443',
        '--certificates', `CertificateArn=${certArn}`, '--ssl-policy', 'ELBSecurityPolicy-TLS13-1-2-2021-06',
        '--default-actions', `Type=forward,TargetGroupArn=${tg.TargetGroupArn}`],
      region, 60_000,
    );
    log('HTTPS :443 listener created on the load balancer.');
  }

  // 6. Point the domain at the ALB.
  await awsJson(
    ['route53', 'change-resource-record-sets', '--hosted-zone-id', zoneId, '--change-batch', r53Change(domain, 'A', lb.DNSName, lb.CanonicalHostedZoneId)],
    region, 60_000,
  );
  log(`${domain} → ${lb.DNSName} (alias record) published.`);
  auditLog({ type: 'domain.setup', summary: `${p.name}: https://${domain} wired (cert ${certArn.split('/').pop()})` });
  return `https://${domain} is wired: Route 53 alias → load balancer, TLS certificate issued and attached, port 443 open. DNS propagation can take a few minutes — probe it shortly (get_status stays on the ALB URL; the domain is additive).`;
}

/* -------------------------------------------------------------------- GCP */

async function setupGcp(p: Project, domain: string, log: (l: string) => void): Promise<string> {
  const proj = p.cloudTarget ?? '';
  const service = p.outputs?.service_name ?? `po-${p.name}`;
  log(`Creating a Cloud Run domain mapping for ${domain} → ${service} (Google provisions the certificate automatically)…`);
  const map = await runCloudCli('gcp', ['beta', 'run', 'domain-mappings', 'create', '--service', service, '--domain', domain, '--region', p.region, '--project', proj, '--quiet'], 120_000);
  if (map.code !== 0 && !/already exists/i.test(map.stderr)) {
    throw new Error(`Domain mapping failed: ${(map.stderr || map.stdout).trim().split('\n').pop()} (Cloud Run requires the domain to be verified for this account — run 'gcloud domains verify ${domain}' if prompted.)`);
  }
  const desc = await runCloudCli('gcp', ['beta', 'run', 'domain-mappings', 'describe', '--domain', domain, '--region', p.region, '--project', proj, '--format', 'json(status.resourceRecords)'], 60_000);
  let records: Array<{ name?: string; rrdata: string; type: string }> = [];
  try { records = JSON.parse(desc.stdout || '{}')?.status?.resourceRecords ?? []; } catch { /* ignore */ }

  const zonesRes = await runCloudCli('gcp', ['dns', 'managed-zones', 'list', '--project', proj, '--format', 'json(name,dnsName)'], 60_000);
  const zones: Array<{ name: string; dnsName: string }> = zonesRes.code === 0 ? JSON.parse(zonesRes.stdout || '[]') : [];
  const zone = bestZoneMatch(domain, zones.map((z) => ({ ...z, name: z.dnsName })));
  if (zone && records.length) {
    for (const r of records) {
      const recordName = r.name ? `${r.name}.${domain}.` : `${domain}.`;
      await runCloudCli('gcp', ['dns', 'record-sets', 'create', recordName, `--type=${r.type}`, `--rrdatas=${r.rrdata}`, `--ttl=300`, `--zone=${(zone as unknown as { name: string; dnsName: string }).name}`, '--project', proj], 60_000).catch(() => null);
    }
    log(`Published ${records.length} record(s) in Cloud DNS zone ${zone.name}.`);
    auditLog({ type: 'domain.setup', summary: `${p.name}: ${domain} mapped on Cloud Run + Cloud DNS records` });
    return `https://${domain} is mapping to ${service}: records published in Cloud DNS; Google issues the managed certificate once DNS propagates (typically 15–60 min).`;
  }
  const recordList = records.map((r) => `  ${r.type}  ${r.name ? r.name + '.' + domain : domain}  →  ${r.rrdata}`).join('\n') || '  (records not yet available — describe the mapping again in a minute)';
  auditLog({ type: 'domain.setup', summary: `${p.name}: ${domain} mapped on Cloud Run (manual DNS records)` });
  return `Domain mapping created. The zone for ${domain} is not hosted in this project's Cloud DNS, so add these records wherever the DNS lives:\n${recordList}\nGoogle issues the certificate automatically once they resolve.`;
}

/* ------------------------------------------------------------------ Azure */

async function setupAzure(p: Project, domain: string, log: (l: string) => void): Promise<string> {
  const rg = p.outputs?.resource_group ?? `po-${p.name}`;
  const appName = `po-${p.name}`;
  const show = await runCloudCli('azure', ['containerapp', 'show', '--name', appName, '--resource-group', rg, '--query', '{fqdn:properties.configuration.ingress.fqdn,verify:properties.customDomainVerificationId,envId:properties.environmentId}', '--output', 'json'], 60_000);
  if (show.code !== 0) throw new Error(`Could not read the Container App: ${(show.stderr || show.stdout).trim().split('\n').pop()} (this flow covers the Azure app/microservices gateway).`);
  const info = JSON.parse(show.stdout) as { fqdn: string; verify: string; envId: string };

  const zonesRes = await runCloudCli('azure', ['network', 'dns', 'zone', 'list', '--query', '[].{name:name,rg:resourceGroup}', '--output', 'json'], 60_000);
  const zones: Array<{ name: string; rg: string }> = zonesRes.code === 0 ? JSON.parse(zonesRes.stdout || '[]') : [];
  const zone = bestZoneMatch(domain, zones);
  if (!zone) {
    return `The zone for ${domain} is not hosted in Azure DNS. Add these records at your DNS provider, then run this again:\n  CNAME  ${domain}  →  ${info.fqdn}\n  TXT    asuid.${domain}  →  ${info.verify}\nOnce they resolve I'll bind the hostname with a free managed certificate.`;
  }
  const sub = domain.replace(`.${zone.name}`, '');
  log(`Publishing records in Azure DNS zone ${zone.name}…`);
  await runCloudCli('azure', ['network', 'dns', 'record-set', 'cname', 'set-record', '--zone-name', zone.name, '--resource-group', zone.rg, '--record-set-name', sub, '--cname', info.fqdn], 60_000);
  await runCloudCli('azure', ['network', 'dns', 'record-set', 'txt', 'add-record', '--zone-name', zone.name, '--resource-group', zone.rg, '--record-set-name', `asuid.${sub}`, '--value', info.verify], 60_000).catch(() => null);

  log('Binding the hostname with a free Azure-managed certificate…');
  const bind = await runCloudCli('azure', ['containerapp', 'hostname', 'bind', '--name', appName, '--resource-group', rg, '--hostname', domain, '--environment', info.envId, '--validation-method', 'CNAME'], 300_000);
  if (bind.code !== 0) {
    return `DNS records are published, but the certificate bind reported: ${(bind.stderr || bind.stdout).trim().split('\n').slice(-2).join(' ')}\nThis usually means DNS hasn't propagated yet — run this again in ~10 minutes and the bind completes.`;
  }
  auditLog({ type: 'domain.setup', summary: `${p.name}: https://${domain} bound on Container Apps` });
  return `https://${domain} is bound to ${appName} with an Azure-managed certificate. Propagation can take a few minutes.`;
}

/* ------------------------------------------------------------------ entry */

export async function setupCustomDomain(p: Project, domain: string, log: (l: string) => void): Promise<string> {
  const d = domain.trim().toLowerCase();
  if (!isValidDomain(d)) throw new Error(`"${domain}" doesn't look like a valid domain (expected something like app.example.com).`);
  const cloud = p.cloud ?? 'aws';
  if (cloud === 'gcp') return setupGcp(p, d, log);
  if (cloud === 'azure') return setupAzure(p, d, log);
  return setupAws(p, d, log);
}
