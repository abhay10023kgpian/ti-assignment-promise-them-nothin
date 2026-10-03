# Grace Period, Edge Cases & Redis Time

> **Session summary:** Identified the 429 cliff at batch window boundaries. Implemented three-regime system (batch/grace/normal) with separate Redis keys and linear ramp-down. Built harness2.js for real-time testing. Switched all time to Redis TIME command for stateless clock.

---

## 🧑 User — 2026-10-02T17:21:08Z

Now we have a minimum working model, lets think of possible edge cases, one of that i guess is , since these are shared nodes they must be sharing all the same states including time, another can be since job batch would have some request outside the 2 to 4 window with greater than 300 rpm, we need to smoothly increase and decrease between 1500, 300, am i correct also tell me how industry approaches this problem

---

## 🤖 Agent — 2026-10-02T17:21:09Z

Great edge cases. Let me address both precisely.

---

## Edge Case 1: Shared Time Across Nodes

**You're right that Docker nodes share the host clock — so this isn't a problem in our setup.** But in production:

| Layer | What happens | Risk |
|---|---|---|
| **Redis counter** | Single source of truth — all nodes read/write the same sorted set | ✅ No inconsistency |
| **Timestamp in Lua script** | `Date.now()` is generated on the **app node**, then sent to Redis as an argument | ⚠️ If nodes have clock skew, the same "real moment" produces different timestamps |
| **Batch window check** | `resolveLimit()` runs on the **app node**, using the node's local clock | ⚠️ Node-1 at 03:59:59 applies 1500 RPM, node-2 at 04:00:01 applies 300 RPM |

The counter itself is consistent (Redis). The **limit applied to the counter** could differ for a few milliseconds around the window boundary if clocks are skewed. With NTP, typical skew is <100ms — so the risk is real but tiny. Our `DECISIONS.md` already calls this out as "not proved."

---

## Edge Case 2: The Hard Cutover Cliff — You're Absolutely Right

This is the **serious one**. Here's exactly what happens with our current code at 04:00 UTC:

```
03:59:30  Northwind at 1000 RPM → limit=1500 → ✅ all pass
03:59:59  sliding window has ~1000 entries from last 60s
04:00:00  resolveLimit() switches to limit=300
04:00:00  sliding window STILL has ~1000 entries (they haven't aged out)
04:00:00  count(1000) >= limit(300) → 429 ❌ EVERY request rejected
04:00:30  entries from 03:59:30 age out → count drops to ~500 → still 429
04:01:00  entries from 04:00:00 and earlier fully aged out → count=0 → OK
```

**Northwind gets a ~60 second 429 storm at exactly 04:00** — the very thing Marcus escalated about. The batch window ends, but the sliding window still remembers the high-rate traffic.

---

## How Industry Solves This

### 1. **Separate rate-limit keys per regime** (most common)

Used by Stripe, Cloudflare rate-limit rules:

```
During batch window:  key = "rl:northwind:batch"   limit = 1500
Outside window:       key = "rl:northwind:normal"   limit = 300
```

When the window ends at 04:00, the `batch` key has 1000 entries but **nobody checks it anymore**. The `normal` key starts fresh at 0. No cliff. The batch key expires naturally via Redis TTL.

**Tradeoff:** During the first 60 seconds after the window ends, Northwind effectively gets a "free" 300 RPM even if they were at 1000 RPM a second earlier. The CTO might dislike this — but it's the same as any customer who was idle for a minute and then starts sending.

### 2. **Grace period / linear ramp-down**

Used by AWS API Gateway (conceptually — they separate burst vs sustained):

```
04:00–04:05 (grace):  limit = 1500 → linearly decreasing → 300
04:05 onward:         limit = 300
```

**Tradeoff:** More complex config, more code. But smoother UX.

### 3. **Drain approach** (Google Cloud Endpoints style)

At window end, stop filling the bucket at the elevated rate but don't reject requests already "in flight." Essentially, the refill rate drops but the existing tokens remain.

This maps to token bucket, not sliding window — so it doesn't apply to our algorithm.

---

## What I Recommend for This Assignment

**Option 1 (separate keys)** — it's the simplest, most correct, and what the industry predominantly does:

```javascript
// In resolveLimit():
if (inBatchWindow) {
  return { limit: bw.rpm, key: `rl:${customerId}:batch`, inBatchWindow: true };
} else {
  return { limit: customer.rpm, key: `rl:${customerId}:normal`, inBatchWindow: false };
}
```

At 04:00:00, the middleware switches to the `:normal` key which has **zero entries** → Northwind gets their full 300 RPM immediately. The `:batch` key expires in 65 seconds via `PEXPIRE`.

Want me to implement this fix now? It's a small change — just the key selection logic in `resolveLimit()` and using the returned key in the middleware instead of hardcoding `rl:${customerId}`.

---

## 🧑 User — 2026-10-02T17:35:57Z

since it is a strict no to 429, we cant take a chance, so use the grace period method used by aws api gateway-which i also suggested.

---

## 🤖 Agent — 2026-10-02T17:35:58Z

Good call. Let me implement the grace period with separate Redis keys per regime to fully eliminate the cliff.

<details><summary>Tool calls (1)</summary>

- `view_file`

</details>

---

## 🤖 Agent — 2026-10-02T17:36:48Z

Now I'll rewrite `resolveLimit()` with three regimes — **batch window → grace period (linear ramp-down) → normal** — plus separate Redis keys per regime to eliminate the sliding window cliff:

<details><summary>Tool calls (1)</summary>

- `replace_file_content`

</details>

---

## 🤖 Agent — 2026-10-02T17:37:46Z

Now update the response headers and logging to use `mode` instead of `inBatchWindow`:

<details><summary>Tool calls (1)</summary>

- `view_file`

</details>

---

## 🤖 Agent — 2026-10-02T17:37:53Z



<details><summary>Tool calls (1)</summary>

- `replace_file_content`

</details>

---

## 🤖 Agent — 2026-10-02T17:38:14Z

Now update the config to include `grace_minutes`:

<details><summary>Tool calls (1)</summary>

- `multi_replace_file_content`

</details>

---

## 🤖 Agent — 2026-10-02T17:38:27Z

Now update `DECISIONS.md` to document the grace period:

<details><summary>Tool calls (1)</summary>

- `view_file`

</details>

---

## 🤖 Agent — 2026-10-02T17:38:32Z



<details><summary>Tool calls (1)</summary>

- `replace_file_content`

</details>

---

## 🤖 Agent — 2026-10-02T17:38:52Z

Now rebuild and verify:

<details><summary>Tool calls (1)</summary>

- `run_command`

</details>

---

## 🤖 Agent — 2026-10-02T17:39:15Z

While the build runs, here's a summary of what was implemented:

---

### The Three Regimes

```
 02:00           04:00        04:05          next day
   │─── BATCH ────│── GRACE ──│── NORMAL ────│
   │  limit=1500  │  1500→300 │  limit=300   │
   │  key=:batch  │  key=:batch│  key=:normal │
   │              │  (ramp ↓) │  (fresh key) │
```

| Time | Limit | Redis Key | Why |
|---|---|---|---|
| 02:00–04:00 | 1500 RPM | `rl:northwind:batch` | Elevated for batch job |
| 04:00–04:05 | 1500 → 300 linear | `rl:northwind:batch` | Smooth ramp-down, shares batch key so sliding window is continuous |
| 04:05+ | 300 RPM | `rl:northwind` | Fresh key — batch key entries don't cause cliff |

### Why this prevents the cliff

| Problem | How it's solved |
|---|---|
| At 04:00, window has ~1000 entries from batch | Grace period starts at limit=1500, so 1000 < 1500 → no 429 |
| Over 5 minutes, old entries age out (60s TTL) | Limit ramps down proportionally → always stays above the natural drain rate |
| At 04:05, any remaining batch entries in key | Switch to fresh `:normal` key with count=0 → clean start at 300 RPM |

### Files changed

| File | What |
|---|---|
| [`rateLimiter.js`](file:///c:/Users/abhay/Desktop/WEB%20dev/Projects/RelayAPI-rate_limiter/solution/app/src/middleware/rateLimiter.js) | `resolveLimit()` now returns `{ limit, key, mode }` with three regimes |
| [`customers.json`](file:///c:/Users/abhay/Desktop/WEB%20dev/Projects/RelayAPI-rate_limiter/solution/app/src/config/customers.json) | Added `grace_minutes: 5` to all batch window configs |
| [`DECISIONS.md`](file:///c:/Users/abhay/Desktop/WEB%20dev/Projects/RelayAPI-rate_limiter/DECISIONS.md) | Documented the cliff problem, separate-key solution, and linear ramp-down |

Once the build finishes, run `node harness.js` from `solution\harness\` to verify all 10 scenarios still pass.

---

## 🤖 Agent — 2026-10-02T17:39:42Z

Stack is up — all images rebuilt and containers started. You can run the harness now:

```powershell
cd solution\harness
node harness.js
```

---

## 🧑 User — 2026-10-02T17:46:34Z

how would we even check the script, since the time is of redis' so we cant configure that right?
we can try a temporary time of right now to check small saperate harness (say harness2.js), run for 5-7 minutes for realistic workload. this approach feels good to test grace period

---

## 🤖 Agent — 2026-10-02T17:46:35Z

Great idea. The time check happens on the **app node** (`Date.now()` in `resolveLimit()`), not in Redis — so we can absolutely control it by setting a batch window that ends soon.

Here's the plan: I'll add a test customer with a batch window ending at **18:00 UTC (23:30 IST)** with 3-minute grace, and write `harness2.js` that sends steady traffic every 10 seconds for ~8 minutes, printing a live status line each tick showing the mode transition in real time.

<details><summary>Tool calls (1)</summary>

- `view_file`

</details>

---

## 🤖 Agent — 2026-10-02T17:47:31Z



<details><summary>Tool calls (1)</summary>

- `replace_file_content`

</details>

---

## 🤖 Agent — 2026-10-02T17:47:46Z

Now create `harness2.js` — a real-time grace period observer:

<details><summary>Tool calls (1)</summary>

- `write_to_file`

</details>

---

## 🤖 Agent — 2026-10-02T17:48:38Z

Now rebuild to pick up the new customer:

<details><summary>Tool calls (1)</summary>

- `run_command`

</details>

---

## 🤖 Agent — 2026-10-02T17:48:59Z

While it builds, here's what to expect:

---

### `harness-grace` customer config

```
Batch window:  17:00 – 18:00 UTC   (limit = 1500 RPM)
Grace period:  18:00 – 18:03 UTC   (limit ramps 1500 → 300 linearly)
Normal:        after 18:03 UTC     (limit = 300 RPM)
```

In IST:
| Phase | IST time | Limit |
|---|---|---|
| **BATCH** | until **23:30 IST** | 1500 |
| **GRACE** | **23:30 – 23:33 IST** | 1500 → 300 ramp |
| **NORMAL** | after **23:33 IST** | 300 |

### What you'll see

Each row is one 10-second tick showing: UTC time, mode badge, effective limit, allowed/rejected counts. The grace period ticks will show the limit **decreasing** in real time:

```
17:59:50    BATCH   1500       15        0
18:00:00    GRACE   1500       15        0     ← just switched
18:00:10    GRACE   1420       15        0     ← limit dropping
18:00:30    GRACE   1200       15        0
18:01:00    GRACE    900       15        0
18:02:00    GRACE    500       15        0
18:03:00    NORMAL   300       15        0     ← contracted limit
```

### How to run (once Docker is up)

```powershell
cd solution\harness
node harness2.js
```

**Start it before 23:30 IST** to catch the batch → grace transition. It runs for 8 minutes automatically.

---

## 🤖 Agent — 2026-10-02T17:49:25Z

Stack is up. You have about **10 minutes** before the 18:00 UTC transition. Run it now:

```powershell
cd solution\harness
node harness2.js
```

---

## 🧑 User — 2026-10-02T18:05:55Z

in short tell me what is the allowed 15 number in this harness2 console,   TIME (UTC)   MODE      LIMIT   ALLOWED  REJECTED  REMAINING
  ────────────────────────────────────────────────────────────────────        
  18:02:04     GRACE       680      15        0       673
  18:02:14     GRACE       607      15        0       590

---

## 🤖 Agent — 2026-10-02T18:05:56Z

The `15` in the **ALLOWED** column is the number of requests that successfully passed (received a `200 OK` response) during that specific 10-second tick. 

In `harness2.js`, we set `BURST_SIZE = 15`. This means every 10 seconds, the script fires exactly 15 concurrent requests to simulate a small, steady trickle of traffic. 

Since `15` were allowed and `0` were rejected, it means all 15 requests in that burst successfully made it through the rate limiter without hitting the ceiling, even as the limit was actively ramping down from 680 to 607.

---

## 🧑 User — 2026-10-02T23:24:53Z

now first make time to be stateless by shared redis time - I will test harness2 again

---

## 🤖 Agent — 2026-10-02T23:24:54Z

Good call — using Redis `TIME` as the single time source eliminates clock skew between nodes entirely.

<details><summary>Tool calls (1)</summary>

- `view_file`

</details>

---

## 🤖 Agent — 2026-10-02T23:25:40Z



<details><summary>Tool calls (1)</summary>

- `view_file`

</details>

---

## 🤖 Agent — 2026-10-02T23:25:49Z



<details><summary>Tool calls (1)</summary>

- `view_file`

</details>

---

## 🤖 Agent — 2026-10-02T23:26:01Z

Now I'll make two changes: (1) `resolveLimit()` accepts a `Date` parameter instead of creating its own, and (2) the middleware fetches time from Redis via `redis.time()` and passes it everywhere:

<details><summary>Tool calls (1)</summary>

- `multi_replace_file_content`

</details>

---

## 🤖 Agent — 2026-10-02T23:26:36Z

Now fix the overage log `new Date(now)` reference to use `nowMs`:

<details><summary>Tool calls (1)</summary>

- `view_file`

</details>

---

## 🤖 Agent — 2026-10-02T23:26:44Z



<details><summary>Tool calls (1)</summary>

- `view_file`

</details>

---

## 🤖 Agent — 2026-10-02T23:26:52Z



<details><summary>Tool calls (1)</summary>

- `replace_file_content`

</details>

---

## 🤖 Agent — 2026-10-02T23:27:02Z

Now update the harness-grace customer times for your current session. Current time is 04:54 IST = 23:24 UTC. I'll set the batch window to end at **23:35 UTC (05:05 IST)** to give you time to rebuild and start:

<details><summary>Tool calls (1)</summary>

- `replace_file_content`

</details>

---

## 🤖 Agent — 2026-10-02T23:27:20Z

Now update `harness2.js` display strings to match:

<details><summary>Tool calls (1)</summary>

- `view_file`

</details>

---

## 🤖 Agent — 2026-10-02T23:27:29Z



<details><summary>Tool calls (1)</summary>

- `view_file`

</details>

---

## 🤖 Agent — 2026-10-02T23:27:36Z



<details><summary>Tool calls (1)</summary>

- `multi_replace_file_content`

</details>

---

## 🤖 Agent — 2026-10-02T23:28:01Z

Now rebuild:

<details><summary>Tool calls (1)</summary>

- `run_command`

</details>

---

## 🤖 Agent — 2026-10-02T23:32:41Z

While Docker rebuilds, here's a summary:

---

### What changed: `Date.now()` → `redis.time()`

**Before** (each node uses its own clock):
```
Node-1: Date.now() → 04:00:00.050   →  resolveLimit uses 04:00
Node-2: Date.now() → 03:59:59.980   →  resolveLimit uses 03:59
Node-3: Date.now() → 04:00:00.120   →  resolveLimit uses 04:00
// Three nodes, two different limits at the same real moment
```

**After** (all nodes ask Redis):
```
Node-1: redis.time() → 04:00:00.015   →  resolveLimit uses 04:00
Node-2: redis.time() → 04:00:00.015   →  resolveLimit uses 04:00
Node-3: redis.time() → 04:00:00.015   →  resolveLimit uses 04:00
// Single source of truth — all nodes agree
```

The same Redis timestamp is also used for the Lua sliding window script (`nowMs`), so the counter entries and the window resolution are fully consistent.

### Transition times for this test

| Phase | UTC | IST |
|---|---|---|
| **BATCH** | until **23:35** | until **05:05** |
| **GRACE** | **23:35 – 23:38** | **05:05 – 05:08** |
| **NORMAL** | after **23:38** | after **05:08** |

Start `node harness2.js` before **05:05 IST** to catch the full transition. You have ~7 minutes after Docker is up.

---

## 🤖 Agent — 2026-10-02T23:33:18Z

Stack is up! Quick sanity check to confirm Redis time is working:

<details><summary>Tool calls (1)</summary>

- `run_command`

</details>

---

## 🤖 Agent — 2026-10-02T23:33:33Z

Working perfectly:
- `X-RateLimit-Mode: batch-window` ✅ (we're before 23:35 UTC)
- `X-RateLimit-Limit: 1500` ✅ (elevated batch RPM)
- `X-RateLimit-Contracted: 300` ✅ (shows the real contract for reference)

Current UTC is ~23:33. The transition to **GRACE** happens at **23:35 UTC (05:05 IST)** — about **2 minutes from now**. Run it now:

```powershell
node harness2.js
```

from `solution\harness\` — you'll catch the full batch → grace → normal transition live.

---

