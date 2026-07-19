// D6: the re-architecture cutover — microservices version is live (gtl-shop,
// deployed by g4-micro), so the monolith era ends: destroy the monolith and
// its staging twin through the product's own destroy path.
import { log } from './common.ts';
import { NAME } from './mono-common.ts';
import { getProject } from '../../src/state.ts';
import { destroy } from '../../src/orchestrator.ts';
import { stagingNameFor } from '../../src/cicd.ts';

const shop = getProject('gtl-shop');
if (shop?.status !== 'live') {
  throw new Error('Refusing the cutover: gtl-shop (the microservices replacement) is not live yet.');
}

for (const name of [stagingNameFor(NAME), NAME]) {
  const p = getProject(name);
  if (!p || p.status === 'destroyed' || p.status === 'new') {
    log(`${name}: nothing to destroy (${p?.status ?? 'absent'})`);
    continue;
  }
  log(`=== CUTOVER: destroying ${name} ===`);
  await destroy(name, log);
  log(`${name} destroyed.`);
}
log('D6 COMPLETE: monolith decommissioned; microservices stack carries production.');
