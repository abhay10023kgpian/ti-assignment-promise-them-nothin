# RelayAPI — Rate Limiter Solution

A distributed, per-customer rate limiter running on three stateless app nodes behind a round-robin load balancer. Redis provides shared sliding-window state; when Redis fails, nodes degrade to local split-quota counters with a circuit breaker.

---

## Quick start

**Prerequisites:** Docker Desktop (or Docker Engine + Compose plugin). Nothing else.

```bash
cd solution/
docker compose up --build
```

Wait for all three nodes to log `listening on port 3000`. Takes about 30 seconds.

---

## What's running

| Service | Container | Port | Purpose |
| ------- | --------- | ---- | ------- |
| Nginx LB | `relay-nginx` | **:8080** | Round-robin entry point — **use this for all testing** |
| App node 1 | `relay-app1` | :3001 | Direct access for per-node debugging |
| App node 2 | `relay-app2` | :3002 | Direct access for per-node debugging |
| App node 3 | `relay-app3` | :3003 | Direct access for per-node debugging |
| Redis | `relay-redis` | :6379 | Shared sliding-window state |

---

## Customers and quotas

Defined in [`app/src/config/customers.json`](app/src/config/customers.json). Config-driven — no customer-specific code paths.

| Customer ID | Name | Tier | RPM | Batch window |
| ----------- | ---- | ---- | --- | ------------ |
| `customer-alpha` | Customer Alpha | starter | 100 | — |
| `customer-beta` | Customer Beta | starter | 100 | — |
| `northwind` | Northwind Logistics | enterprise | 300 | 02:00–04:00 UTC → 1500 RPM, 5-min grace ramp-down |

Northwind's batch window is config, not code. Any customer with a `batch_window` field gets the same three-regime logic.

---

## Smoke test

```bash
# Should get pong from a node (note headers)
curl -i -H "X-Customer-Id: customer-alpha" http://localhost:8080/api/v1/ping

# Response headers you care about:
#   X-RateLimit-Limit: 100
#   X-RateLimit-Remaining: 99
#   X-RateLimit-Window: 60s
#   X-RateLimit-Mode: normal
#   X-Served-By: node-1
```

---

## Run the harness

Two harnesses ship with the solution. Both are first-class deliverables.

### `harness.js` — boundary verification (10 scenarios)

Drives the service at quota boundaries and reports pass/fail. Runs in about 30 seconds.

```bash
cd harness/
node harness.js
```

**What it proves:**

| Scenario | What it tests |
| -------- | ------------- |
| Sc1–3 | Under, at, and over quota for a starter customer |
| Sc4 | Customer isolation — A's spike does not consume B's budget |
| Sc5 | Node distribution — aggregate count is correct across all three nodes |
| Sc6 | Northwind under contract (200 req, 300 RPM limit) |
| Sc7 | Northwind over contract, outside batch window (400 req, 300 RPM limit) |
| Sc8 | Northwind batch — under elevated ceiling (1100 req, 1500 RPM limit) |
| Sc9 | Northwind batch — over elevated ceiling (1700 req, 1500 RPM limit) — **contract renewal data** |
| Sc10 | Batch isolation — Northwind at 1200 RPM + another customer at 80 RPM, concurrent |

### `harness2.js` — real-time grace period and fallback test

Sends steady traffic (120 req every 10 seconds) over ~8 minutes. Shows mode transitions live.

```bash
cd harness/
node harness2.js
```

**What it proves:**

| Transition | What you see |
| ---------- | ------------ |
| `BATCH → GRACE` | Limit ramps from 1500 → 300 linearly over grace period |
| `GRACE → NORMAL` | Clean switch to contracted limit, no 429 cliff |
| `NORMAL → local-fallback` | Run `docker stop relay-redis` during the test — mode switches instantly, rate limiting continues with split quota |
| `local-fallback → NORMAL` | Run `docker start relay-redis` — recovers automatically, no restart needed |

> **Note:** `harness2.js` has hardcoded transition times tied to the `harness-grace` customer's batch window config. Before running, update the `end_utc` field in `customers.json` so the batch window ends ~3 minutes after you plan to start the harness. The README comments in harness2.js explain the exact setup.

---

## Algorithm

**Sliding window counter** backed by a Redis sorted set.

- Every allowed request is stored as a member with score = arrival timestamp (ms).
- On each request: evict members older than 60 000 ms, count remaining, allow or reject.
- The entire check-and-increment runs in a single **Lua script** — atomic on the Redis server, no TOCTOU race across nodes.
- Time is sourced from Redis via the `TIME` command — all nodes share one clock.

### Three regimes (Northwind and any batch-window customer)

```
 02:00           04:00        04:05          next day
   │─── BATCH ────│── GRACE ──│── NORMAL ────│
   │  limit=1500  │  1500→300 │  limit=300   │
   │  key=:batch  │ key=:batch│  key=:normal │
```

Separate Redis keys per regime prevent the "429 cliff" where old high-rate entries cause immediate rejections after the batch window closes. The grace period ramp-down is linear and shares the batch key so sliding-window memory is continuous.

### Graceful degradation

When Redis is unreachable:

1. **Circuit breaker opens** — Redis is skipped entirely for 5 seconds (no per-request timeout penalty).
2. **Local fallback activates** — each node runs an in-memory sliding window with `limit / NODE_COUNT` as its budget.
3. **Auto-recovery** — when Redis comes back, the next request detects it and closes the circuit breaker.

Error direction during fallback: **over-limiting** (a few extra rejections) rather than under-limiting. Consistent with Priya's directive.

---

## Response headers

Every response includes observability headers:

| Header | Example | Meaning |
| ------ | ------- | ------- |
| `X-RateLimit-Limit` | `300` | Effective limit for this request |
| `X-RateLimit-Remaining` | `157` | Remaining budget in current window |
| `X-RateLimit-Window` | `60s` | Sliding window duration |
| `X-RateLimit-Contracted` | `300` | Customer's contracted RPM (may differ from effective during batch) |
| `X-RateLimit-Mode` | `normal` | Active regime: `normal`, `batch-window`, `grace-period`, or `local-fallback` |
| `X-Served-By` | `node-2` | Which app node handled this request |
| `Retry-After` | `12` | Seconds until budget resets (only on 429) |

---

## Inspect Redis state directly

```bash
# Count entries in a customer's sorted set
docker exec relay-redis redis-cli ZCARD "rl:customer-alpha"

# See all entries with timestamps
docker exec relay-redis redis-cli ZRANGE "rl:customer-alpha" 0 -1 WITHSCORES

# Check Redis server time (authoritative clock for all nodes)
docker exec relay-redis redis-cli TIME
```

---

## File map

```
solution/
├── docker-compose.yml          # 3 app nodes + Redis + Nginx LB
├── nginx/
│   └── nginx.conf              # Round-robin upstream config
├── app/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js            # Express app, Redis client, routes
│       ├── config/
│       │   └── customers.json  # All customer configs (tiers, batch windows)
│       └── middleware/
│           └── rateLimiter.js  # Sliding window + batch regimes + local fallback
├── harness/
│   ├── harness.js              # 10-scenario boundary verification
│   └── harness2.js             # Real-time grace period + fallback test
└── harness_result.txt          # Captured output from both harnesses
```

---

## Stop

```bash
docker compose down
```
