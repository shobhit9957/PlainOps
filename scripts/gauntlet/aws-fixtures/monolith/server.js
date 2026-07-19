'use strict';

/**
 * Gauntlet monolith — the task-manager app (Express + PostgreSQL) plus:
 *   - a release marker at /api/version (stamped per release: __MARKER__)
 *   - schema introspection at /api/_tables and /api/_columns (migration proofs)
 *   - an optional TIME BOMB: after __BOMB_MS__ ms of uptime every route
 *     (including /health) returns 500 — simulates the classic slow-death
 *     regression that passes deploy-time checks and dies under sustained watch.
 */

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const VERSION_MARKER = '__MARKER__';
const BOMB_MS = Number('__BOMB_MS__') || 0;
const bootAt = Date.now();

const app = express();
app.use(express.json());

// Simulated slow-death regression (only when a release stamps BOMB_MS > 0).
app.use((_req, res, next) => {
  if (BOMB_MS > 0 && Date.now() - bootAt > BOMB_MS) {
    return res.status(500).json({ error: 'simulated slow-death regression', version: VERSION_MARKER });
  }
  next();
});

// --- Database ---------------------------------------------------------------

let pool = null;
let dbReady = false;

function makePool() {
  if (!process.env.DATABASE_URL) return null;
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
  });
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id          SERIAL PRIMARY KEY,
    title       TEXT        NOT NULL,
    description TEXT        NOT NULL DEFAULT '',
    done        BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

async function initDb() {
  pool = makePool();
  if (!pool) {
    console.log('No DATABASE_URL set — running without a database.');
    return;
  }
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      await pool.query(SCHEMA);
      dbReady = true;
      console.log('Database connected and schema ready.');
      return;
    } catch (err) {
      console.log(`DB not ready (attempt ${attempt}/20): ${err.message}. Retrying in 4s…`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  console.error('Could not connect to the database after 20 attempts.');
}

function requireDb(req, res, next) {
  if (!dbReady) return res.status(503).json({ error: 'Database is still starting up.' });
  next();
}

// --- Health + gauntlet introspection -----------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', dbReady, version: VERSION_MARKER });
});

app.get('/api/version', (_req, res) => {
  res.json({ version: VERSION_MARKER, uptimeMs: Date.now() - bootAt, bombMs: BOMB_MS });
});

app.get('/api/_tables', requireDb, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    res.json(rows.map((r) => r.table_name));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/_columns', requireDb, async (req, res) => {
  try {
    const table = String(req.query.table || 'tasks');
    const { rows } = await pool.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY 1',
      ['public', table],
    );
    res.json(rows.map((r) => r.column_name));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- CRUD API ---------------------------------------------------------------

app.get('/api/tasks', requireDb, async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM tasks ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tasks', requireDb, async (req, res) => {
  const { title, description } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO tasks (title, description) VALUES ($1, $2) RETURNING *',
      [String(title).trim(), String(description || '')],
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/tasks/:id', requireDb, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Task not found' });
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Static frontend + boot ---------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Gauntlet monolith ${VERSION_MARKER} listening on port ${PORT} (bomb: ${BOMB_MS || 'none'})`);
  initDb();
});
