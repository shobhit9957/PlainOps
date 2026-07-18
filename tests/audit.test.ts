import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-audit-'));
  process.env.PLAINOPS_HOME = dir;
});

describe('audit', () => {
  it('appends scrubbed entries in order', async () => {
    const { setSecret } = await import('../src/vault.js');
    const { auditLog, readAudit } = await import('../src/audit.js');
    setSecret('DB_PASS', 'hunter2hunter2');
    auditLog({ type: 'deploy', summary: 'deploying with DB_PASS=hunter2hunter2' });
    auditLog({ type: 'status', summary: 'ok', detail: { note: 'pass hunter2hunter2' } });
    const rows = readAudit();
    expect(rows).toHaveLength(2);
    expect(rows[0].summary).toBe('deploying with DB_PASS={{secret:DB_PASS}}');
    expect(JSON.stringify(rows[1].detail)).toContain('{{secret:DB_PASS}}');
    expect(rows[1].type).toBe('status');
  });

  it('readAudit respects limit and missing file', async () => {
    const { auditLog, readAudit } = await import('../src/audit.js');
    expect(readAudit()).toEqual([]);
    for (let i = 0; i < 5; i++) auditLog({ type: 't', summary: `s${i}` });
    expect(readAudit(2).map((r) => r.summary)).toEqual(['s3', 's4']);
  });
});
