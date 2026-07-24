import { describe, expect, it } from 'vitest';
import { classifyAws, withRegion } from '../src/awscli.js';

describe('classifyAws', () => {
  it('treats describe/list/get as read', () => {
    expect(classifyAws(['ec2', 'describe-instances']).kind).toBe('read');
    expect(classifyAws(['s3api', 'list-buckets']).kind).toBe('read');
    expect(classifyAws(['sts', 'get-caller-identity']).kind).toBe('read');
    expect(classifyAws(['ce', 'get-cost-and-usage']).kind).toBe('read');
  });

  it('treats create/delete/stop/put as mutations', () => {
    expect(classifyAws(['ec2', 'stop-instances', '--instance-ids', 'i-1']).kind).toBe('mutate');
    expect(classifyAws(['ec2', 'run-instances']).kind).toBe('mutate');
    expect(classifyAws(['dynamodb', 'delete-table', '--table-name', 't']).kind).toBe('mutate');
    expect(classifyAws(['s3', 'rm', 's3://b']).kind).toBe('mutate');
  });

  it('s3 ls is read but other s3 verbs mutate', () => {
    expect(classifyAws(['s3', 'ls']).kind).toBe('read');
    expect(classifyAws(['s3', 'sync', '.', 's3://b']).kind).toBe('mutate');
    expect(classifyAws(['s3', 'cp', 'a', 's3://b']).kind).toBe('mutate');
  });

  it('refuses secret/credential-exposing commands', () => {
    expect(classifyAws(['secretsmanager', 'get-secret-value', '--secret-id', 'x']).kind).toBe('denied');
    expect(classifyAws(['iam', 'create-access-key']).kind).toBe('denied');
    expect(classifyAws(['ssm', 'get-parameter', '--name', 'x', '--with-decryption']).kind).toBe('denied');
    // Without decryption a parameter fetch is a normal read.
    expect(classifyAws(['ssm', 'get-parameter', '--name', 'x']).kind).toBe('read');
  });

  it('refuses commands that PRINT live credentials, even though they start with "get-"', () => {
    // These match the `get-` read prefix but hand the model a usable credential.
    expect(classifyAws(['ecr', 'get-login-password']).kind).toBe('denied');
    expect(classifyAws(['sts', 'get-session-token']).kind).toBe('denied');
    expect(classifyAws(['sts', 'assume-role', '--role-arn', 'a', '--role-session-name', 's']).kind).toBe('denied');
    expect(classifyAws(['sts', 'get-federation-token', '--name', 'n']).kind).toBe('denied');
    expect(classifyAws(['rds', 'generate-db-auth-token']).kind).toBe('denied');
    expect(classifyAws(['redshift', 'get-cluster-credentials']).kind).toBe('denied');
    expect(classifyAws(['kms', 'decrypt', '--ciphertext-blob', 'x']).kind).toBe('denied');
    expect(classifyAws(['lightsail', 'get-instance-access-details']).kind).toBe('denied');
  });

  // The model controls the whole args array, so it chooses the ordering.
  it('cannot be tricked out of a denial by putting a global flag first', () => {
    expect(
      classifyAws(['--region', 'us-east-1', 'secretsmanager', 'get-secret-value', '--secret-id', 'x']).kind,
    ).toBe('denied');
    expect(classifyAws(['--output', 'json', 'ecr', 'get-login-password']).kind).toBe('denied');
    expect(classifyAws(['--profile', 'default', 'iam', 'create-access-key']).kind).toBe('denied');
  });

  it('cannot be tricked into "read" by a global flag value that looks like an operation', () => {
    // `--region get-x` must not become the operation slot and downgrade a terminate.
    expect(classifyAws(['ec2', '--region', 'get-x', 'terminate-instances']).kind).toBe('mutate');
    expect(classifyAws(['--profile', 'list-me', 'ec2', 'run-instances']).kind).toBe('mutate');
    expect(classifyAws(['s3', '--region', 'ls', 'rm', 's3://b']).kind).toBe('mutate');
  });

  it('still classifies normal commands correctly when global flags lead', () => {
    expect(classifyAws(['--region', 'us-east-1', 'ec2', 'describe-instances']).kind).toBe('read');
    expect(classifyAws(['--output=json', 'ec2', 'describe-instances']).kind).toBe('read');
    expect(classifyAws(['--region', 'us-east-1', 'ec2', 'terminate-instances']).kind).toBe('mutate');
  });
});

describe('withRegion', () => {
  it('adds the project region to regional services', () => {
    expect(withRegion(['ec2', 'describe-instances'], 'ap-south-1')).toEqual([
      'ec2', 'describe-instances', '--region', 'ap-south-1',
    ]);
  });

  it('does not add a region to global services or when already present', () => {
    expect(withRegion(['s3', 'ls'], 'ap-south-1')).toEqual(['s3', 'ls']);
    expect(withRegion(['iam', 'list-roles'], 'ap-south-1')).toEqual(['iam', 'list-roles']);
    expect(withRegion(['ec2', 'describe-instances', '--region', 'us-east-1'], 'ap-south-1')).toEqual([
      'ec2', 'describe-instances', '--region', 'us-east-1',
    ]);
  });
});
