import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-svl-'));
});

describe('zipLambdas', () => {
  it('zips handler files at the archive root', async () => {
    const { zipLambdas } = await import('../src/serverless.js');
    const src = path.join(process.cwd(), 'examples', 'order-pipeline');
    const out = path.join(process.env.PLAINOPS_HOME!, 'lambda.zip');
    await zipLambdas(src, out);
    expect(fs.existsSync(out)).toBe(true);

    const AdmZip = (await import('adm-zip')).default;
    const names = new AdmZip(out).getEntries().map((e) => e.entryName);
    // Handlers must be at the ROOT so "api.handler" / "worker.handler" resolve.
    expect(names).toContain('api.js');
    expect(names).toContain('worker.js');
    expect(names.some((n) => n.includes('/'))).toBe(false);
  });
});

describe('renderServerless', () => {
  it('copies the blueprint and writes tfvars with the zip path', async () => {
    const { renderServerless } = await import('../src/serverless.js');
    const dir = renderServerless('demo', 'ap-south-1', '/tmp/lambda.zip');
    for (const f of ['main.tf', 'variables.tf', 'outputs.tf', 'terraform.tfvars.json']) {
      expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    }
    const tfvars = JSON.parse(fs.readFileSync(path.join(dir, 'terraform.tfvars.json'), 'utf8'));
    expect(tfvars.project_name).toBe('demo');
    expect(tfvars.api_zip_path).toBe('/tmp/lambda.zip');
    expect(tfvars.worker_zip_path).toBe('/tmp/lambda.zip');

    // Blueprint really contains the serverless resources.
    const main = fs.readFileSync(path.join(dir, 'main.tf'), 'utf8');
    expect(main).toContain('aws_lambda_function');
    expect(main).toContain('aws_sqs_queue');
    expect(main).toContain('aws_dynamodb_table');
    expect(main).toContain('aws_apigatewayv2_api');
    expect(main).toContain('aws_lambda_event_source_mapping');
  });
});

describe('requireApiWorker', () => {
  it('accepts the bundled example and rejects a folder missing handlers', async () => {
    const { requireApiWorker } = await import('../src/serverless.js');
    expect(() => requireApiWorker(path.join(process.cwd(), 'examples', 'order-pipeline'))).not.toThrow();
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'po-empty-'));
    expect(() => requireApiWorker(empty)).toThrow(/api\.js|worker\.js/);
  });
});
