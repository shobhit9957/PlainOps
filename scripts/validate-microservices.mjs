import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectServices, renderMicroservices } from '../src/microservices.ts';
import { resolveTofu, tofuRun } from '../src/tofu.ts';

process.env.PLAINOPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'po-msval-'));
const shopflow = path.join(process.cwd(), 'examples', 'shopflow');
const { services, withDatabase, publicName } = detectServices(shopflow);
console.log('Detected services:', JSON.stringify(services, null, 2));
console.log('withDatabase:', withDatabase, '| public:', publicName);

const dir = renderMicroservices('shopflow', 'ap-south-1', services, withDatabase, 'plainops-bucket-demo');
console.log('Rendered to', dir);

const bin = await resolveTofu();
console.log('tofu:', bin);
const init = await tofuRun(bin, dir, ['init', '-backend=false', '-input=false'], () => {});
if (init.code !== 0) { console.log(init.stdout); process.exit(init.code); }
console.log('init OK');
const val = await tofuRun(bin, dir, ['validate'], (l) => console.log('  ', l));
process.exit(val.code);
