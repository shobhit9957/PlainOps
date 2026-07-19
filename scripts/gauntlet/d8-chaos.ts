// D8: the 3am mystery outage — someone (or something) set desired-count to 0
// OUT-OF-BAND. run_diagnosis must surface the smoking gun; then restore and
// verify serving again.
import { REGION, log } from './common.ts';
import { NAME } from './mono-common.ts';
import { getProject } from '../../src/state.ts';
import { runAwsCli } from '../../src/awscli.ts';
import { collectDiagnosis } from '../../src/diagnosis.ts';
import { validateLive, defaultDeps } from '../../src/orchestrator.ts';

const p = getProject(NAME);
if (!p?.outputs || !p.siteUrl) throw new Error(`${NAME} is not live`);
const { cluster_name, service_name } = p.outputs;

log('=== D8 CHAOS: out-of-band desired=0 (simulated 3am outage) ===');
const broke = await runAwsCli(['ecs', 'update-service', '--cluster', cluster_name, '--service', service_name, '--desired-count', '0', '--region', REGION], 60_000);
if (broke.code !== 0) throw new Error(broke.stderr);

log('waiting for the outage to bite (target drains)…');
for (let i = 0; i < 24; i++) {
  const status = await defaultDeps.healthFetch(p.siteUrl).catch(() => 0);
  if (status >= 500 || status === 0) { log(`URL now failing (status ${status || 'unreachable'})`); break; }
  await new Promise((r) => setTimeout(r, 10_000));
}

log('=== diagnosis (must find the smoking gun) ===');
const evidence = await collectDiagnosis(NAME, 'site is down — load balancer returns 503');
log(evidence);
if (!/"desired":\s*0|desired 0|desiredCount.{0,4}0/i.test(evidence)) {
  throw new Error('diagnosis did NOT surface the desired=0 smoking gun');
}
log('smoking gun present in the evidence ✓');

log('=== restore ===');
await runAwsCli(['ecs', 'update-service', '--cluster', cluster_name, '--service', service_name, '--desired-count', '1', '--region', REGION], 60_000);
const stable = await runAwsCli(['ecs', 'wait', 'services-stable', '--cluster', cluster_name, '--services', service_name, '--region', REGION], 600_000);
if (stable.code !== 0) throw new Error('service did not restabilize');
const live = await validateLive(p.siteUrl, defaultDeps, log, 12, 10_000);
if (!live.ok) throw new Error('restore failed: ' + live.detail);
log('D8 COMPLETE: outage diagnosed (desired=0) and restored to serving.');
