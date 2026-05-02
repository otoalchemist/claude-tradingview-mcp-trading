#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// craig-accumulation-backtest.mjs
// Accumulation / Distribution Strategy — Multi-timeframe BTC backtest
//
// REGIME (1h EMA50/EMA200 cross — slower, less whipsaw):
//   Large death cross  → BUY  regime (accumulate)
//   Large golden cross → SELL regime (distribute)
//
// EXECUTION (15m BOS/CHOCH detection):
//   BUY regime:
//     • Each bearish BOS  → scaled buy (8/12/18/27% of regime-start capital)
//     • Bullish CHOCH     → final buy  (100% remaining cash)
//   SELL regime:
//     • Each bullish BOS  → scaled sell (8/12/18/27% of regime-start BTC)
//     • Bearish CHOCH     → final sell  (100% remaining BTC)
//
// Compares against HODL benchmark.
// ═══════════════════════════════════════════════════════════════════════════

// ── Config ────────────────────────────────────────────────────────────────────
const SYMBOLS         = ["BTC-USD", "ETH-USD", "SOL-USD"];
const INITIAL_CAPITAL = 500;

const EMA_FAST_LARGE  = 50;       // applied to 1h candles
const EMA_SLOW_LARGE  = 200;      // applied to 1h candles
const SWING_LB        = 5;

const BOS_SCALE_PCT   = [8, 12, 18, 27];
const REQUIRE_BOS_BEFORE_CHOCH = true;

// NEW: CHOCH continues the scale ladder instead of going all-in.
// When bosCount < BOS_SCALE_PCT.length, CHOCH uses BOS_SCALE_PCT[bosCount].
// When bosCount >= BOS_SCALE_PCT.length (all slots used), CHOCH deploys remainder.
const CHOCH_CONTINUE_SCALE = true;

// ── Test scenarios ────────────────────────────────────────────────────────────
// endDate: last day of execution window (YYYY-MM-DD). Omit = use today.
// daysBias should be daysExec + ~30 to give EMA200 enough warmup bars.
const SCENARIOS = [
  { label: "Last  30d",           daysExec:  30, daysBias:  60 },
  { label: "Last  60d",           daysExec:  60, daysBias:  90 },
  { label: "Last  90d",           daysExec:  90, daysBias: 120 },
  { label: "Last 120d",           daysExec: 120, daysBias: 150 },
  // Historical slices — Coinbase 1h API retains ~180 days from today (2026-04-30)
  // Oldest available ≈ 2025-10-31. 2022/2023 bear periods are NOT accessible.
  { label: "Nov–Dec 2025  (60d)", daysExec:  60, daysBias:  90, endDate: "2025-12-31" },
  { label: "Jan–Mar 2026  (90d)", daysExec:  90, daysBias: 120, endDate: "2026-03-31" },
];

const TF = {
  exec: { gran: "FIFTEEN_MINUTE", secs: 900,  label: "15m" },
  bias: { gran: "ONE_HOUR",       secs: 3600, label: "1h"  },
};
const CB_MAX = 350;

// ── Coinbase candle fetch ─────────────────────────────────────────────────────
// endMs: optional end timestamp in ms (defaults to Date.now())
async function fetchCandles(symbol, tfConfig, days, endMs = Date.now()) {
  const { gran, secs, label } = tfConfig;
  const totalBars  = Math.ceil(days * 86400 / secs) + 50;
  let allCandles   = [];
  let batchEnd     = Math.floor(endMs / 1000);
  let emptyCount   = 0;

  process.stdout.write(`  Fetching ${symbol} ${label} (${days}d ending ${new Date(endMs).toISOString().slice(0,10)})... `);

  while (allCandles.length < totalBars) {
    const need       = totalBars - allCandles.length;
    const batchSize  = Math.min(CB_MAX, need);
    const batchStart = batchEnd - batchSize * secs;

    const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${symbol}/candles` +
      `?start=${batchStart}&end=${batchEnd}&granularity=${gran}&limit=${batchSize}`;

    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Coinbase ${res.status} for ${symbol} ${label}`);
    const json = await res.json();

    if (!json.candles?.length) {
      if (++emptyCount >= 2) break;
      batchEnd = batchStart;
      continue;
    }
    emptyCount = 0;

    const batch = json.candles.slice().reverse().map(c => ({
      t: parseInt(c.start) * 1000,
      o: parseFloat(c.open),
      h: parseFloat(c.high),
      l: parseFloat(c.low),
      c: parseFloat(c.close),
    }));

    allCandles = [...batch, ...allCandles];
    batchEnd   = batchStart;
  }

  const seen = new Set();
  const candles = allCandles
    .filter(c => { if (seen.has(c.t)) return false; seen.add(c.t); return true; })
    .sort((a, b) => a.t - b.t);

  // Trim to the requested time window
  const windowStart = endMs - days * 86400 * 1000;
  const trimmed = candles.filter(c => c.t >= windowStart && c.t <= endMs);

  console.log(`${trimmed.length} candles`);
  return trimmed;
}

// ── Indicators ────────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  const out = new Array(closes.length).fill(null);
  const k   = 2 / (period + 1);
  let ema   = null;
  for (let i = 0; i < closes.length; i++) {
    if (ema === null) {
      if (i < period - 1) continue;
      ema = closes.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0) / period;
    } else {
      ema = closes[i] * k + ema * (1 - k);
    }
    out[i] = ema;
  }
  return out;
}

// ── 1h Regime Pre-computation ─────────────────────────────────────────────────
function build1hRegime(candles1h) {
  const closes = candles1h.map(c => c.c);
  const ema50  = calcEMA(closes, EMA_FAST_LARGE);
  const ema200 = calcEMA(closes, EMA_SLOW_LARGE);

  const crossMap = new Map();
  const stateMap = new Map();

  for (let i = 1; i < candles1h.length; i++) {
    const e50 = ema50[i],   e200 = ema200[i];
    const e50P= ema50[i-1], e200P= ema200[i-1];
    if (!e50 || !e200 || !e50P || !e200P) continue;

    const closeTime = candles1h[i].t + 3600 * 1000;
    stateMap.set(closeTime, e50 > e200 ? "golden" : "death");

    if (e50P <= e200P && e50 > e200) crossMap.set(closeTime, "golden");
    else if (e50P >= e200P && e50 < e200) crossMap.set(closeTime, "death");
  }

  return { crossMap, stateMap };
}

// ── Simulation ────────────────────────────────────────────────────────────────
function simulate(candles15m, candles1h) {
  const { crossMap, stateMap } = build1hRegime(candles1h);

  let structure = 0;
  let lastSH    = null;
  let lastSL    = null;

  let cash      = INITIAL_CAPITAL;
  let btcQty    = 0;
  let regime    = "neutral";
  let bosCount  = 0;
  let regimeStartCapital = INITIAL_CAPITAL;
  let regimeStartBtcQty  = 0;

  const trades      = [];
  const equityCurve = [];
  const regimeCount = { buy: 0, sell: 0 };
  let initialized   = false;

  const warmup  = SWING_LB * 2 + 2;
  const HOUR_MS = 3600 * 1000;

  for (let i = warmup; i < candles15m.length; i++) {
    const bar = candles15m[i];

    // ── 1. Pivot detection (15m) ──────────────────────────────────────────────
    const pIdx = i - SWING_LB;
    if (pIdx >= SWING_LB) {
      const pb = candles15m[pIdx];
      let isPH = true, isPL = true;
      for (let j = 1; j <= SWING_LB; j++) {
        if (candles15m[pIdx-j].h >= pb.h || candles15m[pIdx+j].h >= pb.h) isPH = false;
        if (candles15m[pIdx-j].l <= pb.l || candles15m[pIdx+j].l <= pb.l) isPL = false;
      }
      if (isPH) lastSH = { price: pb.h, idx: pIdx };
      if (isPL) lastSL = { price: pb.l, idx: pIdx };
    }

    // ── 2. BOS / CHOCH detection (15m) ────────────────────────────────────────
    let bullBOS = false, bearBOS = false, bullCHOCH = false, bearCHOCH = false;
    if (lastSH && lastSL) {
      const pc = candles15m[i-1].c;
      if (bar.c > lastSH.price && pc <= lastSH.price) {
        if (structure === -1) bullCHOCH = true;
        else bullBOS = true;
        structure = 1;
      }
      if (bar.c < lastSL.price && pc >= lastSL.price) {
        if (structure === 1) bearCHOCH = true;
        else bearBOS = true;
        structure = -1;
      }
    }

    // ── 3. Initialize regime on first eligible 15m bar ────────────────────────
    if (!initialized) {
      const recentHourClose = Math.floor(bar.t / HOUR_MS) * HOUR_MS;
      const state = stateMap.get(recentHourClose);
      if (state === "death") {
        regime = "buy";
        bosCount = 0;
        regimeStartCapital = cash + btcQty * bar.c;
        regimeCount.buy++;
        trades.push({ idx: i, t: bar.t, type: "regime_change", to: "buy", price: bar.c, source: "init" });
      }
      initialized = true;
    }

    // ── 4. 1h Regime change check ─────────────────────────────────────────────
    if (bar.t % HOUR_MS === 0) {
      const cross = crossMap.get(bar.t);
      if (cross === "death") {
        regime = "buy";
        bosCount = 0;
        regimeStartCapital = cash + btcQty * bar.c;
        regimeCount.buy++;
        trades.push({ idx: i, t: bar.t, type: "regime_change", to: "buy", price: bar.c });
      } else if (cross === "golden") {
        regime = "sell";
        bosCount = 0;
        regimeStartBtcQty = btcQty;
        regimeCount.sell++;
        trades.push({ idx: i, t: bar.t, type: "regime_change", to: "sell", price: bar.c });
      }
    }

    // ── 5. Execute trades ─────────────────────────────────────────────────────
    if (regime === "buy") {
      // BOS: scaled buy on bearish break of structure
      if (bearBOS && bosCount < BOS_SCALE_PCT.length && cash > 0) {
        const allocPct = BOS_SCALE_PCT[bosCount];
        const allocUSD = (regimeStartCapital * allocPct) / 100;
        const buyUSD   = Math.min(allocUSD, cash);
        if (buyUSD > 0.01) {
          const qty = buyUSD / bar.c;
          cash   -= buyUSD;
          btcQty += qty;
          trades.push({ idx: i, t: bar.t, type: "scaled_buy", price: bar.c, qty, usd: buyUSD, bosNum: bosCount + 1 });
          bosCount++;
        }
      }

      const chochArmed = !REQUIRE_BOS_BEFORE_CHOCH || bosCount >= 1;
      if (bullCHOCH && chochArmed && cash > 0.01) {
        if (CHOCH_CONTINUE_SCALE) {
          // ── NEW: CHOCH continues the BOS scale ladder, not all-in ──────────
          // If slots remain, use the next BOS_SCALE_PCT tier.
          // Once all slots exhausted, deploy remaining cash (overflow).
          let buyUSD;
          if (bosCount < BOS_SCALE_PCT.length) {
            const allocPct = BOS_SCALE_PCT[bosCount];
            const allocUSD = (regimeStartCapital * allocPct) / 100;
            buyUSD = Math.min(allocUSD, cash);
          } else {
            buyUSD = cash; // overflow: all remaining
          }
          if (buyUSD > 0.01) {
            const qty = buyUSD / bar.c;
            cash   -= buyUSD;
            btcQty += qty;
            trades.push({ idx: i, t: bar.t, type: "choch_buy", price: bar.c, qty, usd: buyUSD, bosNum: bosCount + 1 });
            bosCount++;
          }
        } else {
          // ── ORIGINAL: all-in on CHOCH ─────────────────────────────────────
          const buyUSD = cash;
          const qty    = buyUSD / bar.c;
          btcQty += qty;
          cash    = 0;
          trades.push({ idx: i, t: bar.t, type: "final_buy", price: bar.c, qty, usd: buyUSD });
        }
      }
    }

    if (regime === "sell") {
      // BOS: scaled sell on bullish break of structure
      if (bullBOS && bosCount < BOS_SCALE_PCT.length && btcQty > 0) {
        const allocPct = BOS_SCALE_PCT[bosCount];
        const sellQty  = (regimeStartBtcQty * allocPct) / 100;
        const actual   = Math.min(sellQty, btcQty);
        if (actual > 1e-8) {
          const usd = actual * bar.c;
          cash   += usd;
          btcQty -= actual;
          trades.push({ idx: i, t: bar.t, type: "scaled_sell", price: bar.c, qty: actual, usd, bosNum: bosCount + 1 });
          bosCount++;
        }
      }

      const chochArmed = !REQUIRE_BOS_BEFORE_CHOCH || bosCount >= 1;
      if (bearCHOCH && chochArmed && btcQty > 1e-8) {
        if (CHOCH_CONTINUE_SCALE) {
          // ── NEW: CHOCH continues the BOS scale ladder, not all-out ─────────
          let sellQty;
          if (bosCount < BOS_SCALE_PCT.length) {
            const allocPct = BOS_SCALE_PCT[bosCount];
            sellQty = (regimeStartBtcQty * allocPct) / 100;
          } else {
            sellQty = btcQty; // overflow: all remaining
          }
          const actual = Math.min(sellQty, btcQty);
          if (actual > 1e-8) {
            const usd = actual * bar.c;
            cash   += usd;
            btcQty -= actual;
            trades.push({ idx: i, t: bar.t, type: "choch_sell", price: bar.c, qty: actual, usd, bosNum: bosCount + 1 });
            bosCount++;
          }
        } else {
          // ── ORIGINAL: all-out on CHOCH ────────────────────────────────────
          const usd = btcQty * bar.c;
          const qty = btcQty;
          cash   += usd;
          btcQty  = 0;
          trades.push({ idx: i, t: bar.t, type: "final_sell", price: bar.c, qty, usd });
        }
      }
    }

    equityCurve.push({ t: bar.t, equity: cash + btcQty * bar.c });
  }

  const finalPrice = candles15m.at(-1).c;
  const finalValue = cash + btcQty * finalPrice;

  const startBar   = candles15m[warmup] || candles15m[0];
  const startPrice = startBar.c;
  const hodlQty    = INITIAL_CAPITAL / startPrice;
  const hodlValue  = hodlQty * finalPrice;

  let peak = INITIAL_CAPITAL;
  let maxDD = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak - pt.equity;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    candleCount: candles15m.length,
    daysCovered: (candles15m.at(-1).t - candles15m[0].t) / 86_400_000,
    startPrice, endPrice: finalPrice,
    cash, btcQty, finalValue,
    pnl: finalValue - INITIAL_CAPITAL,
    pnlPct: (finalValue - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100,
    hodlValue, hodlPnl: hodlValue - INITIAL_CAPITAL,
    hodlPnlPct: (hodlValue - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100,
    maxDD, regimeCount, trades,
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────
const f2  = n => n.toFixed(2);
const f6  = n => n.toFixed(6);
const fp  = n => (n >= 0 ? "+" : "") + "$" + Math.abs(n).toFixed(2);
const fpp = n => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";

function tradeTag(t) {
  if (t.type === "scaled_buy")    return `BUY  BOS  #${t.bosNum}`;
  if (t.type === "choch_buy")     return `BUY  CHOCH #${t.bosNum}`;
  if (t.type === "final_buy")     return `BUY  CHOCH ★ (all-in)`;
  if (t.type === "scaled_sell")   return `SELL BOS  #${t.bosNum}`;
  if (t.type === "choch_sell")    return `SELL CHOCH #${t.bosNum}`;
  if (t.type === "final_sell")    return `SELL CHOCH ★ (all-out)`;
  if (t.type === "regime_change") return `>>> ${t.to.toUpperCase()} REGIME${t.source ? ` (${t.source})` : ""}`;
  return t.type;
}

function printScenarioResult(label, r) {
  const counts = r.trades.reduce((m, t) => ((m[t.type] = (m[t.type] || 0) + 1), m), {});
  const buys   = r.trades.filter(t => t.type === "scaled_buy"  || t.type === "choch_buy"  || t.type === "final_buy");
  const sells  = r.trades.filter(t => t.type === "scaled_sell" || t.type === "choch_sell" || t.type === "final_sell");
  const avgBuy  = buys.length  ? buys.reduce((s, t) => s + t.usd, 0)  / buys.reduce((s, t) => s + t.qty, 0)  : 0;
  const avgSell = sells.length ? sells.reduce((s, t) => s + t.usd, 0) / sells.reduce((s, t) => s + t.qty, 0) : 0;

  const edge    = r.pnl - r.hodlPnl;
  const edgePct = r.pnlPct - r.hodlPnlPct;

  console.log(`\n${"═".repeat(62)}`);
  console.log(`  SCENARIO: ${label}`);
  console.log(`${"═".repeat(62)}`);

  console.log(`\n── Period ─────────────────────────────────────────────────`);
  console.log(`  Days       : ${r.daysCovered.toFixed(1)}`);
  console.log(`  BTC start  : $${f2(r.startPrice)}`);
  console.log(`  BTC end    : $${f2(r.endPrice)}  (${fpp((r.endPrice/r.startPrice - 1) * 100)})`);

  console.log(`\n── Trades ─────────────────────────────────────────────────`);
  console.log(`  Regime cycles : ${r.regimeCount.buy} BUY, ${r.regimeCount.sell} SELL`);
  console.log(`  Total trades  : ${buys.length + sells.length}`);
  console.log(`    BOS buys    : ${counts.scaled_buy  || 0}`);
  console.log(`    CHOCH buys  : ${(counts.choch_buy  || 0) + (counts.final_buy  || 0)}`);
  console.log(`    BOS sells   : ${counts.scaled_sell || 0}`);
  console.log(`    CHOCH sells : ${(counts.choch_sell || 0) + (counts.final_sell || 0)}`);
  if (buys.length && avgBuy)    console.log(`  Avg buy price : $${f2(avgBuy)}`);
  if (sells.length && avgSell)  console.log(`  Avg sell price: $${f2(avgSell)}`);
  if (avgBuy && avgSell)        console.log(`  Avg spread    : $${f2(avgSell - avgBuy)}`);

  console.log(`\n── Result ─────────────────────────────────────────────────`);
  console.log(`  Cash      : $${f2(r.cash)}`);
  console.log(`  BTC qty   : ${f6(r.btcQty)} ($${f2(r.btcQty * r.endPrice)})`);
  console.log(`  Total     : $${f2(r.finalValue)}`);
  console.log(`  Strategy  : ${fp(r.pnl)} (${fpp(r.pnlPct)})`);
  console.log(`  HODL      : ${fp(r.hodlPnl)} (${fpp(r.hodlPnlPct)})`);
  console.log(`  Edge      : ${fp(edge)} (${fpp(edgePct)} pts)`);
  console.log(`  Max DD    : $${f2(r.maxDD)}`);
  if (edgePct > 1)       console.log(`  ✅ Strategy OUTPERFORMED HODL`);
  else if (edgePct < -1) console.log(`  ❌ Strategy UNDERPERFORMED HODL`);
  else                   console.log(`  ↔  Strategy ≈ HODL (within 1pt)`);

  if (r.trades.length > 0) {
    console.log(`\n── Trade Log ──────────────────────────────────────────────`);
    for (const t of r.trades) {
      const date = new Date(t.t).toISOString().slice(0, 16).replace("T", " ");
      const tag  = tradeTag(t).padEnd(28);
      if (t.type === "regime_change") {
        console.log(`  ${date}  ${tag} @ $${f2(t.price)}`);
      } else {
        const usd = "$" + f2(t.usd);
        console.log(`  ${date}  ${tag} @ $${f2(t.price).padStart(10)}  ${usd.padStart(8)}  (${f6(t.qty)} BTC)`);
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  Craig Accumulation Backtest — Multi-Symbol / Scenario   ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  Symbols  : ${SYMBOLS.join(", ")}`);
  console.log(`  Regime   : EMA${EMA_FAST_LARGE}/${EMA_SLOW_LARGE} on 1h`);
  console.log(`  Exec     : 15m BOS/CHOCH (swing ${SWING_LB} bars each side)`);
  console.log(`  Scaling  : [${BOS_SCALE_PCT.join(", ")}]% per signal — BOS and CHOCH share the same ladder`);
  console.log(`  CHOCH    : continues scale (no all-in), overflow slot = remaining`);
  console.log(`  CHOCH gate: ${REQUIRE_BOS_BEFORE_CHOCH ? "requires ≥1 BOS first" : "off"}`);
  console.log(`  Capital  : $${INITIAL_CAPITAL} per symbol`);
  console.log(`\n  NOTE: Coinbase API retains ~180 days of 1h data.`);
  console.log(`  2022/2023 bear periods are NOT accessible — testing within available window.\n`);

  // symbolResults[symbol] = [ { label, r | skipped } ]
  const symbolResults = {};

  for (const symbol of SYMBOLS) {
    console.log(`\n${"▓".repeat(62)}`);
    console.log(`  SYMBOL: ${symbol}`);
    console.log(`${"▓".repeat(62)}`);

    const results = [];

    for (const sc of SCENARIOS) {
      const endMs = sc.endDate
        ? new Date(sc.endDate + "T23:59:59Z").getTime()
        : Date.now();

      console.log(`\n  ▸ ${sc.label}`);

      const candles15m = await fetchCandles(symbol, TF.exec, sc.daysExec, endMs);
      const candles1h  = await fetchCandles(symbol, TF.bias, sc.daysBias, endMs);

      if (candles15m.length < 100 || candles1h.length < 250) {
        console.log(`    ⚠ Skipped — insufficient data (15m: ${candles15m.length}, 1h: ${candles1h.length})`);
        results.push({ label: sc.label, skipped: true });
        continue;
      }

      const r = simulate(candles15m, candles1h);
      printScenarioResult(`${symbol} — ${sc.label}`, r);
      results.push({ label: sc.label, r });
    }

    symbolResults[symbol] = results;
  }

  // ── Cross-symbol summary table ─────────────────────────────────────────────
  console.log(`\n${"═".repeat(75)}`);
  console.log(`  MASTER SUMMARY — Strategy % vs HODL % (Edge)`);
  console.log(`${"═".repeat(75)}`);

  const hdr = `  ${"Scenario".padEnd(26)}` +
    SYMBOLS.map(s => s.replace("-USD","").padStart(20)).join("");
  console.log(hdr);
  console.log(`  ${"-".repeat(72)}`);

  for (const sc of SCENARIOS) {
    let row = `  ${sc.label.padEnd(26)}`;
    for (const symbol of SYMBOLS) {
      const entry = (symbolResults[symbol] || []).find(e => e.label === sc.label);
      if (!entry || entry.skipped) {
        row += "             SKIP".padStart(20);
      } else {
        const edge = entry.r.pnlPct - entry.r.hodlPnlPct;
        const icon = edge > 1 ? "✅" : edge < -1 ? "❌" : "↔";
        const cell = `${fpp(entry.r.pnlPct)} / ${fpp(entry.r.hodlPnlPct)} ${icon}`;
        row += cell.padStart(20);
      }
    }
    console.log(row);
  }

  // Edge-only table
  console.log(`\n  ${"─".repeat(72)}`);
  console.log(`  Edge only (Strategy − HODL in % pts):`);
  const hdr2 = `  ${"Scenario".padEnd(26)}` +
    SYMBOLS.map(s => s.replace("-USD","").padStart(16)).join("");
  console.log(hdr2);
  console.log(`  ${"-".repeat(68)}`);

  for (const sc of SCENARIOS) {
    let row = `  ${sc.label.padEnd(26)}`;
    for (const symbol of SYMBOLS) {
      const entry = (symbolResults[symbol] || []).find(e => e.label === sc.label);
      if (!entry || entry.skipped) {
        row += "    SKIP".padStart(16);
      } else {
        const edge = entry.r.pnlPct - entry.r.hodlPnlPct;
        const icon = edge > 1 ? "✅" : edge < -1 ? "❌" : "↔";
        row += `${fpp(edge)} ${icon}`.padStart(16);
      }
    }
    console.log(row);
  }
  console.log("");
}

main().catch(console.error);
