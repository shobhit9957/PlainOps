'use strict';
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;
const SERVICES = {
  service01: process.env.SERVICE01_URL || 'http://localhost:3001',
  service02: process.env.SERVICE02_URL || 'http://localhost:3002',
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
