import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { healthVerdict, countErrorLines, watchRelease } from '../src/release.js';
import { detectMigrations, lintMigrationText, scanMigrationRisks, describeRisks } from '../src/migrate.js';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-rel-'));
});

describe('healthVerdict', () => {
  it('reverts when the app stops serving', () => {
    const v = healthVerdict({ ok: false, detail: 'HTTP 503 after 12 checks' }, 0);
    expect(v.rollback).toBe(true);
    expect(v.headline).toMatch(/rolling back automatically/i);
  });

  it('does NOT revert on log noise alone — a serving app is not an outage', () => {
    const v = healthVerdict({ ok: true, detail: 'HTTP 200' }, 7);
    expect(v.rollback).toBe(false);
    expect(v.headline).toMatch(/7 error line/);
  });

  it('clean pass says so plainly', () => {
    expect(healthVerdict({ ok: true, detail: 'HTTP 200' }, 0)).toEqual({
      rollback: false,
      headline: 'Serving cleanly (HTTP 200) with no errors in the logs.',
    });
  });
});

describe('watchRelease — the sustained canary watch behind the health gate', () => {
  // Probe stub: replays a status sequence, repeating the last entry forever.
  const seq = (statuses: Array<number | 'err'>) => {
    let i = 0;
    return async () => {
      const s = statuses[Math.min(i++, statuses.length - 1)];
      if (s === 'err') throw new Error('connect ECONNREFUSED');
      return s as number;
    };
  };

  it('catches the slow-death release: healthy first probes, then dies', async () => {
    // 200, 200, then 500s forever. First-success-wins semantics would call
    // this healthy at probe 1 — the gate must instead revert.
    const r = await watchRelease(seq([200, 200, 500, 500]), 0.1, 10);
    expect(r.ok).toBe(false);
    expect(r.probes).toBe(4); // fails fast on the 2nd consecutive failure
    expect(r.detail).toMatch(/consecutive/);
  });

  it('documents WHY: validateLive is first-success-wins — right for "is it up yet", wrong for a canary', async () => {
    const { validateLive } = await import('../src/orchestrator.js');
    const deps = { healthFetch: seq([200, 500, 500]) } as unknown as Parameters<typeof validateLive>[1];
    const r = await validateLive('http://x', deps, undefined, 3, 1);
    expect(r.ok).toBe(true); // exits on the first 200 — exactly what the gate must NOT do
  });

  it('tolerates a single blip mid-window and reports it', async () => {
    const r = await watchRelease(seq([200, 500, 200, 200, 200]), 0.05, 10);
    expect(r.ok).toBe(true);
    expect(r.blips).toBe(1);
    expect(r.detail).toMatch(/blip/);
  });

  it('never ends the watch on a red light: extends, then reverts on a second failure', async () => {
    const r = await watchRelease(seq([200, 200, 500, 500]), 0.03, 10); // window is 3 probes; 3rd fails
    expect(r.ok).toBe(false); // grace probe #4 also failed → genuinely down
    expect(r.probes).toBe(4);
  });

  it('never ends the watch on a red light: extends, and passes when it recovers', async () => {
    const r = await watchRelease(seq([200, 200, 500, 200]), 0.03, 10);
    expect(r.ok).toBe(true);
    expect(r.blips).toBe(1);
    expect(r.probes).toBe(4);
  });

  it('treats network errors as failures', async () => {
    const r = await watchRelease(seq(['err', 'err']), 0.03, 10);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/unreachable/);
  });

  it('passes a clean window and says how long it watched', async () => {
    const r = await watchRelease(seq([200]), 0.03, 10);
    expect(r.ok).toBe(true);
    expect(r.probes).toBe(3);
    expect(r.detail).toMatch(/healthy across 3 checks/);
  });
});

describe('countErrorLines', () => {
  it('counts real error lines and ignores benign mentions', () => {
    const log = [
      'INFO server started',
      'ERROR connect ECONNREFUSED 10.0.0.5:5432',
      'Unhandled promise rejection: boom',
      'compiled with 0 errors',
      'GET /health 200',
    ].join('\n');
    expect(countErrorLines(log)).toBe(2);
  });
  it('handles empty logs', () => {
    expect(countErrorLines('')).toBe(0);
  });
});

describe('detectMigrations', () => {
  const mk = (files: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-mig-'));
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    return dir;
  };

  it('detects Prisma from the schema file', () => {
    const plan = detectMigrations(mk({ 'prisma/schema.prisma': 'datasource db {}' }));
    expect(plan).toMatchObject({ tool: 'Prisma', command: 'npx prisma migrate deploy' });
  });

  it('detects Django and Rails from their project files', () => {
    expect(detectMigrations(mk({ 'manage.py': '#' }))?.tool).toBe('Django');
    expect(detectMigrations(mk({ Gemfile: 'gem "rails"', 'db/migrate/1_x.rb': '#' }))?.tool).toBe('Rails');
  });

  it('detects Knex via package.json dependencies', () => {
    const plan = detectMigrations(mk({ 'package.json': JSON.stringify({ dependencies: { knex: '^3' } }) }));
    expect(plan?.command).toBe('npx knex migrate:latest');
  });

  it('returns null when the repo has no migrations', () => {
    expect(detectMigrations(mk({ 'index.js': 'console.log(1)' }))).toBeNull();
  });
});

describe('destructive migration linting', () => {
  it('flags the changes a code rollback cannot undo', () => {
    expect(lintMigrationText('ALTER TABLE users DROP COLUMN email;')).toContain('drops a column (that data is gone)');
    expect(lintMigrationText('DROP TABLE sessions;')).toContain('drops a table (all its rows are gone)');
    expect(lintMigrationText('ALTER TABLE t ALTER COLUMN price TYPE numeric;')[0]).toMatch(/changes a column type/);
    expect(lintMigrationText('ALTER TABLE t ALTER COLUMN name SET NOT NULL;')[0]).toMatch(/NOT NULL/);
    expect(lintMigrationText('operations = [migrations.RemoveField(model_name="u", name="x")]')[0]).toMatch(/Django/);
  });

  it('stays quiet on additive migrations', () => {
    expect(lintMigrationText('ALTER TABLE users ADD COLUMN nickname text;')).toEqual([]);
    expect(lintMigrationText('CREATE TABLE likes (id uuid primary key);')).toEqual([]);
  });

  it('scans the repo and explains expand-then-contract when risky', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-mig2-'));
    fs.mkdirSync(path.join(dir, 'prisma/migrations/20260719_drop'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prisma/migrations/20260719_drop/migration.sql'), 'ALTER TABLE users DROP COLUMN bio;');
    const reports = scanMigrationRisks(dir);
    expect(reports).toHaveLength(1);
    expect(reports[0].file).toBe('prisma/migrations/20260719_drop/migration.sql');
    const text = describeRisks(reports);
    expect(text).toMatch(/DESTRUCTIVE/);
    expect(text).toMatch(/expand-then-contract/);
    expect(describeRisks([])).toMatch(/additive and safe/);
  });
});

describe('migrationTaskOverrides — RDS force-SSL', () => {
  it('gives node-postgres tools PGSSLMODE=no-verify (live failure: FATAL 28000, ClientAuthentication — PG15+ rds.force_ssl rejects their plain connection)', async () => {
    const { migrationTaskOverrides } = await import('../src/migrate.js');
    const o = migrationTaskOverrides('app', { tool: 'node-pg-migrate', command: 'npx node-pg-migrate up', note: '' });
    expect(o.containerOverrides[0].command).toEqual(['sh', '-c', 'npx node-pg-migrate up']);
    expect(o.containerOverrides[0].environment).toEqual([{ name: 'PGSSLMODE', value: 'no-verify' }]);
    for (const tool of ['Knex', 'Sequelize', 'TypeORM']) {
      expect(migrationTaskOverrides('app', { tool, command: 'x', note: '' }).containerOverrides[0].environment).toBeDefined();
    }
  });

  it('leaves non-node tools untouched — psycopg/libpq reject the no-verify value', async () => {
    const { migrationTaskOverrides } = await import('../src/migrate.js');
    for (const tool of ['Django', 'Alembic', 'Rails', 'Flyway', 'Prisma']) {
      expect(migrationTaskOverrides('app', { tool, command: 'x', note: '' }).containerOverrides[0].environment).toBeUndefined();
    }
  });
});

describe('healthCheckTarget', () => {
  it('splits http and https URLs into Route 53 health-check fields', async () => {
    const { healthCheckTarget } = await import('../src/cloudmon.js');
    expect(healthCheckTarget('http://po-app-123.ap-south-1.elb.amazonaws.com')).toEqual({
      fqdn: 'po-app-123.ap-south-1.elb.amazonaws.com', port: 80, type: 'HTTP', path: '/',
    });
    expect(healthCheckTarget('https://app.example.com/health')).toEqual({
      fqdn: 'app.example.com', port: 443, type: 'HTTPS', path: '/health',
    });
    expect(healthCheckTarget('http://example.com:8080/api')).toMatchObject({ port: 8080, path: '/api' });
  });
});
