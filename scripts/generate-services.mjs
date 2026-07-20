// Generate a deployable microservices app with N services + a gateway + a
// frontend dashboard that tests every service. Honors "give me 50 services"
// without hand-writing 50 near-duplicate folders.
//
//   node scripts/generate-services.mjs --count 50 --out C:\path\to\bigapp
//
// The output folder is exactly what deploy_microservices expects: one subfolder
// per service, each with a Dockerfile. Deploy however many your AWS Fargate
// quota allows.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const count = parseInt(getArg('--count', '10'), 10);
const outDir = path.resolve(getArg('--out', path.join(process.cwd(), 'generated-app')));

if (count < 1 || count > 200) {
  console.error('--count must be between 1 and 200');
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

function write(rel, content) {
  const p = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const svcPkg = (name) =>
  JSON.stringify(
    { name: `svc-${name}`, version: '1.0.0', type: 'commonjs', main: 'server.js', scripts: { start: 'node server.js' }, dependencies: { express: '^4.19.2' } },
    null,
    2,
  ) + '\n';

const svcDockerfile = (port) =>
  [
    'FROM node:20-alpine',
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm install --omit=dev',
    'COPY . .',
    'ENV NODE_ENV=production',
    `EXPOSE ${port}`,
    'CMD ["node", "server.js"]',
    '',
  ].join('\n');

const svcServer = (name, port) => `'use strict';
const express = require('express');
const app = express();
app.use(express.json());
const PORT = process.env.PORT || ${port};
const NAME = '${name}';
app.get('/health', (_req, res) => res.json({ status: 'ok', service: NAME }));
app.get('/', (_req, res) => res.json({ service: NAME, message: 'service is up', time: new Date().toISOString() }));
app.get('/work', (_req, res) => res.json({ service: NAME, result: Math.round(Math.random() * 1000), time: new Date().toISOString() }));
app.listen(PORT, () => console.log('[' + NAME + '] listening on ' + PORT));
`;

// N worker services on ports 3001..(3000+N).
const services = [];
for (let i = 1; i <= count; i++) {
  const name = `service${String(i).padStart(2, '0')}`;
  const port = 3000 + i;
  services.push({ name, port });
  write(`${name}/package.json`, svcPkg(name));
  write(`${name}/Dockerfile`, svcDockerfile(port));
  write(`${name}/server.js`, svcServer(name, port));
}

// Gateway: routes /api/<service>/* to each service, serves the dashboard.
const svcUrlEnv = services.map((s) => `  ${s.name}: process.env.${s.name.toUpperCase()}_URL || 'http://localhost:${s.port}',`).join('\n');
write(
  'gateway/server.js',
  `'use strict';
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;
const SERVICES = {
${svcUrlEnv}
};
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'gateway', count: Object.keys(SERVICES).length }));
app.get('/api/services', (_req, res) => res.json(Object.keys(SERVICES)));
app.use('/api/:service', async (req, res) => {
  const base = SERVICES[req.params.service];
  if (!base) return res.status(404).json({ error: 'unknown service' });
  const rest = req.originalUrl.replace('/api/' + req.params.service, '') || '/';
  try {
    const r = await fetch(base + rest, { signal: AbortSignal.timeout(8000) });
    res.status(r.status).set('content-type', r.headers.get('content-type') || 'application/json');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ error: 'cannot reach ' + req.params.service + ': ' + e.message });
  }
});
app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log('[gateway] listening on ' + PORT + ' with ' + Object.keys(SERVICES).length + ' services'));
`,
);
write('gateway/package.json', svcPkg('gateway'));
write('gateway/Dockerfile', svcDockerfile(8080));
write(
  'gateway/public/index.html',
  `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${count}-service dashboard</title><style>
:root{color-scheme:dark}body{margin:0;font-family:system-ui,sans-serif;background:#0b1120;color:#e2e8f0;padding:32px}
h1{margin:0 0 4px}.s{color:#94a3b8;margin-bottom:20px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.card{background:#131c31;border:1px solid #263354;border-radius:8px;padding:10px;font-size:.8rem;display:flex;align-items:center;gap:8px}
.dot{width:10px;height:10px;border-radius:50%;background:#64748b}.dot.ok{background:#4ade80}.dot.bad{background:#f87171}
</style></head><body>
<h1>🛰️ Microservices dashboard</h1><div class="s">Live health of every service, tested through the gateway.</div>
<div class="grid" id="grid"></div>
<script>
async function load(){const svcs=await (await fetch('/api/services')).json();
const grid=document.getElementById('grid');grid.innerHTML=svcs.map(s=>'<div class="card" id="c-'+s+'"><span class="dot"></span>'+s+'</div>').join('');
svcs.forEach(async s=>{try{const r=await fetch('/api/'+s+'/health');document.querySelector('#c-'+s+' .dot').className='dot '+(r.ok?'ok':'bad');}catch{document.querySelector('#c-'+s+' .dot').className='dot bad';}});}
load();setInterval(load,5000);
</script></body></html>
`,
);

console.log(`Generated ${count} services + gateway at:\n  ${outDir}`);
console.log(`\nDeploy with PLAINOPS by pointing deploy_microservices at that folder.`);
console.log(`Note: ${count + 1} live Fargate services need enough AWS Fargate vCPU quota and ~$${(count + 1) * 9 + 21}/mo.`);
