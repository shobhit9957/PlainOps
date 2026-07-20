import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-mc-'));
});

describe('renderCloudBlueprint', () => {
  it('copies the HCL trio and writes tfvars for a gcp-app project', async () => {
    const { renderCloudBlueprint } = await import('../src/multicloud.js');
    const dir = renderCloudBlueprint('gcp-app', 'demo', {
      project_name: 'demo',
      gcp_project: 'acme-123',
      region: 'asia-south1',
      with_database: false,
      app_secrets: [],
    });
    for (const f of ['main.tf', 'variables.tf', 'outputs.tf', 'terraform.tfvars.json']) {
      expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    }
    const tfvars = JSON.parse(fs.readFileSync(path.join(dir, 'terraform.tfvars.json'), 'utf8'));
    expect(tfvars.gcp_project).toBe('acme-123');
    // Secret VALUES must never appear in tfvars — only names/params.
    expect(JSON.stringify(tfvars)).not.toMatch(/password|secret_value/i);
  });

  it('copies the trio for every new blueprint', async () => {
    const { renderCloudBlueprint } = await import('../src/multicloud.js');
    for (const bp of ['gcp-app', 'gcp-serverless', 'gcp-microservices', 'azure-app', 'azure-serverless', 'azure-microservices']) {
      const dir = renderCloudBlueprint(bp, `t-${bp.replace(/[^a-z]/g, '')}`, { project_name: 'x', region: 'r' });
      expect(fs.readFileSync(path.join(dir, 'main.tf'), 'utf8').length).toBeGreaterThan(200);
    }
  });

  it('throws a clear error for an unknown blueprint', async () => {
    const { renderCloudBlueprint } = await import('../src/multicloud.js');
    expect(() => renderCloudBlueprint('gcp-nonsense', 'demo', {})).toThrow(/Blueprint not found/);
  });
});

describe('destroyCloud', () => {
  it('refuses when nothing was ever rendered', async () => {
    const { destroyCloud } = await import('../src/multicloud.js');
    const { upsertProject } = await import('../src/state.js');
    upsertProject({ name: 'ghost', region: 'asia-south1', cloud: 'gcp', status: 'new', createdAt: new Date().toISOString() });
    await expect(destroyCloud('ghost', () => {})).rejects.toThrow(/Nothing to destroy/);
  });
});

describe('Azure resource-provider registration (fresh-subscription first deploy)', () => {
  it('maps each archetype to exactly the providers its blueprint creates', async () => {
    const { azureProvidersFor } = await import('../src/multicloud.js');
    expect(azureProvidersFor('app', true)).toEqual([
      'Microsoft.App', 'Microsoft.ContainerRegistry', 'Microsoft.OperationalInsights', 'Microsoft.DBforPostgreSQL',
    ]);
    expect(azureProvidersFor('app', false)).not.toContain('Microsoft.DBforPostgreSQL');
    expect(azureProvidersFor('serverless', false)).toEqual(['Microsoft.Web', 'Microsoft.Storage']);
    expect(azureProvidersFor('microservices', true)).toContain('Microsoft.DocumentDB');
  });

  it('registers only what is not already Registered, and never throws on failure', async () => {
    const { ensureAzureProviders, defaultMcDeps } = await import('../src/multicloud.js');
    const calls: string[][] = [];
    const deps = {
      ...defaultMcDeps,
      runCli: async (_cloud: 'gcp' | 'azure', args: string[]) => {
        calls.push(args);
        if (args[1] === 'show') {
          // Microsoft.App is registered already; the rest are not.
          return { code: 0, stdout: args.includes('Microsoft.App') ? 'Registered\n' : 'NotRegistered\n', stderr: '' };
        }
        return { code: args.includes('Microsoft.Storage') ? 1 : 0, stdout: '', stderr: 'denied' }; // one failure path
      },
    };
    const lines: string[] = [];
    await ensureAzureProviders(['Microsoft.App', 'Microsoft.Web', 'Microsoft.Storage'], (l) => lines.push(l), deps as never);
    const registers = calls.filter((a) => a[1] === 'register').map((a) => a[3]);
    expect(registers).toEqual(['Microsoft.Web', 'Microsoft.Storage']); // App skipped
    expect(calls.every((a) => a[0] === 'provider')).toBe(true);
    expect(lines.join('\n')).toContain('az provider register --namespace Microsoft.Storage'); // honest fallback instruction
  });
});

describe('deployGcp preflight', () => {
  it('fails cleanly for an unknown project', async () => {
    const { deployGcp } = await import('../src/multicloud.js');
    await expect(deployGcp('nope', 'app', {}, () => {})).rejects.toThrow(/Unknown project/);
  });
});

describe('datastoreOf', () => {
  it('detects each datastore shape correctly', async () => {
    const { datastoreOf } = await import('../src/backup.js');
    const mk = (o: Record<string, unknown>) => ({ name: 'x', region: 'r', status: 'live', createdAt: 'now', ...o }) as import('../src/state.js').Project;
    expect(datastoreOf(mk({ siteBucket: 'b' }))).toEqual({ kind: 's3', bucket: 'b' });
    expect(datastoreOf(mk({ outputs: { orders_table: 't' } }))).toEqual({ kind: 'dynamo', table: 't' });
    expect(datastoreOf(mk({ outputs: { docdb_endpoint: 'e' } }))).toEqual({ kind: 'docdb', id: 'po-x' });
    expect(datastoreOf(mk({ outputs: { db_endpoint: 'e' }, blueprint: { withDatabase: true } }))).toEqual({ kind: 'rds', id: 'po-x' });
    expect(datastoreOf(mk({ outputs: { app_url: 'u' } }))).toEqual({ kind: 'none' });
  });
});
