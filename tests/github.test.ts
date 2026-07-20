import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-gh-'));
});

describe('classifyGh — reads run instantly, mutations wait for a click, credentials never print', () => {
  it('read commands: views, lists, statuses, api GETs', async () => {
    const { classifyGh } = await import('../src/github.js');
    expect(classifyGh(['run', 'list', '--repo', 'o/r']).kind).toBe('read');
    expect(classifyGh(['run', 'view', '123', '--log-failed']).kind).toBe('read');
    expect(classifyGh(['repo', 'view', 'o/r', '--json', 'name']).kind).toBe('read');
    expect(classifyGh(['release', 'list']).kind).toBe('read');
    expect(classifyGh(['pr', 'status']).kind).toBe('read');
    expect(classifyGh(['auth', 'status']).kind).toBe('read');
    expect(classifyGh(['secret', 'list', '--repo', 'o/r']).kind).toBe('read');
    expect(classifyGh(['api', 'user']).kind).toBe('read');
    expect(classifyGh(['api', 'repos/o/r/commits', '--method', 'GET']).kind).toBe('read');
    expect(classifyGh(['search', 'repos', 'plainops']).kind).toBe('read');
  });

  it('mutating commands need approval', async () => {
    const { classifyGh } = await import('../src/github.js');
    expect(classifyGh(['repo', 'create', 'o/r', '--private']).kind).toBe('mutate');
    expect(classifyGh(['run', 'rerun', '123']).kind).toBe('mutate');
    expect(classifyGh(['release', 'create', 'v1.0.0']).kind).toBe('mutate');
    expect(classifyGh(['pr', 'merge', '5']).kind).toBe('mutate');
    expect(classifyGh(['workflow', 'run', 'deploy.yml']).kind).toBe('mutate');
    expect(classifyGh(['api', 'repos/o/r/issues', '-f', 'title=x']).kind).toBe('mutate');
    expect(classifyGh(['api', 'repos/o/r', '-X', 'PATCH']).kind).toBe('mutate');
    expect(classifyGh(['secret', 'delete', 'NAME', '--repo', 'o/r']).kind).toBe('mutate');
  });

  it('credential-exposing and code-installing commands are refused outright', async () => {
    const { classifyGh } = await import('../src/github.js');
    expect(classifyGh(['auth', 'token']).kind).toBe('denied');
    expect(classifyGh(['auth', 'login']).kind).toBe('denied');
    expect(classifyGh(['auth', 'logout']).kind).toBe('denied');
    expect(classifyGh(['config', 'get', 'oauth_token']).kind).toBe('denied');
    expect(classifyGh(['extension', 'install', 'x/y']).kind).toBe('denied');
    expect(classifyGh(['ssh-key', 'add']).kind).toBe('denied');
    expect(classifyGh(['gpg-key', 'list']).kind).toBe('denied');
  });

  it('secret set is refused and routed to the secure-box tool', async () => {
    const { classifyGh } = await import('../src/github.js');
    const cls = classifyGh(['secret', 'set', 'AWS_ACCESS_KEY_ID', '--repo', 'o/r']);
    expect(cls.kind).toBe('denied');
    expect(cls.reason).toContain('set_github_secret');
  });

  it('builds the GitHub-attributing noreply email', async () => {
    const { buildNoreplyEmail } = await import('../src/github.js');
    expect(buildNoreplyEmail(116124866, 'shobhit9957')).toBe('116124866+shobhit9957@users.noreply.github.com');
  });
});
