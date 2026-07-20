'use strict';
const express = require('express');
const mongoose = require('mongoose');
const Redis = require('ioredis');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3002;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/shopflow';

// Optional Redis cache. If REDIS_URL is set, the catalog is cached; otherwise
// the service works fine straight from MongoDB. Cache ops are best-effort.
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
  redis.on('error', (e) => console.log('[products] redis error:', e.message));
  redis.on('connect', () => console.log('[products] Redis connected'));
}
const CACHE_KEY = 'products:all';
const CACHE_TTL = 30; // seconds

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    stock: { type: Number, default: 0, min: 0 },
    category: { type: String, default: 'general' },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
const Product = mongoose.model('Product', productSchema);

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'products', db: mongoose.connection.readyState === 1, cache: Boolean(redis) }),
);

app.get('/products', async (req, res) => {
  const q = req.query.category ? { category: req.query.category } : {};
  // Try the cache first (only for the full, unfiltered list).
  if (redis && !req.query.category) {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        res.set('x-cache', 'HIT');
        return res.json(JSON.parse(cached));
      }
    } catch { /* fall through to DB */ }
  }
  const products = await Product.find(q).sort('-createdAt').limit(200);
  if (redis && !req.query.category) {
    redis.set(CACHE_KEY, JSON.stringify(products), 'EX', CACHE_TTL).catch(() => {});
  }
  res.set('x-cache', 'MISS');
  res.json(products);
});

app.post('/products', async (req, res) => {
  try {
    const p = await Product.create(req.body);
    if (redis) redis.del(CACHE_KEY).catch(() => {}); // invalidate on write
    res.status(201).json(p);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/products/:id', async (req, res) => {
  const p = await Product.findById(req.params.id).catch(() => null);
  if (!p) return res.status(404).json({ error: 'product not found' });
  res.json(p);
});

async function seed() {
  if ((await Product.estimatedDocumentCount()) === 0) {
    await Product.insertMany([
      { name: 'Aurora Headphones', price: 129, stock: 40, category: 'audio' },
      { name: 'Nimbus Keyboard', price: 89, stock: 75, category: 'accessories' },
      { name: 'Vertex Mouse', price: 49, stock: 120, category: 'accessories' },
      { name: 'Halo Webcam', price: 69, stock: 60, category: 'video' },
    ]);
    console.log('[products] seeded catalog');
  }
}

connectAndListen();
async function connectAndListen() {
  app.listen(PORT, () => console.log(`[products] listening on ${PORT}`));
  for (let i = 1; i <= 30; i++) {
    try {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
      console.log('[products] MongoDB connected');
      await seed();
      return;
    } catch (e) {
      console.log(`[products] Mongo not ready (${i}/30): ${e.message}. Retrying in 4s…`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}
