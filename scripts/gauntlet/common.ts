// Shared helpers for the live AWS gauntlet. Every script REQUIRES the
// isolated home so test projects never touch the founder's real ~/.plainops.
import path from 'node:path';
import os from 'node:os';

export const REGION = 'ap-south-1';

// Isolated homes only: ~/.plainops-gauntlet or ~/.plainops-gauntlet-<suffix>
// (a second home lets AWS and GCP ladders run in parallel without racing on
// the same state.json). NEVER the founder's real ~/.plainops.
const resolvedHome = path.resolve(process.env.PLAINOPS_HOME ?? '');
const okHome =
  path.dirname(resolvedHome) === os.homedir() &&
  /^\.plainops-gauntlet(-[a-z0-9]+)?$/.test(path.basename(resolvedHome));
if (!okHome) {
  console.error(`REFUSING to run: PLAINOPS_HOME must be ~/.plainops-gauntlet or ~/.plainops-gauntlet-<suffix>, got "${resolvedHome}"`);
  process.exit(2);
}
export const GAUNTLET_HOME = resolvedHome;

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
