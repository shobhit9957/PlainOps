import { upsertProject } from './state.js';
import { emitBus } from './bus.js';

/**
 * Demo mode (PLAINOPS_DEMO=1): seed a project and script a believable
 * chat/approval/deploy sequence so the dashboard can be exercised end-to-end
 * with no AWS account or API key. Purely for UI verification.
 */
export function startDemo(): void {
  upsertProject({
    name: 'acme-store',
    repoPath: 'C:/Users/Founder/code/acme-store',
    cloud: 'aws',
    archetype: 'app',
    region: 'us-east-1',
    status: 'live',
    createdAt: '2026-07-10T10:00:00.000Z',
    lastDeployAt: '2026-07-17T09:30:00.000Z',
    blueprint: {
      projectName: 'acme-store',
      region: 'us-east-1',
      cpu: 256,
      memoryMb: 512,
      desiredCount: 1,
      maxCount: 4,
      withDatabase: true,
      healthPath: '/',
      containerPort: 3000,
      appSecrets: ['DATABASE_URL', 'STRIPE_KEY'],
      budgetMonthlyUsd: 60,
    },
    outputs: {
      app_url: 'http://po-acme-store-123.us-east-1.elb.amazonaws.com',
      cluster_name: 'po-acme-store',
      service_name: 'po-acme-store',
      log_group: '/plainops/acme-store',
    },
  });

  // A second project on another cloud so the Costs tab shows the multi-cloud story.
  upsertProject({
    name: 'acme-api',
    cloud: 'gcp',
    cloudTarget: 'acme-demo',
    archetype: 'app',
    region: 'asia-south1',
    status: 'live',
    createdAt: '2026-07-12T10:00:00.000Z',
    lastDeployAt: '2026-07-16T18:00:00.000Z',
    outputs: { app_url: 'https://po-acme-api-84213.asia-south1.run.app' },
    siteUrl: 'https://po-acme-api-84213.asia-south1.run.app',
  });

  // Re-emit a short scripted chat whenever a client connects is overkill;
  // instead expose a trigger the UI calls on load via /api/state (demo:true).
}

/** Called by a demo endpoint to replay a scripted conversation. */
export function replayDemoChat(): void {
  const project = 'acme-store';
  const steps: Array<() => void> = [
    () => emitBus({ type: 'chat.message', projectName: project, text: "Hi! I looked at your Next.js store. It needs a database (I found a DATABASE_URL reference) and a Stripe key. How many customers are you expecting at launch — a few hundred, or thousands?" }),
    () => emitBus({ type: 'chat.tool', projectName: project, tool: 'propose_infrastructure' }),
    () =>
      emitBus({
        type: 'cost.estimate',
        projectName: project,
        estimate: {
          monthly: 46.1,
          daily: 1.52,
          yearly: 553.2,
          lines: [
            { item: 'App containers (1 × 0.25 vCPU / 0.5 GB, Fargate)', monthly: 8.87 },
            { item: 'Load balancer (ALB)', monthly: 20.08 },
            { item: 'PostgreSQL database (db.t4g.micro, 20 GB)', monthly: 13.98 },
            { item: 'Other (registry, logs, builds, transfer)', monthly: 3.17 },
          ],
          disclaimer: 'Estimate ±15%.',
        },
      }),
    () =>
      emitBus({
        type: 'action.pending',
        action: {
          id: 'demo-action-1',
          type: 'provision',
          projectName: project,
          summary: 'Create AWS infrastructure for "acme-store" (with database) in us-east-1.',
          costText: '~$1.52/day · ~$46.10/month · ~$553.20/year',
          createdAt: new Date('2026-07-17T09:25:00.000Z').toISOString(),
        },
      }),
  ];
  steps.forEach((fn, i) => setTimeout(fn, i * 900));
}
