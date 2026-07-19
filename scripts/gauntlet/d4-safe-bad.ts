// D4: safe_deploy of a BAD release — the slow-death regression. The app
// serves 200 at deploy time (passes deployApp's own validateLive) and starts
// returning 500 after 5 minutes of uptime. The sustained health gate must
// catch it mid-watch and AUTO-REVERT to the previous image tag.
import { log, expectContent } from './common.ts';
import { autoApprove } from './approve.ts';
import { stampRelease, NAME } from './mono-common.ts';
import { getProject } from '../../src/state.ts';
import { dispatchTool } from '../../src/agent/tools.ts';

const stop = autoApprove();

log('=== D4: SAFE DEPLOY (bad release — slow death; must auto-revert) ===');
stampRelease('TASKMGR-V2-BOMB', 300_000, 'release v2: regression (dies after 5 min uptime)');

const r = await dispatchTool('safe_deploy', { watchSeconds: 420 }, { projectName: NAME });
log('safe_deploy →\n' + r);
if (!/REVERTED/i.test(r)) {
  throw new Error('safe_deploy did NOT auto-revert the bad release — the health gate failed its one job');
}

// Production must be back on the previous release (V1_2 from the promotion).
const url = getProject(NAME)!.siteUrl!;
await expectContent(url + '/api/version', 'TASKMGR-V1_2', 30);
log('D4 COMPLETE: bad release caught by the sustained gate and auto-reverted; previous build serving again.');
stop();
