'use strict';
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// Where each downstream microservice lives (overridden per environment).
const SERVICES = {
  users: process.env.USERS_URL || 'http://localhost:3001',
  products: process.env.PRODUCTS_URL || 'http://localhost:3002',
  cart: process.env.CART_URL || 'http://localhost:3003',
  orders: process.env.ORDERS_URL || 'http://localhost:3004',
};

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'gateway', routes: Object.keys(SERVICES) }));

// Reverse-proxy /api/<service>/<rest> → the matching service's /<rest>.
app.use('/api/:service', async (req, res) => {
  const base = SERVICES[req.params.service];
  if (!base) return res.status(404).json({ error: `unknown service: ${req.params.service}` });
  const rest = req.originalUrl.replace(`/api/${req.params.service}`, '') || '/';
  const url = base + rest;
  try {
    const headers = { ...req.headers, host: undefined };
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    await new Promise((r) => req.on('end', r));
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      signal: AbortSignal.timeout(10000),
    });
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('content-type', ct);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ error: `gateway could not reach ${req.params.service}: ${e.message}` });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`[gateway] listening on ${PORT} → ${JSON.stringify(SERVICES)}`));
