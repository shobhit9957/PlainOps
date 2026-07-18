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

describe('deployGcp preflight', () => {
  it('fails cleanly for an unknown project', async () => {
    const { deployGcp } = await import('../src/multicloud.js');
    await expect(deployGcp('nope', 'app', {}, () => {})).rejects.toThrow(/Unknown project/);
  });
});
