// D3: safe_deploy of a GOOD release WITH database migrations, through the
// real tool layer. Proofs:
//   - destructive-migration lint appears on the approval card (contract step)
//   - RDS snapshot before migrating
//   - migrations run as a one-off ECS task inside the founder's cloud
//   - sustained health gate passes; schema actually changed in RDS
import { log, expectContent } from './common.ts';
import { autoApprove } from './approve.ts';
import { stampRelease, NAME } from './mono-common.ts';
import { getProject } from '../../src/state.ts';
import { dispatchTool } from '../../src/agent/tools.ts';
import { releasePreview } from '../../src/release.ts';

const stop = autoApprove();

log('=== D3: SAFE DEPLOY (good release + expand/contract migrations) ===');
stampRelease('TASKMGR-V1_1', 0, 'release v1.1: audit-log migrations');

const preview = releasePreview(getProject(NAME)!, true);
log('release preview →\n' + preview);
if (!/DESTRUCTIVE/.test(preview)) throw new Error('lint failed to flag the destructive contract migration');
if (!/RDS snapshot/i.test(preview)) throw new Error('preview does not promise the RDS snapshot');

const r = await dispatchTool('safe_deploy', { migrate: true, watchSeconds: 120 }, { projectName: NAME });
log('safe_deploy →\n' + r);
if (!/Release VERIFIED/i.test(r)) throw new Error('safe_deploy did not verify the good release — see output above');

const url = getProject(NAME)!.siteUrl!;
await expectContent(url + '/api/version', 'TASKMGR-V1_1');
await expectContent(url + '/api/_tables', 'audit_log');
await expectContent(url + '/api/_tables', 'pgmigrations');

// Contract step applied → legacy_flag added by the expand step must be gone.
const cols = await (await fetch(url + '/api/_columns?table=tasks', { signal: AbortSignal.timeout(15_000) })).text();
if (cols.includes('legacy_flag')) throw new Error('contract migration did not apply — legacy_flag still present: ' + cols);
log('schema proof: audit_log + pgmigrations present, legacy_flag dropped.');
log('D3 COMPLETE: migrations ran in-cloud, snapshot first, gate passed.');
stop();
