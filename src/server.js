import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pg from 'pg';
import { z } from 'zod';

const { Pool } = pg;
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..');
const port = Number(process.env.PORT || 10000);
const sessionSecret = process.env.SESSION_SECRET;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Configure a PostgreSQL database before starting Northstar.');
}
if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be set to a random value with at least 32 characters.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'northstar-api'
});

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
app.disable('x-powered-by');
if (isProduction) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
app.use(express.json({ limit: '32kb', strict: true }));

const PgSession = connectPgSimple(session);
app.use(session({
  name: 'northstar.sid',
  store: new PgSession({ pool, tableName: 'northstar_sessions', createTableIfMissing: false }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: true,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 90,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again shortly.' }
});
app.use('/api', apiLimiter);

const scenarioInput = z.object({
  asset: z.string().trim().min(1).max(64),
  side: z.enum(['long', 'short']),
  equity: z.number().finite().positive().max(1_000_000_000),
  riskPct: z.number().finite().positive().max(100),
  entry: z.number().finite().positive().max(1_000_000_000_000),
  stop: z.number().finite().positive().max(1_000_000_000_000),
  target: z.number().finite().positive().max(1_000_000_000_000)
});

function estimateScenario(input) {
  const { asset, side, equity, riskPct, entry, stop, target } = input;
  if (entry === stop) return { error: 'Entry and stop must be different so risk can be calculated.' };
  if (side === 'long' && !(stop < entry && entry < target)) {
    return { error: 'For a long scenario, use Stop < Entry < Target.' };
  }
  if (side === 'short' && !(target < entry && entry < stop)) {
    return { error: 'For a short scenario, use Target < Entry < Stop.' };
  }

  const riskAmount = equity * riskPct / 100;
  const stopDistance = Math.abs(entry - stop);
  const targetDistance = Math.abs(target - entry);
  return {
    asset, side, equity, riskPct, entry, stop, target,
    riskAmount,
    stopDistance,
    quantity: riskAmount / stopDistance,
    gain: riskAmount * targetDistance / stopDistance,
    rr: targetDistance / stopDistance
  };
}

function serializeScenario(row) {
  const createdAt = new Date(row.created_at);
  return {
    id: row.id,
    ...row.payload,
    date: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(createdAt)
  };
}

app.get('/api/v1/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'unavailable' });
  }
});

app.post('/api/v1/risk/estimate', (req, res) => {
  const parsed = scenarioInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Check the scenario values and try again.' });
  const result = estimateScenario(parsed.data);
  if (result.error) return res.status(422).json({ error: result.error });
  res.json(result);
});

app.get('/api/v1/scenarios', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, payload, created_at FROM trade_scenarios WHERE session_id = $1 ORDER BY created_at DESC LIMIT 8',
      [req.sessionID]
    );
    res.json(rows.map(serializeScenario));
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/scenarios', async (req, res, next) => {
  const parsed = scenarioInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Check the scenario values and try again.' });
  const payload = estimateScenario(parsed.data);
  if (payload.error) return res.status(422).json({ error: payload.error });

  try {
    const id = crypto.randomUUID();
    const { rows } = await pool.query(
      'INSERT INTO trade_scenarios (id, session_id, payload) VALUES ($1, $2, $3::jsonb) RETURNING id, payload, created_at',
      [id, req.sessionID, JSON.stringify(payload)]
    );
    res.status(201).json(serializeScenario(rows[0]));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/v1/scenarios/:id', async (req, res, next) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: 'Invalid scenario id.' });
  try {
    await pool.query('DELETE FROM trade_scenarios WHERE id = $1 AND session_id = $2', [id.data, req.sessionID]);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get('/', (_req, res) => res.sendFile(path.join(repoRoot, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(repoRoot, 'index.html')));

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' });
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  console.error('Request failed:', error?.message || 'Unknown error');
  res.status(500).json({ error: 'The request could not be completed.' });
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS northstar_sessions (
      sid varchar NOT NULL PRIMARY KEY,
      sess json NOT NULL,
      expire timestamp(6) NOT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS northstar_sessions_expire_idx ON northstar_sessions (expire)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trade_scenarios (
      id uuid PRIMARY KEY,
      session_id text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS trade_scenarios_session_created_idx ON trade_scenarios (session_id, created_at DESC)');
  const server = app.listen(port, '0.0.0.0', () => console.log(`Northstar API listening on ${port}`));

  async function shutdown() {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(error => {
  console.error('Northstar could not start:', error.message);
  process.exit(1);
});

