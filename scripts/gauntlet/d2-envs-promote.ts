// D2: environments + promotion, driven through the REAL tool layer
// (dispatchTool + auto-approved gate — same seam as the founder's click).
//   1. setup_environments → staging twin record
//   2. provision + deploy staging (full isolated stack, same blueprint)
//   3. promote_to_production (clean path: HEAD == staging-tested commit)
//   4. commit a NEWER release → promotion must REFUSE without acceptNewerCommit
//   5. acceptNewerCommit=true → promotes, prod serves the new marker
import { REGION, log, expectContent } from './common.ts';
import { autoApprove } from './approve.ts';
import { stampRelease, NAME } from './mono-common.ts';
import { upsertProject, getProject } from '../../src/state.ts';
import { provision, deployApp } from '../../src/orchestrator.ts';
import { putAppSecret } from '../../src/aws.ts';
import { dispatchTool } from '../../src/agent/tools.ts';
import { stagingNameFor, recordDeployedCommit } from '../../src/cicd.ts';

const stop = autoApprove();
const STG = stagingNameFor(NAME);

log('=== D2: ENVIRONMENTS + PROMOTION ===');
let r = await dispatchTool('setup_environments', {}, { projectName: NAME });
log('setup_environments →\n' + r);
if (!r.includes(STG)) throw new Error('staging twin was not created');

// Staging needs the blueprint (prod's, renamed) before it can provision.
const prod = getProject(NAME)!;
const stg = getProject(STG)!;
upsertProject({ ...stg, blueprint: { ...prod.blueprint!, projectName: STG } });

log(`--- provisioning staging twin ${STG} (full isolated stack incl. its own RDS) ---`);
const outputs = await provision(STG, log);
const arns = JSON.parse(outputs.secret_arns ?? '{}');
if (arns.APP_TOKEN) await putAppSecret(REGION, arns.APP_TOKEN, 'gauntlet-stg-' + Date.now());

log('--- deploying to staging ---');
const stgUrl = await deployApp(STG, log);
await recordDeployedCommit(STG);
log('STAGING LIVE: ' + stgUrl);
await expectContent(stgUrl + '/api/version', 'TASKMGR-V1_1');

log('--- promotion, clean path (repo HEAD == staging-tested commit) ---');
r = await dispatchTool('promote_to_production', {}, { projectName: NAME });
log('promote_to_production →\n' + r);
if (!/Promoted to production/i.test(r)) throw new Error('clean-path promotion failed');

log('--- promotion drift guard: commit a NEWER release, promotion must refuse ---');
stampRelease('TASKMGR-V1_2', 0, 'release v1.2 (newer than staging tested)');
r = await dispatchTool('promote_to_production', {}, { projectName: NAME });
log('promote_to_production (drift) →\n' + r);
if (!/moved past what staging tested/i.test(r)) throw new Error('promotion did NOT flag the newer commit — drift guard broken');

log('--- founder accepts the newer commit ---');
r = await dispatchTool('promote_to_production', { acceptNewerCommit: true }, { projectName: NAME });
log('promote_to_production (accepted) →\n' + r);
if (!/Promoted to production/i.test(r)) throw new Error('acceptNewerCommit promotion failed');

const prodUrl = getProject(NAME)!.siteUrl!;
await expectContent(prodUrl + '/api/version', 'TASKMGR-V1_2');
log('D2 COMPLETE: staging twin live, both promotion paths proven, prod on V1_2.');
stop();
