# DECISIONS.md — Promise Them Nothing Twice

## Conflict Resolution

**The conflict:** Priya (CTO) requires hard 429 enforcement when any customer exceeds their contracted RPM. Marcus (Support) requires Northwind to never see a 429 during their nightly batch window (02:00–04:00 UTC).

**What I decided:**

Northwind gets a **config-driven elevated quota** of 1500 RPM, active only during the 02:00–04:00 UTC window. Outside that window their contracted 300 RPM limit is enforced with hard 429s. Above 1500 RPM even during the window, 429s fire and all overage events are logged.

This satisfies Marcus (no 429s at Northwind's observed 800–1200 RPM natural load) while satisfying Priya (there is a defined hard limit, it is enforced, it is config-driven, and it is fully auditable — no `if (customerId === ...)` in the code path).

**What I rejected:**

- **Silently processing all Northwind traffic without a ceiling** — breaks auditability and makes contract renegotiation impossible because you have no data to negotiate with.
- **Queuing excess requests** — the actual service type and upstream latency SLAs are not documented in the briefs. Queuing introduces latency that may be unacceptable. No infra capacity numbers exist to size a queue. Noted as future work.
- **Overcharge/burst billing** — explicitly ruled out by the CTO for v1 ("no 'we'll bill you extra' path").
- **Hardcoded customer bypass** — explicitly forbidden by Priya ("no special-case hacks buried in if-blocks").
- **Caching upstream responses to absorb retries** — the upstream is a mock endpoint; caching is meaningless here. In production, a short-TTL idempotency cache keyed on (customerId, requestFingerprint) is the right tool for retry storms caused by non-429 errors. Cached hits should not consume quota. Out of scope for this slice.

**Why the elevated limit is 1500 RPM:**

Platform context states Northwind's observed batch load is 800–1200 RPM. The documented retry amplification is entirely caused by 429s being fired. With 429s eliminated during the batch window, true demand settles at the natural ERP pace — peak ~1200 RPM. 1500 RPM gives ~25% headroom while keeping a real, enforceable ceiling. The harness captures observed peak RPM for use in contract renewal.

---

## Technical Design

**Algorithm: Sliding Window Counter (Redis-backed)**

A fixed window counter creates a well-known boundary vulnerability: 300 requests at xx:59 + 300 at xx:00 = 600 requests in two seconds, both windows technically clean. Unacceptable for metered billing.

A sliding window counter tracks a rolling 60-second lookback. At any moment, the count reflects actual requests in the last 60 seconds — no boundary spikes.

**Why no burst allowance — and why customer isolation is the deciding reason:**

The CTO requires per-customer isolation: Customer A's traffic spike must not affect Customer B. This requirement is what makes burst-tolerant algorithms (token bucket, leaky bucket) unsuitable — not just the quota semantics.

When a customer is allowed to burst, they consume upstream resources (connection pool slots, CPU, memory on app nodes) at a rate higher than their sustained quota. If two customers burst simultaneously, the shared upstream absorbs a combined spike that neither contracted for individually. Even if each customer's burst is technically within their own token bucket ceiling, the combined resource pressure can degrade service for both — violating the isolation requirement. The only way to guarantee isolation is to prevent burst at the infrastructure level, not just count it. A strict sliding window that refuses the request the moment the count hits the limit is the only algorithm that does this correctly without knowledge of upstream capacity.

A token bucket would allow bursting up to the bucket ceiling before settling to the refill rate — a 300 RPM customer could fire 600 requests in the first second. Rejected for the isolation reason above, and because the CTO's memo is explicit: quota means quota.

**Distributed coordination:**

All three nodes write to a single shared Redis counter per customer. Redis ZADD + ZREMRANGEBYSCORE + ZCOUNT in a single Lua script gives atomic sliding window check-and-increment. No node-local state. A node restart loses nothing.

Error direction: if Redis is unavailable, the middleware fails closed (reject the request) — consistent with the CTO's preference for under-limiting over over-limiting.

**Customer identity:** X-Customer-Id header, trusted from the API gateway as documented.

**Batch window override:** Stored in customers.json as a structured field — batch_window: { start_utc: "02:00", end_utc: "04:00", rpm: 1500, grace_minutes: 5 }. No customer-specific branches in middleware logic.

**Grace period — preventing the 429 cliff at window boundaries:**

A naive implementation would switch from 1500 RPM to 300 RPM at exactly 04:00. But the sliding window still holds ~1000 entries from the last 60 seconds of batch traffic. With a 300 limit and 1000 entries, every request gets 429'd for up to 60 seconds — the exact sudden rejection storm Marcus escalated about.

The solution has two parts:

1. **Separate Redis keys per regime.** Batch/grace traffic counts against `rl:<id>:batch`; normal traffic counts against `rl:<id>`. When the grace period ends, the middleware switches to the normal key which has zero entries — no cliff. The batch key expires naturally via Redis TTL.

2. **Linear ramp-down during grace period.** For 5 minutes after the batch window ends (04:00–04:05), the effective limit linearly interpolates from 1500 → 300. This gives Northwind's ERP time to wind down naturally rather than hitting a wall. The grace period shares the batch key so the sliding window memory is continuous — the ramp accounts for recent batch traffic correctly.

The three regimes:
- **02:00–04:00 (batch):** limit = 1500, key = `rl:northwind:batch`
- **04:00–04:05 (grace):** limit ramps 1500 → 300 linearly, key = `rl:northwind:batch`
- **04:05+ (normal):** limit = 300, key = `rl:northwind` (fresh, 0 entries)

**On the choice of specific numeric parameters:**

Several parameters in this implementation — the 60-second window size, the 1500 RPM batch ceiling, the 25% headroom buffer, the harness concurrency of 20 parallel workers — were chosen without access to real system specifications (upstream latency SLAs, server memory, connection pool sizes, network throughput). These numbers are reasonable defaults, not engineered values.

- **60-second window:** Standard industry convention for RPM metering. A shorter window (e.g. 10s) would be more responsive but requires the harness to pace requests over real time rather than burst-testing; a longer window compounds Redis sorted set size. 60s is the right default until load profiling says otherwise.
- **1500 RPM batch ceiling:** Derived from the documented 800–1200 RPM natural Northwind load plus a ~25% buffer. The buffer percentage is arbitrary — it should be validated against actual harness telemetry once the batch window override is implemented and the retry amplification loop is removed from the equation.
- **Harness concurrency (20):** Chosen to saturate the rate limiter quickly in testing without overwhelming a local Docker network. Not a production sizing number.

These values should be treated as placeholders pending real capacity data. The architecture does not assume them — swapping any of these numbers requires a config change only, not a code change.

---

## Verification

**What the harness proves:**

| Scenario | Expected | Verifies |
|---|---|---|
| Northwind at 1100 RPM during batch window | 0 rejections | Window override active and sufficient |
| Northwind at 1600 RPM during batch window | Rejections above 1500 threshold | Hard ceiling still enforced during window |
| Northwind at 400 RPM outside batch window | Rejections above 300 threshold | Contracted quota enforced outside window |
| Two customers on 300 RPM, one spikes to 600 | Spiker gets 429s, other unaffected | Per-customer isolation holds |
| Same load split across 3 nodes | Aggregate count correct, not per-node | Distributed coordination works |
| Harness output: peak RPM observed in batch | Captured in report table | Data for contract renewal |

**What the harness does not prove:**

- Clock skew between nodes affecting sliding window boundaries (mitigated: all time sourced from Redis).
- Northwind's retry amplification factor (we model clean load only).
- Upstream capacity under the elevated 1500 RPM load — infra specs undocumented.

---

## Graceful Degradation (Local Fallback)

**What it does:** When Redis is unreachable, each node falls back to an in-memory sliding window counter with split quota: `limit / NODE_COUNT` per node. A circuit breaker prevents repeated failed Redis calls — after one failure, Redis is skipped entirely for 5 seconds before retrying.

**What the harness proved (harness2.js with `docker stop relay-redis`):**
- Redis mode → local-fallback transition: instant (one tick delay at most)
- Rate limiting continues during Redis outage with per-node split quota
- Redis recovery detected automatically — mode switches back without restart

**Known tradeoff — transition overshoot:**

When the local counter activates, it starts at count = 0 regardless of what the customer had consumed in Redis. This means a customer who was already at their Redis limit gets a brief "free" window of up to `limit / NODE_COUNT` additional requests per node (e.g., 100 extra with 300 RPM / 3 nodes).

This overshoot is:
- **Bounded:** max `ceil(limit / NODE_COUNT)` extra requests per node, one time
- **Brief:** one sliding window cycle (~10 seconds) until the local counter fills
- **Rare:** only occurs at the exact moment of Redis failure
- **Error direction:** under-limiting (allowing extra) — not the CTO's preferred direction, but the alternative during an outage is 503 for everyone

To fix this, each node could cache the last known Redis count per customer and seed the local counter with `cachedCount / NODE_COUNT`. This was not implemented because: the local counter uses a timestamp array (not a simple count), seeding requires synthetic entries, the cached count may be stale, and the overshoot is bounded to a single transition event during an already-exceptional outage. Documented here as a known gap.

---

## If I Had Four More Hours

- **Queuing for batch overflow:** If service type is confirmed idempotent (read-heavy logistics queries), a bounded queue could absorb bursts above 1500 RPM and drain them at rate rather than 429-ing. Requires upstream latency SLAs and capacity numbers currently unknown.
- **Idempotency cache:** Short-TTL response cache for safe endpoints — retries served without hitting upstream or consuming quota.
- **Redis HA:** Sentinel or cluster — local fallback handles outages gracefully but Redis remains the primary path and a SPOF for accurate global counts.
- **Seed local fallback from cached Redis state:** Cache last-known count per customer on each successful Redis call; on fallback activation, pre-fill the local counter to eliminate the transition overshoot. Bounded complexity but would close the under-limiting gap.
- **Peer-to-peer node heartbeats for fallback accuracy:** If an app node crashes *while* Redis is already down, its share of the local split-quota is lost (e.g. 3 nodes down to 2, but remaining nodes still only allow limit/3). Nodes could gossip their health state to dynamically recalculate the divisor (`limit / activeNodes`) to restrict overuse while maintaining accurate global counts during extended dual-outage scenarios.
- **Overage report endpoint:** GET /admin/overage-report returning Northwind's batch window usage over the last N days, formatted for the commercial renewal conversation.
- **Dynamic config reload** without restart, so the batch window limit can be adjusted live during renewal negotiation.
