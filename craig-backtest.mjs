/**
 * Craig SMC Strategy — Backtest
 * Tests the 3-Step Range → Change → Execution strategy on historical 1m data.
 *
 * METHODOLOGY
 * ───────────
 * • 15m candles → determine trend bias (bullish / bearish / neutral via BOS)
 * • 1m candles  → detect CHOCH + FVG + LIL setup, then entry/exit
 * • Entry  : candle LOW touches FVG midpoint → fill at FVG midpoint
 * • Stop   : LIL price × (1 − 0.15%)
 * • Target : entry + 4 × risk  (1:4 R:R)
 * • BE     : first 1m swing low confirmed above entry (for longs) → SL → entry
 * • One position at a time per symbol
 * • No look-ahead bias: only confirmed candles used (swingLookback respected)
 *
 * Run: node craig-backtest.mjs
 */

import "dotenv/config";

// ─── Config ───────────────────────────────────────────────────────────────────

const SYMBOLS        = ["BTC-USD", "ETH-USD", "SOL-USD"];
const DAYS_EXEC      = 30;           // 5m execution candles (30 days available)
const DAYS_BIAS      = 35;           // 1h bias candles (extra buffer for warmup)
const RISK_USD       = 15;           // $ risked per trade
const MAX_POS_USD    = 200;          // hard cap on position size
const INITIAL_CAPITAL = 500;         // starting capital for return calculation
const SWING_LB       = 5;            // pivot lookback (bars each side)
const FVG_MIN_GAP    = 0.0005;       // 0.05% minimum FVG size
const CHOCH_BODY     = 0.40;         // 40% body/range for high-impact candle
const SL_BUFFER      = 0.0015;       // 0.15% beyond LIL
const INITIAL_RR     = 4;            // take profit at 4R
const FVG_MAX_AGE    = 90 * 60000;   // discard FVGs older than 90 min (6× 5m bars = 30min equiv)
const SETUP_EXPIRY   = 90 * 60000;   // setup expires after 90 min

// ─── Coinbase Data Fetching ────────────────────────────────────────────────────

// Coinbase 1m candles are only retained for ~5 days.
// 5m candles are retained for ~30 days — used here for the execution TF.
// 1h candles are retained for 180+ days — used for bias.
const CB_GRAN = {
  "5m":  { gran: "FIVE_MINUTE",    secs: 300  },
  "1h":  { gran: "ONE_HOUR",       secs: 3600 },
};

async function fetchCandles(symbol, tf, days) {
  const { gran, secs } = CB_GRAN[tf];
  const totalBars = Math.ceil(days * 86400 / secs) + 50; // +50 warmup bars
  const CB_MAX    = 350;
  let allCandles  = [];
  let batchEnd    = Math.floor(Date.now() / 1000);
  let emptyCount  = 0;

  while (allCandles.length < totalBars) {
    const need       = totalBars - allCandles.length;
    const batchSize  = Math.min(CB_MAX, need);
    const batchStart = batchEnd - batchSize * secs;

    const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${symbol}/candles`
      + `?start=${batchStart}&end=${batchEnd}&granularity=${gran}&limit=${batchSize}`;

    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Coinbase ${res.status} ${symbol} ${tf}`);
    const json = await res.json();

    // Stop only if truly empty (not just slightly short — gaps can cause short batches)
    if (!json.candles?.length) { if (++emptyCount >= 2) break; batchEnd = batchStart; continue; }
    emptyCount = 0;

    const batch = json.candles.slice().reverse().map(c => ({
      time:  parseInt(c.start) * 1000,
      open:  parseFloat(c.open),
      high:  parseFloat(c.high),
      low:   parseFloat(c.low),
      close: parseFloat(c.close),
    }));

    allCandles = [...batch, ...allCandles];
    batchEnd   = batchStart;
    if (json.candles.length === 0) break;
    await new Promise(r => setTimeout(r, 200));
  }

  // Deduplicate and sort
  const seen = new Set();
  return allCandles
    .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a, b) => a.time - b.time);
}

// ─── Indicator Functions (same logic as craig-bot.js) ─────────────────────────

function detectSwings(candles, lb = SWING_LB) {
  const highs = [], lows = [];
  const end = candles.length - lb;
  for (let i = lb; i < end; i++) {
    const slice = candles.slice(i - lb, i + lb + 1);
    const isH = slice.every((c, j) => j === lb || c.high <= candles[i].high);
    const isL = slice.every((c, j) => j === lb || c.low  >= candles[i].low);
    if (isH) highs.push({ idx: i, price: candles[i].high, time: candles[i].time });
    if (isL) lows.push({ idx: i, price: candles[i].low,  time: candles[i].time });
  }
  return { highs, lows };
}

function detectStructure(highs, lows) {
  if (highs.length < 2 || lows.length < 2) return "neutral";
  const isHH = highs.at(-1).price > highs.at(-2).price;
  const isHL  = lows.at(-1).price  > lows.at(-2).price;
  const isLL  = lows.at(-1).price  < lows.at(-2).price;
  const isLH  = highs.at(-1).price < highs.at(-2).price;
  if (isHH && isHL) return "bullish";
  if (isLL && isLH) return "bearish";
  return "neutral";
}

function detectCHOCH(candles, highs, lows, bias) {
  if (bias === "bullish") {
    if (highs.length < 2) return null;
    const lastH = highs.at(-1), prevH = highs.at(-2);
    if (lastH.price >= prevH.price) return null; // no LH to break
    for (let i = lastH.idx + 1; i < candles.length; i++) {
      if (candles[i].close > lastH.price) {
        const body = Math.abs(candles[i].close - candles[i].open);
        const range = candles[i].high - candles[i].low;
        if (range > 0 && body / range >= CHOCH_BODY) {
          return { chochIdx: i, breakLevel: lastH.price, candle: candles[i] };
        }
      }
    }
  }
  if (bias === "bearish") {
    if (lows.length < 2) return null;
    const lastL = lows.at(-1), prevL = lows.at(-2);
    if (lastL.price <= prevL.price) return null; // no HL to break
    for (let i = lastL.idx + 1; i < candles.length; i++) {
      if (candles[i].close < lastL.price) {
        const body = Math.abs(candles[i].close - candles[i].open);
        const range = candles[i].high - candles[i].low;
        if (range > 0 && body / range >= CHOCH_BODY) {
          return { chochIdx: i, breakLevel: lastL.price, candle: candles[i] };
        }
      }
    }
  }
  return null;
}

function detectFVGs(candles, direction) {
  const avg = candles.slice(-20).reduce((s, c) => s + c.close, 0) / 20;
  const minGap = avg * FVG_MIN_GAP;
  const fvgs   = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const [c0, c2] = [candles[i - 1], candles[i + 1]];
    if (direction === "bullish") {
      const gap = c2.low - c0.high;
      if (gap >= minGap) {
        let filled = false;
        for (let j = i + 2; j < candles.length; j++) {
          if (candles[j].close < c0.high) { filled = true; break; }
        }
        if (!filled) fvgs.push({ bottom: c0.high, top: c2.low, midpoint: (c0.high + c2.low) / 2, idx: i, time: candles[i].time });
      }
    } else {
      const gap = c0.low - c2.high;
      if (gap >= minGap) {
        let filled = false;
        for (let j = i + 2; j < candles.length; j++) {
          if (candles[j].close > c0.low) { filled = true; break; }
        }
        if (!filled) fvgs.push({ bottom: c2.high, top: c0.low, midpoint: (c2.high + c0.low) / 2, idx: i, time: candles[i].time });
      }
    }
  }
  return fvgs.reverse().slice(0, 10); // newest first
}

// ─── Build 15m Bias Lookup ────────────────────────────────────────────────────
// Returns a Map<15m_timestamp → structure>

function build15mBiasMap(candles15m) {
  const map = new Map();
  for (let i = SWING_LB * 2 + 2; i < candles15m.length; i++) {
    const slice = candles15m.slice(0, i + 1);
    const { highs, lows } = detectSwings(slice, SWING_LB);
    map.set(candles15m[i].time, detectStructure(highs, lows));
  }
  return map;
}

function get15mBias(ts, candles15m, biasMap) {
  // Find the most recent 15m bar at or before ts
  const bar15m = candles15m.filter(c => c.time <= ts).at(-1);
  if (!bar15m) return "neutral";
  return biasMap.get(bar15m.time) || "neutral";
}

// ─── Simulation ───────────────────────────────────────────────────────────────

function calcSize(entry, sl) {
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return { qty: 0, sizeUSD: 0 };
  let qty     = RISK_USD / risk;
  let sizeUSD = qty * entry;
  if (sizeUSD > MAX_POS_USD) { sizeUSD = MAX_POS_USD; qty = sizeUSD / entry; }
  return { qty, sizeUSD };
}

function runSimulation(symbol, candles1m, candles15m, biasMap) {
  const trades   = [];
  const WIN_1M   = 200;  // 1m window for setup detection

  let phase      = "idle";
  let setup      = null;
  let position   = null;
  let setupExpiry = 0;

  // Start after enough candles for swing detection warmup
  const startIdx = WIN_1M;

  for (let i = startIdx; i < candles1m.length; i++) {
    const bar     = candles1m[i];
    const window1m = candles1m.slice(Math.max(0, i - WIN_1M), i); // completed bars only

    // ── IN POSITION ──────────────────────────────────────────────────────────
    if (phase === "in_position" && position) {
      const { side, entry, sl, tp, qty, beTriggered, entryTime } = position;

      let exitPrice = null, exitReason = null;

      if (side === "long") {
        // Check SL first (conservative — if both hit same bar, SL wins)
        if (bar.low <= sl) {
          exitPrice  = sl;
          exitReason = beTriggered ? "break_even" : "stop_loss";
        } else if (bar.high >= tp) {
          exitPrice  = tp;
          exitReason = "take_profit";
        }

        // Check BE: new swing low confirmed above entry
        if (!position.beTriggered && !exitPrice) {
          const { lows } = detectSwings(window1m, SWING_LB);
          const newLows = lows.filter(l => l.price > entry && l.time > entryTime);
          if (newLows.length > 0) position.beTriggered = true;
        }
      } else {
        if (bar.high >= sl) {
          exitPrice  = sl;
          exitReason = beTriggered ? "break_even" : "stop_loss";
        } else if (bar.low <= tp) {
          exitPrice  = tp;
          exitReason = "take_profit";
        }
        if (!position.beTriggered && !exitPrice) {
          const { highs } = detectSwings(window1m, SWING_LB);
          const newHighs = highs.filter(h => h.price < entry && h.time > entryTime);
          if (newHighs.length > 0) position.beTriggered = true;
        }
      }

      if (exitPrice !== null) {
        const pnl = side === "long"
          ? (exitPrice - entry) * qty
          : (entry - exitPrice) * qty;
        const rMultiple = (exitPrice - entry) / Math.abs(entry - sl) * (side === "long" ? 1 : -1);
        trades.push({
          symbol, side, entry, exitPrice, sl, tp, qty,
          pnl, rMultiple,
          reason: exitReason,
          entryTime: new Date(entryTime).toISOString().slice(0, 16),
          exitTime:  new Date(bar.time).toISOString().slice(0, 16),
        });
        phase    = "idle";
        position = null;
        setup    = null;
      }
      continue; // don't look for new setups while in position
    }

    // ── SETUP DETECTED — WAITING FOR ENTRY ───────────────────────────────────
    if (phase === "setup_detected" && setup) {
      // Expire by time
      if (bar.time > setupExpiry) {
        phase = "idle"; setup = null; continue;
      }

      const { fvg, lil, direction } = setup;

      // Check if FVG was blown through or missed
      const fvgMissed = direction === "bullish" ? bar.low > fvg.top   * 1.005 : bar.high < fvg.bottom * 0.995;
      const fvgVoid   = direction === "bullish" ? bar.close < fvg.bottom * 0.998 : bar.close > fvg.top * 1.002;
      if (fvgMissed || fvgVoid) { phase = "idle"; setup = null; continue; }

      // Entry trigger
      const entryHit = direction === "bullish"
        ? bar.low <= fvg.midpoint
        : bar.high >= fvg.midpoint;

      if (entryHit) {
        const entry = fvg.midpoint;
        const sl    = direction === "bullish"
          ? lil.price * (1 - SL_BUFFER)
          : lil.price * (1 + SL_BUFFER);
        const { qty, sizeUSD } = calcSize(entry, sl);
        if (qty <= 0) { phase = "idle"; setup = null; continue; }
        const tp = direction === "bullish"
          ? entry + INITIAL_RR * (entry - sl)
          : entry - INITIAL_RR * (sl - entry);

        position = { side: direction === "bullish" ? "long" : "short", entry, sl, tp, qty, sizeUSD, beTriggered: false, entryTime: bar.time };
        phase    = "in_position";
        setup    = null;
      }
      continue;
    }

    // ── IDLE — LOOK FOR SETUP ─────────────────────────────────────────────────
    const bias = get15mBias(bar.time, candles15m, biasMap);
    if (bias === "neutral") continue;

    const { highs, lows } = detectSwings(window1m, SWING_LB);
    const choch = detectCHOCH(window1m, highs, lows, bias);
    if (!choch) continue;

    const direction = bias === "bullish" ? "bullish" : "bearish";
    const allFVGs   = detectFVGs(window1m, direction);
    const now       = bar.time;
    const nearFVGs  = allFVGs.filter(f =>
      Math.abs(f.idx - choch.chochIdx) <= 5 &&
      (now - f.time) <= FVG_MAX_AGE
    );
    if (!nearFVGs.length) continue;

    const fvg = nearFVGs[0];

    // LIL: swing low/high before CHOCH
    let lil = null;
    if (direction === "bullish") {
      const before = lows.filter(l => l.idx < choch.chochIdx);
      lil = before.at(-1);
    } else {
      const before = highs.filter(h => h.idx < choch.chochIdx);
      lil = before.at(-1);
    }
    if (!lil) continue;

    // Don't enter if price already past FVG
    const alreadyPast = direction === "bullish" ? bar.close > fvg.top : bar.close < fvg.bottom;
    if (alreadyPast) continue;

    setup       = { direction, fvg, lil, choch };
    phase       = "setup_detected";
    setupExpiry = bar.time + SETUP_EXPIRY;
  }

  return trades;
}

// ─── Reporting ────────────────────────────────────────────────────────────────

function report(symbol, trades) {
  if (!trades.length) {
    console.log(`\n${symbol}: 0 trades in available data window`);
    return { symbol, trades: 0, wins: 0, losses: 0, wr: 0, pf: 0, totalPnL: 0, maxDD: 0, avgR: 0 };
  }

  const wins   = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const wr     = wins / trades.length;

  const grossWin  = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf        = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const totalPnL  = trades.reduce((s, t) => s + t.pnl, 0);
  const avgR      = trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length;

  // Max drawdown
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  const byReason = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] || 0) + 1;

  const spanDays = trades.length > 0
    ? ((trades.at(-1).exitTime ? new Date(trades.at(-1).exitTime) : new Date()) - new Date(trades[0].entryTime)) / 86400000
    : 0;
  console.log(`\n${"═".repeat(52)}`);
  console.log(`  ${symbol}  (${trades.length} trades · ~${spanDays.toFixed(1)} days)`);
  console.log(`${"═".repeat(52)}`);
  console.log(`  Win Rate    : ${(wr * 100).toFixed(1)}%  (${wins}W / ${losses}L)`);
  console.log(`  Profit Factor: ${isFinite(pf) ? pf.toFixed(2) : "∞"}`);
  console.log(`  Avg R/trade : ${avgR.toFixed(2)}R`);
  console.log(`  Total PnL   : $${totalPnL.toFixed(2)}`);
  console.log(`  Max Drawdown: $${maxDD.toFixed(2)}`);
  console.log(`  Exits       : ${Object.entries(byReason).map(([k,v]) => `${k.replace(/_/g," ")} ×${v}`).join("  |  ")}`);

  // Last 5 trades
  console.log(`\n  Recent trades:`);
  for (const t of trades.slice(-5)) {
    const dir = t.side === "long" ? "▲ LONG " : "▼ SHORT";
    const res = t.pnl >= 0 ? "✅" : "❌";
    console.log(`    ${res} ${dir} ${t.entryTime}  entry $${t.entry.toFixed(2)} → $${t.exitPrice.toFixed(2)}  ${t.rMultiple.toFixed(2)}R  $${t.pnl.toFixed(2)}  (${t.reason.replace(/_/g," ")})`);
  }

  return { symbol, trades: trades.length, wins, losses, wr, pf, totalPnL, maxDD, avgR };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nCraig SMC Backtest — 5m execution / 1h bias`);
  console.log(`Note: Uses 5-minute candles (30-day history available) as proxy for 1m strategy.`);
  console.log(`Setup logic identical — CHOCH + FVG + LIL detection, same filters.`);
  console.log(`Risk $${RISK_USD}/trade | 1:${INITIAL_RR} R:R | Starting capital $${INITIAL_CAPITAL}`);
  console.log(`Symbols: ${SYMBOLS.join(", ")}\n`);

  const allResults = [];

  for (const symbol of SYMBOLS) {
    process.stdout.write(`  ${symbol}: fetching 1h bias...`);
    const candles15m = await fetchCandles(symbol, "1h", DAYS_BIAS);
    process.stdout.write(` ${candles15m.length} bars  |  fetching 5m exec...`);
    const candles1m  = await fetchCandles(symbol, "5m", DAYS_EXEC);
    process.stdout.write(` ${candles1m.length} bars  |  simulating...`);

    const biasMap = build15mBiasMap(candles15m);
    const trades  = runSimulation(symbol, candles1m, candles15m, biasMap);
    process.stdout.write(` ${trades.length} trades found\n`);

    const result = report(symbol, trades);
    allResults.push(result);
  }

  // ── Combined Summary ──────────────────────────────────────────────────────
  const allTrades = allResults.reduce((s, r) => s + r.trades, 0);
  const allWins   = allResults.reduce((s, r) => s + r.wins, 0);
  const allPnL    = allResults.reduce((s, r) => s + r.totalPnL, 0);
  const grossW    = allResults.filter(r => r.totalPnL > 0).reduce((s, r) => s + r.totalPnL, 0);
  const grossL    = Math.abs(allResults.filter(r => r.totalPnL <= 0).reduce((s, r) => s + r.totalPnL, 0));

  console.log(`\n${"═".repeat(52)}`);
  console.log(`  COMBINED SUMMARY — BTC + ETH + SOL`);
  console.log(`${"═".repeat(52)}`);
  console.log(`  Total Trades  : ${allTrades}`);
  console.log(`  Overall WR    : ${allTrades > 0 ? ((allWins / allTrades) * 100).toFixed(1) : 0}%`);
  console.log(`  Combined PnL  : $${allPnL.toFixed(2)}`);
  console.log(`  Profit Factor : ${grossL > 0 ? (grossW / grossL).toFixed(2) : "∞"}`);
  console.log(`  Start capital : $${INITIAL_CAPITAL.toFixed(2)}`);
  console.log(`  End capital   : $${(INITIAL_CAPITAL + allPnL).toFixed(2)}  (${((allPnL / INITIAL_CAPITAL) * 100).toFixed(1)}%)`);
  console.log(`\n  Per-symbol breakdown:`);
  for (const r of allResults) {
    console.log(`    ${r.symbol.padEnd(8)} ${r.trades} trades  WR ${(r.wr * 100).toFixed(0)}%  PnL $${r.totalPnL.toFixed(2)}  PF ${isFinite(r.pf) ? r.pf.toFixed(2) : "∞"}  MaxDD $${r.maxDD.toFixed(2)}`);
  }
  console.log();
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
