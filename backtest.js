/**
 * Backtest — Contrarian Golden/Death Cross Strategy
 *
 * Fetches candle data from Coinbase Advanced Trade public API,
 * then replays the strategy bar-by-bar and reports detailed statistics.
 *
 * Run:  node backtest.js
 * Args: --symbol BTCUSDT   (single symbol override)
 *       --interval 5m      (candle size, default 1h)
 *       --limit 1440       (number of candles, default 1000)
 *       --relaxed          (also test 3-of-5 condition variant)
 */

import "dotenv/config";
import { writeFileSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────

const SYMBOLS   = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT,AKTUSDT").split(",").map(s => s.trim());
const INTERVAL  = process.argv.includes("--interval") ? process.argv[process.argv.indexOf("--interval") + 1] : "1h";
const LIMIT     = process.argv.includes("--limit")    ? parseInt(process.argv[process.argv.indexOf("--limit") + 1]) : 1000;
const STOP_PCT  = 2.0;    // stop-loss  %
const TP_PCT    = 5.0;    // take-profit %
const MAX_HOLD  = 72;     // max bars to hold before force-exit

const overrideSymbol = process.argv.includes("--symbol") ? process.argv[process.argv.indexOf("--symbol") + 1] : null;
const symbols = overrideSymbol ? [overrideSymbol] : SYMBOLS;
const testRelaxed = process.argv.includes("--relaxed");

// ─── Market data (Coinbase Advanced Trade — no auth required) ─────────────────

const CB_GRANULARITY = {
  "1m":  { gran: "ONE_MINUTE",     secs: 60    },
  "5m":  { gran: "FIVE_MINUTE",    secs: 300   },
  "15m": { gran: "FIFTEEN_MINUTE", secs: 900   },
  "30m": { gran: "THIRTY_MINUTE",  secs: 1800  },
  "1h":  { gran: "ONE_HOUR",       secs: 3600  },
  "1H":  { gran: "ONE_HOUR",       secs: 3600  },
  "2h":  { gran: "TWO_HOUR",       secs: 7200  },
  "4h":  { gran: "ONE_HOUR",       secs: 3600  }, // no 4H on Coinbase → 1H
  "4H":  { gran: "ONE_HOUR",       secs: 3600  },
  "6H":  { gran: "SIX_HOUR",       secs: 21600 },
  "1d":  { gran: "ONE_DAY",        secs: 86400 },
  "1D":  { gran: "ONE_DAY",        secs: 86400 },
};
const CB_MAX = 350;

function toCbSymbol(s) {
  if (s.endsWith("USDT")) return s.slice(0, -4) + "-USD";
  if (s.endsWith("USD"))  return s.slice(0, -3) + "-USD";
  return s;
}

async function fetchCandles(symbol) {
  const cbSym = toCbSymbol(symbol);
  const { gran, secs } = CB_GRANULARITY[INTERVAL] || CB_GRANULARITY["1h"];
  let all = [], batchEnd = Math.floor(Date.now() / 1000);

  while (all.length < LIMIT) {
    const n     = Math.min(CB_MAX, LIMIT - all.length);
    const start = batchEnd - n * secs;
    const url   = `https://api.coinbase.com/api/v3/brokerage/market/products/${cbSym}/candles` +
                  `?start=${start}&end=${batchEnd}&granularity=${gran}&limit=${n}`;
    const res   = await fetch(url);
    if (!res.ok) throw new Error(`Coinbase ${res.status}: ${cbSym}`);
    const json  = await res.json();
    if (!json.candles || json.candles.length === 0) break;
    const batch = json.candles.slice().reverse().map(c => ({
      time: +c.start * 1000, open: +c.open, high: +c.high,
      low: +c.low, close: +c.close, volume: +c.volume,
    }));
    all = [...batch, ...all];
    batchEnd = start;
    if (json.candles.length < n) break;
    if (all.length < LIMIT) await new Promise(r => setTimeout(r, 150));
  }
  return all.slice(-LIMIT);
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function sma(closes, n) {
  if (closes.length < n) return null;
  return closes.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  const ag = g / n, al = l / n;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function bb(closes, n = 20, k = 2) {
  if (closes.length < n) return null;
  const sl = closes.slice(-n);
  const m  = sl.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(sl.reduce((s, v) => s + (v - m) ** 2, 0) / n);
  return { upper: m + k * sd, middle: m, lower: m - k * sd };
}

function stochRSI(closes, rsiP = 14, stP = 14, kSmooth = 3) {
  const needed = rsiP + stP + kSmooth + 1;
  if (closes.length < needed) return null;
  const rsiSeries = [];
  for (let i = rsiP; i <= closes.length; i++) {
    const sl = closes.slice(i - rsiP - 1, i);
    let g = 0, l = 0;
    for (let j = 1; j < sl.length; j++) { const d = sl[j] - sl[j - 1]; d > 0 ? g += d : l -= d; }
    const ag = g / rsiP, al = l / rsiP;
    rsiSeries.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  const stoch = [];
  for (let i = stP; i <= rsiSeries.length; i++) {
    const sl = rsiSeries.slice(i - stP, i);
    const hi = Math.max(...sl), lo = Math.min(...sl);
    stoch.push(hi === lo ? 50 : (rsiSeries[i - 1] - lo) / (hi - lo) * 100);
  }
  if (stoch.length < kSmooth) return null;
  return stoch.slice(-kSmooth).reduce((a, b) => a + b, 0) / kSmooth;
}

function volRatio(candles, n = 20) {
  if (candles.length < n + 1) return null;
  const avg = candles.slice(-n - 1, -1).reduce((s, c) => s + c.volume, 0) / n;
  return avg === 0 ? null : candles[candles.length - 1].volume / avg;
}

// ─── Daily regime fetch ───────────────────────────────────────────────────────
// Fetches 210 daily candles per symbol once, returns MA50d/MA200d for regime.

const dailyRegimeCache = {};

async function getDailyRegime(symbol) {
  if (dailyRegimeCache[symbol]) return dailyRegimeCache[symbol];
  try {
    const cbSym = toCbSymbol(symbol);
    const { gran, secs } = CB_GRANULARITY["1d"];
    let all = [], batchEnd = Math.floor(Date.now() / 1000);
    while (all.length < 210) {
      const n = Math.min(CB_MAX, 210 - all.length);
      const start = batchEnd - n * secs;
      const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${cbSym}/candles` +
                  `?start=${start}&end=${batchEnd}&granularity=${gran}&limit=${n}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Coinbase daily ${res.status}: ${cbSym}`);
      const json = await res.json();
      if (!json.candles || json.candles.length === 0) break;
      const batch = json.candles.slice().reverse().map(c => ({
        time: +c.start * 1000, close: +c.close,
      }));
      all = [...batch, ...all];
      batchEnd = start;
      if (json.candles.length < n) break;
      await new Promise(r => setTimeout(r, 150));
    }
    const closes = all.map(c => c.close);
    const result = { ma50d: sma(closes, 50), ma200d: sma(closes, 200) };
    dailyRegimeCache[symbol] = result;
    return result;
  } catch (err) {
    return { ma50d: null, ma200d: null };
  }
}

// ─── Single-bar indicator snapshot ───────────────────────────────────────────

function indicators(candles) {
  const closes = candles.map(c => c.close);
  const price  = closes.at(-1);
  return {
    price,
    ma50:  sma(closes, 50),    // 50×5m = ~4.2hrs
    ma200: sma(closes, 200),   // 200×5m = ~16.7hrs
    rsi14: rsi(closes, 14),    // Contrarian G/D Cross uses RSI(14)
    bands: bb(closes, 20, 2),
    stRsi: stochRSI(closes),   // booster only
    volR:  volRatio(candles, 20),
  };
}

// ─── Entry conditions — matches TradingView "Contrarian G/D Cross" strategy ──
// Hard gates: Regime (MA50/MA200) + RSI(14) at 38/62 = 2 conditions only.
// StochRSI, BB, Volume are signal strength BOOSTERS — NOT hard gates.

function conditions(ind) {
  const { ma50, ma200, rsi14 } = ind;
  return {
    long: [
      { name: "5m Death Cross (MA50 < MA200)", met: ma50 && ma200 && ma50 < ma200 },
      { name: "RSI(14) ≤ 38",                  met: rsi14 !== null && rsi14 <= 38 },
    ],
    short: [
      { name: "5m Golden Cross (MA50 > MA200)", met: ma50 && ma200 && ma50 > ma200 },
      { name: "RSI(14) ≥ 62",                   met: rsi14 !== null && rsi14 >= 62 },
    ],
  };
}

// ─── Backtest engine ──────────────────────────────────────────────────────────

function runBacktest(candles, symbol, minConditions = 2) {
  const trades = [];
  let position  = null;
  const WARMUP  = 210; // need 200 bars for MA200

  for (let i = WARMUP; i < candles.length - 1; i++) {
    const snap  = indicators(candles.slice(0, i + 1));
    const conds = conditions(snap);
    const { price } = snap;

    const longMet  = conds.long.filter(c => c.met).length;
    const shortMet = conds.short.filter(c => c.met).length;

    // ── Exit open position ──
    if (position) {
      const holdBars = i - position.entryIndex;
      const pnl = position.side === "long"
        ? (price - position.entryPrice) / position.entryPrice * 100
        : (position.entryPrice - price) / position.entryPrice * 100;

      let exitReason = null;
      if      (pnl <= -STOP_PCT)                          exitReason = "stop_loss";
      else if (pnl >=  TP_PCT)                            exitReason = "take_profit";
      else if (holdBars >= MAX_HOLD)                      exitReason = "max_hold";
      else if (position.side === "long"  && snap.bands && price >= snap.bands.middle) exitReason = "bb_middle";
      else if (position.side === "short" && snap.bands && price <= snap.bands.middle) exitReason = "bb_middle";

      if (exitReason) {
        trades.push({ ...position, exitPrice: price, exitIndex: i, pnl, exitReason, holdBars,
          exitTime: new Date(candles[i].time).toISOString() });
        position = null;
      }
    }

    // ── Enter new position ──
    if (!position) {
      if (longMet >= minConditions) {
        position = { side: "long",  entryPrice: price, entryIndex: i,
          entryTime: new Date(candles[i].time).toISOString(),
          conditionsMet: longMet, symbol };
      } else if (shortMet >= minConditions) {
        position = { side: "short", entryPrice: price, entryIndex: i,
          entryTime: new Date(candles[i].time).toISOString(),
          conditionsMet: shortMet, symbol };
      }
    }
  }

  // Close any open trade at last bar
  if (position) {
    const price    = candles.at(-1).close;
    const holdBars = candles.length - 1 - position.entryIndex;
    const pnl = position.side === "long"
      ? (price - position.entryPrice) / position.entryPrice * 100
      : (position.entryPrice - price) / position.entryPrice * 100;
    trades.push({ ...position, exitPrice: price, exitIndex: candles.length - 1,
      pnl, exitReason: "still_open", holdBars,
      exitTime: new Date(candles.at(-1).time).toISOString() });
  }

  return trades;
}

// ─── Per-condition miss analysis ──────────────────────────────────────────────
// Counts how often each individual condition was the ONLY thing blocking an entry

function nearMissAnalysis(candles, minConditions = 2) {
  const WARMUP = 210;
  const counts = {};

  for (let i = WARMUP; i < candles.length - 1; i++) {
    const snap  = indicators(candles.slice(0, i + 1));
    const conds = conditions(snap);

    for (const side of ["long", "short"]) {
      const all = conds[side];
      const met = all.filter(c => c.met);
      const missed = all.filter(c => !c.met);
      if (met.length === all.length - 1 && missed.length === 1) {
        // Near-miss: only 1 condition missing
        const k = `${side}:${missed[0].name}`;
        counts[k] = (counts[k] || 0) + 1;
      }
    }
  }

  return counts;
}

// ─── Stats summary ────────────────────────────────────────────────────────────

function stats(trades, label) {
  const n      = trades.length;
  if (n === 0) return { label, n: 0 };

  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winPct = (wins.length / n * 100).toFixed(1);
  const avgWin = wins.length   ? wins.reduce((s, t)   => s + t.pnl, 0) / wins.length   : 0;
  const avgLoss= losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const profitFactor = losses.length === 0 ? Infinity
    : Math.abs(wins.reduce((s, t) => s + t.pnl, 0) / losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  // Max drawdown (running sum of pnl)
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  const avgHold = (trades.reduce((s, t) => s + t.holdBars, 0) / n).toFixed(1);
  const best  = trades.reduce((b, t) => t.pnl > b.pnl ? t : b, trades[0]);
  const worst = trades.reduce((b, t) => t.pnl < b.pnl ? t : b, trades[0]);

  // Exit reason breakdown
  const exits = {};
  for (const t of trades) exits[t.exitReason] = (exits[t.exitReason] || 0) + 1;

  return { label, n, winPct, avgWin: avgWin.toFixed(2), avgLoss: avgLoss.toFixed(2),
    profitFactor: profitFactor === Infinity ? "∞" : profitFactor.toFixed(2),
    totalPnl: totalPnl.toFixed(2), maxDD: maxDD.toFixed(2), avgHold,
    best:  { pnl: best.pnl.toFixed(2),  time: best.entryTime,  exit: best.exitReason  },
    worst: { pnl: worst.pnl.toFixed(2), time: worst.entryTime, exit: worst.exitReason },
    exits, wins: wins.length, losses: losses.length };
}

// ─── Pretty print ─────────────────────────────────────────────────────────────

function printStats(s, indent = "") {
  if (s.n === 0) { console.log(`${indent}  No trades triggered.`); return; }
  console.log(`${indent}  Trades     : ${s.n}  (${s.wins}W / ${s.losses}L)`);
  console.log(`${indent}  Win rate   : ${s.winPct}%`);
  console.log(`${indent}  Avg win    : +${s.avgWin}%`);
  console.log(`${indent}  Avg loss   : ${s.avgLoss}%`);
  console.log(`${indent}  Profit fct : ${s.profitFactor}`);
  console.log(`${indent}  Total PnL  : ${s.totalPnl}%`);
  console.log(`${indent}  Max DD     : -${s.maxDD}%`);
  console.log(`${indent}  Avg hold   : ${s.avgHold} bars`);
  console.log(`${indent}  Best trade : +${s.best.pnl}%  (${s.best.exit})  @ ${s.best.time}`);
  console.log(`${indent}  Worst trade: ${s.worst.pnl}%  (${s.worst.exit}) @ ${s.worst.time}`);
  console.log(`${indent}  Exit reasons:`);
  for (const [k, v] of Object.entries(s.exits))
    console.log(`${indent}    ${k.padEnd(14)}: ${v}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Backtest — Contrarian Golden/Death Cross Strategy");
  console.log(`  Interval: ${INTERVAL}  |  Bars: ${LIMIT}  |  Symbols: ${symbols.join(", ")}`);
  console.log(`  Rules: SL=${STOP_PCT}%  TP=${TP_PCT}%  MaxHold=${MAX_HOLD} bars`);
  console.log(`  Exit: BB middle reversion or SL/TP`);
  console.log("═══════════════════════════════════════════════════════════\n");

  const allTrades = [];
  const allNearMisses = {};
  const symbolResults = [];

  for (const sym of symbols) {
    console.log(`\n── ${sym} ${"─".repeat(52 - sym.length)}`);

    let candles;
    try {
      process.stdout.write("  Fetching candles...");
      candles = await fetchCandles(sym);
      console.log(` ${candles.length} bars  (${new Date(candles[0].time).toLocaleDateString()} → ${new Date(candles.at(-1).time).toLocaleDateString()})`);
    } catch (err) {
      console.log(`\n  ⚠️  Fetch failed: ${err.message}`);
      continue;
    }

    // ── Strict (both conditions: Regime + RSI(14)) ──
    const strict = runBacktest(candles, sym, 2);
    const s4     = stats(strict, `${sym} strict`);
    console.log(`\n  ▶ STRICT (both conditions met: Regime + RSI(14) at 38/62)`);
    printStats(s4, "  ");
    allTrades.push(...strict);
    symbolResults.push({ sym, mode: "strict", ...s4 });

    // ── Relaxed (regime only, ignore RSI) ──
    if (testRelaxed) {
      const relaxed = runBacktest(candles, sym, 1);
      const s3      = stats(relaxed, `${sym} relaxed`);
      console.log(`\n  ▶ RELAXED (regime only — RSI(14) not required)`);
      printStats(s3, "  ");
      symbolResults.push({ sym, mode: "relaxed", ...s3 });
    }

    // ── Near-miss analysis ──
    const nm = nearMissAnalysis(candles, 2);
    console.log(`\n  ▶ Near-misses (1/2 met — what's blocking entries?)`);
    if (Object.keys(nm).length === 0) {
      console.log("     None found.");
    } else {
      const sorted = Object.entries(nm).sort((a, b) => b[1] - a[1]);
      for (const [k, v] of sorted)
        console.log(`     ${v.toString().padStart(4)}×  ${k}`);
      for (const [k, v] of sorted) allNearMisses[k] = (allNearMisses[k] || 0) + v;
    }
  }

  // ── Combined across all symbols ──
  if (symbols.length > 1 && allTrades.length > 0) {
    console.log(`\n${"═".repeat(59)}`);
    console.log("  COMBINED — All symbols strict");
    console.log("═".repeat(59));
    printStats(stats(allTrades, "combined"), "");
  }

  // ── Global near-miss summary ──
  if (Object.keys(allNearMisses).length > 0) {
    console.log(`\n${"═".repeat(59)}`);
    console.log("  NEAR-MISS SUMMARY — conditions blocking the most entries");
    console.log("═".repeat(59));
    const sorted = Object.entries(allNearMisses).sort((a, b) => b[1] - a[1]);
    for (const [k, v] of sorted)
      console.log(`  ${v.toString().padStart(5)}×  ${k}`);
  }

  // ── Individual trade list ──
  console.log(`\n${"═".repeat(59)}`);
  console.log("  ALL STRICT TRADES");
  console.log("═".repeat(59));
  if (allTrades.length === 0) {
    console.log("  No trades triggered under strict conditions.");
    console.log("  → Try running with --relaxed to see looser signals.");
  } else {
    console.log(`  ${"Time".padEnd(22)} ${"Sym".padEnd(8)} ${"Side".padEnd(6)} ${"Entry".padEnd(10)} ${"Exit".padEnd(10)} ${"PnL".padEnd(8)} Exit`);
    console.log("  " + "─".repeat(74));
    for (const t of allTrades) {
      const pnlStr = (t.pnl >= 0 ? "+" : "") + t.pnl.toFixed(2) + "%";
      const pnlCol = t.pnl >= 0 ? pnlStr : pnlStr;
      console.log(
        `  ${t.entryTime.slice(0, 19).replace("T", " ").padEnd(22)}` +
        `${t.symbol.padEnd(8)}` +
        `${t.side.padEnd(6)}` +
        `$${t.entryPrice.toFixed(2).padEnd(10)}` +
        `$${t.exitPrice.toFixed(2).padEnd(10)}` +
        `${pnlCol.padEnd(8)}` +
        t.exitReason
      );
    }
  }

  // ── Save JSON results ──
  const out = { timestamp: new Date().toISOString(), interval: INTERVAL,
    symbols, config: { STOP_PCT, TP_PCT, MAX_HOLD },
    symbolResults, allTrades,
    nearMisses: allNearMisses };
  writeFileSync("backtest-results.json", JSON.stringify(out, null, 2));
  console.log(`\n  📄 Full results saved → backtest-results.json\n`);

  // ── Verdict ──
  console.log("═".repeat(59));
  console.log("  VERDICT");
  console.log("═".repeat(59));
  if (allTrades.length === 0) {
    console.log(`
  ⚠️  Zero strict trades triggered in ${LIMIT} bars of ${INTERVAL} data.
  This means both conditions (Regime + RSI(14) at 38/62) never aligned.

  Most likely causes:
  • MA50/MA200 cross doesn't happen often on ${INTERVAL} timeframe
  • RSI(14) ≤ 38 / ≥ 62 requires genuine momentum exhaustion

  What to try:
  1. Run with --relaxed (regime only, no RSI gate)
  2. Run with --interval 4H or 1d (longer candles, more regime crossings)
  3. Add more bars with --limit 2000
    `);
  } else {
    const combined = stats(allTrades, "combined");
    const pf = parseFloat(combined.profitFactor);
    const wr = parseFloat(combined.winPct);
    if (pf > 1.5 && wr > 50) {
      console.log(`\n  ✅ Strategy looks VIABLE — PF ${combined.profitFactor}, WR ${combined.winPct}%`);
    } else if (pf > 1 && wr > 40) {
      console.log(`\n  ⚠️  Strategy is MARGINAL — worth refining conditions`);
    } else {
      console.log(`\n  ❌ Strategy is NOT profitable under these settings — needs adjustment`);
    }
    console.log(`\n  Key takeaways:`);
    const stopCount = allTrades.filter(t => t.exitReason === "stop_loss").length;
    const tpCount   = allTrades.filter(t => t.exitReason === "take_profit").length;
    const bbCount   = allTrades.filter(t => t.exitReason === "bb_middle").length;
    console.log(`  • Stop-loss hits  : ${stopCount}/${allTrades.length} (${(stopCount/allTrades.length*100).toFixed(0)}%)`);
    console.log(`  • Take-profit hits: ${tpCount}/${allTrades.length} (${(tpCount/allTrades.length*100).toFixed(0)}%)`);
    console.log(`  • BB middle exits : ${bbCount}/${allTrades.length} (${(bbCount/allTrades.length*100).toFixed(0)}%)`);
  }
  console.log("═".repeat(59) + "\n");
}

main().catch(err => { console.error("Backtest error:", err); process.exit(1); });
