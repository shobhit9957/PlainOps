'use strict';

/**
 * Task Manager — a full CRUD API + UI backed by PostgreSQL.
 *
 * Reads its database connection from the DATABASE_URL environment variable.
 * When deployed with PLAINOPS (with a database), PLAINOPS creates an RDS
 * PostgreSQL instance and injects DATABASE_URL automatically — this app just
 * reads it. Locally, set DATABASE_URL yourself (or run without a DB: the health
 * check still passes and the UI shows a "database starting…" state).
 */

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());

// --- Database ---------------------------------------------------------------

let pool = null;
let dbReady = false;

function makePool() {
  if (!process.env.DATABASE_URL) return null;
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    // RDS requires SSL; we use it without local CA verification (RDS-managed cert).
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

// Connect + create the schema, retrying so a not-quite-ready RDS doesn't crash us.
async function initDb() {
  pool = makePool();
  if (!pool) {
    console.log('No DATABASE_URL set — running without a database (UI will show a notice).');
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
  console.error('Could not connect to the database after 20 attempts. CRUD endpoints will return 503.');
}

function requireDb(req, res, next) {
  if (!dbReady) {
    return res.status(503).json({ error: 'Database is still starting up. Try again in a few seconds.' });
  }
  next();
}

// --- Health (DB-independent so the load balancer marks us healthy fast) -----

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', dbReady });
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

app.get('/api/tasks/:id', requireDb, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    res.json(rows[0]);
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

app.put('/api/tasks/:id', requireDb, async (req, res) => {
  const { title, description, done } = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE tasks SET
         title       = COALESCE($1, title),
         description = COALESCE($2, description),
         done        = COALESCE($3, done),
         updated_at  = now()
       WHERE id = $4 RETURNING *`,
      [title ?? null, description ?? null, typeof done === 'boolean' ? done : null, req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    res.json(rows[0]);
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

// --- Static frontend --------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

// --- Boot -------------------------------------------------------------------

// Listen immediately so /health passes even while the DB is still connecting.
app.listen(PORT, () => {
  console.log(`Task Manager listening on port ${PORT}`);
  initDb();
});
