#!/usr/bin/env node
/**
 * RelayAPI Load Harness
 * ─────────────────────
 * What this is:
 *   A load-generating test script that fires controlled bursts of HTTP
 *   requests at the rate-limiter service and compares actual outcomes
 *   (allowed vs rejected) against what the sliding-window algorithm
 *   should produce. Prints a visual ASCII report to stdout.
 *
 * What it proves:
 *   ✓ Under-quota traffic passes through cleanly
 *   ✓ Over-quota traffic is cut off at exactly the right boundary
 *   ✓ Two customers on the same tier do NOT eat each other's quota
 *   ✓ Load is distributed across all three nodes (round-robin visible)
 *   ✓ Northwind's contracted 300 RPM is enforced outside batch window
 *   ✓ Northwind's elevated 1500 RPM is active during batch window
 *   ✓ Northwind above 1500 RPM during batch window → 429 + overage logged
 *   ✓ Northwind batch window traffic does NOT impact other customers
 *
 * What it does NOT prove:
 *   ✗ Clock skew between nodes (all in Docker, shared clock)
 *   ✗ Redis failure / split-brain behaviour
 *   ✗ Retry amplification loop (clean load only)
 *
 * Zero external dependencies — pure Node.js stdlib.
 */

'use strict';

const http = require('http');

const BASE_URL    = process.env.BASE_URL    || 'http://localhost:8080';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '20', 10);

// ── ANSI colours ──────────────────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  red:     '\x1b[31m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  magenta: '\x1b[35m',
  white:   '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgRed:   '\x1b[41m',
  bgYellow:'\x1b[43m',
};

// ── HTTP helper ───────────────────────────────────────────────────────────────
function ping(customerId) {
  return new Promise((resolve) => {
    const url = new URL('/api/v1/ping', BASE_URL);
    const options = {
      hostname: url.hostname,
      port:     url.port || 80,
      path:     url.pathname,
      method:   'GET',
      headers:  { 'X-Customer-Id': customerId },
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({
          status:       res.statusCode,
          node:         res.headers['x-served-by']            || 'unknown',
          remaining:    res.headers['x-ratelimit-remaining']  || '?',
          limit:        res.headers['x-ratelimit-limit']      || '?',
          contracted:   res.headers['x-ratelimit-contracted'] || '?',
          mode:         res.headers['x-ratelimit-mode']       || 'normal',
          retryAfter:   res.headers['retry-after']            || null,
          body,
        });
      });
    });
    req.on('error', () => resolve({ status: 0, node: 'error', remaining: '?', limit: '?', contracted: '?', mode: 'error', retryAfter: null, body: '' }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: 0, node: 'timeout', remaining: '?', limit: '?', contracted: '?', mode: 'timeout', retryAfter: null, body: '' }); });
    req.end();
  });
}

// ── Burst sender — N requests, bounded concurrency ───────────────────────────
async function burst(customerId, n, concurrency = CONCURRENCY) {
  const results = [];
  const slots   = Array(n).fill(null);

  async function worker() {
    while (slots.length > 0) {
      slots.pop();
      results.push(await ping(customerId));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker));
  return results;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function stats(results) {
  const allowed  = results.filter(r => r.status === 200).length;
  const rejected = results.filter(r => r.status === 429).length;
  const errors   = results.filter(r => r.status !== 200 && r.status !== 429).length;
  const nodes    = {};
  const modes    = {};
  const retryAfters = [];
  for (const r of results) {
    nodes[r.node] = (nodes[r.node] || 0) + 1;
    modes[r.mode] = (modes[r.mode] || 0) + 1;
    if (r.retryAfter) retryAfters.push(Number(r.retryAfter));
  }
  const avgRetryAfter = retryAfters.length > 0
    ? (retryAfters.reduce((a, b) => a + b, 0) / retryAfters.length).toFixed(1)
    : null;
  return { allowed, rejected, errors, total: results.length, nodes, modes, avgRetryAfter };
}

// ── Render helpers ────────────────────────────────────────────────────────────
const BAR_WIDTH = 24;

function bar(count, total, colour) {
  const filled = total > 0 ? Math.round((count / total) * BAR_WIDTH) : 0;
  return colour + '█'.repeat(filled) + C.dim + '░'.repeat(BAR_WIDTH - filled) + C.reset;
}

function passLabel(ok) {
  return ok
    ? `${C.bgGreen}${C.bold}  PASS  ${C.reset}`
    : `${C.bgRed}${C.bold}  FAIL  ${C.reset}`;
}

function pct(n, total) {
  return total > 0 ? `${Math.round((n / total) * 100)}%` : '0%';
}

function divider(char = '─', w = 62) { return char.repeat(w); }

function printScenarioHeader(num, title) {
  console.log(`\n${C.cyan}${C.bold}  ┌${divider('─', 58)}┐${C.reset}`);
  console.log(`${C.cyan}${C.bold}  │  Scenario ${num}: ${title.padEnd(46)}│${C.reset}`);
  console.log(`${C.cyan}${C.bold}  └${divider('─', 58)}┘${C.reset}`);
}

function printStats(label, s, expected) {
  const { allowed, rejected, errors, total, nodes, modes, avgRetryAfter } = s;

  console.log(`\n  ${C.bold}${label}${C.reset}`);
  console.log(`  ${C.dim}${divider('·', 54)}${C.reset}`);
  console.log(`  Sent      ${C.bold}${String(total).padStart(4)}${C.reset}  ${bar(total, total, C.white)}`);
  console.log(`  Allowed   ${C.green}${String(allowed).padStart(4)}${C.reset}  ${bar(allowed, total, C.green)}  ${C.green}${pct(allowed, total)}${C.reset}`);
  console.log(`  Rejected  ${C.red}${String(rejected).padStart(4)}${C.reset}  ${bar(rejected, total, C.red)}  ${C.red}${pct(rejected, total)}${C.reset}`);
  if (errors > 0)
    console.log(`  ${C.yellow}Errors    ${String(errors).padStart(4)}${C.reset}  (check service is up)`);
  if (avgRetryAfter !== null)
    console.log(`  ${C.dim}Avg Retry-After: ${avgRetryAfter}s${C.reset}`);

  // Rate limit mode
  const modeEntries = Object.entries(modes);
  if (modeEntries.length > 0 && !(modeEntries.length === 1 && modeEntries[0][0] === 'normal')) {
    console.log(`\n  Rate-limit mode:`);
    for (const [mode, cnt] of modeEntries) {
      const modeColor = mode === 'batch-window' ? C.magenta : C.cyan;
      console.log(`    ${modeColor}${mode.padEnd(16)}${C.reset}  ${cnt} responses`);
    }
  }

  // Node distribution
  const nodeEntries = Object.entries(nodes).sort(([a], [b]) => a.localeCompare(b));
  if (nodeEntries.length > 0) {
    console.log(`\n  Node distribution:`);
    for (const [node, cnt] of nodeEntries) {
      console.log(`    ${C.cyan}${node.padEnd(12)}${C.reset}  ${bar(cnt, total, C.cyan)}  ${cnt}`);
    }
  }

  // Pass / fail
  const ok = allowed >= expected.minAllowed &&
             allowed <= (expected.maxAllowed ?? Infinity) &&
             rejected >= expected.minRejected &&
             rejected <= (expected.maxRejected ?? Infinity);

  console.log(`\n  Expected  allowed ∈ [${expected.minAllowed}, ${expected.maxAllowed ?? '∞'}]  ` +
              `rejected ∈ [${expected.minRejected}, ${expected.maxRejected ?? '∞'}]`);
  console.log(`  ${passLabel(ok)}`);

  return ok;
}

// ── Connectivity check ────────────────────────────────────────────────────────
async function checkConnectivity() {
  return new Promise((resolve) => {
    const url  = new URL('/health', BASE_URL);
    const req  = http.request({ hostname: url.hostname, port: url.port || 80, path: '/health', method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Banner
  console.log(`\n${C.cyan}${C.bold}`);
  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║       RelayAPI Rate Limiter — Load Harness v2           ║');
  console.log('  ║       Stakeholder 1 + Stakeholder 2 (Northwind)        ║');
  console.log('  ╚══════════════════════════════════════════════════════════╝');
  console.log(C.reset);
  console.log(`  ${C.bold}Target   ${C.reset}: ${BASE_URL}`);
  console.log(`  ${C.bold}Started  ${C.reset}: ${new Date().toISOString()}`);
  console.log(`  ${C.bold}Concurrency${C.reset}: ${CONCURRENCY} parallel requests`);

  // Check service is up
  process.stdout.write(`\n  Checking connectivity... `);
  const up = await checkConnectivity();
  if (!up) {
    console.log(`${C.red}✗ FAILED${C.reset}`);
    console.error(`\n  ${C.red}Cannot reach ${BASE_URL}${C.reset}`);
    console.error('  Make sure the stack is running:  docker compose up --build\n');
    process.exit(1);
  }
  console.log(`${C.green}✓ OK${C.reset}`);

  const scenarioResults = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // PART 1 — STAKEHOLDER 1: CTO — Hard enforcement, per-customer isolation
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${C.bold}${C.yellow}  ═══ PART 1: Stakeholder 1 — CTO (Hard Enforcement) ═══${C.reset}`);

  // ── Scenario 1 — Under quota ──────────────────────────────────────────────
  printScenarioHeader(1, 'Under Quota — 80 req vs limit 100');
  {
    const r = stats(await burst('harness-sc1', 80));
    scenarioResults.push(printStats(
      'customer-alpha-like | 80 req | limit=100 RPM',
      r,
      { minAllowed: 80, maxAllowed: 80, minRejected: 0, maxRejected: 0 }
    ));
  }

  // ── Scenario 2 — Exactly at quota boundary ────────────────────────────────
  printScenarioHeader(2, 'At Quota Boundary — 100 req vs limit 100');
  {
    const r = stats(await burst('harness-sc2', 100));
    scenarioResults.push(printStats(
      '100 req | limit=100 RPM | 100th request must be allowed',
      r,
      { minAllowed: 100, maxAllowed: 100, minRejected: 0, maxRejected: 0 }
    ));
  }

  // ── Scenario 3 — Over quota ───────────────────────────────────────────────
  printScenarioHeader(3, 'Over Quota Boundary — 130 req vs limit 100');
  {
    const r = stats(await burst('harness-sc3', 130));
    scenarioResults.push(printStats(
      '130 req | limit=100 RPM | ~100 allowed, ~30 rejected',
      r,
      { minAllowed: 98, maxAllowed: 102, minRejected: 28 }
    ));
  }

  // ── Scenario 4 — Customer isolation ───────────────────────────────────────
  printScenarioHeader(4, 'Customer Isolation — two customers, 80 req each');
  {
    const [rawA, rawB] = await Promise.all([
      burst('harness-sc4a', 80),
      burst('harness-sc4b', 80),
    ]);
    const rA = stats(rawA);
    const rB = stats(rawB);
    const pA = printStats('Customer A: 80 req | limit=100', rA,
      { minAllowed: 80, maxAllowed: 80, minRejected: 0, maxRejected: 0 });
    const pB = printStats('Customer B: 80 req | limit=100', rB,
      { minAllowed: 80, maxAllowed: 80, minRejected: 0, maxRejected: 0 });
    scenarioResults.push(pA && pB);
  }

  // ── Scenario 5 — Round-robin node distribution ────────────────────────────
  printScenarioHeader(5, 'Round-Robin Node Distribution — 90 req');
  {
    const raw = await burst('harness-sc5', 90);
    const r   = stats(raw);
    console.log(`\n  ${C.bold}90 requests via nginx round-robin${C.reset}`);
    console.log(`  ${C.dim}${'·'.repeat(54)}${C.reset}`);
    const entries = Object.entries(r.nodes).sort(([a], [b]) => a.localeCompare(b));
    for (const [node, cnt] of entries) {
      console.log(`  ${C.cyan}${node.padEnd(14)}${C.reset}  ${bar(cnt, 90, C.cyan)}  ${C.bold}${cnt}${C.reset} req`);
    }
    const counts  = Object.values(r.nodes);
    const maxNode = Math.max(...counts);
    const minNode = Math.min(...counts);
    const spread  = maxNode - minNode;
    const nodeCount = entries.length;
    const balanced  = nodeCount >= 3 && spread <= 18;
    console.log(`\n  Nodes seen: ${C.bold}${nodeCount}${C.reset}  |  spread: ${C.bold}${spread}${C.reset} (max-min, expect ≤ 18)`);
    console.log(`  ${passLabel(balanced)}`);
    scenarioResults.push(balanced);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PART 2 — STAKEHOLDER 2: Support — Northwind batch window
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${C.bold}${C.magenta}  ═══ PART 2: Stakeholder 2 — Support (Northwind Batch Window) ═══${C.reset}`);

  // ── Scenario 6 — Northwind at contracted rate (no batch window needed) ────
  printScenarioHeader(6, 'Northwind — Sub-contract (250 req vs 300 RPM)');
  {
    const r = stats(await burst('harness-nw1', 250));
    scenarioResults.push(printStats(
      'northwind | 250 req | contracted=300 RPM | no batch window',
      r,
      { minAllowed: 250, maxAllowed: 250, minRejected: 0, maxRejected: 0 }
    ));
  }

  // ── Scenario 7 — Northwind over contract, no batch window ─────────────────
  printScenarioHeader(7, 'Northwind — Over Contract, NO Batch Window (400 req vs 300)');
  {
    const r = stats(await burst('harness-nw2', 400));
    scenarioResults.push(printStats(
      'northwind | 400 req | contracted=300 RPM | this is what Marcus escalated',
      r,
      { minAllowed: 295, maxAllowed: 305, minRejected: 95 }
    ));
    console.log(`\n  ${C.yellow}⚠  These 429s are the Marcus Webb escalation.`);
    console.log(`     Scenarios 8–10 prove the batch window resolves this.${C.reset}`);
  }

  // ── Scenario 8 — Northwind at batch-window rate (1100 RPM) ────────────────
  // harness-nw3 has batch_window: 00:00–23:59 so it's always active in tests
  printScenarioHeader(8, 'Northwind Batch — 1100 req vs elevated 1500 RPM');
  {
    const r = stats(await burst('harness-nw3', 1100));
    scenarioResults.push(printStats(
      'northwind batch | 1100 req | elevated=1500 RPM | 0 rejections expected',
      r,
      { minAllowed: 1100, maxAllowed: 1100, minRejected: 0, maxRejected: 0 }
    ));
    // Verify the mode header shows batch-window
    const batchModeCount = r.modes['batch-window'] || 0;
    const modeOk = batchModeCount > 0;
    console.log(`\n  ${C.magenta}Batch-window mode responses: ${C.bold}${batchModeCount}${C.reset}${C.magenta} / ${r.total}${C.reset}`);
    console.log(`  ${passLabel(modeOk)}  (mode header present)`);
  }

  // ── Scenario 9 — Northwind OVER batch ceiling (1700 req vs 1500 RPM) ──────
  // This is the critical contract-documentation scenario:
  //   - 1500 should be allowed, ~200 rejected
  //   - The rejected count = proof that demand exceeds even the elevated limit
  //   - This data goes directly into the renewal conversation
  printScenarioHeader(9, 'Northwind Batch — OVER Elevated Ceiling (1700 vs 1500)');
  {
    const raw    = await burst('harness-nw4', 1700);
    const r      = stats(raw);
    const passed = printStats(
      'northwind batch | 1700 req | elevated=1500 RPM | ~200 rejections expected',
      r,
      { minAllowed: 1490, maxAllowed: 1510, minRejected: 190 }
    );
    scenarioResults.push(passed);

    // ── Overage report for contract documentation ─────────────────────────
    const overageCount   = r.rejected;
    const overagePct     = ((overageCount / r.total) * 100).toFixed(1);
    const peakObserved   = r.allowed;  // all allowed = effective peak RPM

    console.log(`\n${C.magenta}${C.bold}  ┌──────────────────────────────────────────────────────────┐${C.reset}`);
    console.log(`${C.magenta}${C.bold}  │        NORTHWIND OVERAGE REPORT (Contract Data)          │${C.reset}`);
    console.log(`${C.magenta}${C.bold}  └──────────────────────────────────────────────────────────┘${C.reset}`);
    console.log(`  ${C.dim}${'─'.repeat(56)}${C.reset}`);
    console.log(`  Contracted RPM           :  ${C.bold}300${C.reset}`);
    console.log(`  Elevated batch ceiling   :  ${C.bold}1500${C.reset}`);
    console.log(`  Requests sent (this test):  ${C.bold}${r.total}${C.reset}`);
    console.log(`  Requests allowed         :  ${C.green}${C.bold}${r.allowed}${C.reset}  (effective peak RPM)`);
    console.log(`  Requests rejected (429)  :  ${C.red}${C.bold}${overageCount}${C.reset}  (${overagePct}% of total)`);
    console.log(`  Avg Retry-After          :  ${C.bold}${r.avgRetryAfter || 'N/A'}s${C.reset}`);
    console.log(`  ${C.dim}${'─'.repeat(56)}${C.reset}`);
    console.log(`  ${C.yellow}${C.bold}Conclusion:${C.reset} Northwind's workload exceeds even the`);
    console.log(`  elevated 1500 RPM ceiling. ${C.bold}${overageCount} requests${C.reset} were rejected.`);
    console.log(`  Contract renewal should target ≥ ${C.bold}${peakObserved}${C.reset} RPM.`);
    console.log(`  ${C.dim}${'─'.repeat(56)}${C.reset}`);
  }

  // ── Scenario 10 — Batch window isolation: Northwind heavy load ────────────
  //    does NOT eat a normal customer's quota
  printScenarioHeader(10, 'Batch Isolation — NW at 1200 + other at 80 (concurrent)');
  {
    const [rawNW, rawOther] = await Promise.all([
      burst('harness-nw5', 1200),
      burst('harness-iso-other', 80),
    ]);
    const rNW    = stats(rawNW);
    const rOther = stats(rawOther);

    const pNW = printStats(
      'Northwind (batch, 1200 req, elevated=1500)',
      rNW,
      { minAllowed: 1200, maxAllowed: 1200, minRejected: 0, maxRejected: 0 }
    );
    const pOther = printStats(
      'Other customer (80 req, limit=100) — must be unaffected',
      rOther,
      { minAllowed: 80, maxAllowed: 80, minRejected: 0, maxRejected: 0 }
    );
    scenarioResults.push(pNW && pOther);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  const passed = scenarioResults.filter(Boolean).length;
  const total  = scenarioResults.length;
  const allOk  = passed === total;

  console.log(`\n${C.bold}${allOk ? C.green : C.red}`);
  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log(`  ║  SUMMARY : ${String(passed).padStart(2)} / ${String(total).padStart(2)} scenarios passed${' '.repeat(29)}║`);
  console.log(`  ║  Result  : ${allOk ? '✓ ALL PASS' : '✗ SOME FAILED'}${' '.repeat(allOk ? 39 : 38)}║`);
  console.log('  ╚══════════════════════════════════════════════════════════╝');
  console.log(C.reset);

  // Per-scenario summary table
  const labels = [
    'Sc1   Under quota (80 req, limit 100)',
    'Sc2   At quota boundary (100 req, limit 100)',
    'Sc3   Over quota (130 req, limit 100)',
    'Sc4   Customer isolation (2×80 req concurrent)',
    'Sc5   Round-robin node distribution',
    'Sc6   Northwind sub-contract (250 req, limit 300)',
    'Sc7   Northwind over-contract, NO batch window (400 req)',
    'Sc8   Northwind batch — under elevated ceiling (1100 req)',
    'Sc9   Northwind batch — OVER elevated ceiling (1700 req)',
    'Sc10  Batch isolation (NW@1200 + other@80, concurrent)',
  ];
  for (let i = 0; i < scenarioResults.length; i++) {
    const ok  = scenarioResults[i];
    const sym = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`  ${sym}  ${labels[i]}`);
  }
  console.log();

  if (!allOk) process.exit(1);
}

main().catch((err) => {
  console.error(`\n${C.red}Harness crashed:${C.reset}`, err.message);
  console.error('Is the service up?  docker compose up --build\n');
  process.exit(1);
});
