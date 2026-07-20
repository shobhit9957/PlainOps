'use strict';
const express = require('express');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3003;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/shopflow';

const cartSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    items: [{ productId: String, name: String, price: Number, quantity: { type: Number, default: 1 } }],
    updatedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
const Cart = mongoose.model('Cart', cartSchema);

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'cart', db: mongoose.connection.readyState === 1 }));

app.get('/cart/:userId', async (req, res) => {
  const cart = (await Cart.findOne({ userId: req.params.userId })) || { userId: req.params.userId, items: [] };
  res.json(cart);
});

app.post('/cart/:userId/items', async (req, res) => {
  const { productId, name, price, quantity } = req.body;
  const cart = await Cart.findOneAndUpdate(
    { userId: req.params.userId },
    { $push: { items: { productId, name, price, quantity: quantity || 1 } }, $set: { updatedAt: new Date() } },
    { new: true, upsert: true },
  );
  res.status(201).json(cart);
});

app.delete('/cart/:userId', async (req, res) => {
  await Cart.deleteOne({ userId: req.params.userId });
  res.status(204).end();
});

connectAndListen();
async function connectAndListen() {
  app.listen(PORT, () => console.log(`[cart] listening on ${PORT}`));
  for (let i = 1; i <= 30; i++) {
    try {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
      console.log('[cart] MongoDB connected');
      return;
    } catch (e) {
      console.log(`[cart] Mongo not ready (${i}/30): ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
