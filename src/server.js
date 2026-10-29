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
import WebSocket from 'ws';
import { fetchDerivMarkets, fetchDerivMarketCatalog } from './deriv-market-data.js';

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
const marketCache = new Map();
let marketCatalogCache = { at: 0, markets: [] };
const marketQuery = z.object({
  granularity: z.coerce.number().int().optional().default(3600),
  count: z.coerce.number().int().min(2).max(365).optional().default(24)
});
const marketDataCacheMs = 15_000;

async function getMarkets(keys, granularity, count) {
  const marketKeys = Array.isArray(keys) ? keys : [];
  const cacheKey = `${marketKeys.slice().sort().join(',')}:${granularity}:${count}`;
  const cached = marketCache.get(cacheKey);
  if (cached && Date.now() - cached.at < marketDataCacheMs) return cached.data;
  const data = await fetchDerivMarkets({ keys: marketKeys, granularity, count });
  marketCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

async function getMarketCatalog() {
  if (marketCatalogCache.markets.length && Date.now() - marketCatalogCache.at < 5 * 60_000) return marketCatalogCache.markets;
  const markets = await fetchDerivMarketCatalog();
  marketCatalogCache = { at: Date.now(), markets };
  return markets;
}

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (const item of values.slice(period)) value = item * multiplier + value * (1 - multiplier);
  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  const moves = values.slice(1).map((value, i) => value - values[i]);
  let gains = 0, losses = 0;
  for (const move of moves.slice(0, period)) {
    if (move > 0) gains += move;
    else losses -= move;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (const move of moves.slice(period)) {
    avgGain = (avgGain * (period - 1) + Math.max(move, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-move, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function derivTokenKey() {
  return crypto.createHash('sha256').update(sessionSecret).update('northstar-deriv-token-v1').digest();
}

function sealToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivTokenKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function openToken(value) {
  const [iv, tag, ciphertext] = String(value).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', derivTokenKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

async function derivApi(pathname, token, options = {}) {
  const response = await fetch(`https://api.derivws.com${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    signal: AbortSignal.timeout(12_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('Deriv account request failed.');
    error.status = response.status;
    throw error;
  }
  return result.data ?? result;
}

async function readDerivAccount(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map([[101, 'balance'], [102, 'portfolio'], [103, 'statement']]);
    const result = {};
    const timer = setTimeout(() => finish(new Error('Deriv account data timed out.')), 12_000);
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error); else resolve(result);
    }
    ws.on('open', () => {
      ws.send(JSON.stringify({ balance: 1, req_id: 101 }));
      ws.send(JSON.stringify({ portfolio: 1, req_id: 102 }));
      ws.send(JSON.stringify({ statement: 1, limit: 50, description: 1, req_id: 103 }));
    });
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.error) return finish(new Error('Deriv could not return complete account information.'));
        const key = pending.get(message.req_id) || message.msg_type;
        if (['balance', 'portfolio', 'statement'].includes(key)) result[key] = message[key] ?? message;
        if (message.req_id && pending.has(message.req_id)) pending.delete(message.req_id);
        if (['balance', 'portfolio', 'statement'].every(name => result[name])) finish();
      } catch { finish(new Error('Invalid response from Deriv.')); }
    });
    ws.on('error', () => finish(new Error('Could not connect to the Deriv account feed.')));
    ws.on('close', () => { if (!settled) finish(Object.keys(result).length ? null : new Error('Deriv closed the account connection.')); });
  });
}

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
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin) {
      try { if (new URL(origin).origin !== new URL(`${req.protocol}://${req.get('host')}`).origin) return res.status(403).json({ error: 'Cross-origin request blocked.' }); }
      catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
    }
  }
  next();
});
app.use('/api', apiLimiter);

const scenarioInput = z.object({
  asset: z.string().trim().min(1).max(64),
  side: z.enum(['long', 'short']),
  equity: z.number().finite().positive().max(1_000_000_000),
  riskPct: z.number().finite().positive().max(100),
  entry: z.number().finite().positive().max(1_000_000_000_000),
  stop: z.number().finite().positive().max(1_000_000_000_000),
  target: z.number().finite().positive().max(1_000_000_000_000),
  currency: z.enum(['USD', 'ZAR', 'ZWL', 'EUR', 'GBP']).optional().default('USD')
});
const registrationInput = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(128)
});
const loginInput = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128)
});
const accountSettingsDefaults = { plannerCurrency: 'USD', defaultMarket: 'BTCUSD', defaultTimeframe: '1m', timeZone: 'local', appearance: 'system' };
const accountSettingsInput = z.object({
  plannerCurrency: z.enum(['USD', 'ZAR', 'ZWL', 'EUR', 'GBP']),
  defaultMarket: z.string().regex(/^[A-Za-z0-9_]{2,30}$/),
  defaultTimeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1D']),
  timeZone: z.enum(['local', 'UTC', 'Africa/Harare', 'Africa/Johannesburg', 'America/Los_Angeles', 'Europe/London']),
  appearance: z.enum(['light', 'dark', 'system'])
}).strict();
const scrypt = (password, salt, length) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, length, (error, key) => error ? reject(error) : resolve(key));
});

async function passwordDigest(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = await scrypt(password, salt, 64);
  return { salt, hash: hash.toString('hex') };
}

function establishSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => {
      if (error) return reject(error);
      req.session.userId = user.id;
      req.session.userName = user.display_name;
      req.session.userEmail = user.email;
      req.session.save(saveError => saveError ? reject(saveError) : resolve());
    });
  });
}

function requireAccount(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Sign in to access saved scenarios.' });
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Sign in to access this page.' });
  try {
    const { rows } = await pool.query('SELECT role FROM northstar_users WHERE id = $1', [req.session.userId]);
    if (rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
    next();
  } catch (error) { next(error); }
}

async function getDerivConnection(userId) {
  const { rows } = await pool.query(
    'SELECT access_token_ciphertext, expires_at, selected_account_id FROM deriv_connections WHERE user_id = $1',
    [userId]
  );
  if (!rows[0]) return null;
  if (new Date(rows[0].expires_at) <= new Date()) return { expired: true };
  try { return { token: openToken(rows[0].access_token_ciphertext), selectedAccountId: rows[0].selected_account_id }; }
  catch { return { invalid: true }; }
}

function normalizeDerivAccounts(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.accounts) ? payload.accounts : Array.isArray(payload?.data) ? payload.data : [];
  return rows.filter(item => item && typeof item.account_id === 'string').map(item => ({
    accountId: item.account_id,
    accountType: item.account_type || item.type || 'Deriv',
    currency: item.currency || null,
    isVirtual: Boolean(item.is_virtual ?? item.is_demo ?? /demo|virtual/i.test(item.account_type || '')),
    status: item.status || null
  }));
}

app.get('/api/v1/connections/deriv/start', requireAccount, (req, res) => {
  const appId = process.env.DERIV_APP_ID;
  const redirectUri = process.env.DERIV_REDIRECT_URI;
  if (!appId?.trim()) return res.redirect('/?connection=deriv-app-id-missing');
  if (!redirectUri?.trim()) return res.redirect('/?connection=deriv-redirect-uri-missing');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const state = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  req.session.derivOAuth = { verifier, state, createdAt: Date.now() };
  req.session.save(error => {
    if (error) return res.status(500).json({ error: 'Could not start Deriv authorization.' });
    const authorize = new URL('https://auth.deriv.com/oauth2/auth');
    authorize.search = new URLSearchParams({ response_type: 'code', client_id: appId, redirect_uri: redirectUri, scope: 'trade', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    res.redirect(authorize.toString());
  });
});

app.get('/api/v1/connections/deriv/callback', requireAccount, async (req, res) => {
  const pending = req.session.derivOAuth;
  delete req.session.derivOAuth;
  const state = String(req.query.state || '');
  if (!pending || Date.now() - pending.createdAt > 10 * 60_000 || state.length !== pending.state.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) {
    return res.status(400).send('Deriv authorization could not be verified. Return to Northstar and try again.');
  }
  if (req.query.error || typeof req.query.code !== 'string') return res.redirect('/?connection=deriv-cancelled');
  try {
    const response = await fetch('https://auth.deriv.com/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: process.env.DERIV_APP_ID || '', code: req.query.code, code_verifier: pending.verifier, redirect_uri: process.env.DERIV_REDIRECT_URI || '' }),
      signal: AbortSignal.timeout(12_000)
    });
    const result = await response.json();
    if (!response.ok || typeof result.access_token !== 'string' || !Number.isFinite(Number(result.expires_in))) return res.status(502).send('Deriv authorization did not return a usable access token. Return to Northstar and try again.');
    await pool.query(`INSERT INTO deriv_connections (user_id, access_token_ciphertext, expires_at, selected_account_id, updated_at)
      VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 second'), NULL, NOW())
      ON CONFLICT (user_id) DO UPDATE SET access_token_ciphertext = EXCLUDED.access_token_ciphertext, expires_at = EXCLUDED.expires_at, selected_account_id = NULL, updated_at = NOW()`,
    [req.session.userId, sealToken(result.access_token), Number(result.expires_in)]);
    res.redirect('/?connection=deriv-connected');
  } catch {
    res.status(502).send('Could not complete Deriv authorization. Return to Northstar and try again.');
  }
});

app.get('/api/v1/connections/deriv/accounts', requireAccount, async (req, res) => {
  try {
    const connection = await getDerivConnection(req.session.userId);
    if (!connection) return res.status(404).json({ error: 'Deriv is not connected.' });
    if (connection.expired || connection.invalid) return res.status(401).json({ error: 'Deriv authorization expired. Reconnect the account.' });
    const payload = await derivApi('/trading/v1/options/accounts', connection.token);
    const accounts = normalizeDerivAccounts(payload);
    res.json({ accounts, selectedAccountId: connection.selectedAccountId, source: 'Deriv' });
  } catch (error) {
    res.status(error.status || 503).json({ error: error.status === 401 ? 'Deriv authorization expired. Reconnect the account.' : 'Could not load accounts from Deriv.' });
  }
});

app.delete('/api/v1/connections/deriv', requireAccount, async (req, res) => {
  try {
    await pool.query('DELETE FROM deriv_connections WHERE user_id = $1', [req.session.userId]);
    res.json({ removed: true });
  } catch {
    res.status(500).json({ error: 'Could not remove the saved Deriv connection.' });
  }
});

app.post('/api/v1/connections/deriv/account', requireAccount, async (req, res) => {
  const accountId = z.string().trim().min(3).max(40).safeParse(req.body?.accountId);
  if (!accountId.success) return res.status(400).json({ error: 'Choose a valid Deriv account.' });
  try {
    const connection = await getDerivConnection(req.session.userId);
    if (!connection || connection.expired || connection.invalid) return res.status(401).json({ error: 'Connect Deriv again before selecting an account.' });
    const accounts = normalizeDerivAccounts(await derivApi('/trading/v1/options/accounts', connection.token));
    if (!accounts.some(item => item.accountId === accountId.data)) return res.status(403).json({ error: 'That account was not returned by Deriv for this authorization.' });
    await pool.query('UPDATE deriv_connections SET selected_account_id = $2, updated_at = NOW() WHERE user_id = $1', [req.session.userId, accountId.data]);
    res.json({ selectedAccountId: accountId.data });
  } catch (error) {
    res.status(error.status || 503).json({ error: error.status === 401 ? 'Deriv authorization expired. Reconnect the account.' : 'Could not select the Deriv account.' });
  }
});

app.get('/api/v1/account/summary', requireAccount, async (req, res) => {
  try {
    const connection = await getDerivConnection(req.session.userId);
    if (!connection || connection.expired || connection.invalid) return res.status(401).json({ error: 'Connect Deriv and select an account to view real account data.' });
    if (!connection.selectedAccountId) return res.status(409).json({ error: 'Select a Deriv account to view its balance and positions.' });
    const otp = await derivApi(`/trading/v1/options/accounts/${encodeURIComponent(connection.selectedAccountId)}/otp`, connection.token, { method: 'POST' });
    const data = await readDerivAccount(otp.url);
    res.json({ accountId: connection.selectedAccountId, source: 'Deriv', asOf: new Date().toISOString(), balance: data.balance, portfolio: data.portfolio, statement: data.statement });
  } catch (error) {
    res.status(error.status || 503).json({ error: error.status === 401 ? 'Deriv authorization expired. Reconnect the account.' : 'Could not load current data from the selected Deriv account.' });
  }
});

function estimateScenario(input) {
  const { asset, side, equity, riskPct, entry, stop, target, currency = 'USD' } = input;
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
    asset, side, equity, riskPct, entry, stop, target, currency,
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

app.get('/api/v1/admin/overview', requireAdmin, async (_req, res, next) => {
  try {
    const [{ rows: users }, { rows: connections }, health] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM northstar_users'),
      pool.query('SELECT COUNT(*)::int AS count FROM deriv_connections'),
      pool.query('SELECT 1 AS ok')
    ]);
    res.json({
      registeredUsers: users[0].count,
      brokerConnections: connections[0].count,
      database: health.rows[0]?.ok ? 'connected' : 'degraded',
      providers: { derivMarkets: true, derivOAuth: Boolean(process.env.DERIV_APP_ID?.trim() && process.env.DERIV_REDIRECT_URI?.trim()), gemini: Boolean(process.env.GEMINI_API_KEY?.trim()) },
      asOf: new Date().toISOString()
    });
  } catch (error) { next(error); }
});

app.get('/api/v1/providers', (_req, res) => {
  const derivAppIdConfigured = Boolean(process.env.DERIV_APP_ID?.trim());
  const derivRedirectUriConfigured = Boolean(process.env.DERIV_REDIRECT_URI?.trim());
  res.json({
    markets: 'Deriv public market data',
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    derivAppIdConfigured,
    derivRedirectUriConfigured,
    derivOAuthConfigured: derivAppIdConfigured && derivRedirectUriConfigured
  });
});

app.get('/api/v1/markets/catalog', async (_req, res) => {
  try {
    const markets = await getMarketCatalog();
    res.json({ source: 'Deriv active symbols', updatedAt: new Date(marketCatalogCache.at).toISOString(), count: markets.length, markets });
  } catch {
    res.status(503).json({ error: 'Deriv market catalog is temporarily unavailable.' });
  }
});

app.get('/api/v1/markets', async (req, res) => {
  const parsed = marketQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid market-data interval.' });
  try {
    const markets = await getMarkets(null, parsed.data.granularity, parsed.data.count);
    if (!markets.length) return res.status(503).json({ error: 'The live market feed returned no quotes.' });
    res.json({ source: 'Deriv', updatedAt: new Date().toISOString(), markets });
  } catch {
    res.status(503).json({ error: 'Live market data is temporarily unavailable.' });
  }
});

app.get('/api/v1/markets/:asset/history', async (req, res) => {
  const requestedKey = String(req.params.asset || '');
  const parsed = marketQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid market-data interval.' });
  try {
    const catalog = await getMarketCatalog();
    const marketDefinition = catalog.find(item => item.key === requestedKey || item.symbol === requestedKey || item.key.toUpperCase() === requestedKey.toUpperCase());
    if (!marketDefinition) return res.status(404).json({ error: 'That instrument is not in Deriv’s active market catalog.' });
    const markets = await getMarkets([marketDefinition.key], parsed.data.granularity, parsed.data.count);
    const market = markets[0];
    if (!market) return res.status(503).json({ error: 'No live candles are available for this market.' });
    res.json(market);
  } catch {
    res.status(503).json({ error: 'Live market history is temporarily unavailable.' });
  }
});

app.get('/api/v1/signals', async (_req, res) => {
  try {
    const markets = await getMarkets(['BTCUSD', 'ETHUSD', 'EURUSD', 'XAUUSD'], 3600, 60);
    const signals = markets.map(market => {
      const closes = market.candles.map(candle => candle.close);
      const fast = ema(closes, 20), slow = ema(closes, 50), strength = rsi(closes, 14);
      let bias = 'Neutral';
      if (fast !== null && slow !== null && strength !== null) {
        if (fast > slow && strength < 70) bias = 'Bullish bias';
        else if (fast < slow && strength > 30) bias = 'Bearish bias';
      }
      return {
        key: market.key,
        name: market.name,
        bias,
        indicators: { ema20: fast, ema50: slow, rsi14: strength },
        price: market.price,
        source: market.source,
        asOf: market.asOf,
        method: 'EMA 20/50 and RSI 14 on hourly candles'
      };
    });
    res.json({ kind: 'rule-based technical analysis', source: 'Deriv', signals });
  } catch {
    res.status(503).json({ error: 'Live data is unavailable, so signals cannot be calculated.' });
  }
});

const aiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many AI requests. Please wait and try again.' }
});
app.post('/api/v1/ai/ask', requireAccount, aiLimiter, async (req, res) => {
  const question = z.string().trim().min(3).max(1200).safeParse(req.body?.question);
  if (!question.success) return res.status(400).json({ error: 'Enter a question between 3 and 1,200 characters.' });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'Gemini is not configured on the server yet.' });
  try {
    const markets = await getMarkets(null, 3600, 24);
    const context = markets.map(market => ({
      market: market.name,
      latestQuote: market.price,
      quoteTime: market.asOf,
      source: market.source,
      hourlyCandles: market.candles.slice(-12)
    }));
    const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `You are a market research assistant. Use only the supplied, timestamped market observations. Do not invent prices, events, positions, account data, confidence scores, or performance. Distinguish observations from interpretation. Explain uncertainty and risk. Do not give personalized financial advice or tell the user to place a trade. If the data is missing or stale, say so clearly.\n\nUser question: ${question.data}\n\nLive provider observations (JSON): ${JSON.stringify(context)}` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 700 }
      }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) return res.status(503).json({ error: 'Gemini could not complete the analysis right now.' });
    const data = await response.json();
    const answer = data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
    if (!answer) return res.status(503).json({ error: 'Gemini returned no analysis.' });
    res.json({ answer, source: 'Gemini', marketSource: 'Deriv', asOf: new Date().toISOString() });
  } catch {
    res.status(503).json({ error: 'Live market data or Gemini is temporarily unavailable.' });
  }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait and try again.' }
});
app.get('/api/v1/auth/me', async (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const { rows } = await pool.query('SELECT role FROM northstar_users WHERE id = $1', [req.session.userId]);
    if (!rows[0]) return res.status(401).json({ error: 'Account no longer exists.' });
    res.json({ user: { id: req.session.userId, name: req.session.userName, email: req.session.userEmail, role: rows[0].role } });
  } catch (error) { next(error); }
});

app.post('/api/v1/auth/register', authLimiter, async (req, res, next) => {
  const parsed = registrationInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Use a valid name and email, and a password with at least 12 characters.' });
  const email = parsed.data.email.toLowerCase();
  try {
    const credentials = await passwordDigest(parsed.data.password);
    const { rows } = await pool.query(
      'INSERT INTO northstar_users (d