'use strict';
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3005;

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'payments' }));

// Simulate a payment processor. ~92% succeed; real one would call Stripe etc.
app.post('/charge', (req, res) => {
  const { orderId, amount } = req.body || {};
  const ok = Math.random() > 0.08;
  console.log(`[payments] charge order=${orderId} amount=${amount} -> ${ok ? 'PAID' : 'DECLINED'}`);
  res.json({ ok, paymentId: ok ? 'pay_' + crypto.randomBytes(6).toString('hex') : null, amount });
});

app.listen(PORT, () => console.log(`[payments] listening on ${PORT}`));
