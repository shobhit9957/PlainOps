import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let home = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'po-fu-'));
  process.env.PLAINOPS_HOME = home;
  vi.useFakeTimers();
});

afterEach(async () => {
  const { _disarmAll } = await import('../src/followups.js');
  _disarmAll();
  vi.useRealTimers();
});

describe('follow-up queue — the agent resumes its own waiting work', () => {
  it('schedules, persists to disk, lists, and cancels', async () => {
    const { initFollowups, scheduleFollowup, listFollowups, cancelFollowup } = await import('../src/followups.js');
    initFollowups(async () => {});

    const out = scheduleFollowup('my-app', 'Check the ACM cert; when ISSUED attach it to CloudFront.', 5 * 60_000);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(fs.existsSync(path.join(home, 'followups.json'))).toBe(true);
    const listed = listFollowups();
    expect(listed).toHaveLength(1);
    expect(listed[0].projectName).toBe('my-app');
    expect(listed[0].task).toContain('ACM cert');

    expect(cancelFollowup(out.followup.id)).toBe(true);
    expect(listFollowups()).toHaveLength(0);
    expect(cancelFollowup(out.followup.id)).toBe(false);
  });

  it('fires the task back into the agent loop when due, then removes it', async () => {
    const { initFollowups, scheduleFollowup, listFollowups } = await import('../src/followups.js');
    const calls: Array<{ project: string; text: string }> = [];
    initFollowups(async (project, text) => {
      calls.push({ project, text });
    });

    scheduleFollowup('my-app', 'Check cert status and finish the domain.', 60_000);
    await vi.advanceTimersByTimeAsync(61_000);

    expect(calls).toHaveLength(1);
    expect(calls[0].project).toBe('my-app');
    expect(calls[0].text).toContain('[Scheduled follow-up');
    expect(calls[0].text).toContain('Check cert status and finish the domain.');
    expect(listFollowups()).toHaveLength(0);
  });

  it('overdue follow-ups (app was closed) fire shortly after start', async () => {
    const overdue = {
      id: 'past1234',
      projectName: 'my-app',
      task: 'Finish the CloudFront attachment.',
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      dueAt: new Date(Date.now() - 1_800_000).toISOString(),
    };
    fs.writeFileSync(path.join(home, 'followups.json'), JSON.stringify([overdue]));

    const { initFollowups } = await import('../src/followups.js');
    const calls: string[] = [];
    initFollowups(async (_p, text) => {
      calls.push(text);
    });
    await vi.advanceTimersByTimeAsync(5_100);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('Finish the CloudFront attachment.');
  });

  it('rejects bad delays and enforces the pending cap', async () => {
    const { initFollowups, scheduleFollowup } = await import('../src/followups.js');
    initFollowups(async () => {});

    expect(scheduleFollowup('p', 'too soon', 10_000).ok).toBe(false);
    expect(scheduleFollowup('p', 'too late', 8 * 24 * 60 * 60_000).ok).toBe(false);
    expect(scheduleFollowup('p', '', 60_000).ok).toBe(false);

    for (let i = 0; i < 20; i++) {
      expect(scheduleFollowup('p', `task ${i}`, 60_000).ok).toBe(true);
    }
    const over = scheduleFollowup('p', 'one too many', 60_000);
    expect(over.ok).toBe(false);
  });

  it('a crashing agent run is contained (audited, not thrown)', async () => {
    const { initFollowups, scheduleFollowup, listFollowups } = await import('../src/followups.js');
    initFollowups(async () => {
      throw new Error('model unreachable');
    });
    scheduleFollowup('my-app', 'Will fail.', 60_000);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(listFollowups()).toHaveLength(0); // consumed, not stuck retrying
  });
});
