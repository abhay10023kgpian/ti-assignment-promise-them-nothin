'use strict';

const express = require('express');
const Redis   = require('ioredis');
const { createRateLimiter } = require('./middleware/rateLimiter');

// ---------------------------------------------------------------------------
// Redis connection — single shared client for this process
// ---------------------------------------------------------------------------
const redis = new Redis({
  host:                  process.env.REDIS_HOST || 'localhost',
  port:                  parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest:  1,           // fail fast so middleware can reject
  connectTimeout:        2000,
  commandTimeout:        1000,        // commands fail after 1s, not default 10s+
  enableOfflineQueue:    false,       // reject commands immediately when disconnected
  lazyConnect:           false,
  retryStrategy(times) {
    // Reconnect attempt every 1s, capped at 3s
    return Math.min(times * 1000, 3000);
  },
});

redis.on('error',   (err) => console.error('[redis] error:', err.message));
redis.on('connect', ()    => console.log('[redis] connected'));

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
// nosemgrep: javascript.express.security.audit.express-check-csurf-middleware-usage.express-check-csurf-middleware-usage
const app = express();
app.use(express.json());

const NODE_ID = process.env.NODE_ID || 'node-?';
const PORT    = parseInt(process.env.PORT || '3000', 10);

// Attach rate limiter to all API routes
const rateLimiter = createRateLimiter(redis);

// ── Health check — no rate limiting ─────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', node: NODE_ID });
});

// ── Main API route ───────────────────────────────────────────────────────────
// GET /api/v1/ping — the thin mock endpoint used in load tests
app.get('/api/v1/ping', rateLimiter, (req, res) => {
  res.json({
    message:     'pong',
    node:        NODE_ID,
    customer_id: req.headers['x-customer-id'],
    timestamp:   new Date().toISOString(),
  });
});

// ── Catch-all ────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[${NODE_ID}] listening on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log(`[${NODE_ID}] SIGTERM received — closing`);
  await redis.quit();
  process.exit(0);
});
