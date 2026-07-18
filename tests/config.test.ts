import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-test-'));
  process.env.PLAINOPS_HOME = dir;
  return dir;
}

describe('config', () => {
  beforeEach(() => {
    freshHome();
  });

  it('returns defaults when no config exists', async () => {
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();
    expect(cfg.model).toBe('claude-opus-4-8');
    expect(cfg.port).toBe(7717);
    expect(cfg.anthropicApiKey).toBeUndefined();
  });

  it('appDir is always absolute, even with a relative PLAINOPS_HOME', async () => {
    process.env.PLAINOPS_HOME = '.plainops-rel-test';
    const { appDir, binDir } = await import('../src/config.js');
    const path = await import('node:path');
    expect(path.isAbsolute(appDir())).toBe(true);
    expect(path.isAbsolute(binDir())).toBe(true);
  });

  it('round-trips saved config', async () => {
    const { loadConfig, saveConfig } = await import('../src/config.js');
    saveConfig({ anthropicApiKey: 'sk-ant-test123', port: 9999 });
    const cfg = loadConfig();
    expect(cfg.anthropicApiKey).toBe('sk-ant-test123');
    expect(cfg.port).toBe(9999);
    expect(cfg.model).toBe('claude-opus-4-8'); // default preserved
  });
});

describe('state', () => {
  beforeEach(() => {
    freshHome();
  });

  it('upserts and reads projects', async () => {
    const { upsertProject, getProject, loadState } = await import('../src/state.js');
    upsertProject({
      name: 'demo',
      repoPath: 'C:/tmp/app',
      region: 'us-east-1',
      status: 'new',
      createdAt: new Date().toISOString(),
    });
    expect(getProject('demo')?.status).toBe('new');
    upsertProject({ ...getProject('demo')!, status: 'live' });
    expect(getProject('demo')?.status).toBe('live');
    expect(loadState().projects).toHaveLength(1);
  });
});
