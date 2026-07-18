import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectsDir } from '../config.js';
import type { BlueprintParams } from '../estimator.js';

const FILES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'files');
const HCL_FILES = ['main.tf', 'variables.tf', 'outputs.tf'];

export function projectTfDir(projectName: string): string {
  return path.join(projectsDir(), projectName, 'tf');
}

/**
 * Materialize the blueprint for a project: copy HCL + write terraform.tfvars.json.
 * Secret VALUES are never rendered — only secret NAMES (Secrets Manager shells).
 */
export function renderProject(p: BlueprintParams, bootstrapBucket: string): string {
  const dir = projectTfDir(p.projectName);
  fs.mkdirSync(dir, { recursive: true });

  for (const f of HCL_FILES) {
    fs.copyFileSync(path.join(FILES_DIR, f), path.join(dir, f));
  }

  const tfvars = {
    project_name: p.projectName,
    region: p.region,
    cpu: p.cpu,
    memory_mb: p.memoryMb,
    desired_count: p.desiredCount,
    max_count: p.maxCount,
    with_database: p.withDatabase,
    health_path: p.healthPath,
    container_port: p.containerPort,
    app_secrets: p.appSecrets,
    budget_email: p.budgetEmail ?? '',
    budget_monthly_usd: p.budgetMonthlyUsd,
    bootstrap_bucket: bootstrapBucket,
  };
  fs.writeFileSync(path.join(dir, 'terraform.tfvars.json'), JSON.stringify(tfvars, null, 2), 'utf8');
  return dir;
}
