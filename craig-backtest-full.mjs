#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// craig-backtest-full.mjs — Full 5-Symbol Portfolio Backtest
//
// Tests EVERY live-bot symbol with its exact production config:
//   BTC-USD  : 1h  EMA50/200 regime  →  15m BOS/CHOCH execution
//   ETH-USD  : 30m EMA50/200 regime  →   5m BOS/CHOCH execution  (30m agg from 5m)
//   SOL-USD  : 30m EMA50/200 regime  →   5m BOS/CHOCH execution  (30m agg from 5m)
//   LINK-USD : 30m EMA50/200 regime  →   5m BOS/CHOCH execution  (30m agg from 5m)
//   PEPE-USD :  4h EMA50/200 regime  →   5m BOS/CHOCH execution  (4h agg from 1h)
//
// Usage:  node craig-backtest-full.mjs [lookbackDays]
//   e.g.  node craig-backtest-full.mjs 90
//
// Data: Coinbase Exchange public API (no auth required)
// ═══════════════════════════════════════════════════════════════════════════

import { writeFileSync } from "fs";

// ── Strategy constants (exact match to live bot) ──────────────────────────────
const EMA_FAST      = 50;
const EMA_SLOW      = 200;
const SWING_LB      = 5;
const WARMUP        = SWING_LB * 2 + 2;
const INITIAL_CAP   = 100;
const MIN_ORDER_USD = 1.00;
const MIN_ORDER_QTY = 1e-8;
const REQUIRE_BOS_BEFORE_CHOCH = true;
const CHOCH_CONTINUE_SCALE     = true;

const DEFAULT_BUY_LADDER  = [15, 15, 15, 15];  // flat-15  — optimal for BTC/ETH/SOL
const DEFAULT_SELL_LADDER = [5, 10, 20, 40];   // back-steep — optimal for BTC/ETH/SOL

const LOOKBACK_DAYS = parseInt(process.argv[2] ?? "90", 10);

// ── Symbol configs — mirror SYMBOL_CONFIG in craig-accumulation-bot.mjs ──────
// execFetch.gran   : Coinbase Exchange granularity in seconds (300, 900, 3600…)
// regimeFetch.gran : null  → aggregate exec bars to regimeMs
//                    int   → fetch separate bars at this granularity
// regimeFetch.days : extra days beyond LOOKBACK for EMA200 warmup
//   (EMA200 warmup = 200 regime bars × regime hours / 24; round up generously)
const CONFIGS = [
  {
    sym: "BTC-USD",
    execLabel: "15m", regimeLabel: "1h",
    execFetch:   { gran: 900,  days: LOOKBACK_DAYS + 3   },
    regimeFetch: { gran: 3600, days: LOOKBACK_DAYS + 12  },  // 200 × 1h / 24 ≈ 9d → use 12
    regimeMs:    3_600_000,
    regimeFromExec: false,
    buyLadder:  DEFAULT_BUY_LADDER,
    sellLadder: DEFAULT_SELL_LADDER,
  },
  {
    sym: "ETH-USD",
    execLabel: "5m", regimeLabel: "30m",
    execFetch:   { gran: 300, days: LOOKBACK_DAYS + 6    },  // share data; 200 × 30m / 24 ≈ 4d → use 6
    regimeFetch: null,                                         // aggregate from exec bars
    regimeMs:    1_800_000,
    regimeFromExec: true,
    buyLadder:  DEFAULT_BUY_LADDER,
    sellLadder: DEFAULT_SELL_LADDER,
  },
  {
    sym: "SOL-USD",
    execLabel: "5m", regimeLabel: "30m",
    execFetch:   { gran: 300, days: LOOKBACK_DAYS + 6    },
    regimeFetch: null,
    regimeMs:    1_800_000,
    regimeFromExec: true,
    buyLadder:  DEFAULT_BUY_LADDER,
    sellLadder: DEFAULT_SELL_LADDER,
  },
  {
    sym: "LINK-USD",
    execLabel: "5m", regimeLabel: "30m",
    execFetch:   { gran: 300, days: LOOKBACK_DAYS + 6    },
    regimeFetch: null,
    regimeMs:    1_800_000,
    regimeFromExec: true,
    buyLadder:  DEFAULT_BUY_LADDER,
    sellLadder: [33, 33, 33, 33],  // flat-33 — LINK oscillates; uniform beats backloaded
  },
  {
    sym: "PEPE-USD",
    execLabel: "5m", regimeLabel: "4h",
    execFetch:   { gran: 300,  days: LOOKBACK_DAYS + 3   },  // exec needs minimal warmup
    regimeFetch: { gran: 3600, days: LOOKBACK_DAYS + 40  },  // 200 × 4h / 24 ≈ 33d → use 40; fetch 1h, agg to 4h
    regimeMs:    14_400_000,
    regimeFromExec: false,
    regimeAggFromSecs: 3600,   // 1h bars → 4h aggregate (not native on Coinbase Exchange)
    buyLadder:  [33, 33, 33, 33],  // flat-33 — uniform accumulation
    sellLadder: [30, 25, 20, 10],  // front-steep — PEPE spikes front-loaded
  },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Data fetch (Coinbase Exchange public) ─────────────────────────────────────
// Supported granularities: 60, 300, 900, 3600, 21600, 86400 seconds
async function fetchAllBars(symbol, granSec, totalDays, label) {
  const cutoff   = Date.now() - totalDays * 86_400_000;
  const windowMs = 300 * granSec * 1000;   // 300 bars per page
  const bars     = [];
  let   endMs    = Date.now();
  process.stdout.write(`  Fetching ${label} (${totalDays}d)`);
  let errors = 0;

  while (endMs > cutoff) {
    const startMs = Math.max(endMs - windowMs, cutoff);
    const url = `https://api.exchange.coinbase.com/products/${symbol}/candles` +
      `?granularity=${granSec}&start=${Math.floor(startMs / 1000)}&end=${Math.floor(endMs / 1000)}`;
    try {
      const res  = await fetch(url, { headers: { "User-Agent": "craig-backtest/2.0" },
                                      signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error(`Unexpected response`);
      if (data.length) {
        bars.unshift(...data.map(k => ({
          t: +k[0] * 1000, l: +k[1], h: +k[2], o: +k[3], c: +k[4], v: +k[5],
        })));
      }
      endMs = startMs - granSec * 1000;
      process.stdout.write(".");
      errors = 0;
    } catch (e) {
      process.stdout.write("!");
      if (++errors >= 5) { console.error(`\n  ✗ Too many errors fetching ${label}: ${e.message}`); break; }
      await sleep(2000);
      continue;
    }
    await sleep(130);
  }

  const seen = new Set();
  const result = bars
    .filter(b => { if (seen.has(b.t)) return false; seen.add(b.t); return true; })
    .sort((a, b) => a.t - b.t);
  console.log(` → ${result.length} bars`);
  return result;
}

// ── Candle aggregation ────────────────────────────────────────────────────────
function aggregateBars(bars, targetMs) {
  const buckets = new Map();
  for (const b of bars) {
    const k = Math.floor(b.t / targetMs) * targetMs;
    if (!buckets.has(k)) {
      buckets.set(k, { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 });
    } else {
      const agg = buckets.get(k);
      agg.h  = Math.max(agg.h, b.h);
      agg.l  = Math.min(agg.l, b.l);
      agg.c  = b.c;
      agg.v += b.v ?? 0;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

// ── EMA ───────────────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  const out = new Array(closes.length).fill(null);
  const k   = 2 / (period + 1);
  let sum = 0, count = 0;
  for (let i = 0; i < closes.length; i++) {
    if (count < period) {
      sum += closes[i]; count++;
      if (count === period) out[i] = sum / period;
    } else {
      out[i] = closes[i] * k + out[i - 1] * (1 - k);
    }
  }
  return out;
}

// ── Regime map builder (matches buildRegime in live bot) ──────────────────────
function buildRegimeMaps(candles, regimeMs) {
  const closes   = candles.map(c => c.c);
  const emaF     = calcEMA(closes, EMA_FAST);
  const emaS     = calcEMA(closes, EMA_SLOW);
  const crossMap = new Map();
  const stateMap = new Map();
  for (let i = 1; i < candles.length; i++) {
    const ef = emaF[i], es = emaS[i], efP = emaF[i - 1], esP = emaS[i - 1];
    if (!ef || !es || !efP || !esP) continue;
    const ct = candles[i].t + regimeMs;   // key = close time of this regime bar
    stateMap.set(ct, ef > es ? "golden" : "death");
    if      (efP <= esP && ef > es) crossMap.set(ct, "golden");
    else if (efP >= esP && ef < es) crossMap.set(ct, "death");
  }
  return { crossMap, stateMap };
}

// ── Core simulation (matches processSymbol logic in live bot) ─────────────────
function runSim(cfg, execBars, regimeBars) {
  const { regimeMs, buyLadder, sellLadder } = cfg;
  const buySlot  = n => buyLadder [Math.min(n, buyLadder.length  - 1)];
  const sellSlot = n => sellLadder[Math.min(n, sellLadder.length - 1)];

  // Build regime maps
  const { crossMap, stateMap } = buildRegimeMaps(regimeBars, regimeMs);

  // Trim exec bars to the backtest window
  const startMs   = Date.now() - LOOKBACK_DAYS * 86_400_000;
  const backtestBars = execBars.filter(b => b.t >= startMs);
  if (!backtestBars.length) return null;

  // Initialize regime from stateMap at the start of the backtest window
  const firstBar    = backtestBars[0];
  const initBucket  = Math.floor(firstBar.t / regimeMs) * regimeMs;
  // stateMap keys are candle.t + regimeMs (= close times).
  // The bucket that contains firstBar.t closed at initBucket + regimeMs (if complete)
  // or at initBucket (if it was the close of the previous bar).
  // Search around the firstBar's bucket to find the nearest regime state.
  let initRegime = "neutral";
  for (let offset = 0; offset <= 3; offset++) {
    const t = initBucket + offset * regimeMs;
    if (stateMap.has(t)) { initRegime = stateMap.get(t) === "death" ? "buy" : "sell"; break; }
    if (offset > 0 && stateMap.has(initBucket - offset * regimeMs)) {
      initRegime = stateMap.get(initBucket - offset * regimeMs) === "death" ? "buy" : "sell"; break;
    }
  }

  // Simulation state
  let cash                 = INITIAL_CAP;
  let cryptoQty            = 0;
  let regime               = initRegime;
  let bosCount             = 0;
  let regimeStartCapital   = regime === "buy"  ? INITIAL_CAP : 0;
  let regimeStartCryptoQty = regime === "sell" ? 0           : 0;
  let structure            = 0;
  let lastSH               = null;
  let lastSL               = null;
  const regimeCount        = { buy: 0, sell: 0 };
  const trades             = [];

  let peakValue  = INITIAL_CAP;
  let maxDrawdown = 0;
  let crosses    = 0;
  const equity   = [];

  for (let i = 0; i < backtestBars.length; i++) {
    const bar = backtestBars[i];

    // ── Regime change check (every regimeMs boundary) ────────────────────────
    // Matches live bot exactly: death cross → BUY (accumulate in downtrend)
    //                           golden cross → SELL (distribute in uptrend)
    if (bar.t % regimeMs === 0) {
      const cross = crossMap.get(bar.t);
      if (cross === "death" && regime !== "buy") {
        // ☠️ Death cross: EMA50 crosses BELOW EMA200 → BUY regime (accumulate)
        regime                = "buy";
        bosCount              = 0;
        regimeStartCapital    = cash + cryptoQty * bar.c;
        structure             = 0; lastSH = null; lastSL = null;
        regimeCount.buy++;
        crosses++;
      } else if (cross === "golden" && regime !== "sell") {
        // ⭐ Golden cross: EMA50 crosses ABOVE EMA200 → SELL regime (distribute)
        regime                = "sell";
        bosCount              = 0;
        regimeStartCryptoQty  = cryptoQty;
        structure             = 0; lastSH = null; lastSL = null;
        regimeCount.sell++;
        crosses++;
      }
    }

    if (i < WARMUP) continue;

    // ── Swing pivot detection at i - SWING_LB ────────────────────────────────
    const pIdx = i - SWING_LB;
    if (pIdx >= SWING_LB) {
      const pb = backtestBars[pIdx];
      let isPH = true, isPL = true;
      for (let j = 1; j <= SWING_LB; j++) {
        const prev = backtestBars[pIdx - j], next = backtestBars[pIdx + j];
        if (!prev || !next) { isPH = isPL = false; break; }
        if (prev.h >= pb.h || next.h >= pb.h) isPH = false;
        if (prev.l <= pb.l || next.l <= pb.l) isPL = false;
      }
      if (isPH && (!lastSH || pb.t >= lastSH.t)) lastSH = { price: pb.h, t: pb.t };
      if (isPL && (!lastSL || pb.t >= lastSL.t)) lastSL = { price: pb.l, t: pb.t };
    }

    // ── BOS / CHOCH detection ────────────────────────────────────────────────
    let bullBOS = false, bearBOS = false, bullCHOCH = false, bearCHOCH = false;
    if (lastSH && lastSL && i > 0) {
      const pc = backtestBars[i - 1].c;
      if (bar.c > lastSH.price && pc <= lastSH.price) {
        if (structure === -1) bullCHOCH = true; else bullBOS = true;
        structure = 1;
      }
      if (bar.c < lastSL.price && pc >= lastSL.price) {
        if (structure === 1) bearCHOCH = true; else bearBOS = true;
        structure = -1;
      }
    }

    if (regime === "neutral") {
      const tv = cash + cryptoQty * bar.c;
      equity.push({ t: bar.t, v: +tv.toFixed(4) });
      continue;
    }

    const chochArmed = !REQUIRE_BOS_BEFORE_CHOCH || bosCount >= 1;

    // ── BUY regime: scale in on bearBOS or bullCHOCH ────────────────────────
    if (regime === "buy") {
      if (bearBOS || (CHOCH_CONTINUE_SCALE && bullCHOCH && chochArmed)) {
        const buyUSD = Math.min((regimeStartCapital * buySlot(bosCount)) / 100, cash);
        if (buyUSD >= MIN_ORDER_USD) {
          cryptoQty += buyUSD / bar.c;
          cash      -= buyUSD;
          bosCount++;
          trades.push({ t: bar.t, type: bearBOS ? "buy_bos" : "buy_choch",
                        price: bar.c, usd: buyUSD });
        }
      }
    }

    // ── SELL regime: scale out on bullBOS or bearCHOCH ──────────────────────
    if (regime === "sell") {
      if (bullBOS || (CHOCH_CONTINUE_SCALE && bearCHOCH && chochArmed)) {
        const sellQty = Math.min((regimeStartCryptoQty * sellSlot(bosCount)) / 100, cryptoQty);
        if (sellQty >= MIN_ORDER_QTY) {
          cash      += sellQty * bar.c;
          cryptoQty -= sellQty;
          bosCount++;
          trades.push({ t: bar.t, type: bullBOS ? "sell_bos" : "sell_choch",
                        price: bar.c, qty: sellQty, usd: sellQty * bar.c });
        }
      }
    }

    // ── Drawdown tracking ────────────────────────────────────────────────────
    const tv = cash + cryptoQty * bar.c;
    if (tv > peakValue) peakValue = tv;
    const dd = peakValue > 0 ? (peakValue - tv) / peakValue * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;

    // Equity curve (sample ~daily — every 288 bars at 5m = 24h; 96 bars at 15m)
    const sampleEvery = Math.max(1, Math.round(86400000 / (cfg.execFetch.gran * 1000)));
    if (i % sampleEvery === 0) equity.push({ t: bar.t, v: +tv.toFixed(4) });
  }

  const lastBar  = backtestBars.at(-1);
  const finalVal = cash + cryptoQty * lastBar.c;
  const pnlPct   = (finalVal - INITIAL_CAP) / INITIAL_CAP * 100;
  const bah      = (lastBar.c - firstBar.c) / firstBar.c * 100;
  const alpha    = pnlPct - bah;

  const buys  = trades.filter(t => t.type.startsWith("buy"));
  const sells = trades.filter(t => t.type.startsWith("sell"));

  return {
    finalVal,  cash,  cryptoQty,
    pnlPct,    bah,   alpha,
    maxDrawdown,
    trades: trades.length,  buys: buys.length,  sells: sells.length,
    crosses,
    regimeCount,
    firstPrice: firstBar.c,  lastPrice: lastBar.c,
    equity,
    currentRegime: regime,
  };
}

// ── Adaptive price formatter ──────────────────────────────────────────────────
function fPrice(n) {
  if (!n) return "0";
  if (Math.abs(n) >= 1)    return "$" + n.toFixed(2);
  if (Math.abs(n) >= 0.01) return "$" + n.toFixed(4);
  return "$" + n.toExponential(3);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  Craig Accumulation Bot — Full Portfolio Backtest                ║`);
  console.log(`║  Period: ${LOOKBACK_DAYS}d  |  Capital: $${INITIAL_CAP}/symbol  |  $${INITIAL_CAP * CONFIGS.length} total${" ".repeat(Math.max(0, 18 - String(LOOKBACK_DAYS).length))}║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝\n`);

  const results = [];

  for (const cfg of CONFIGS) {
    console.log(`\n─── ${cfg.sym}  (${cfg.execLabel} exec / ${cfg.regimeLabel} regime) ────────────────────`);

    // Fetch exec bars
    const rawExec = await fetchAllBars(cfg.sym, cfg.execFetch.gran, cfg.execFetch.days, `${cfg.sym} ${cfg.execLabel}`);
    if (!rawExec.length) { console.log(`  ✗ No exec data — skipping`); continue; }

    // Fetch or derive regime bars
    let rawRegime;
    if (cfg.regimeFromExec) {
      // Aggregate exec bars to regime TF (e.g. 5m → 30m for ETH/SOL/LINK)
      rawRegime = aggregateBars(rawExec, cfg.regimeMs);
      console.log(`  Aggregated ${rawExec.length} × ${cfg.execLabel} bars → ${rawRegime.length} × ${cfg.regimeLabel} bars`);
    } else {
      // Fetch separate regime bars
      await sleep(400);
      const regGran = cfg.regimeAggFromSecs ?? cfg.regimeFetch.gran;
      rawRegime = await fetchAllBars(cfg.sym, regGran, cfg.regimeFetch.days, `${cfg.sym} ${cfg.regimeLabel} (raw)`);

      if (cfg.regimeAggFromSecs) {
        // Secondary aggregation (e.g. 1h → 4h for PEPE)
        const preAgg = rawRegime.length;
        rawRegime = aggregateBars(rawRegime, cfg.regimeMs);
        console.log(`  Aggregated ${preAgg} × 1h bars → ${rawRegime.length} × ${cfg.regimeLabel} bars`);
      }
    }

    if (rawRegime.length < EMA_SLOW + 10) {
      console.log(`  ✗ Insufficient regime bars (${rawRegime.length}) — skipping`);
      continue;
    }

    // Run simulation
    console.log(`  Running simulation (${LOOKBACK_DAYS}d window)...`);
    const r = runSim(cfg, rawExec, rawRegime);
    if (!r) { console.log(`  ✗ Simulation failed (no bars in backtest window) — skipping`); continue; }

    const sign = (n, dec = 2) => (n >= 0 ? "+" : "") + n.toFixed(dec) + "%";
    console.log(`  P&L: ${sign(r.pnlPct)}  |  vs B&H: ${sign(r.alpha)}  |  B&H: ${sign(r.bah)}`);
    console.log(`  Max DD: -${r.maxDrawdown.toFixed(2)}%  |  Trades: ${r.trades} (${r.buys}B/${r.sells}S)  |  Regime crosses: ${r.crosses}`);
    console.log(`  Final: $${r.finalVal.toFixed(2)}  (cash $${r.cash.toFixed(2)} + crypto $${(r.cryptoQty * r.lastPrice).toFixed(2)})  [@${fPrice(r.lastPrice)}]`);
    console.log(`  Regime: ${r.currentRegime.toUpperCase()}  |  Buy cycles: ${r.regimeCount.buy}  |  Sell cycles: ${r.regimeCount.sell}`);

    results.push({ ...r, cfg });
    await sleep(600);
  }

  if (!results.length) { console.log("\n✗ No results — check network and try again."); return; }

  // ── Portfolio summary table ───────────────────────────────────────────────────
  const W = 100;
  console.log(`\n\n${"═".repeat(W)}`);
  console.log(`  PORTFOLIO SUMMARY  |  ${LOOKBACK_DAYS}d Backtest  |  $${INITIAL_CAP}/symbol  |  $${(INITIAL_CAP * CONFIGS.length).toFixed(0)} deployed`);
  console.log(`${"═".repeat(W)}`);

  const hdr = [
    "Symbol".padEnd(10),
    "Exec".padEnd(5),
    "Regime".padEnd(7),
    "P&L".padStart(9),
    "vs B&H".padStart(9),
    "B&H".padStart(8),
    "MaxDD".padStart(8),
    "Trades".padStart(7),
    "Crosses".padStart(8),
    "Regime".padStart(8),
    "Final $".padStart(10),
  ];
  console.log(`  ${hdr.join(" ")}`);
  console.log(`  ${"-".repeat(W - 2)}`);

  let totalFinal = 0, totalStart = 0;
  let totalBuys = 0, totalSells = 0, totalTrades = 0;
  let weightedAlpha = 0;

  for (const r of results) {
    const s = n => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
    const row = [
      r.cfg.sym.padEnd(10),
      r.cfg.execLabel.padEnd(5),
      r.cfg.regimeLabel.padEnd(7),
      s(r.pnlPct).padStart(9),
      s(r.alpha).padStart(9),
      s(r.bah).padStart(8),
      ("-" + r.maxDrawdown.toFixed(2) + "%").padStart(8),
      String(r.trades).padStart(7),
      String(r.crosses).padStart(8),
      (`${r.regimeCount.buy}B/${r.regimeCount.sell}S`).padStart(8),
      ("$" + r.finalVal.toFixed(2)).padStart(10),
    ];
    const flag = r.pnlPct > 0 ? "✅" : r.pnlPct > -10 ? "⚠️ " : "❌";
    console.log(`${flag} ${row.join(" ")}`);
    totalFinal  += r.finalVal;
    totalStart  += INITIAL_CAP;
    totalBuys   += r.buys;
    totalSells  += r.sells;
    totalTrades += r.trades;
    weightedAlpha += r.alpha;
  }

  const totalPnl  = (totalFinal - totalStart) / totalStart * 100;
  const avgAlpha  = weightedAlpha / results.length;
  console.log(`  ${"-".repeat(W - 2)}`);
  console.log(`  ${"TOTAL".padEnd(10)} ${"".padEnd(5)} ${"".padEnd(7)} ${((totalPnl >= 0 ? "+" : "") + totalPnl.toFixed(2) + "%").padStart(9)} ${"".padStart(9)} ${"".padStart(8)} ${"".padStart(8)} ${String(totalTrades).padStart(7)} ${"".padStart(8)} ${"".padStart(8)} ${"$" + totalFinal.toFixed(2).padStart(9)}`);
  console.log(`${"═".repeat(W)}`);

  // Portfolio-level analytics
  const gainers = results.filter(r => r.pnlPct > 0);
  const losers  = results.filter(r => r.pnlPct < 0);
  const best    = results.reduce((a, b) => a.pnlPct > b.pnlPct ? a : b);
  const worst   = results.reduce((a, b) => a.pnlPct < b.pnlPct ? a : b);

  console.log(`\n  Win rate:    ${gainers.length}/${results.length} symbols profitable`);
  console.log(`  Avg alpha:   ${avgAlpha >= 0 ? "+" : ""}${avgAlpha.toFixed(2)}% vs buy-and-hold`);
  console.log(`  Best:        ${best.cfg.sym}   ${best.pnlPct >= 0 ? "+" : ""}${best.pnlPct.toFixed(2)}%  (${best.trades} trades, ${best.crosses} crosses)`);
  console.log(`  Worst:       ${worst.cfg.sym}  ${worst.pnlPct >= 0 ? "+" : ""}${worst.pnlPct.toFixed(2)}%  (${worst.trades} trades, ${worst.crosses} crosses)`);
  console.log(`  Total trades: ${totalTrades}  (${totalBuys} buys / ${totalSells} sells)\n`);

  // Buy-and-hold portfolio comparison
  const totalBah = results.reduce((s, r) => s + (INITIAL_CAP * (1 + r.bah / 100)), 0);
  const bahPnl   = (totalBah - totalStart) / totalStart * 100;
  console.log(`  Portfolio B&H:  $${totalBah.toFixed(2)} (${bahPnl >= 0 ? "+" : ""}${bahPnl.toFixed(2)}%)`);
  console.log(`  Strategy vs B&H: ${(totalPnl - bahPnl >= 0 ? "+" : "")}${(totalPnl - bahPnl).toFixed(2)}% alpha on $${totalStart} deployed\n`);

  // ── Save results ──────────────────────────────────────────────────────────────
  const outFile = "backtest-full-results.json";
  writeFileSync(outFile, JSON.stringify({
    generatedAt:        new Date().toISOString(),
    lookbackDays:       LOOKBACK_DAYS,
    capitalPerSymbol:   INITIAL_CAP,
    totalStart,
    totalFinal:         +totalFinal.toFixed(2),
    totalPnl:           +totalPnl.toFixed(2),
    totalBah:           +totalBah.toFixed(2),
    bahPnl:             +bahPnl.toFixed(2),
    strategyAlpha:      +(totalPnl - bahPnl).toFixed(2),
    avgSymbolAlpha:     +avgAlpha.toFixed(2),
    winnersCount:       gainers.length,
    losersCount:        losers.length,
    results: results.map(r => ({
      sym:             r.cfg.sym,
      execLabel:       r.cfg.execLabel,
      regimeLabel:     r.cfg.regimeLabel,
      pnlPct:          +r.pnlPct.toFixed(2),
      bah:             +r.bah.toFixed(2),
      alpha:           +r.alpha.toFixed(2),
      maxDrawdown:     +r.maxDrawdown.toFixed(2),
      trades:          r.trades,
      buys:            r.buys,
      sells:           r.sells,
      crosses:         r.crosses,
      buyRegimes:      r.regimeCount.buy,
      sellRegimes:     r.regimeCount.sell,
      finalVal:        +r.finalVal.toFixed(4),
      cash:            +r.cash.toFixed(4),
      cryptoVal:       +(r.cryptoQty * r.lastPrice).toFixed(4),
      firstPrice:      r.firstPrice,
      lastPrice:       r.lastPrice,
      currentRegime:   r.currentRegime,
      equityCurve:     r.equity,
    })),
  }, null, 2));
  console.log(`📁 Full results saved to ${outFile}`);
}

main().catch(e => { console.error("\n✗ Fatal error:", e.message, e.stack); process.exit(1); });
