// GCP teardown: destroy a project's cloud stack via the product's destroyCloud.
import { log } from './common.ts';
import { getProject } from '../../src/state.ts';
import { destroyCloud } from '../../src/multicloud.ts';

const NAME = process.argv[2];
const p = getProject(NAME ?? '');
if (!p) {
  console.error(`Unknown project: ${NAME}`);
  process.exit(2);
}
log(`=== DESTROY ${NAME} (GCP) ===`);
await destroyCloud(NAME!, log);
log(`${NAME} torn down.`);
