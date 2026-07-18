import fs from 'node:fs';
import path from 'node:path';
import { appDir } from './config.js';
import type { BlueprintParams } from './estimator.js';

export type ProjectStatus = 'new' | 'provisioned' | 'live' | 'destroyed';

export type Cloud = 'aws' | 'gcp' | 'azure';

export interface Project {
  name: string;
  repoPath?: string;
  /** Which cloud this project deploys to. Absent = aws (pre-multicloud projects). */
  cloud?: Cloud;
  /** GCP project id / Azure subscription the deploy targets. */
  cloudTarget?: string;
  /** app | serverless | microservices | static — set on first deploy. */
  archetype?: string;
  region: string;
  blueprint?: BlueprintParams;
  status: ProjectStatus;
  outputs?: Record<string, string>;
  accountId?: string;
  bootstrapBucket?: string;
  siteBucket?: string;
  siteUrl?: string;
  lastDeployAt?: string;
  createdAt: string;
}

export interface AppState {
  projects: Project[];
}

function statePath(): string {
  return path.join(appDir(), 'state.json');
}

export function loadState(): AppState {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return { projects: [] };
  }
}

export function saveState(state: AppState): void {
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
}

export function upsertProject(p: Project): void {
  const state = loadState();
  const i = state.projects.findIndex((x) => x.name === p.name);
  if (i >= 0) state.projects[i] = p;
  else state.projects.push(p);
  saveState(state);
}

export function getProject(name: string): Project | undefined {
  return loadState().projects.find((x) => x.name === name);
}
