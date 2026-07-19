import { describe, it, expect } from 'vitest';
import {
  gcpRunSection,
  gcpFunctionsSection,
  gcpSqlSection,
  gcpGkeSection,
  azureContainerAppsSection,
  azureFunctionAppsSection,
  azurePostgresSection,
  azureAksSection,
  azureActivityFailuresSection,
} from '../src/clouds/estate.js';

describe('GCP estate sections', () => {
  it('flags Cloud Run services that are not Ready, with the condition message', () => {
    const out = gcpRunSection([
      { metadata: { name: 'api' }, status: { url: 'https://api-x.run.app', conditions: [{ type: 'Ready', status: 'True' }] } },
      {
        metadata: { name: 'worker' },
        status: { conditions: [{ type: 'Ready', status: 'False', message: 'Image not found in Artifact Registry' }] },
      },
    ]);
    expect(out).toContain('api: Ready');
    expect(out).toContain('https://api-x.run.app');
    expect(out).toContain('worker: NOT READY ⚠ — Image not found in Artifact Registry');
  });

  it('reports empty regions honestly', () => {
    expect(gcpRunSection([])).toBe('No Cloud Run services in this region.');
    expect(gcpFunctionsSection([])).toBe('No Cloud Functions in this region.');
    expect(gcpSqlSection([])).toBe('No Cloud SQL instances.');
    expect(gcpGkeSection([])).toBe('No GKE clusters.');
  });

  it('shortens function resource names and flags non-ACTIVE states', () => {
    const out = gcpFunctionsSection([
      { name: 'projects/p/locations/r/functions/po-app-api', state: 'ACTIVE' },
      { name: 'projects/p/locations/r/functions/po-app-worker', state: 'DEPLOYING' },
    ]);
    expect(out).toContain('po-app-api: ACTIVE');
    expect(out).not.toContain('po-app-api: ACTIVE ⚠');
    expect(out).toContain('po-app-worker: DEPLOYING ⚠');
  });

  it('flags Cloud SQL not RUNNABLE and GKE not RUNNING', () => {
    expect(gcpSqlSection([{ name: 'db1', state: 'SUSPENDED' }])).toContain('⚠');
    expect(gcpGkeSection([{ name: 'k1', status: 'DEGRADED', currentNodeCount: 3 }])).toContain('DEGRADED ⚠, 3 node(s)');
  });
});

describe('Azure estate sections', () => {
  it('flags Container Apps that are not Running', () => {
    const out = azureContainerAppsSection([
      { name: 'gateway', rg: 'po-shop', running: 'Running', fqdn: 'gw.azurecontainerapps.io' },
      { name: 'orders', rg: 'po-shop', running: 'Degraded', fqdn: null },
    ]);
    expect(out).toContain('gateway (rg po-shop): Running');
    expect(out).toContain('https://gw.azurecontainerapps.io');
    expect(out).toContain('orders (rg po-shop): Degraded ⚠');
  });

  it('flags stopped Function Apps and not-Ready Postgres', () => {
    expect(azureFunctionAppsSection([{ name: 'fn', state: 'Stopped', rg: 'g' }])).toContain('Stopped ⚠');
    expect(azurePostgresSection([{ name: 'pg', state: 'Stopped' }])).toContain('⚠ (not Ready)');
    expect(azurePostgresSection([{ name: 'pg', state: 'Ready' }])).not.toContain('⚠');
  });

  it('flags AKS provisioning/power problems', () => {
    const out = azureAksSection([{ name: 'aks1', status: 'Failed', power: 'Stopped' }]);
    expect(out).toContain('Failed ⚠');
    expect(out).toContain('power Stopped ⚠');
  });

  it('compacts activity-log failures to readable lines', () => {
    const out = azureActivityFailuresSection([
      {
        op: 'Microsoft.App/containerApps/write',
        res: '/subscriptions/s/resourceGroups/po-shop/providers/Microsoft.App/containerApps/orders',
        at: '2026-07-19T09:00:00Z',
      },
    ]);
    expect(out).toContain('Microsoft.App/containerApps/write');
    expect(out).toContain('containerApps/orders');
    expect(out).toContain('FAILED ⚠');
    expect(azureActivityFailuresSection([])).toContain('No failed operations');
  });
});
