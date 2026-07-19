// Shared helpers for the live AWS gauntlet. Every script REQUIRES the
// isolated home so test projects never touch the founder's real ~/.plainops.
import path from 'node:path';
import os from 'node:os';

export const REGION = 'ap-south-1';
export const GAUNTLET_HOME = path.join(os.homedir(), '.plainops-gauntlet');

if (path.resolve(process.env.PLAINOPS_HOME ?? '') !== GAUNTLET_HOME) {
  console.error(`REFUSING to run: PLAINOPS_HOME must be ${GAUNTLET_HOME}`);
  process.exit(2);
}

export const log = (l: string) => console.log(new Date().toISOString().slice(11, 19), l);

export async function expectContent(url: string, marker: string, attempts = 12): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const body = await res.text();
      if (res.ok && body.includes(marker)) {
        log(`VERIFIED: ${url} serves marker "${marker}" (HTTP ${res.status})`);
        return;
      }
      log(`waiting: HTTP ${res.status}, marker ${body.includes(marker) ? 'present' : 'absent'} (${i + 1}/${attempts})`);
    } catch (e) {
      log(`waiting: ${(e as Error).message} (${i + 1}/${attempts})`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`Content verification FAILED: ${url} never served "${marker}"`);
}
