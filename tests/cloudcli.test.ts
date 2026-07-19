import { describe, it, expect } from 'vitest';
import { classifyCloud } from '../src/clouds/cloudcli.js';

describe('classifyCloud — gcloud', () => {
  it('classifies list/describe commands as read', () => {
    expect(classifyCloud('gcp', ['run', 'services', 'list']).kind).toBe('read');
    expect(classifyCloud('gcp', ['compute', 'instances', 'describe', 'vm-1', '--zone', 'us-central1-a']).kind).toBe('read');
    expect(classifyCloud('gcp', ['logging', 'read', 'severity>=ERROR', '--limit', '20']).kind).toBe('read');
    expect(classifyCloud('gcp', ['config', 'get-value', 'project']).kind).toBe('read');
  });

  it('classifies create/delete/deploy as mutate', () => {
    expect(classifyCloud('gcp', ['run', 'deploy', 'my-svc', '--image', 'x']).kind).toBe('mutate');
    expect(classifyCloud('gcp', ['compute', 'instances', 'delete', 'vm-1']).kind).toBe('mutate');
    expect(classifyCloud('gcp', ['projects', 'add-iam-policy-binding', 'p']).kind).toBe('mutate');
    expect(classifyCloud('gcp', ['services', 'enable', 'run.googleapis.com']).kind).toBe('mutate');
  });

  it('denies credential-exposing commands outright', () => {
    expect(classifyCloud('gcp', ['auth', 'print-access-token']).kind).toBe('denied');
    expect(classifyCloud('gcp', ['auth', 'application-default', 'print-access-token']).kind).toBe('denied');
    expect(classifyCloud('gcp', ['secrets', 'versions', 'access', 'latest', '--secret', 'DB_URL']).kind).toBe('denied');
    expect(classifyCloud('gcp', ['iam', 'service-accounts', 'keys', 'create', 'k.json']).kind).toBe('denied');
  });

  it('denied wins even though "access"/"print" are not read verbs', () => {
    // Flag placement must not confuse the classifier.
    expect(classifyCloud('gcp', ['secrets', 'versions', 'access', '--secret=DB_URL', 'latest']).kind).toBe('denied');
  });
});

describe('classifyCloud — az', () => {
  it('classifies list/show as read', () => {
    expect(classifyCloud('azure', ['containerapp', 'list', '--output', 'table']).kind).toBe('read');
    expect(classifyCloud('azure', ['group', 'show', '--name', 'po-x']).kind).toBe('read');
    expect(classifyCloud('azure', ['account', 'show']).kind).toBe('read');
    expect(classifyCloud('azure', ['functionapp', 'show', '--name', 'f', '--resource-group', 'g']).kind).toBe('read');
  });

  it('classifies create/delete/update as mutate', () => {
    expect(classifyCloud('azure', ['group', 'delete', '--name', 'po-x', '--yes']).kind).toBe('mutate');
    expect(classifyCloud('azure', ['containerapp', 'update', '--name', 'x']).kind).toBe('mutate');
    expect(classifyCloud('azure', ['acr', 'build', '--registry', 'r', '--image', 'i', '.']).kind).toBe('mutate');
  });

  it('denies key/credential/secret-exposing commands outright', () => {
    expect(classifyCloud('azure', ['account', 'get-access-token']).kind).toBe('denied');
    expect(classifyCloud('azure', ['keyvault', 'secret', 'show', '--name', 's', '--vault-name', 'v']).kind).toBe('denied');
    expect(classifyCloud('azure', ['acr', 'credential', 'show', '--name', 'r']).kind).toBe('denied');
    expect(classifyCloud('azure', ['storage', 'account', 'keys', 'list', '--account-name', 'a']).kind).toBe('denied');
    expect(classifyCloud('azure', ['cosmosdb', 'keys', 'list', '--name', 'c', '--resource-group', 'g']).kind).toBe('denied');
    expect(classifyCloud('azure', ['redis', 'list-keys', '--name', 'r', '--resource-group', 'g']).kind).toBe('denied');
    expect(classifyCloud('azure', ['functionapp', 'deployment', 'list-publishing-profiles', '--name', 'f']).kind).toBe('denied');
  });

  it('does not deny harmless commands that merely contain similar words', () => {
    // `keyvault list` (list vaults) is read; only secret/key value access is denied.
    expect(classifyCloud('azure', ['keyvault', 'list']).kind).toBe('read');
    expect(classifyCloud('azure', ['storage', 'account', 'list']).kind).toBe('read');
  });
});

describe('quoteForCmdShell (Windows .cmd shim safety)', () => {
  it('passes plain args through untouched', async () => {
    const { quoteForCmdShell } = await import('../src/clouds/cloudcli.js');
    expect(quoteForCmdShell('run')).toBe('run');
    expect(quoteForCmdShell('--format=json')).toBe('--format=json');
    expect(quoteForCmdShell('po-my-app')).toBe('po-my-app');
  });
  it('quotes args with spaces so gcloud filters survive the cmd shell', async () => {
    const { quoteForCmdShell } = await import('../src/clouds/cloudcli.js');
    expect(quoteForCmdShell('severity>=ERROR AND resource.type=cloud_run_revision'))
      .toBe('"severity>=ERROR AND resource.type=cloud_run_revision"');
    expect(quoteForCmdShell('')).toBe('""');
    expect(quoteForCmdShell('a "quoted" bit')).toBe('"a ""quoted"" bit"');
  });
  it('quotes the DEFAULT install path (C:\\Program Files (x86)\\...) so a shelled .cmd runs', async () => {
    const { quoteForCmdShell } = await import('../src/clouds/cloudcli.js');
    // The real bug: unquoted, cmd reads "C:\Program" as the command and fails.
    expect(quoteForCmdShell(String.raw`C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`))
      .toBe(String.raw`"C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"`);
  });
});
