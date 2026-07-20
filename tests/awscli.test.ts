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
