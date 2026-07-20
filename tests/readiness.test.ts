import { describe, it, expect } from 'vitest';
import {
  renderReport,
  pgMaxConnections,
  judgeLambdaRuntime,
  judgeBaseImage,
  dockerfileBaseImages,
} from '../src/readiness.js';

describe('renderReport', () => {
  it('leads with "ready" when nothing warns', () => {
    const out = renderReport('Launch preflight for "shop"', [{ check: 'Quota', status: 'PASS', detail: 'fine' }], []);
    expect(out).toContain('ready — no blockers found');
    expect(out).toContain('✅ Quota: fine');
  });
  it('counts warnings and lists skipped checks', () => {
    const out = renderReport('T', [
      { check: 'A', status: 'WARN', detail: 'bad' },
      { check: 'B', status: 'INFO', detail: 'note' },
    ], ['iam (denied)']);
    expect(out).toContain('1 thing(s) to fix');
    expect(out).toContain('⚠ A: bad');
    expect(out).toContain('Could not check: iam (denied)');
  });
});

describe('pgMaxConnections', () => {
  it('scales with instance class', () => {
    expect(pgMaxConnections('db.t4g.micro')).toBeLessThan(pgMaxConnections('db.t4g.small'));
    expect(pgMaxConnections('db.r6g.large')).toBeGreaterThan(pgMaxConnections('db.t4g.medium'));
  });
});

describe('version judgements', () => {
  it('flags EOL Lambda runtimes and passes current ones', () => {
    expect(judgeLambdaRuntime('nodejs18.x').level).toBe('eol');
    expect(judgeLambdaRuntime('python3.8').level).toBe('eol');
    expect(judgeLambdaRuntime('nodejs22.x').level).toBe('ok');
    expect(judgeLambdaRuntime('nodejs20.x').level).toBe('aging');
    expect(judgeLambdaRuntime('somethingnew1.x').level).toBe('ok');
  });
  it('judges base images by major line, ignoring tags like -alpine', () => {
    expect(judgeBaseImage('node:18-alpine')?.level).toBe('eol');
    expect(judgeBaseImage('node:22-alpine')?.level).toBe('ok');
    expect(judgeBaseImage('python:3.9-slim')?.level).toBe('eol');
    expect(judgeBaseImage('ubuntu:20.04')?.level).toBe('eol');
    expect(judgeBaseImage('nginx:1.27')).toBeNull();
  });
});

describe('dockerfileBaseImages', () => {
  it('extracts every FROM, dropping AS aliases and scratch', () => {
    const text = [
      'FROM node:18-alpine AS build',
      'RUN npm ci',
      'FROM scratch',
      'from python:3.12-slim',
      'COPY . .',
    ].join('\n');
    expect(dockerfileBaseImages(text)).toEqual(['node:18-alpine', 'python:3.12-slim']);
  });
});
