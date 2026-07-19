import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BlueprintParams } from '../src/estimator.js';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-render-'));
});

const params: BlueprintParams = {
  projectName: 'demo-app',
  region: 'us-east-1',
  cpu: 256,
  memoryMb: 512,
  desiredCount: 1,
  maxCount: 4,
  withDatabase: true,
  healthPath: '/health',
  containerPort: 3000,
  appSecrets: ['DATABASE_URL', 'STRIPE_KEY'],
  budgetMonthlyUsd: 60,
};

describe('renderProject', () => {
  it('copies HCL files and writes tfvars matching params', async () => {
    const { setSecret } = await import('../src/vault.js');
    setSecret('STRIPE_KEY', 'sk_live_do_not_leak_12345');

    const { renderProject } = await import('../src/blueprint/render.js');
    const dir = renderProject(params, 'plainops-123456789012-us-east-1');

    for (const f of ['main.tf', 'variables.tf', 'outputs.tf', 'terraform.tfvars.json']) {
      expect(fs.existsSync(path.join(dir, f)), `${f} should exist`).toBe(true);
    }
    const tfvars = JSON.parse(fs.readFileSync(path.join(dir, 'terraform.tfvars.json'), 'utf8'));
    expect(tfvars.project_name).toBe('demo-app');
    expect(tfvars.app_secrets).toEqual(['DATABASE_URL', 'STRIPE_KEY']);
    expect(tfvars.with_database).toBe(true);
    expect(tfvars.bootstrap_bucket).toBe('plainops-123456789012-us-east-1');
    expect(tfvars.budget_email).toBe('');

    // Absolutely no secret values anywhere in the rendered directory.
    for (const f of fs.readdirSync(dir)) {
      const content = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(content).not.toContain('sk_live_do_not_leak_12345');
    }
  });

  it('withDatabase GUARANTEES DATABASE_URL in the rendered app secrets (the contract the app docs promise)', async () => {
    const { renderProject } = await import('../src/blueprint/render.js');
    // A caller that forgets DATABASE_URL (only the propose_infrastructure tool
    // used to add it) must still get a database-connected app — GCP/Azure
    // blueprints hardwire this in HCL; AWS must honor it at render time.
    const dir = renderProject({ ...params, projectName: 'dbapp', appSecrets: ['APP_TOKEN'] }, 'bkt');
    const tfvars = JSON.parse(fs.readFileSync(path.join(dir, 'terraform.tfvars.json'), 'utf8'));
    expect(tfvars.app_secrets).toContain('DATABASE_URL');
    expect(tfvars.app_secrets).toContain('APP_TOKEN');

    // Never duplicated, and never added without a database.
    const dir2 = renderProject({ ...params, projectName: 'dbapp2' }, 'bkt');
    const tf2 = JSON.parse(fs.readFileSync(path.join(dir2, 'terraform.tfvars.json'), 'utf8'));
    expect(tf2.app_secrets.filter((s: string) => s === 'DATABASE_URL')).toHaveLength(1);
    const dir3 = renderProject({ ...params, projectName: 'nodb', withDatabase: false, appSecrets: ['APP_TOKEN'] }, 'bkt');
    const tf3 = JSON.parse(fs.readFileSync(path.join(dir3, 'terraform.tfvars.json'), 'utf8'));
    expect(tf3.app_secrets).not.toContain('DATABASE_URL');
  });

  it('buildspec pushes both the immutable and the live tag', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src', 'blueprint', 'files', 'main.tf'),
      'utf8',
    );
    expect(main).toContain('docker push $ECR_URL:$IMAGE_TAG');
    expect(main).toContain('docker push $ECR_URL:live');
    expect(main).not.toContain('nat_gateway'); // cost guard: no NAT, ever
  });
});
