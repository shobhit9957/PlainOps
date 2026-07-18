import fs from 'node:fs';
import path from 'node:path';

export interface RepoReport {
  framework: 'nextjs' | 'node' | 'python' | 'static' | 'unknown';
  hasDockerfile: boolean;
  containerPort: number;
  healthPath: string;
  envVarsReferenced: string[];
  startCommand?: string;
  notes: string[];
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '__pycache__', '.venv']);
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py']);
const RUNTIME_ENV_VARS = new Set(['PORT', 'NODE_ENV', 'PYTHONUNBUFFERED', 'HOME', 'PATH']);

function* walkFiles(dir: string, depth = 0): Generator<string> {
  if (depth > 4) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) yield* walkFiles(path.join(dir, entry.name), depth + 1);
    } else if (entry.isFile()) {
      yield path.join(dir, entry.name);
    }
  }
}

export function analyzeRepo(repoPath: string): RepoReport {
  if (!fs.existsSync(repoPath)) throw new Error(`Repo path not found: ${repoPath}`);
  const notes: string[] = [];
  const envVars = new Set<string>();
  let framework: RepoReport['framework'] = 'unknown';
  let containerPort = 3000;
  let healthPath = '/';
  let startCommand: string | undefined;

  const pkgPath = path.join(repoPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      framework = deps.next ? 'nextjs' : 'node';
      startCommand = pkg.scripts?.start;
      if (framework === 'nextjs') {
        containerPort = 3000;
        notes.push('Next.js app detected — will run `next start`.');
      }
      if (!startCommand && framework === 'node') {
        notes.push('No "start" script in package.json — a start command is required to deploy.');
      }
    } catch {
      notes.push('package.json exists but could not be parsed.');
    }
  } else if (
    fs.existsSync(path.join(repoPath, 'requirements.txt')) ||
    fs.existsSync(path.join(repoPath, 'pyproject.toml'))
  ) {
    framework = 'python';
    containerPort = 8000;
  } else if (fs.existsSync(path.join(repoPath, 'index.html'))) {
    framework = 'static';
    containerPort = 80; // served by nginx
    notes.push('Static site (HTML/CSS/JS). On Fargate it runs behind nginx; on S3 it needs no server (cheaper).');
  }

  const hasDockerfile = fs.existsSync(path.join(repoPath, 'Dockerfile'));
  let dockerfilePort: number | null = null;
  if (hasDockerfile) {
    try {
      const df = fs.readFileSync(path.join(repoPath, 'Dockerfile'), 'utf8');
      const exposeMatch = df.match(/^\s*EXPOSE\s+(\d{2,5})/im);
      if (exposeMatch) dockerfilePort = parseInt(exposeMatch[1], 10);
    } catch {
      /* ignore */
    }
  }

  let sawHealthRoute = false;
  for (const file of walkFiles(repoPath)) {
    if (!CODE_EXTENSIONS.has(path.extname(file))) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of content.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      if (!RUNTIME_ENV_VARS.has(m[1])) envVars.add(m[1]);
    }
    for (const m of content.matchAll(/os\.environ(?:\.get)?\s*[[(]\s*["']([A-Z][A-Z0-9_]*)["']/g)) {
      if (!RUNTIME_ENV_VARS.has(m[1])) envVars.add(m[1]);
    }
    if (/["'`]\/health["'`]/.test(content)) sawHealthRoute = true;
    const portMatch = content.match(/process\.env\.PORT\s*(?:\|\||\?\?)\s*(\d{2,5})/);
    if (portMatch) containerPort = parseInt(portMatch[1], 10);
  }
  if (sawHealthRoute) healthPath = '/health';
  // The Dockerfile's EXPOSE is authoritative — it's the port the container listens on.
  if (dockerfilePort !== null) containerPort = dockerfilePort;

  if (envVars.has('DATABASE_URL')) {
    notes.push('App references DATABASE_URL — it likely needs a PostgreSQL database.');
  }

  return {
    framework,
    hasDockerfile,
    containerPort,
    healthPath,
    envVarsReferenced: [...envVars].sort(),
    startCommand,
    notes,
  };
}

/** Write a Dockerfile when the repo has none. Never overwrites an existing one. */
export function generateDockerfile(report: RepoReport, repoPath: string): string {
  const dockerfilePath = path.join(repoPath, 'Dockerfile');
  if (fs.existsSync(dockerfilePath)) return fs.readFileSync(dockerfilePath, 'utf8');

  let content: string;
  if (report.framework === 'nextjs') {
    content = `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
EXPOSE ${report.containerPort}
CMD ["npm", "start"]
`;
  } else if (report.framework === 'node') {
    content = `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE ${report.containerPort}
CMD ["npm", "start"]
`;
  } else if (report.framework === 'static') {
    content = `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`;
  } else if (report.framework === 'python') {
    content = `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE ${report.containerPort}
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "${report.containerPort}"]
`;
  } else {
    throw new Error('Cannot generate a Dockerfile: framework not recognized. Add a Dockerfile to the repo.');
  }
  fs.writeFileSync(dockerfilePath, content, 'utf8');
  return content;
}
