// Azure probe on a FRESH az install (no login, no extensions): exactly what a
// founder's machine looks like on day one. Exercises the product's own
// resolveCloudBin (spaced path) + detectClouds + runCloudCli quoting.
import { detectClouds, runCloudCli, classifyCloud } from '../../src/clouds/cloudcli.ts';

console.log('--- detectClouds() on fresh az (spaced install path, not logged in) ---');
console.log(JSON.stringify((await detectClouds()).azure, null, 2));

console.log('--- extension-command behavior: az containerapp list (fresh install) ---');
const t0 = Date.now();
const r = await runCloudCli('azure', ['containerapp', 'list', '--output', 'json'], 45_000);
console.log(`code ${r.code} in ${Date.now() - t0}ms`);
console.log('stdout:', r.stdout.slice(0, 500).trim());
console.log('stderr:', r.stderr.slice(0, 500).trim());
console.log('classify:', JSON.stringify(classifyCloud('azure', ['containerapp', 'list'])));
