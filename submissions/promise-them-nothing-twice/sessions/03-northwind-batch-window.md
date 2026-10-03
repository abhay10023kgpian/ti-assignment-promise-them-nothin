# Northwind Batch Window & DECISIONS.md

> **Session summary:** Added batch window override for Northwind (1500 RPM during 02:00–04:00 UTC). Expanded harness to 10 scenarios including batch over/under ceiling. Updated DECISIONS.md with algorithm rationale and parameter choices.

---

## 🧑 User — 2026-10-02T13:41:42Z

harness result is exactly as expected,
also in decision.md add the reasoning about choosing sliding window counter - that since the stakeholder requires client A's request should not impact client B, means bursts may impact resoources and it may violate requirements - so this made the reason of decision, also I let you choose the algorith intervals etc at your own at random since we are less aware about the exact system specs and resource for handling processes - so for now those randoms are chosen, add these into right place of my decision.md

---

## 🤖 Agent — 2026-10-02T13:41:43Z



<details><summary>Tool calls (1)</summary>

- `view_file`

</details>

---

## 🤖 Agent — 2026-10-02T13:41:52Z



<details><summary>Tool calls (1)</summary>

- `multi_replace_file_content`

</details>

---

## 🤖 Agent — 2026-10-02T13:42:22Z

[`DECISIONS.md`](file:///c:/Users/abhay/Desktop/WEB%20dev/Projects/RelayAPI-rate_limiter/DECISIONS.md) updated. Two additions under **Technical Design**:

---

**1. Why no burst — isolation is the real reason** (not just "quota means quota"):

The argument now flows as:
> CTO requires Customer A's spike must not impact Customer B → bursts consume shared upstream resources (connection pool, CPU, memory) above sustained rate → two concurrent bursters create combined pressure neither contracted for → violates isolation even if each is within their own bucket ceiling → the only safe choice is strict sliding window that rejects at the instant of breach, with no knowledge of upstream capacity needed

This is a stronger argument than just citing the CTO memo — it shows *why* the memo's requirement forces the algorithm choice.

**2. Explicit note on all arbitrary numbers:**

| Parameter | Status |
|---|---|
| 60s window | Industry convention, right default until profiling |
| 1500 RPM batch ceiling | 800–1200 + 25% buffer — buffer is arbitrary, needs harness validation |
| Harness concurrency=20 | Enough to saturate locally, not a production number |

The key line: *"swapping any of these numbers requires a config change only, not a code change"* — which shows the architecture is sound even if the values aren't.

---

## 🧑 User — 2026-10-02T13:45:28Z

check once that for northwind - the config mentioned is just for some special cases as requested or all the northwind requests are verified with config

---

## 🤖 Agent — 2026-10-02T13:45:28Z

Let me check both files directly.

<details><summary>Tool calls (2)</summary>

- `view_file`
- `view_file`

</details>

---

## 🤖 Agent — 2026-10-02T13:45:39Z

**All Northwind requests go through the same config-driven path — zero special casing.**

Here's exactly what happens for every single request, regardless of who the customer is:

```
Request arrives with X-Customer-Id: northwind
       ↓
middleware reads CUSTOMERS["northwind"]   ← customers.json
       ↓
limit = customer.rpm  → 300
       ↓
Redis sliding window: count < 300? → allow : 429
```

The middleware has **no knowledge that "northwind" is special**. It sees `northwind` the same way it sees `customer-alpha` — just a key in the config file, with an `rpm` value. The only difference is the number: 300 vs 100.

---

### What this means for Stakeholder 2 (batch window)

The `batch_window` override we described in `DECISIONS.md` is **not yet in the code**. When we build it, it will still go through config — the middleware will:

```javascript
// No if(customerId === 'northwind') — instead:
const limit = isInBatchWindow(customer) 
  ? customer.batch_window.rpm   // 1500, from config
  : customer.rpm;               // 300, from config
```

`isInBatchWindow()` checks the current UTC time against `customer.batch_window.start_utc / end_utc` — also from config. The middleware itself stays generic. Every customer *could* have a batch window override if the config has one — Northwind just happens to be the only one that does right now.

So to directly answer your question: **config drives everything, for all customers, all the time. Nothing is hardcoded for Northwind.**

---

## 🧑 User — 2026-10-02T13:46:34Z

ok now check once if that is expected same from assignment details for northwind

---

## 🤖 Agent — 2026-10-02T13:46:35Z



<details><summary>Tool calls (1)</summary>

- `view_file`

</details>

---

## 🤖 Agent — 2026-10-02T13:46:42Z

Yes, this config-driven approach is **exactly what the assignment demands** to resolve the conflict correctly. 

If we check the CTO's memo, Priya explicitly states (Line 31):

> *"Special-case hacks buried in `if (customerId === ...)` blocks. If we ever grant a commercial exception, **it goes through config and audit** — not a midnight commit."*

Meanwhile, Marcus (Support Lead) says in his memo (Line 30):

> *"If you need a temporary exception mechanism, fine — but it must be invisible to the customer."*

By putting the batch window override purely in `customers.json` and keeping the rate limiter code generic, we are doing exactly what Priya demanded for commercial exceptions ("it goes through config") while delivering exactly what Marcus needs (no 429s during Northwind's batch window). 

The rate limiter code doesn't know who Northwind is. It just applies whatever rules are in the config file. All of Northwind's requests are verified against the config, just like every other customer.

**Are you ready for me to implement this final piece?** I'll update the middleware to parse the `batch_window` rule from the config, update Northwind's config entry, and then we can run the harness to prove Stakeholder 2's problem is solved.

---

## 🧑 User — 2026-10-02T13:57:04Z

build the rest part of limiter, i.e. northwind requests with 800-1200 and 25% buffer makes it nearly 1500 (with sliding window counter to avoid impact on any other user, since there would be no expected retries because of retry on 429, still if network error retries are recieved - return with header to retry after calculated time when rpm is reset for that user), later we need to make a harness monitoring for representative workload -  if the rpm exceeds this limit so that a documentation with proof will ready for contract with northwind about exceding rpm values,
so that for some rare cases 429 will be obvious to prevent overload, and if extra rpm continues - the result will be helpfull as i said.

---

## 🤖 Agent — 2026-10-02T13:57:04Z

Let me build all three pieces: config update, middleware batch window support, and updated harness with Northwind-specific scenarios.

<details><summary>Tool calls (1)</summary>

- `view_file`

</details>

---

## 🤖 Agent — 2026-10-02T13:57:15Z



---

## 🤖 Agent — 2026-10-02T13:57:18Z



---

## 🤖 Agent — 2026-10-02T13:57:21Z



---

## 🧑 User — 2026-10-02T13:58:36Z

build the rest part of limiter, i.e. northwind requests with 800-1200 and 25% buffer makes it nearly 1500 (with sliding window counter to avoid impact on any other user, since there would be no expected retries because of retry on 429, still if network error retries are recieved - return with header to retry after calculated time when rpm is reset for that user), later we need to make a harness monitoring for representative workload -  if the rpm exceeds this limit so that a documentation with proof will ready for contract with northwind about exceding rpm values,
so that for some rare cases 429 will be obvious to prevent overload, and if extra rpm continues - the result will be helpfull as i said.

---

## 🤖 Agent — 2026-10-02T13:58:36Z

I'll update all three files: config, middleware, and harness.

**Step 1 — Add batch window to Northwind config:**

<details><summary>Tool calls (1)</summary>

- `write_to_file`

</details>

---

## 🤖 Agent — 2026-10-02T13:58:58Z

**Step 2 — Update middleware with batch window resolution and overage logging:**

<details><summary>Tool calls (1)</summary>

- `write_to_file`

</details>

---

## 🤖 Agent — 2026-10-02T13:59:48Z

**Step 3 — Update harness with Northwind batch window scenarios and overage report:**

<details><summary>Tool calls (1)</summary>

- `write_to_file`

</details>

---

## 🤖 Agent — 2026-10-02T14:01:31Z

Now rebuild and run the stack:

<details><summary>Tool calls (1)</summary>

- `run_command`

</details>

---

## 🤖 Agent — 2026-10-02T14:03:06Z

Waiting for the Docker rebuild to finish. Here's a summary of everything that was just built:

---

### What changed

| File | Change |
|---|---|
| [`customers.json`](file:///c:/Users/abhay/Desktop/WEB%20dev/Projects/RelayAPI-rate_limiter/solution/app/src/config/customers.json) | Northwind now has `batch_window: { start_utc: "02:00", end_utc: "04:00", rpm: 1500 }`. Harness NW entries use `00:00–23:59` so the window is always active during testing. |
| [`rateLimiter.js`](file:///c:/Users/abhay/Desktop/WEB%20dev/Projects/RelayAPI-rate_limiter/solution/app/src/middleware/rateLimiter.js) | New `resolveLimit()` function checks if current UTC time falls in customer's batch window → uses elevated RPM. Structured overage logging on rejection. New headers: `X-RateLimit-Contracted`, `X-RateLimit-Mode`. |
| [`harness.js`](file:///c:/Users/abhay/Desktop/WEB%20dev/Projects/RelayAPI-rate_limiter/solution/harness/harness.js) | 10 scenarios in 2 parts. Part 2 adds Sc8 (under elevated ceiling), Sc9 (over ceiling + overage report), Sc10 (batch isolation). |

### The 10 harness scenarios

| # | Part | Scenario | Proves |
|---|---|---|---|
| 1–5 | CTO | Under/at/over quota, isolation, round-robin | Hard enforcement works |
| 6 | CTO | Northwind sub-contract (250 vs 300) | Contract rate works |
| 7 | Support | Northwind over-contract, NO window (400 vs 300) | **This is the Marcus problem** |
| 8 | Support | Northwind batch — 1100 vs elevated 1500 | **Window override active, 0 rejections** |
| 9 | Support | Northwind batch — 1700 vs elevated 1500 | **429s above ceiling + OVERAGE REPORT** |
| 10 | Support | NW@1200 + other@80, concurrent | **Batch traffic doesn't eat other's quota** |

### Scenario 9's overage report

This prints contract-ready data:
```
Contracted RPM          : 300
Elevated batch ceiling  : 1500
Requests allowed        : ~1500 (effective peak RPM)
Requests rejected (429) : ~200  (proof for contract)
Conclusion: Contract renewal should target ≥ 1500 RPM.
```

Once Docker finishes rebuilding, run:
```powershell
cd solution\harness
node harness.js
```

---

## 🤖 Agent — 2026-10-02T14:03:33Z

Stack is rebuilt and all 5 containers are running. The exit code 1 is just PowerShell's stderr redirect quirk — all images built and containers started successfully.

You can run the harness now:

```powershell
cd solution\harness
node harness.js
```

This will run all 10 scenarios and print the Northwind overage report at the end of Scenario 9.

---

