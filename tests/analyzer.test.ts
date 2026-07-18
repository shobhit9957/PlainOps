import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeRepo, generateDockerfile } from '../src/analyzer.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-analyze-'));
});

function write(rel: string, content: string) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

describe('analyzeRepo', () => {
  it('detects a node app with port, env vars, and health route', () => {
    write('package.json', JSON.stringify({ scripts: { start: 'node server.js' }, dependencies: { express: '^4' } }));
    write(
      'server.js',
      `const port = process.env.PORT || 8080;
       const db = process.env.DATABASE_URL;
       const stripe = process.env.STRIPE_KEY;
       app.get('/health', ok);`,
    );
    const r = analyzeRepo(dir);
    expect(r.framework).toBe('node');
    expect(r.containerPort).toBe(8080);
    expect(r.healthPath).toBe('/health');
    expect(r.envVarsReferenced).toEqual(['DATABASE_URL', 'STRIPE_KEY']);
    expect(r.hasDockerfile).toBe(false);
    expect(r.notes.join(' ')).toContain('PostgreSQL');
  });

  it('detects next.js', () => {
    write('package.json', JSON.stringify({ scripts: { start: 'next start' }, dependencies: { next: '^15' } }));
    const r = analyzeRepo(dir);
    expect(r.framework).toBe('nextjs');
    expect(r.containerPort).toBe(3000);
  });

  it('detects a static site and reads the Dockerfile EXPOSE port', () => {
    write('index.html', '<h1>hello</h1>');
    write('Dockerfile', 'FROM nginx:alpine\nCOPY . /usr/share/nginx/html\nEXPOSE 80\n');
    const r = analyzeRepo(dir);
    expect(r.framework).toBe('static');
    expect(r.hasDockerfile).toBe(true);
    expect(r.containerPort).toBe(80); // from EXPOSE, not the 3000 default
    expect(r.healthPath).toBe('/');
  });

  it('bundled task-manager example analyzes as a Node app needing a database', () => {
    const r = analyzeRepo(path.join(process.cwd(), 'examples', 'task-manager'));
    expect(r.framework).toBe('node');
    expect(r.hasDockerfile).toBe(true);
    expect(r.containerPort).toBe(3000); // from Dockerfile EXPOSE
    expect(r.healthPath).toBe('/health');
    expect(r.envVarsReferenced).toContain('DATABASE_URL');
    expect(r.notes.join(' ')).toContain('PostgreSQL');
  });

  it('bundled static-site example is Fargate-ready (Dockerfile + port 80)', () => {
    const r = analyzeRepo(path.join(process.cwd(), 'examples', 'static-site'));
    expect(r.framework).toBe('static');
    expect(r.hasDockerfile).toBe(true);
    expect(r.containerPort).toBe(80);
  });

  it('detects python', () => {
    write('requirements.txt', 'fastapi\nuvicorn');
    write('main.py', `import os\nkey = os.environ["API_KEY"]\n`);
    const r = analyzeRepo(dir);
    expect(r.framework).toBe('python');
    expect(r.containerPort).toBe(8000);
    expect(r.envVarsReferenced).toEqual(['API_KEY']);
  });
});

describe('generateDockerfile', () => {
  it('writes a node Dockerfile with the right port', () => {
    write('package.json', JSON.stringify({ scripts: { start: 'node server.js' } }));
    const r = analyzeRepo(dir);
    const df = generateDockerfile(r, dir);
    expect(df).toContain('node:20-alpine');
    expect(df).toContain('EXPOSE 3000');
    expect(fs.existsSync(path.join(dir, 'Dockerfile'))).toBe(true);
  });

  it('never overwrites an existing Dockerfile', () => {
    write('package.json', '{}');
    write('Dockerfile', 'FROM custom:1\n');
    const r = analyzeRepo(dir);
    expect(generateDockerfile(r, dir)).toBe('FROM custom:1\n');
  });
});
