import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

beforeEach(() => {
  process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-ms-'));
});

describe('detectServices', () => {
  it('auto-detects the ShopFlow services, ports, DB need, and gateway', async () => {
    const { detectServices } = await import('../src/microservices.js');
    const { services, withDatabase, publicName } = detectServices(path.join(process.cwd(), 'examples', 'shopflow'));
    const names = Object.keys(services).sort();
    expect(names).toEqual(['cart', 'gateway', 'notifications', 'orders', 'payments', 'products', 'users']);
    expect(publicName).toBe('gateway');
    expect(services.gateway.public).toBe(true);
    expect(services.gateway.port).toBe(8080);
    expect(services.users.needs_db).toBe(true); // uses mongoose
    expect(services.products.port).toBe(3002);
    expect(services.payments.needs_db).toBe(false); // stateless
    expect(withDatabase).toBe(true);
  });

  it('detects the Redis cache need (products uses ioredis)', async () => {
    const { detectServices } = await import('../src/microservices.js');
    const { withCache } = detectServices(path.join(process.cwd(), 'examples', 'shopflow'));
    expect(withCache).toBe(true);
  });

  it('throws when a folder has no services', async () => {
    const { detectServices } = await import('../src/microservices.js');
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'po-empty-'));
    expect(() => detectServices(empty)).toThrow(/No microservices/);
  });
});

describe('renderMicroservices', () => {
  it('writes tfvars with the services map and DB flag', async () => {
    const { detectServices, renderMicroservices } = await import('../src/microservices.js');
    const { services, withDatabase } = detectServices(path.join(process.cwd(), 'examples', 'shopflow'));
    const dir = renderMicroservices('shopflow', 'ap-south-1', services, withDatabase, 'bkt');
    const tfvars = JSON.parse(fs.readFileSync(path.join(dir, 'terraform.tfvars.json'), 'utf8'));
    expect(tfvars.with_database).toBe(true);
    expect(tfvars.services.gateway.public).toBe(true);
    expect(Object.keys(tfvars.services)).toHaveLength(7);
    // Blueprint carries the multi-service resources.
    const main = fs.readFileSync(path.join(dir, 'main.tf'), 'utf8');
    expect(main).toContain('aws_service_discovery_service');
    expect(main).toContain('aws_docdb_cluster');
    expect(main).toContain('for_each = var.services');
  });
});
