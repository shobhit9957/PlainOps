'use strict';
const express = require('express');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3004;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/shopflow';
const PAYMENTS_URL = process.env.PAYMENTS_URL || 'http://localhost:3005';
const NOTIFICATIONS_URL = process.env.NOTIFICATIONS_URL || 'http://localhost:3006';

const orderSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    items: [{ productId: String, name: String, price: Number, quantity: Number }],
    total: { type: Number, required: true },
    status: { type: String, default: 'CREATED', enum: ['CREATED', 'PAID', 'PAYMENT_FAILED'] },
    paymentId: String,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
const Order = mongoose.model('Order', orderSchema);

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'orders', db: mongoose.connection.readyState === 1 }));

// Create an order → call the payments service → notify. Classic service-to-service flow.
app.post('/orders', async (req, res) => {
  try {
    const items = req.body.items || [];
    const total = items.reduce((s, i) => s + (i.price || 0) * (i.quantity || 1), 0);
    const order = await Order.create({ userId: req.body.userId || 'guest', items, total });

    let payment = { ok: false };
    try {
      const r = await fetch(`${PAYMENTS_URL}/charge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId: order.id, amount: total }),
        signal: AbortSignal.timeout(5000),
      });
      payment = await r.json();
    } catch (e) {
      payment = { ok: false, error: e.message };
    }

    order.status = payment.ok ? 'PAID' : 'PAYMENT_FAILED';
    order.paymentId = payment.paymentId;
    await order.save();

    // Fire-and-forget notification.
    fetch(`${NOTIFICATIONS_URL}/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: order.userId, message: `Order ${order.id} is ${order.status}` }),
    }).catch(() => {});

    res.status(201).json(order);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/orders', async (req, res) => {
  const q = req.query.userId ? { userId: req.query.userId } : {};
  res.json(await Order.find(q).sort('-createdAt').limit(100));
});

app.get('/orders/:id', async (req, res) => {
  const o = await Order.findById(req.params.id).catch(() => null);
  if (!o) return res.status(404).json({ error: 'order not found' });
  res.json(o);
});

connectAndListen();
async function connectAndListen() {
  app.listen(PORT, () => console.log(`[orders] listening on ${PORT}`));
  for (let i = 1; i <= 30; i++) {
    try {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
      console.log('[orders] MongoDB connected');
      return;
    } catch (e) {
      console.log(`[orders] Mongo not ready (${i}/30): ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
