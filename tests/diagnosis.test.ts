import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-diag-'));
});

describe('collectDiagnosis', () => {
  it('errors clearly for an unknown project', async () => {
    const { collectDiagnosis } = await import('../src/diagnosis.js');
    expect(await collectDiagnosis('missing')).toMatch(/not found/);
  });

  it('collects a full evidence bundle for a fresh project without touching any cloud', async () => {
    const { collectDiagnosis } = await import('../src/diagnosis.js');
    const { upsertProject } = await import('../src/state.js');
    upsertProject({ name: 'fresh', region: 'ap-south-1', status: 'new', createdAt: new Date().toISOString() });
    const bundle = await collectDiagnosis('fresh', 'Error: connect ECONNREFUSED 127.0.0.1:5432');
    expect(bundle).toMatch(/DIAGNOSIS EVIDENCE/);
    expect(bundle).toMatch(/error reported by the founder/);
    expect(bundle).toMatch(/ECONNREFUSED/);
    expect(bundle).toMatch(/project record/);
    expect(bundle).toMatch(/nothing has been deployed/i);
    expect(bundle).toMatch(/No rendered blueprint/);
  });

  it('reads resources out of a tfstate when one exists', async () => {
    const { collectDiagnosis } = await import('../src/diagnosis.js');
    const { upsertProject } = await import('../src/state.js');
    const { cloudTfDir } = await import('../src/multicloud.js');
    upsertProject({ name: 'built', region: 'asia-south1', cloud: 'gcp', status: 'provisioned', createdAt: new Date().toISOString() });
    const dir = cloudTfDir('built');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'terraform.tfstate'),
      JSON.stringify({ resources: [{ type: 'google_cloud_run_v2_service', name: 'app' }] }),
    );
    fs.writeFileSync(path.join(dir, 'main.tf'), '# x');
    const bundle = await collectDiagnosis('built');
    expect(bundle).toMatch(/google_cloud_run_v2_service\.app/);
  });

  it('caps enormous evidence so it cannot blow the model context', async () => {
    const { collectDiagnosis } = await import('../src/diagnosis.js');
    const { upsertProject } = await import('../src/state.js');
    upsertProject({ name: 'noisy', region: 'ap-south-1', status: 'new', createdAt: new Date().toISOString() });
    const bundle = await collectDiagnosis('noisy', 'x'.repeat(60_000));
    expect(bundle.length).toBeLessThan(20_000);
  });
});
