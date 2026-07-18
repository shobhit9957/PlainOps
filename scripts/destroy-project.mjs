// Tear down any PLAINOPS project by name, using its stored state.
//   node scripts/destroy-project.mjs <projectName>
import { getProject } from '../src/state.ts';
import * as orchestrator from '../src/orchestrator.ts';

const name = process.argv[2];
if (!name) {
  console.error('Usage: destroy-project.mjs <projectName>');
  process.exit(1);
}
const p = getProject(name);
if (!p) {
  console.error(`No project "${name}" in state (home: ${process.env.PLAINOPS_HOME || '~/.plainops'}).`);
  process.exit(1);
}
const log = (l) => console.log(new Date().toISOString().slice(11, 19), l);
log(`Destroying "${name}" (${p.status}) in ${p.region}…`);
await orchestrator.destroy(name, log);
log('Torn down.');
