'use strict';
const express = require('express');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/shopflow';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
const User = mongoose.model('User', userSchema);

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'users', db: mongoose.connection.readyState === 1 }));

app.post('/users', async (req, res) => {
  try {
    const user = await User.create({ name: req.body.name, email: req.body.email });
    res.status(201).json(user);
  } catch (e) {
    res.status(e.code === 11000 ? 409 : 400).json({ error: e.code === 11000 ? 'email already exists' : e.message });
  }
});

app.get('/users', async (_req, res) => res.json(await User.find().sort('-createdAt').limit(100)));

app.get('/users/:id', async (req, res) => {
  const user = await User.findById(req.params.id).catch(() => null);
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json(user);
});

connectAndListen();

async function connectAndListen() {
  app.listen(PORT, () => console.log(`[users] listening on ${PORT}`));
  for (let i = 1; i <= 30; i++) {
    try {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
      console.log('[users] MongoDB connected');
      return;
    } catch (e) {
      console.log(`[users] Mongo not ready (${i}/30): ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
