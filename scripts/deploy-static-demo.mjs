// Manual end-to-end test: deploy the sample static site to a REAL AWS account.
//   node scripts/deploy-static-demo.mjs deploy   → creates + prints URL
//   node scripts/deploy-static-demo.mjs destroy  → tears down
import { whoAmI } from '../src/aws.ts';
import { deployStaticSite, destroyStaticSite, staticBucketName } from '../src/static-site.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGION = process.env.FM_REGION || 'ap-south-1';
const PROJECT = 'demo';
const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.join(here, '..', 'examples', 'static-site');
const mode = process.argv[2] || 'deploy';

const { accountId } = await whoAmI(REGION);
const bucket = staticBucketName(PROJECT, accountId);
const log = (l) => console.log('  ', l);
console.log(`Account ${accountId} · region ${REGION} · bucket ${bucket}`);

if (mode === 'deploy') {
  const res = await deployStaticSite(REGION, bucket, siteDir, log);
  console.log('\nLIVE URL:', res.url);
} else if (mode === 'destroy') {
  await destroyStaticSite(REGION, bucket, log);
  console.log('\nDestroyed.');
} else {
  console.error('Unknown mode:', mode);
  process.exit(1);
}
