#!/usr/bin/env node
/**
 * RelayAPI Grace Period Harness (harness2.js)
 * ────────────────────────────────────────────
 * Real-time test of the batch → grace → normal transition.
 *
 * This harness sends a small burst of requests every 10 seconds and prints
 * a live status line showing:
 *   - Current UTC time
 *   - Rate-limit mode (batch-window / grace-period / normal)
 *   - Effective limit the server is applying
 *   - Allowed / rejected counts in that tick
 *
 * Config for harness-grace customer:
 *   batch window: 12:00–12:13 UTC   (limit 1500)
 *   grace period: 12:13–12:16 UTC   (limit ramps 1500 → 300)
 *   normal:       after 12:16 UTC   (limit 300)
 *
 * You should see:
 *   ✓ Before 12:13 UTC  → mode=batch-window, limit=1500, 0 rejections
 *   ✓ 12:13–12:16 UTC   → mode=grace-period, limit decreasing each tick, rejections start as limit < 720
 *   ✓ After 12:16 UTC   → mode=normal, limit=300, mixed allowed/rejected
 *
 * NOTE: Time is sourced from Redis (shared clock), not app node local time.
 *
 * Run time: ~8 minutes (start before 12:13 UTC, ends after 12:16 UTC)
 * Zero dependencies — pure Node.js stdlib.
 */

'use strict';

const http = require('http');

const BASE_URL    = process.env.BASE_URL    || 'http://localhost:8080';
const CUSTOMER_ID = 'harness-grace';
const TICK_MS     = 10_000;   // send a burst every 10 seconds
const BURST_SIZE  = 120;      // 120 req / 10s = 720 RPM. Within batch (1500), but over normal (300)
const RUN_MINUTES = 8;        // total run time

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
  bgYellow:'\x1b[43m\x1b[30m',
  bgMagenta:'\x1b[45m',
};

// Mode → colour
const MODE_STYLE = {
  'batch-window':  { bg: C.bgGreen,   label: 'BATCH  ' },
  'grace-period':  { bg: C.bgYellow,  label: 'GRACE  ' },
  'normal':        { bg: C.bgMagenta, label: 'NORMAL ' },
};

// ── HTTP helper ───────────────────────────────────────────────────────────────
function ping() {
  return new Promise((resolve) => {
    const url = new URL('/api/v1/ping', BASE_URL);
    const req = http.request({
      hostname: url.hostname,
      port:     url.port || 80,
      path:     url.pathname,
      method:   'GET',
      headers:  { 'X-Customer-Id': CUSTOMER_ID },
    }, (res) => {
      res.resume();
      resolve({
        status: res.statusCode,
        mode:   res.headers['x-ratelimit-mode']  || 'unknown',
        limit:  res.headers['x-ratelimit-limit'] || '?',
        remaining: res.headers['x-ratelimit-remaining'] || '?',
        node:   res.headers['x-served-by']       || '?',
      });
    });
    req.on('error', () => resolve({ status: 0, mode: 'error', limit: '?', remaining: '?', node: '?' }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ status: 0, mode: 'timeout', limit: '?', remaining: '?', node: '?' }); });
    req.end();
  });
}

// ── Burst ─────────────────────────────────────────────────────────────────────
async function burst(n) {
  return Promise.all(Array.from({ length: n }, () => ping()));
}

// ── Timeline bar ──────────────────────────────────────────────────────────────
function timelineBar(mode) {
  const s = MODE_STYLE[mode] || { bg: C.dim, label: mode.padEnd(7) };
  return `${s.bg}${C.bold} ${s.label} ${C.reset}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.cyan}${C.bold}`);
  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║       Grace Period Real-Time Test (harness2.js)         ║');
  console.log('  ╚══════════════════════════════════════════════════════════╝');
  console.log(C.reset);

  // Show the expected transition times
  console.log(`  ${C.bold}Customer      ${C.reset}: ${CUSTOMER_ID}`);
  console.log(`  ${C.bold}Target        ${C.reset}: ${BASE_URL}`);
  console.log(`  ${C.bold}Contracted RPM${C.reset}: 300`);
  console.log(`  ${C.bold}Batch RPM     ${C.reset}: 1500`);
  console.log(`  ${C.bold}Burst size    ${C.reset}: ${BURST_SIZE} req every ${TICK_MS / 1000}s`);
  console.log();
  console.log(`  ${C.bold}Expected transitions (UTC):${C.reset}`);
  console.log(`  ${C.green}  ■ BATCH ${C.reset}  until  12:13 UTC   (limit = 1500)`);
  console.log(`  ${C.yellow}  ■ GRACE ${C.reset}  12:13–12:16 UTC   (limit ramps 1500 → 300)`);
  console.log(`  ${C.magenta}  ■ NORMAL${C.reset}  after  12:16 UTC   (limit = 300)`);
  console.log(`  ${C.dim}  Time source: Redis (shared across all nodes)${C.reset}`);
  console.log();

  const nowUtc = new Date().toISOString().substring(11, 19);
  console.log(`  ${C.dim}Current UTC: ${nowUtc}${C.reset}`);
  console.log(`  ${C.dim}Run time: ~${RUN_MINUTES} minutes${C.reset}`);
  console.log();

  // Header
  console.log(`  ${C.bold}${'TIME (UTC)'.padEnd(12)} MODE      LIMIT   ALLOWED  REJECTED  REMAINING${C.reset}`);
  console.log(`  ${C.dim}${'─'.repeat(68)}${C.reset}`);

  const history = [];
  const totalTicks = Math.ceil((RUN_MINUTES * 60 * 1000) / TICK_MS);

  for (let tick = 0; tick < totalTicks; tick++) {
    const results = await burst(BURST_SIZE);

    const time    = new Date().toISOString().substring(11, 19);
    const allowed = results.filter(r => r.status === 200).length;
    const rejected= results.filter(r => r.status === 429).length;
    // Use the mode and limit from the first response (all should agree)
    const mode    = results[0]?.mode || 'unknown';
    const limit   = results[0]?.limit || '?';
    const remaining = results[0]?.remaining || '?';

    const modeBar = timelineBar(mode);

    const rejColor = rejected > 0 ? C.red : C.green;
    console.log(
      `  ${C.bold}${time}${C.reset}    ` +
      `${modeBar}  ` +
      `${C.bold}${String(limit).padStart(5)}${C.reset}   ` +
      `${C.green}${String(allowed).padStart(5)}${C.reset}    ` +
      `${rejColor}${String(rejected).padStart(5)}${C.reset}     ` +
      `${C.dim}${String(remaining).padStart(5)}${C.reset}`
    );

    history.push({ time, mode, limit: Number(limit), allowed, rejected });

    // Wait for next tick (unless last iteration)
    if (tick < totalTicks - 1) {
      await new Promise(r => setTimeout(r, TICK_MS));
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n  ${C.dim}${'─'.repeat(68)}${C.reset}`);
  console.log(`\n${C.bold}  Summary:${C.reset}\n`);

  // Group by mode
  const modes = {};
  for (const h of history) {
    if (!modes[h.mode]) modes[h.mode] = { ticks: 0, allowed: 0, rejected: 0, limits: [] };
    modes[h.mode].ticks++;
    modes[h.mode].allowed  += h.allowed;
    modes[h.mode].rejected += h.rejected;
    modes[h.mode].limits.push(h.limit);
  }

  for (const [mode, data] of Object.entries(modes)) {
    const minLimit = Math.min(...data.limits);
    const maxLimit = Math.max(...data.limits);
    const limitRange = minLimit === maxLimit ? `${minLimit}` : `${maxLimit} → ${minLimit}`;
    const modeBar = timelineBar(mode);
    console.log(`  ${modeBar}  ${data.ticks} ticks  |  limit: ${C.bold}${limitRange}${C.reset}  |  allowed: ${C.green}${data.allowed}${C.reset}  |  rejected: ${C.red}${data.rejected}${C.reset}`);
  }

  // Check if we saw all three modes
  const seenModes = Object.keys(modes);
  const sawBatch  = seenModes.includes('batch-window');
  const sawGrace  = seenModes.includes('grace-period');
  const sawNormal = seenModes.includes('normal');

  console.log();
  if (sawBatch && sawGrace && sawNormal) {
    console.log(`  ${C.bgGreen}${C.bold}  PASS  ${C.reset}  All three transitions observed: batch → grace → normal`);
  } else if (sawGrace) {
    console.log(`  ${C.bgYellow}${C.bold}  PARTIAL  ${C.reset}  Grace period observed but missed ${!sawBatch ? 'batch' : 'normal'} transition`);
    console.log(`  ${C.dim}  Try starting the harness earlier (before 18:00 UTC) or running longer${C.reset}`);
  } else {
    console.log(`  ${C.bgRed}${C.bold}  MISS  ${C.reset}  Did not observe grace period transition`);
    console.log(`  ${C.dim}  Modes seen: ${seenModes.join(', ')}${C.reset}`);
    console.log(`  ${C.dim}  Make sure to run this between ~17:55 and 18:05 UTC${C.reset}`);
  }

  // Grace limit ramp visualization
  if (sawGrace) {
    const graceEntries = history.filter(h => h.mode === 'grace-period');
    console.log(`\n  ${C.bold}Grace period limit ramp:${C.reset}`);
    for (const g of graceEntries) {
      const pct = ((g.limit - 300) / (1500 - 300) * 100).toFixed(0);
      const barLen = Math.round(g.limit / 1500 * 30);
      const barStr = C.yellow + '█'.repeat(barLen) + C.dim + '░'.repeat(30 - barLen) + C.reset;
      console.log(`    ${g.time}  ${barStr}  ${C.bold}${g.limit}${C.reset} RPM  (${pct}% above contracted)`);
    }
  }

  console.log();
}

main().catch((err) => {
  console.error(`\n${C.red}Harness2 crashed:${C.reset}`, err.message);
  process.exit(1);
});
