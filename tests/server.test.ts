import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-server-'));
  delete process.env.PLAINOPS_DEMO;
});

describe('server routes', () => {
  it('preflight returns the expected shape', async () => {
    const { createServer } = await import('../src/server.js');
    const res = await request(createServer()).get('/api/preflight');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('node');
    expect(res.body).toHaveProperty('aws');
    expect(res.body.aws).toHaveProperty('ok');
  });

  it('saves config and reports hasKey without leaking the key', async () => {
    const { createServer } = await import('../src/server.js');
    const app = createServer();
    await request(app).post('/api/config').send({ anthropicApiKey: 'sk-ant-secret' }).expect(200);
    const state = await request(app).get('/api/state');
    expect(state.body.config.hasKey).toBe(true);
    expect(JSON.stringify(state.body)).not.toContain('sk-ant-secret');
  });

  it('creates a project from a valid repo path', async () => {
    const { createServer } = await import('../src/server.js');
    const repo = path.join(process.cwd(), 'examples', 'sample-app');
    const res = await request(createServer()).post('/api/project').send({ name: 'demo-proj', repoPath: repo });
    expect(res.status).toBe(200);
    expect(res.body.report.framework).toBe('node');
    expect(res.body.report.hasDockerfile).toBe(true);
  });

  it('rejects invalid project names', async () => {
    const { createServer } = await import('../src/server.js');
    const res = await request(createServer()).post('/api/project').send({ name: 'Bad Name', repoPath: '.' });
    expect(res.status).toBe(400);
  });

  it('approve resolves a pending gate action', async () => {
    process.env.PLAINOPS_GATE_TIMEOUT_MS = '5000';
    const { createServer } = await import('../src/server.js');
    const { requestApproval, listPendingActions } = await import('../src/gate.js');
    const app = createServer();
    const p = requestApproval({ type: 'provision', projectName: 'x', summary: 'go' });
    const id = listPendingActions()[0].id;
    await request(app).post(`/api/action/${id}/approved`).expect(200);
    expect(await p).toBe('approved');
  });

  it('stores a secret via the vault and never echoes the value', async () => {
    const { createServer } = await import('../src/server.js');
    const { readAudit } = await import('../src/audit.js');
    const app = createServer();
    await request(app).post('/api/secret').send({ name: 'MY_TOKEN', value: 'zzzsecretvalue123' }).expect(200);
    const { getSecret } = await import('../src/vault.js');
    expect(getSecret('MY_TOKEN')).toBe('zzzsecretvalue123');
    expect(JSON.stringify(readAudit())).not.toContain('zzzsecretvalue123');
  });

  // The agent asked for secret X. If the POST resolves prompt X while storing
  // secret Y, the agent is told "X is saved" and downstream steps read a stale
  // or absent X. The prompt and the payload must agree.
  it('refuses to resolve a secret prompt with a different secret name', async () => {
    process.env.PLAINOPS_GATE_TIMEOUT_MS = '5000';
    const { createServer } = await import('../src/server.js');
    const { requestSecretValue } = await import('../src/gate.js');
    const { getSecret } = await import('../src/vault.js');
    const { onBus } = await import('../src/bus.js');
    const app = createServer();

    let promptId = '';
    const off = onBus((e) => {
      if (e.type === 'secret.request' && typeof e.id === 'string') promptId = e.id;
    });

    let settled: boolean | null = null;
    const pending = requestSecretValue('proj', 'DATABASE_URL').then((ok) => (settled = ok));
    off();

    const res = await request(app)
      .post('/api/secret')
      .send({ promptId, projectName: 'proj', name: 'OTHER_KEY', value: 'zzzsecretvalue123' });

    expect(res.status).toBe(400);
    expect(getSecret('OTHER_KEY')).toBeNull(); // nothing stored under the wrong name
    expect(settled).toBeNull(); // prompt still pending, not falsely satisfied

    // The name the agent actually asked for settles it.
    await request(app)
      .post('/api/secret')
      .send({ promptId, projectName: 'proj', name: 'DATABASE_URL', value: 'zzzsecretvalue123' })
      .expect(200);
    expect(await pending).toBe(true);
  });
});
