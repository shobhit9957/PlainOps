import express, { type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { loadConfig, saveConfig, isDemoMode } from './config.js';
import { loadState, getProject, upsertProject, type Project, type Cloud } from './state.js';
import { detectClouds } from './clouds/cloudcli.js';
import { estimate, estimateCloud } from './estimator.js';
import { readAudit } from './audit.js';
import { onBus, emitBus } from './bus.js';
import { resolveApproval, resolveSecretPrompt, listPendingActions } from './gate.js';
import { setSecret } from './vault.js';
import { analyzeRepo } from './analyzer.js';
import { getDailyCosts, putAppSecret, whoAmI } from './aws.js';
import { runTurn, type InboundImage } from './agent/loop.js';
import { startDemo, replayDemoChat } from './demo.js';

const ALLOWED_IMAGE_TYPES: Record<string, InboundImage['mediaType']> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

/** Turn incoming data URLs (data:image/png;base64,xxxx) into image blocks. Caps to 5. */
function parseInboundImages(images: unknown): InboundImage[] {
  if (!Array.isArray(images)) return [];
  const out: InboundImage[] = [];
  for (const entry of images.slice(0, 5)) {
    if (typeof entry !== 'string') continue;
    const m = entry.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
    if (!m) continue;
    const mediaType = ALLOWED_IMAGE_TYPES[m[1].toLowerCase()];
    if (!mediaType) continue;
    out.push({ mediaType, data: m[2] });
  }
  return out;
}

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

function version(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { shell: process.platform === 'win32' }, (err) => resolve(!err));
  });
}

export interface Preflight {
  node: boolean;
  git: boolean;
  aws: { ok: boolean; accountId?: string };
  anthropicKey: boolean;
  tofu: boolean;
}

export async function preflight(): Promise<Preflight> {
  if (isDemoMode()) {
    return { node: true, git: true, aws: { ok: true, accountId: '123456789012' }, anthropicKey: true, tofu: true };
  }
  const cfg = loadConfig();
  const major = parseInt(process.versions.node.split('.')[0], 10);
  const [git, tofu] = await Promise.all([version('git', ['--version']), version('tofu', ['version'])]);
  let aws: Preflight['aws'] = { ok: false };
  try {
    const id = await whoAmI('us-east-1');
    aws = { ok: true, accountId: id.accountId };
  } catch {
    aws = { ok: false };
  }
  const tofuOrTerraform = tofu || (await version('terraform', ['version']));
  return { node: major >= 20, git, aws, anthropicKey: Boolean(cfg.anthropicApiKey), tofu: tofuOrTerraform };
}

export function createServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(WEB_DIR));

  app.get('/api/preflight', async (_req, res) => {
    res.json(await preflight());
  });

  app.get('/api/state', (_req, res) => {
    const cfg = loadConfig();
    res.json({
      projects: loadState().projects,
      config: { model: cfg.model, hasKey: Boolean(cfg.anthropicApiKey) },
      demo: isDemoMode(),
      pendingActions: listPendingActions(),
    });
  });

  app.post('/api/config', (req, res) => {
    const { anthropicApiKey, model } = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (typeof anthropicApiKey === 'string' && anthropicApiKey.trim()) patch.anthropicApiKey = anthropicApiKey.trim();
    if (typeof model === 'string' && model.trim()) patch.model = model.trim();
    const cfg = saveConfig(patch);
    res.json({ ok: true, model: cfg.model, hasKey: Boolean(cfg.anthropicApiKey) });
  });

  app.post('/api/project', (req, res) => {
    const { name, repoPath, region, cloud } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'a project name is required' });
    if (!/^[a-z][a-z0-9-]{1,19}$/.test(name)) {
      return res.status(400).json({ error: 'name must be lowercase letters/numbers/hyphens, starting with a letter, max 20 chars (cloud resource names build on it)' });
    }
    const chosenCloud: Cloud = cloud === 'gcp' || cloud === 'azure' ? cloud : 'aws';
    // repoPath is OPTIONAL — a project can be for questions or a static site.
    let report = null;
    if (repoPath && repoPath.trim()) {
      try {
        report = analyzeRepo(repoPath);
      } catch (e) {
        return res.status(400).json({ error: (e as Error).message });
      }
    }
    const defaultRegion = { aws: 'ap-south-1', gcp: 'asia-south1', azure: 'centralindia' }[chosenCloud];
    const project: Project = {
      name,
      repoPath: repoPath && repoPath.trim() ? repoPath.trim() : undefined,
      cloud: chosenCloud,
      region: region || defaultRegion,
      status: 'new',
      createdAt: new Date().toISOString(),
    };
    upsertProject(project);
    res.json({ project, report });
  });

  // Which clouds can this machine deploy to right now?
  app.get('/api/clouds', async (_req, res) => {
    if (isDemoMode()) {
      return res.json({
        aws: { connected: true, detail: 'account 123456789012' },
        gcp: { connected: true, detail: 'project acme-demo' },
        azure: { connected: true, detail: 'subscription Acme Dev' },
      });
    }
    const clouds = await detectClouds();
    let aws: { connected: boolean; detail: string };
    try {
      const w = await whoAmI('us-east-1');
      aws = { connected: true, detail: `account ${w.accountId}` };
    } catch {
      aws = { connected: false, detail: 'run `aws configure`' };
    }
    res.json({
      aws,
      gcp: { connected: clouds.gcp.installed && clouds.gcp.authenticated, detail: clouds.gcp.detail },
      azure: { connected: clouds.azure.installed && clouds.azure.authenticated, detail: clouds.azure.detail },
    });
  });

  // Cost dashboard: monthly estimate per project + portfolio totals per cloud.
  app.get('/api/costsummary', (_req, res) => {
    const projects = loadState().projects.filter((p) => p.status !== 'destroyed');
    const rows = projects.map((p) => {
      const cloud = p.cloud ?? 'aws';
      let monthly = 0;
      let basis = 'no infrastructure yet';
      try {
        if (cloud === 'aws') {
          if (p.siteBucket) {
            monthly = 0.5;
            basis = 'static site (S3)';
          } else if (p.archetype === 'serverless' || p.outputs?.api_url) {
            monthly = 1;
            basis = 'serverless (pay-per-request)';
          } else if (p.outputs?.service_urls) {
            const n = Object.keys(JSON.parse(p.outputs.service_urls)).length;
            monthly = n * 9 + 21 + (p.outputs?.mongodb_note ? 60 : 0);
            basis = `${n} microservices + load balancer`;
          } else if (p.blueprint && p.status !== 'new') {
            monthly = estimate(p.blueprint).monthly;
            basis = 'container app (Fargate)';
          }
        } else if (p.status !== 'new') {
          const services = p.outputs?.service_urls ? Object.keys(JSON.parse(p.outputs.service_urls)).length : 1;
          const archetype = (p.archetype ?? 'app') as 'app' | 'serverless' | 'microservices';
          monthly = estimateCloud(cloud, { archetype, services }).monthly;
          basis = `${archetype} (${cloud})`;
        }
      } catch {
        /* estimate is best-effort for the dashboard */
      }
      return {
        name: p.name,
        cloud,
        status: p.status,
        archetype: p.archetype ?? (p.siteBucket ? 'static' : undefined),
        url: p.siteUrl ?? p.outputs?.app_url ?? p.outputs?.gateway_url ?? p.outputs?.api_url ?? null,
        monthlyEstimate: Math.round(monthly * 100) / 100,
        basis,
      };
    });
    const byCloud: Record<string, number> = {};
    for (const r of rows) byCloud[r.cloud] = Math.round(((byCloud[r.cloud] ?? 0) + r.monthlyEstimate) * 100) / 100;
    const total = Math.round(rows.reduce((s, r) => s + r.monthlyEstimate, 0) * 100) / 100;
    res.json({ rows, byCloud, totalMonthly: total });
  });

  app.post('/api/chat', (req, res) => {
    const { projectName, text, images } = req.body ?? {};
    if (!projectName || !getProject(projectName)) {
      return res.status(400).json({ error: 'Create or select a project first (top-left), then chat.' });
    }
    const cfg = loadConfig();
    if (!isDemoMode() && !cfg.anthropicApiKey) {
      return res.status(400).json({ error: 'Add your Anthropic API key in Settings (⚙) first — it powers the AI.' });
    }
    if (isDemoMode()) {
      replayDemoChat();
      return res.json({ ok: true });
    }
    const parsedImages = parseInboundImages(images);
    // Fire and forget — progress streams over SSE.
    runTurn(projectName, String(text ?? ''), parsedImages).catch((e) => {
      emitBus({ type: 'chat.message', projectName, text: `Something went wrong: ${(e as Error).message}` });
      emitBus({ type: 'chat.done', projectName });
    });
    res.json({ ok: true });
  });

  app.post('/api/action/:id/:verdict', (req, res) => {
    const { id, verdict } = req.params;
    if (verdict !== 'approved' && verdict !== 'rejected') return res.status(400).json({ error: 'bad verdict' });
    const ok = resolveApproval(id, verdict);
    res.json({ ok });
  });

  // Store a secret value: vault + (if provisioned) AWS Secrets Manager. Value is never logged.
  app.post('/api/secret', async (req, res) => {
    const { promptId, projectName, name, value } = req.body ?? {};
    if (!name || typeof value !== 'string' || !value) return res.status(400).json({ error: 'name and value required' });
    try {
      setSecret(name, value);
      const project = getProject(projectName);
      const secretArns = project?.outputs?.secret_arns ? JSON.parse(project.outputs.secret_arns) : {};
      if (project?.region && secretArns[name]) {
        await putAppSecret(project.region, secretArns[name], value);
      }
      if (promptId) resolveSecretPrompt(promptId, true);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/costs/:project', async (req, res) => {
    if (isDemoMode()) {
      return res.json({ dailyCosts: demoCosts(), total14d: 41.2 });
    }
    const costs = await getDailyCosts(req.params.project);
    res.json({ dailyCosts: costs, total14d: Math.round(costs.reduce((s, c) => s + c.usd, 0) * 100) / 100 });
  });

  app.get('/api/audit', (_req, res) => {
    res.json({ entries: readAudit(50) });
  });

  // Server-Sent Events: all live progress.
  app.get('/api/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const off = onBus((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      off();
    });
  });

  return app;
}

function demoCosts() {
  // Deterministic fake series for the UI (no Date.now/random in workflow-safe code, but this is server runtime).
  const base = ['2026-07-04', '2026-07-05', '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'];
  return base.map((date, i) => ({ date, usd: Math.round((2.5 + i * 0.15) * 100) / 100 }));
}

export function maybeStartDemo(): void {
  if (isDemoMode()) startDemo();
}
