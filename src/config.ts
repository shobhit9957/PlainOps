import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AppConfig {
  /** Legacy field — still honored as the Anthropic key for existing installs. */
  anthropicApiKey?: string;
  /** Active AI provider id (see agent/providers.ts). Default: anthropic. */
  aiProvider?: string;
  /** API keys per provider id — switching providers never loses a key. */
  aiKeys?: Record<string, string>;
  /** Model override per provider id (blank = the provider's default). */
  aiModels?: Record<string, string>;
  /** Base-URL override per provider id (Ollama / custom endpoints). */
  aiBaseUrls?: Record<string, string>;
  /** Legacy Anthropic model field — used when provider is anthropic. */
  model: string;
  port: number;
}

const DEFAULTS: AppConfig = {
  model: 'claude-opus-4-8',
  port: 7717,
};

/** Root data dir (always absolute). Overridable for tests via PLAINOPS_HOME. */
export function appDir(): string {
  // Resolve to absolute — a relative PLAINOPS_HOME would break the tofu binary
  // path once we spawn it with a different working directory.
  const root = path.resolve(process.env.PLAINOPS_HOME || path.join(os.homedir(), '.plainops'));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function projectsDir(): string {
  const dir = path.join(appDir(), 'projects');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function binDir(): string {
  const dir = path.join(appDir(), 'bin');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function configPath(): string {
  return path.join(appDir(), 'config.json');
}

export function loadConfig(): AppConfig {
  let cfg: AppConfig;
  try {
    cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
  } catch {
    cfg = { ...DEFAULTS };
  }
  if (process.env.PLAINOPS_PORT) cfg.port = parseInt(process.env.PLAINOPS_PORT, 10);
  return cfg;
}

export function saveConfig(cfg: Partial<AppConfig>): AppConfig {
  const merged = { ...loadConfig(), ...cfg };
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

export function isDemoMode(): boolean {
  return process.env.PLAINOPS_DEMO === '1';
}
