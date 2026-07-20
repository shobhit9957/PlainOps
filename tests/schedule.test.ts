import { describe, it, expect } from 'vitest';
import { normalizeSchedule, scheduleName, ecsScheduleTarget, sqsScheduleTarget } from '../src/schedule.js';

describe('normalizeSchedule', () => {
  it('passes AWS-native expressions through untouched', () => {
    expect(normalizeSchedule('cron(0 3 * * ? *)')).toBe('cron(0 3 * * ? *)');
    expect(normalizeSchedule('rate(1 hour)')).toBe('rate(1 hour)');
    expect(normalizeSchedule('at(2026-08-01T03:00:00)')).toBe('at(2026-08-01T03:00:00)');
  });
  it('converts standard 5-field cron to AWS 6-field with ? exclusivity', () => {
    expect(normalizeSchedule('0 3 * * *')).toBe('cron(0 3 * * ? *)');
    expect(normalizeSchedule('30 2 1 * *')).toBe('cron(30 2 1 * ? *)');
    // Day-of-week given → day-of-month must become ?
    expect(normalizeSchedule('0 9 * * MON')).toBe('cron(0 9 ? * MON *)');
  });
  it('rejects junk with a helpful message', () => {
    expect(() => normalizeSchedule('every day at 3')).toThrow(/5-field cron/);
    expect(() => normalizeSchedule('')).toThrow();
  });
});

describe('scheduleName', () => {
  it('builds a stable, safe, prefixed name', () => {
    expect(scheduleName('shop', 'Nightly Cleanup!')).toBe('po-shop-nightly-cleanup');
    expect(scheduleName('shop', '---')).toBe('po-shop-job');
    expect(scheduleName('shop', 'x'.repeat(80)).length).toBeLessThanOrEqual(64);
  });
});

describe('schedule targets', () => {
  it('builds an ECS run-task target with the command override', () => {
    const t = JSON.parse(
      ecsScheduleTarget({
        clusterArn: 'arn:aws:ecs:r:1:cluster/po-shop',
        taskDefinitionArn: 'arn:aws:ecs:r:1:task-definition/po-shop:7',
        roleArn: 'arn:aws:iam::1:role/po-shop-scheduler',
        containerName: 'app',
        command: 'node jobs/cleanup.js',
        subnets: ['subnet-1', 'subnet-2'],
        securityGroups: ['sg-1'],
        assignPublicIp: 'ENABLED',
      }),
    );
    expect(t.Arn).toBe('arn:aws:ecs:r:1:cluster/po-shop');
    expect(t.EcsParameters.LaunchType).toBe('FARGATE');
    expect(t.EcsParameters.NetworkConfiguration.awsvpcConfiguration.Subnets).toEqual(['subnet-1', 'subnet-2']);
    const overrides = JSON.parse(t.Input);
    expect(overrides.containerOverrides[0]).toEqual({ name: 'app', command: ['sh', '-c', 'node jobs/cleanup.js'] });
  });
  it('builds an SQS target the existing worker can consume', () => {
    const t = JSON.parse(sqsScheduleTarget('arn:aws:sqs:r:1:po-shop-q', 'arn:aws:iam::1:role/po-shop-scheduler', 'digest'));
    expect(t.Arn).toBe('arn:aws:sqs:r:1:po-shop-q');
    const body = JSON.parse(t.Input);
    expect(body).toMatchObject({ source: 'plainops-schedule', job: 'digest' });
  });
});
