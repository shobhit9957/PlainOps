// D5: routine day-2 battery against the live monolith — the checks a DevOps
// engineer runs weekly: launch preflight, EOL versions, cost waste, security
// posture, drift, and an ACCOUNT-scope diagnosis (whole-estate sweep).
import { REGION, log } from './common.ts';
import { NAME } from './mono-common.ts';
import { getProject } from '../../src/state.ts';

const p = getProject(NAME);
if (!p || p.status !== 'live') throw new Error(`${NAME} is not live`);

const { preflightLaunch, checkVersions } = await import('../../src/readiness.ts');
log('=== PREFLIGHT LAUNCH (quota / scaling / connection math) ===');
log(await preflightLaunch(p));

log('=== CHECK VERSIONS (EOL watch) ===');
log(await checkVersions(p));

const { findSavings } = await import('../../src/ops.ts');
log('=== FIND SAVINGS (idle/orphan sweep) ===');
log(await findSavings(REGION));

const { scanSecurity } = await import('../../src/security.ts');
log('=== SECURITY POSTURE SCAN ===');
log(await scanSecurity(REGION));

const { checkDrift } = await import('../../src/ops.ts');
log('=== DRIFT CHECK (tofu plan -detailed-exitcode) ===');
log(await checkDrift(p, log));

const { collectDiagnosis } = await import('../../src/diagnosis.ts');
log('=== ACCOUNT-SCOPE DIAGNOSIS (whole-estate sweep) ===');
log(await collectDiagnosis(NAME, 'routine weekly estate review', 'account'));

log('D5 COMPLETE.');
