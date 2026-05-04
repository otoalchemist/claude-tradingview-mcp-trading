#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// craig-backtest-akt.mjs — AKT-USD Strategy Optimiser
//
// Phase 1: Compares regime timeframes (15m / 30m / 1h / 4h) with 5m exec
// Phase 2: Sweeps buy × sell ladder combos on the top 2 regime TFs
// Output : Ranked table of regime × ladder combinations sorted by alpha
//
// Usage:  node craig-backtest-akt.mjs [lookbackDays]
//   e.g.  node craig-backtest-akt.mjs 90
// ═══════════════════════════════════════════════════════════════════════════

import { writeFileSync } from "fs";

// ── Constants (match live bot) ────────────────────────────────────────────────
const EMA_FAST      = 50;
const EMA_SLOW      = 200;
const SWING_LB      = 5;
const WARMUP        = SWING_LB * 2 + 2;
const INITIAL_CAP   = 100;
const MIN_ORDER_USD = 1.00;
const MIN_ORDER_QTY = 1e-8;
const REQUIRE_BOS_BEFORE_CHOCH = true;

const LOOKBACK_DAYS = parseInt(process.argv[2] ?? "90", 10);
const SYMBOL = "AKT-USD";

// ── Regime timeframes to test ─────────────────────────────────────────────────
const REGIME_TFS = [
  { label: "15m", ms:      900_000, warmupDays: 50  },
  { label: "30m", ms:    1_800_000, warmupDays: 100 },
  { label: "1h",  ms:    3_600_000, warmupDays: 180 },
  { label: "4h",  ms:   14_400_000, warmupDays: 365 },
];
const MAX_WARMUP_DAYS = 180;

// ── Ladder configs to sweep ───────────────────────────────────────────────────
const BUY_LADDERS = [
  { name: "flat-15",     v: [15, 15, 15, 15] },
  { name: "flat-25",     v: [25, 25, 25, 25] },
  { name: "flat-33",     v: [33, 33, 33, 33] },
  { name: "front-mild",  v: [30, 25, 20, 15] },
  { name: "front-35",    v: [35, 25, 15, 10] },
  { name: "front-50",    v: [50, 25, 15, 10] },
  { name: "back-mild",   v: [15, 20, 25, 30] },
  { name: "back-steep",  v: [10, 15, 25, 35] },
  { name: "back-xsteep", v: [10, 20, 30, 40] },
];

const SELL_LADDERS = [
  { name: "flat-15",     v: [15, 15, 15, 15] },
  { name: "flat-25",     v: [25, 25, 25, 25] },
  { name: "flat-33",     v: [33, 33, 33, 33] },
  { name: "back-mild",   v: [ 8, 12, 20, 30] },
  { name: "back-steep",  v: [ 5, 10, 20, 40] },
  { name: "back-xsteep", v: [ 5,  8, 15, 50] },
  { name: "front-mild",  v: [25, 25, 20, 15] },
  { name: "front-steep", v: [30, 25, 20, 10] },
  { name: "front-50",    v: [50, 25, 15, 10] },
];

// Default ladder used for Phase 1 regime comparison
const DEFAULT_BUY_LADDER  = [25, 25, 25, 25];
const DEFAULT_SELL_LADDER = [ 8, 12, 20, 30];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Coinbase Exchange public candles ──────────────────────────────────────────
async function fetchAllBars(symbol, granSec, totalDays, label) {
  const cutoff   = Date.now() - totalDays * 86_400_000;
  const windowMs = 300 * granSec * 1000;
  const bars     = [];
  let   endMs    = Date.now();
  let   errors   = 0;
  process.stdout.write(`  Fetching ${label} (${totalDays}d)`);

  while (endMs > cutoff) {
    const startMs = Math.max(endMs - windowMs, cutoff);
    const url = `https://api.exchange.coinbase.com/products/${symbol}/candles` +
      `?granularity=${granSec}&start=${Math.floor(startMs / 1000)}&end=${Math.floor(endMs / 1000)}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "craig-backtest-akt/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error(`Unexpected response: ${JSON.stringify(data).slice(0, 100)}`);
      if (data.length) bars.unshift(...data.map(k => ({
        t: +k[0] * 1000, l: +k[1], h: +k[2], o: +k[3], c: +k[4], v: +k[5]
      })));
      endMs  = startMs - granSec * 1000;
      errors = 0;
      process.stdout.write(".");
    } catch (e) {
      process.stdout.write("!");
      if (++errors >= 5) {
        console.error(`\n  ✗ Too many errors: ${e.message}`);
        break;
      }
      await sleep(2000);
      continue;
    }
    await sleep(130);
  }

  const seen = new Set();
  const out  = bars
    .filter(b => { if (seen.has(b.t)) return false; seen.add(b.t); return true; })
    .sort((a, b) => a.t - b.t);
  console.log(` → ${out.length} bars`);
  return out;
}

// ── Aggregate n×5m bars into regime buckets ───────────────────────────────────
function aggregateBars(bars5m, regimeMs) {
  const buckets = new Map();
  for (const b of bars5m) {
    const bucket = Math.floor(b.t / regimeMs) * regimeMs;
    if (!buckets.has(bucket)) {
      buckets.set(bucket, { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    } else {
      const agg = buckets.get(bucket);
      agg.h  = Math.max(agg.h, b.h);
      agg.l  = Math.min(agg.l, b.l);
      agg.c  = b.c;
      agg.v += b.v;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

// ── EMA (SMA-seeded, matches live bot) ───────────────────────────────────────
function calcEMA(closes, period) {
  const ema = new Array(closes.length).fill(null);
  const k   = 2 / (period + 1);
  let sum = 0, count = 0;
  for (let i = 0; i < closes.length; i++) {
    if (count < period) {
      sum += closes[i]; count++;
      if (count === period) ema[i] = sum / period;
    } else {
      ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

// ── Build cross map from regime candles ───────────────────────────────────────
function buildCrossMap(candles, regimeMs) {
  const closes   = candles.map(c => c.c);
  const emaF     = calcEMA(closes, EMA_FAST);
  const emaS     = calcEMA(closes, EMA_SLOW);
  const crossMap = new Map();
  for (let i = 1; i < candles.length; i++) {
    const ef = emaF[i], es = emaS[i], efP = emaF[i - 1], esP = emaS[i - 1];
    if (!ef || !es || !efP || !esP) continue;
    const ct = candles[i].t + regimeMs;
    if      (efP <= esP && ef > es) crossMap.set(ct, "golden");   // golden → SELL
    else if (efP >= esP && ef < es) crossMap.set(ct, "death");    // death  → BUY
  }
  return crossMap;
}

// ── Core simulation ───────────────────────────────────────────────────────────
function runSim(execBars, crossMap, regimeMs, buyLadder, sellLadder) {
  const buySlot  = n => buyLadder [Math.min(n, buyLadder.length  - 1)];
  const sellSlot = n => sellLadder[Math.min(n, sellLadder.length - 1)];

  const state = {
    regime: "neutral", bosCount: 0,
    cash: INITIAL_CAP, cryptoQty: 0,
    regimeStartCapital: INITIAL_CAP, regimeStartCryptoQty: 0,
    structure: 0, lastSH: null, lastSL: null,
    regimeCount: { buy: 0, sell: 0 },
    trades: [],
  };

  let peakValue = INITIAL_CAP, maxDrawdown = 0;

  for (let i = 0; i < execBars.length; i++) {
    const bar = execBars[i];

    // Regime boundary check
    if (bar.t % regimeMs === 0) {
      const cross = crossMap.get(bar.t);
      if (cross) {
        const totalVal = state.cash + state.cryptoQty * bar.c;
        if (cross === "death") {
          // Death cross → BUY regime (contrarian: accumulate on weakness)
          state.regime = "buy"; state.bosCount = 0;
          state.regimeStartCapital = totalVal;
          state.structure = 0; state.lastSH = null; state.lastSL = null;
          state.regimeCount.buy++;
        } else {
          // Golden cross → SELL regime (contrarian: distribute on strength)
          state.regime = "sell"; state.bosCount = 0;
          state.regimeStartCryptoQty = state.cryptoQty;
          state.structure = 0; state.lastSH = null; state.lastSL = null;
          state.regimeCount.sell++;
        }
      }
    }

    if (i < WARMUP) continue;

    // Swing pivot detection
    const pIdx = i - SWING_LB;
    if (pIdx >= SWING_LB) {
      const pb = execBars[pIdx];
      let isPH = true, isPL = true;
      for (let j = 1; j <= SWING_LB; j++) {
        const prev = execBars[pIdx - j], next = execBars[pIdx + j];
        if (!prev || !next) { isPH = isPL = false; break; }
        if (prev.h >= pb.h || next.h >= pb.h) isPH = false;
        if (prev.l <= pb.l || next.l <= pb.l) isPL = false;
      }
      if (isPH && (!state.lastSH || pb.t >= state.lastSH.t)) state.lastSH = { price: pb.h, t: pb.t };
      if (isPL && (!state.lastSL || pb.t >= state.lastSL.t)) state.lastSL = { price: pb.l, t: pb.t };
    }

    // BOS / CHOCH detection
    let bullBOS = false, bearBOS = false, bullCHOCH = false, bearCHOCH = false;
    if (state.lastSH && state.lastSL && i > 0) {
      const pc = execBars[i - 1].c;
      if (bar.c > state.lastSH.price && pc <= state.lastSH.price) {
        if (state.structure === -1) bullCHOCH = true; else bullBOS = true;
        state.structure = 1;
      }
      if (bar.c < state.lastSL.price && pc >= state.lastSL.price) {
        if (state.structure === 1) bearCHOCH = true; else bearBOS = true;
        state.structure = -1;
      }
    }

    if (state.regime === "neutral") continue;

    // Order execution
    const chochArmed = !REQUIRE_BOS_BEFORE_CHOCH || state.bosCount >= 1;

    if (state.regime === "buy" && (bearBOS || (bullCHOCH && chochArmed))) {
      const buyUSD = Math.min((state.regimeStartCapital * buySlot(state.bosCount)) / 100, state.cash);
      if (buyUSD >= MIN_ORDER_USD) {
        state.cash      -= buyUSD;
        state.cryptoQty += buyUSD / bar.c;
        state.bosCount++;
        state.trades.push({ type: "buy", price: bar.c, usd: buyUSD });
      }
    } else if (state.regime === "sell" && (bullBOS || (bearCHOCH && chochArmed)) && state.cryptoQty > 0) {
      const sellQty = Math.min((state.regimeStartCryptoQty * sellSlot(state.bosCount)) / 100, state.cryptoQty);
      if (sellQty >= MIN_ORDER_QTY) {
        state.cash      += sellQty * bar.c;
        state.cryptoQty -= sellQty;
        state.bosCount++;
        state.trades.push({ type: "sell", price: bar.c, usd: sellQty * bar.c });
      }
    }

    // Drawdown tracking
    const tv = state.cash + state.cryptoQty * bar.c;
    if (tv > peakValue) peakValue = tv;
    const dd = peakValue > 0 ? (peakValue - tv) / peakValue * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const lastBar  = execBars.at(-1);
  const firstBar = execBars[0];
  const finalVal = state.cash + state.cryptoQty * lastBar.c;
  const pnlPct   = (finalVal - INITIAL_CAP) / INITIAL_CAP * 100;
  const buyHold  = (lastBar.c - firstBar.c) / firstBar.c * 100;
  const buys     = state.trades.filter(t => t.type === "buy");
  const sells    = state.trades.filter(t => t.type === "sell");
  const totalCrosses = state.regimeCount.buy + state.regimeCount.sell;

  return {
    finalVal, pnlPct, buyHold,
    alpha: pnlPct - buyHold,
    maxDrawdown,
    trades: state.trades.length,
    buys: buys.length, sells: sells.length,
    regimeCount: state.regimeCount,
    totalCrosses,
    cashRemaining: state.cash,
    cryptoVal: state.cryptoQty * lastBar.c,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║        AKT-USD  Strategy Optimiser  |  Exec: 5m             ║`);
  console.log(`║        ${LOOKBACK_DAYS}d lookback  ×  4 regime TFs  ×  9×9 ladders       ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  // How much extra warmup data do we need?
  const maxWarmup  = Math.min(MAX_WARMUP_DAYS, Math.max(...REGIME_TFS.map(r => r.warmupDays)));
  const totalDays  = LOOKBACK_DAYS + maxWarmup;

  console.log(`  Need ${totalDays}d of 5m data (${LOOKBACK_DAYS}d backtest + ${maxWarmup}d EMA warmup)\n`);

  // Fetch all 5m data
  const raw5m = await fetchAllBars(SYMBOL, 300, totalDays, `${SYMBOL} 5m`);
  if (raw5m.length < 500) {
    console.error(`  ✗ Only ${raw5m.length} bars fetched — AKT-USD may not be available on Coinbase Exchange public API.`);
    console.error(`    Try: https://api.exchange.coinbase.com/products/AKT-USD/candles?granularity=300`);
    process.exit(1);
  }

  // Exec window = backtest period only (no warmup)
  const execCutoff = Date.now() - LOOKBACK_DAYS * 86_400_000;
  const execBars   = raw5m.filter(b => b.t >= execCutoff);
  const firstBar   = execBars[0];
  const lastBar    = execBars.at(-1);
  const periodDays = (lastBar.t - firstBar.t) / 86_400_000;
  const buyHold    = (lastBar.c - firstBar.c) / firstBar.c * 100;

  console.log(`\n  Exec bars: ${execBars.length} bars`);
  console.log(`  Period: ${new Date(firstBar.t).toISOString().slice(0,10)} → ${new Date(lastBar.t).toISOString().slice(0,10)} (${periodDays.toFixed(0)}d)`);
  console.log(`  AKT price: $${firstBar.c.toFixed(4)} → $${lastBar.c.toFixed(4)}  |  Buy & Hold: ${buyHold >= 0 ? "+" : ""}${buyHold.toFixed(2)}%\n`);

  // ── PHASE 1: Regime comparison with default ladder ─────────────────────────
  console.log(`${"═".repeat(80)}`);
  console.log(`  PHASE 1 — Regime Timeframe Comparison  (buy=[25,25,25,25]  sell=[8,12,20,30])`);
  console.log(`${"─".repeat(80)}`);

  const regimeResults = [];

  for (const rtf of REGIME_TFS) {
    process.stdout.write(`  Building ${rtf.label} cross map...`);
    const regimeBars = aggregateBars(raw5m, rtf.ms);
    const crossMap   = buildCrossMap(regimeBars, rtf.ms);
    process.stdout.write(` ${crossMap.size} crosses\n`);

    const result = runSim(execBars, crossMap, rtf.ms, DEFAULT_BUY_LADDER, DEFAULT_SELL_LADDER);
    regimeResults.push({ regime: rtf.label, regimeMs: rtf.ms, crossMap, ...result });
  }

  // Sort by alpha
  regimeResults.sort((a, b) => b.alpha - a.alpha);

  console.log(`\n  ${"Regime".padEnd(8)} ${"P&L".padStart(9)} ${"vs B&H".padStart(9)} ${"MaxDD".padStart(9)} ${"Trades".padStart(7)} ${"Crosses".padStart(9)} ${"BuyR".padStart(5)} ${"SellR".padStart(5)}`);
  console.log(`  ${"─".repeat(72)}`);
  for (const r of regimeResults) {
    const star   = r === regimeResults[0] ? "★" : " ";
    const pnlStr = `${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(2)}%`;
    const vsStr  = `${r.alpha  >= 0 ? "+" : ""}${r.alpha.toFixed(2)}%`;
    const ddStr  = `-${r.maxDrawdown.toFixed(2)}%`;
    console.log(`${star} ${r.regime.padEnd(8)} ${pnlStr.padStart(9)} ${vsStr.padStart(9)} ${ddStr.padStart(9)} ${String(r.trades).padStart(7)} ${String(r.totalCrosses).padStart(9)} ${String(r.regimeCount.buy).padStart(5)} ${String(r.regimeCount.sell).padStart(5)}`);
  }
  console.log(`  ${"─".repeat(72)}`);
  console.log(`  Buy & Hold: ${buyHold >= 0 ? "+" : ""}${buyHold.toFixed(2)}%  over ${periodDays.toFixed(0)} days\n`);

  // ── PHASE 2: Ladder sweep on top 2 regime TFs ──────────────────────────────
  const TOP_N = 2;
  const topRegimes = regimeResults.slice(0, TOP_N);
  const totalCombos = topRegimes.length * BUY_LADDERS.length * SELL_LADDERS.length;

  console.log(`${"═".repeat(80)}`);
  console.log(`  PHASE 2 — Ladder Sweep on ${topRegimes.map(r=>r.regime).join(" + ")} regime`);
  console.log(`  ${BUY_LADDERS.length} buy × ${SELL_LADDERS.length} sell × ${topRegimes.length} regime = ${totalCombos} combinations`);
  console.log(`${"─".repeat(80)}\n`);

  const allResults = [];
  let done = 0;

  for (const rt of topRegimes) {
    process.stdout.write(`  Sweeping ${rt.regime} regime...`);
    for (const buy of BUY_LADDERS) {
      for (const sell of SELL_LADDERS) {
        const r = runSim(execBars, rt.crossMap, rt.regimeMs, buy.v, sell.v);
        allResults.push({
          regime: rt.regime,
          buyName: buy.name, buyV: buy.v,
          sellName: sell.name, sellV: sell.v,
          ...r,
        });
        if (++done % 20 === 0) process.stdout.write(".");
      }
    }
    process.stdout.write(` done\n`);
  }

  // Sort by alpha (P&L vs B&H)
  allResults.sort((a, b) => b.alpha - a.alpha);

  // ── Top 20 results table ───────────────────────────────────────────────────
  const TOP_RESULTS = 20;
  console.log(`\n  Top ${TOP_RESULTS} combinations (sorted by alpha vs Buy & Hold):`);
  console.log(`\n  ${"#".padEnd(3)} ${"Regime".padEnd(5)} ${"Buy Ladder".padEnd(12)} ${"Sell Ladder".padEnd(12)} ${"P&L".padStart(9)} ${"vs B&H".padStart(9)} ${"MaxDD".padStart(9)} ${"Trades".padStart(7)}`);
  console.log(`  ${"─".repeat(80)}`);

  for (let i = 0; i < Math.min(TOP_RESULTS, allResults.length); i++) {
    const r      = allResults[i];
    const rank   = i === 0 ? "★ 1" : `  ${i + 1}`;
    const pnlStr = `${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(2)}%`;
    const vsStr  = `${r.alpha  >= 0 ? "+" : ""}${r.alpha.toFixed(2)}%`;
    const ddStr  = `-${r.maxDrawdown.toFixed(2)}%`;
    console.log(
      `${rank} ${r.regime.padEnd(5)} ${r.buyName.padEnd(12)} ${r.sellName.padEnd(12)}` +
      ` ${pnlStr.padStart(9)} ${vsStr.padStart(9)} ${ddStr.padStart(9)} ${String(r.trades).padStart(7)}`
    );
  }
  console.log(`  ${"─".repeat(80)}`);

  // ── Buy ladder analysis: which buy ladder wins most across sell combos ─────
  console.log(`\n  Buy Ladder Rankings (avg alpha across all sell combos, best regime):`);
  const bestRegimeLabel = regimeResults[0].regime;
  const bestRegimeRows  = allResults.filter(r => r.regime === bestRegimeLabel);

  const buyMap = new Map();
  for (const r of bestRegimeRows) {
    if (!buyMap.has(r.buyName)) buyMap.set(r.buyName, []);
    buyMap.get(r.buyName).push(r.alpha);
  }
  const buyRanked = [...buyMap.entries()]
    .map(([name, alphas]) => ({ name, avgAlpha: alphas.reduce((s,a)=>s+a,0)/alphas.length }))
    .sort((a, b) => b.avgAlpha - a.avgAlpha);

  for (const b of buyRanked) {
    const bar = "█".repeat(Math.max(0, Math.round((b.avgAlpha + 20) / 4)));
    console.log(`    ${b.name.padEnd(12)} avg alpha: ${(b.avgAlpha >= 0 ? "+" : "") + b.avgAlpha.toFixed(2)}%  ${bar}`);
  }

  // ── Sell ladder analysis ──────────────────────────────────────────────────
  console.log(`\n  Sell Ladder Rankings (avg alpha across all buy combos, best regime):`);
  const sellMap = new Map();
  for (const r of bestRegimeRows) {
    if (!sellMap.has(r.sellName)) sellMap.set(r.sellName, []);
    sellMap.get(r.sellName).push(r.alpha);
  }
  const sellRanked = [...sellMap.entries()]
    .map(([name, alphas]) => ({ name, avgAlpha: alphas.reduce((s,a)=>s+a,0)/alphas.length }))
    .sort((a, b) => b.avgAlpha - a.avgAlpha);

  for (const s of sellRanked) {
    const bar = "█".repeat(Math.max(0, Math.round((s.avgAlpha + 20) / 4)));
    console.log(`    ${s.name.padEnd(12)} avg alpha: ${(s.avgAlpha >= 0 ? "+" : "") + s.avgAlpha.toFixed(2)}%  ${bar}`);
  }

  // ── Recommendation ────────────────────────────────────────────────────────
  const best = allResults[0];
  console.log(`\n${"═".repeat(80)}`);
  console.log(`  RECOMMENDATION`);
  console.log(`${"═".repeat(80)}`);
  console.log(`  Regime TF : ${best.regime}`);
  console.log(`  Buy ladder: [${best.buyV.join(", ")}]%  (${best.buyName})`);
  console.log(`  Sell ladder: [${best.sellV.join(", ")}]%  (${best.sellName})`);
  console.log(`  P&L ${best.pnlPct >= 0 ? "+" : ""}${best.pnlPct.toFixed(2)}%  |  Alpha ${best.alpha >= 0 ? "+" : ""}${best.alpha.toFixed(2)}%  |  Max DD -${best.maxDrawdown.toFixed(2)}%  |  ${best.trades} trades`);
  console.log(`  Buy & Hold over same period: ${buyHold >= 0 ? "+" : ""}${buyHold.toFixed(2)}%`);
  console.log(`${"═".repeat(80)}\n`);

  // ── Save JSON ─────────────────────────────────────────────────────────────
  const outFile = "backtest-akt-results.json";
  writeFileSync(outFile, JSON.stringify({
    symbol: SYMBOL,
    execGran: "5m",
    lookbackDays: LOOKBACK_DAYS,
    period: {
      from: new Date(firstBar.t).toISOString(),
      to:   new Date(lastBar.t).toISOString(),
      days: +periodDays.toFixed(0),
    },
    buyHoldPct: +buyHold.toFixed(2),
    phaseOne: {
      description: "Regime TF comparison with default ladder [25,25,25,25] / [8,12,20,30]",
      results: regimeResults.map(r => ({
        regime: r.regime,
        pnlPct: +r.pnlPct.toFixed(2),
        alphaPct: +r.alpha.toFixed(2),
        maxDrawdownPct: +r.maxDrawdown.toFixed(2),
        trades: r.trades, buys: r.buys, sells: r.sells,
        totalCrosses: r.totalCrosses,
        regimeCount: r.regimeCount,
        finalVal: +r.finalVal.toFixed(4),
      })),
    },
    phaseTwo: {
      description: `Ladder sweep on top ${TOP_N} regime TFs`,
      top20: allResults.slice(0, 20).map(r => ({
        regime: r.regime,
        buyLadder: r.buyName, buyV: r.buyV,
        sellLadder: r.sellName, sellV: r.sellV,
        pnlPct: +r.pnlPct.toFixed(2),
        alphaPct: +r.alpha.toFixed(2),
        maxDrawdownPct: +r.maxDrawdown.toFixed(2),
        trades: r.trades,
        finalVal: +r.finalVal.toFixed(4),
      })),
      buyLadderRanking: buyRanked.map(b => ({
        name: b.name, avgAlpha: +b.avgAlpha.toFixed(2)
      })),
      sellLadderRanking: sellRanked.map(s => ({
        name: s.name, avgAlpha: +s.avgAlpha.toFixed(2)
      })),
    },
    recommendation: {
      regimeTF: best.regime,
      buyLadder: { name: best.buyName, v: best.buyV },
      sellLadder: { name: best.sellName, v: best.sellV },
      pnlPct: +best.pnlPct.toFixed(2),
      alphaPct: +best.alpha.toFixed(2),
      maxDrawdownPct: +best.maxDrawdown.toFixed(2),
      trades: best.trades,
    },
  }, null, 2));
  console.log(`  📁 Full results saved to ${outFile}\n`);
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
