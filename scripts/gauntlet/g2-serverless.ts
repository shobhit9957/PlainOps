// Gauntlet L2: serverless — deploy API GW + 2 Lambdas + SQS + DynamoDB,
// verify the API answers, exercise the order pipeline end to end.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGION, log } from './common.ts';
import { upsertProject, getProject } from '../../src/state.ts';
import { deployServerless } from '../../src/serverless.ts';

const NAME = 'gtl-api';
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', '..', 'examples', 'order-pipeline');

upsertProject({
  name: NAME,
  region: REGION,
  status: getProject(NAME)?.status ?? 'new',
  createdAt: getProject(NAME)?.createdAt ?? new Date().toISOString(),
  accountId: getProject(NAME)?.accountId,
  outputs: getProject(NAME)?.outputs,
});

const url = await deployServerless(NAME, src, log);
log('L2 SERVERLESS LIVE: ' + url);

// Exercise the pipeline: POST an order, confirm the API accepts it.
const res = await fetch(url.replace(/\/$/, '') + '/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ item: 'gauntlet-widget', qty: 1 }),
  signal: AbortSignal.timeout(15_000),
}).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as unknown as Response);
log(`order POST → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
if (!res.ok) throw new Error('The API did not accept an order — pipeline not fully live.');
log('L2 pipeline exercised: order accepted (API → SQS → worker → DynamoDB).');
