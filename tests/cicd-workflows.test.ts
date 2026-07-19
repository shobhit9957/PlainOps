import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import type { Project } from '../src/state.js';

/**
 * Every workflow PlainOps emits must be VALID YAML that GitHub Actions can
 * run, wired to the project's REAL resource names. A workflow that fails to
 * parse (or references placeholder names) burns the founder's trust on their
 * very first push — so every shape on every cloud is asserted here.
 */

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-wf-'));
});

const base = { region: 'ap-south-1', status: 'live', createdAt: 'now', repoPath: 'C:\\x' } as const;

function proj(extra: Partial<Project>): Project {
  return { name: 'shop', ...base, ...extra } as Project;
}

interface Wf {
  name: string;
  on: { push: { branches: string[] } };
  concurrency: string;
  jobs: { deploy: { steps: Array<{ run?: string; uses?: string }>; strategy?: { matrix: { service: string[] } } } };
}

async function gen(p: Project): Promise<{ wf: Wf; plan: { yaml: string; secretsNeeded: string[] } }> {
  const { generateWorkflow } = await import('../src/cicd.js');
  const plan = generateWorkflow(p);
  const wf = yamlLoad(plan.yaml) as Wf;
  return { wf, plan };
}

describe('generated GitHub Actions workflows parse and target real resources', () => {
  it('AWS container app', async () => {
    const { wf, plan } = await gen(proj({
      accountId: '659587495971',
      outputs: { ecr_repo_url: '659.dkr.ecr.ap-south-1.amazonaws.com/po-shop', cluster_name: 'po-shop', service_name: 'po-shop' },
    }));
    expect(wf.on.push.branches).toEqual(['main']);
    const runs = wf.jobs.deploy.steps.map((s) => s.run ?? s.uses ?? '').join('\n');
    expect(runs).toContain('659.dkr.ecr.ap-south-1.amazonaws.com/po-shop');
    expect(runs).toContain('aws ecs update-service --cluster po-shop --service po-shop');
    expect(plan.secretsNeeded).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
  });

  it('AWS serverless (both Lambdas updated in place)', async () => {
    const { wf } = await gen(proj({ outputs: { api_function: 'po-shop-api', worker_function: 'po-shop-worker' } }));
    const runs = wf.jobs.deploy.steps.map((s) => s.run ?? '').join('\n');
    expect(runs).toContain('--function-name po-shop-api');
    expect(runs).toContain('--function-name po-shop-worker');
  });

  it('AWS microservices (matrix over every service)', async () => {
    const { wf } = await gen(proj({
      accountId: '1',
      outputs: { cluster_name: 'po-shop', service_names: JSON.stringify({ gateway: 'x', cart: 'y' }) },
    }));
    expect(wf.jobs.deploy.strategy!.matrix.service).toEqual(['gateway', 'cart']);
  });

  it('AWS static site (S3 sync)', async () => {
    const { wf } = await gen(proj({ siteBucket: 'shop-site-1' }));
    expect(wf.jobs.deploy.steps.map((s) => s.run ?? '').join('')).toContain('s3://shop-site-1');
  });

  it('GCP app / serverless / microservices', async () => {
    const app = await gen(proj({ cloud: 'gcp', cloudTarget: 'proj-1', outputs: { artifact_repo_url: 'r/x', service_name: 'po-shop' } }));
    expect(app.plan.secretsNeeded).toEqual(['GCP_SA_KEY']);
    expect(app.wf.jobs.deploy.steps.some((s) => (s.run ?? '').includes('gcloud builds submit'))).toBe(true);

    const sls = await gen(proj({ cloud: 'gcp', cloudTarget: 'proj-1', archetype: 'serverless', outputs: {} }));
    expect(sls.wf.jobs.deploy.steps.map((s) => s.run ?? '').join('\n')).toContain('gcloud functions deploy po-shop-api');

    const micro = await gen(proj({
      cloud: 'gcp', cloudTarget: 'proj-1',
      outputs: { artifact_repo_url: 'r/x', service_urls: JSON.stringify({ gateway: 'u1', orders: 'u2' }) },
    }));
    expect(micro.wf.jobs.deploy.strategy!.matrix.service).toEqual(['gateway', 'orders']);
    expect(micro.wf.jobs.deploy.steps.map((s) => s.run ?? '').join('\n')).toContain('po-shop-${{ matrix.service }}');
  });

  it('Azure app / serverless / microservices', async () => {
    const app = await gen(proj({ cloud: 'azure', outputs: { acr_name: 'poshop1', acr_login_server: 'poshop1.azurecr.io', resource_group: 'po-shop' } }));
    expect(app.plan.secretsNeeded).toEqual(['AZURE_CREDENTIALS']);
    const appRuns = app.wf.jobs.deploy.steps.map((s) => s.run ?? '').join('\n');
    expect(appRuns).toContain('az acr build --registry poshop1');
    expect(appRuns).toContain('az containerapp update --name po-shop --resource-group po-shop');

    const sls = await gen(proj({ cloud: 'azure', outputs: { function_app_name: 'po-shop-abc123', resource_group: 'po-shop' } }));
    expect(sls.wf.jobs.deploy.steps.map((s) => s.run ?? '').join('\n')).toContain('config-zip --resource-group po-shop --name po-shop-abc123');

    const micro = await gen(proj({
      cloud: 'azure',
      outputs: { acr_name: 'poshop1', acr_login_server: 'poshop1.azurecr.io', resource_group: 'po-shop', service_urls: JSON.stringify({ gateway: 'u', cart: 'u' }) },
    }));
    expect(micro.wf.jobs.deploy.strategy!.matrix.service).toEqual(['gateway', 'cart']);
  });

  it('refuses to overwrite a workflow PlainOps did not write', async () => {
    const { generateWorkflow, writeWorkflow } = await import('../src/cicd.js');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'po-wfrepo-'));
    const p = proj({ siteBucket: 'b', repoPath: repo });
    const dir = path.join(repo, '.github', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plainops-deploy.yml'), 'name: theirs\n');
    expect(() => writeWorkflow(p, generateWorkflow(p))).toThrow(/refusing to overwrite/i);
  });
});
