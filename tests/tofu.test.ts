import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseOutputs, resolveTofu, tofuRun } from '../src/tofu.js';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-tofu-'));
});

describe('resolveTofu', () => {
  it('honors PLAINOPS_TOFU_PATH when the file exists', async () => {
    const stub = path.join(process.env.PLAINOPS_HOME!, 'stub-tofu.cmd');
    fs.writeFileSync(stub, '@echo off');
    process.env.PLAINOPS_TOFU_PATH = stub;
    try {
      expect(await resolveTofu()).toBe(stub);
    } finally {
      delete process.env.PLAINOPS_TOFU_PATH;
    }
  });
});

describe('tofuRun', () => {
  it('streams lines and reports the exit code', async () => {
    const dir = process.env.PLAINOPS_HOME!;
    const script = path.join(dir, 'fake.cjs');
    fs.writeFileSync(
      script,
      `console.log('line one');console.log('line two');console.error('err line');process.exit(3);`,
    );
    const lines: string[] = [];
    // node <script> — the extra -no-color arg tofuRun appends is harmlessly ignored by the script
    const res = await tofuRun(process.execPath, dir, [script], (l) => lines.push(l));
    expect(res.code).toBe(3);
    expect(lines).toContain('line one');
    expect(lines).toContain('err line');
    expect(res.stdout).toContain('line two');
  });
});

describe('parseOutputs', () => {
  it('flattens tofu output -json into a string map', () => {
    const json = JSON.stringify({
      app_url: { sensitive: false, type: 'string', value: 'http://alb-123.elb.amazonaws.com' },
      secret_arns: { sensitive: false, type: ['object'], value: { API_KEY: 'arn:aws:sm:1' } },
    });
    const out = parseOutputs(json);
    expect(out.app_url).toBe('http://alb-123.elb.amazonaws.com');
    expect(out.secret_arns).toContain('arn:aws:sm:1');
  });
});
