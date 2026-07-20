'use strict';
const express = require('express');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3006;
const recent = [];

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'notifications' }));

// Real one would send email/SMS/push. Here we record + log.
app.post('/notify', (req, res) => {
  const { to, message } = req.body || {};
  const note = { to, message, at: new Date().toISOString() };
  recent.unshift(note);
  if (recent.length > 50) recent.pop();
  console.log(`[notifications] to=${to} :: ${message}`);
  res.status(201).json({ ok: true });
});

app.get('/notifications', (_req, res) => res.json(recent));

app.listen(PORT, () => console.log(`[notifications] listening on ${PORT}`));
