/**
 * E2 Ensemble Backtest — mirrors bot.js strategy logic exactly
 *
 * Leg A — Donchian-GC Trend (70% of equity)
 *   Entry : close > Don20H AND EMA50 > EMA200 AND close > EMA50
 *   Exit  : close < Don10L  OR  close >= entry + 5×ATR
 *
 * Leg B — Hybrid Mean-Reversion (30% of equity)
 *   Entry : (death-cross AND RSI14 ≤ 30) OR (GC AND close < EMA50 AND RSI14 ≤ 45)
 *   Exit  : close >= entry + 5×ATR
 *
 * Sizing : 10% of leg equity per trade (compounding)
 * Fee    : 0.60% taker (entry + exit)
 * Max    : 10 concurrent positions per leg
 */

import "dotenv/config";

// ─── Config ──────────────────────────────────────────────────────────────────
const SYMBOLS      = ["BTCUSDT","ETHUSDT","SOLUSDT","LINKUSDT","DOGEUSDT"];
const STARTING_CAP = 1163.14;
const LEG_A_SPLIT  = 0.70;
const LEG_B_SPLIT  = 0.30;
const SIZING_PCT   = 0.10;
const TP_ATR_MULT  = 5;
const FEE_RATE     = 0.006;   // 0.6% taker
const MAX_CONCURRENT = 10;
const CANDLE_LIMIT = 1500;    // ~1 year of 6h bars

// ─── Coinbase market data (public endpoint — no auth needed) ──────────────────

function toCBSymbol(symbol) {
  if (symbol.endsWith("USDT")) return symbol.slice(0, -4) + "-USD";
  if (symbol.endsWith("USD"))  return symbol.slice(0, -3) + "-USD";
  return symbol;
}

async function fetchCandles(symbol, limit = CANDLE_LIMIT) {
  const cbSym   = toCBSymbol(symbol);
  const secs    = 21600; // 6h in seconds
  const maxPage = 350;
  let allCandles = [];
  let batchEnd   = Math.floor(Date.now() / 1000);

  while (allCandles.length < limit) {
    const batchSize  = Math.min(maxPage, limit - allCandles.length);
    const batchStart = batchEnd - batchSize * secs;
    const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${cbSym}/candles`
      + `?start=${batchStart}&end=${batchEnd}&granularity=SIX_HOUR&limit=${batchSize}`;

    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${cbSym}`);
    const json = await res.json();
    if (!json.candles?.length) break;

    const batch = json.candles.slice().reverse().map(c => ({
      time:  parseInt(c.start) * 1000,
      open:  parseFloat(c.open),
      high:  parseFloat(c.high),
      low:   parseFloat(c.low),
      close: parseFloat(c.close),
    }));
    allCandles = [...batch, ...allCandles];
    batchEnd   = batchStart;
    if (json.candles.length < batchSize) break;
    if (allCandles.length < limit) await new Promise(r => setTimeout(r, 200));
  }
  return allCandles.slice(-limit);
}

// ─── Indicators (vectorized) ──────────────────────────────────────────────────

function emaArr(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let val = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = val;
  for (let i = period; i < closes.length; i++) {
    val = closes[i] * k + val * (1 - k);
    out[i] = val;
  }
  return out;
}

function rsiArr(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  for (let i = period; i < closes.length; i++) {
    let gains = 0, losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - closes[j - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    const ag = gains / period, al = losses / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function atrArr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const h = candles[j].high, l = candles[j].low, pc = candles[j - 1].close;
      sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    out[i] = sum / period;
  }
  return out;
}

// Donchian high of the `period` bars BEFORE bar i (excludes bar i itself — same as live bot)
function donHighArr(candles, period) {
  const out = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let max = -Infinity;
    for (let j = i - period; j < i; j++) max = Math.max(max, candles[j].high);
    out[i] = max;
  }
  return out;
}

function donLowArr(candles, period) {
  const out = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let min = Infinity;
    for (let j = i - period; j < i; j++) min = Math.min(min, candles[j].low);
    out[i] = min;
  }
  return out;
}

// ─── Portfolio simulation ─────────────────────────────────────────────────────

function simulate(allCandles) {
  const legA = { cash: STARTING_CAP * LEG_A_SPLIT };
  const legB = { cash: STARTING_CAP * LEG_B_SPLIT };
  const posA = {};   // symbol → { entryPrice, qty, cost, atrAtEntry, entryBar, entryDate }
  const posB = {};
  const trades = [];
  const equityCurve = [];

  // Compute indicators for every symbol
  const ind = {};
  for (const sym of SYMBOLS) {
    if (!allCandles[sym]) continue;
    const c = allCandles[sym];
    const closes = c.map(x => x.close);
    ind[sym] = {
      ema50:  emaArr(closes, 50),
      ema200: emaArr(closes, 200),
      rsi14:  rsiArr(closes, 14),
      atr14:  atrArr(c, 14),
      don20H: donHighArr(c, 20),
      don10L: donLowArr(c, 10),
    };
  }

  // Build unified sorted timeline from BTC (longest/most complete)
  const anchor = allCandles["BTCUSDT"] || Object.values(allCandles)[0];
  const barIdx = {};
  for (const sym of SYMBOLS) {
    if (!allCandles[sym]) continue;
    barIdx[sym] = new Map(allCandles[sym].map((c, i) => [c.time, i]));
  }

  for (let bi = 0; bi < anchor.length; bi++) {
    const t = anchor[bi].time;
    if (bi < 210) continue;

    // ── Exits ───────────────────────────────────────────────────────────
    for (const sym of SYMBOLS) {
      if (!allCandles[sym]) continue;
      const i = barIdx[sym].get(t);
      if (i == null || i < 210) continue;

      const c     = allCandles[sym][i];
      const close = c.close;
      const d10l  = ind[sym].don10L[i];
      const atr   = ind[sym].atr14[i];

      // Leg A exit: TP or Donchian10 stop
      if (posA[sym]) {
        const pos     = posA[sym];
        const tpPrice = pos.entryPrice + TP_ATR_MULT * pos.atrAtEntry;
        const hitTP   = close >= tpPrice;
        const hitDon  = d10l !== null && close < d10l;
        if (hitTP || hitDon) {
          const exitPrice = hitTP ? tpPrice : close;
          const gross     = pos.qty * exitPrice;
          const fee       = gross * FEE_RATE;
          const net       = gross - fee;
          const pnl       = net - pos.cost;
          legA.cash += net;
          trades.push({
            sym, leg: "A",
            entryDate: pos.entryDate,
            exitDate:  new Date(t).toISOString().slice(0, 10),
            entry: pos.entryPrice, exit: exitPrice,
            qty: pos.qty, cost: pos.cost, proceeds: net,
            pnl, pnlPct: pnl / pos.cost * 100,
            bars: i - pos.entryBar,
            reason: hitTP ? "TP" : "STOP",
          });
          delete posA[sym];
        }
      }

      // Leg B exit: TP only
      if (posB[sym]) {
        const pos     = posB[sym];
        const tpPrice = pos.entryPrice + TP_ATR_MULT * pos.atrAtEntry;
        if (close >= tpPrice) {
          const gross = pos.qty * tpPrice;
          const fee   = gross * FEE_RATE;
          const net   = gross - fee;
          const pnl   = net - pos.cost;
          legB.cash += net;
          trades.push({
            sym, leg: "B",
            entryDate: pos.entryDate,
            exitDate:  new Date(t).toISOString().slice(0, 10),
            entry: pos.entryPrice, exit: tpPrice,
            qty: pos.qty, cost: pos.cost, proceeds: net,
            pnl, pnlPct: pnl / pos.cost * 100,
            bars: i - pos.entryBar,
            reason: "TP",
          });
          delete posB[sym];
        }
      }
    }

    // ── Entries ─────────────────────────────────────────────────────────
    for (const sym of SYMBOLS) {
      if (!allCandles[sym]) continue;
      const i = barIdx[sym].get(t);
      if (i == null || i < 210) continue;

      const c     = allCandles[sym][i];
      const close = c.close;
      const e50   = ind[sym].ema50[i];
      const e200  = ind[sym].ema200[i];
      const rsi   = ind[sym].rsi14[i];
      const atr   = ind[sym].atr14[i];
      const d20h  = ind[sym].don20H[i];

      if (!e50 || !e200 || !atr) continue;
      const inGC = e50 > e200;

      // Leg A entry
      if (!posA[sym] && Object.keys(posA).length < MAX_CONCURRENT && legA.cash > 5) {
        if (inGC && d20h !== null && close > d20h && close > e50) {
          // Equity = cash + open positions MTM
          const legAEq = legA.cash + Object.values(posA).reduce((s, p) => {
            const pi = barIdx[sym]?.get(t); // simplified: use same close for MTM
            return s + p.qty * (p.entryPrice); // conservative: use entry price for MTM
          }, 0);
          const size = Math.min(legAEq * SIZING_PCT, legA.cash);
          if (size >= 5) {
            const fee  = size * FEE_RATE;
            const cost = size - fee;
            const qty  = cost / close;
            legA.cash -= size;
            posA[sym] = {
              entryPrice: close, qty, cost, atrAtEntry: atr,
              entryBar: i, entryDate: new Date(t).toISOString().slice(0, 10),
            };
          }
        }
      }

      // Leg B entry
      if (!posB[sym] && Object.keys(posB).length < MAX_CONCURRENT && legB.cash > 5) {
        const dcDip  = !inGC && rsi !== null && rsi <= 30;
        const gcPull = inGC && close < e50 && rsi !== null && rsi <= 45;
        if (dcDip || gcPull) {
          const legBEq = legB.cash + Object.values(posB).reduce((s, p) => s + p.qty * p.entryPrice, 0);
          const size = Math.min(legBEq * SIZING_PCT, legB.cash);
          if (size >= 5) {
            const fee  = size * FEE_RATE;
            const cost = size - fee;
            const qty  = cost / close;
            legB.cash -= size;
            posB[sym] = {
              entryPrice: close, qty, cost, atrAtEntry: atr,
              entryBar: i, entryDate: new Date(t).toISOString().slice(0, 10),
            };
          }
        }
      }
    }

    // ── Equity snapshot ──────────────────────────────────────────────────
    let openMTM = 0;
    for (const sym of SYMBOLS) {
      if (!allCandles[sym]) continue;
      const i = barIdx[sym].get(t);
      if (i == null) continue;
      const close = allCandles[sym][i].close;
      if (posA[sym]) openMTM += posA[sym].qty * close;
      if (posB[sym]) openMTM += posB[sym].qty * close;
    }
    equityCurve.push({
      date: new Date(t).toISOString().slice(0, 10),
      total: legA.cash + legB.cash + openMTM,
    });
  }

  // Final equity (close open positions at last price)
  let finalOpenMTM = 0;
  const openPositions = [];
  for (const sym of SYMBOLS) {
    if (!allCandles[sym]) continue;
    const last = allCandles[sym][allCandles[sym].length - 1];
    if (posA[sym]) { finalOpenMTM += posA[sym].qty * last.close; openPositions.push(`${sym}(A)`); }
    if (posB[sym]) { finalOpenMTM += posB[sym].qty * last.close; openPositions.push(`${sym}(B)`); }
  }

  return {
    trades,
    equityCurve,
    finalEquity: legA.cash + legB.cash + finalOpenMTM,
    openPositions,
    legACash: legA.cash,
    legBCash: legB.cash,
  };
}

// ─── Report ───────────────────────────────────────────────────────────────────

function printReport(result) {
  const { trades, equityCurve, finalEquity, openPositions } = result;

  const wins       = trades.filter(t => t.pnl > 0);
  const losses     = trades.filter(t => t.pnl <= 0);
  const tpHits     = trades.filter(t => t.reason === "TP");
  const stops      = trades.filter(t => t.reason === "STOP");
  const totalPnL   = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWins  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profFactor = grossLoss > 0 ? (grossWins / grossLoss).toFixed(2) : "∞";
  const avgWin     = wins.length  ? wins.reduce((s, t)  => s + t.pnlPct, 0) / wins.length  : 0;
  const avgLoss    = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const avgBars    = trades.length ? trades.reduce((s, t) => s + (t.bars || 0), 0) / trades.length : 0;

  // Max drawdown
  let peak = STARTING_CAP, maxDD = 0, maxDDPct = 0;
  for (const { total } of equityCurve) {
    if (total > peak) peak = total;
    const dd = peak - total;
    if (dd > maxDD) { maxDD = dd; maxDDPct = dd / peak * 100; }
  }

  // Per-symbol
  const bySym = {};
  for (const t of trades) {
    if (!bySym[t.sym]) bySym[t.sym] = { n: 0, pnl: 0, wins: 0, legA: 0, legB: 0 };
    bySym[t.sym].n++;
    bySym[t.sym].pnl += t.pnl;
    if (t.pnl > 0) bySym[t.sym].wins++;
    if (t.leg === "A") bySym[t.sym].legA++; else bySym[t.sym].legB++;
  }

  // Per-leg
  const legATrades = trades.filter(t => t.leg === "A");
  const legBTrades = trades.filter(t => t.leg === "B");

  const netPct = ((finalEquity - STARTING_CAP) / STARTING_CAP * 100).toFixed(1);
  const W = 58;
  const sep = "─".repeat(W);

  console.log(`\n${"═".repeat(W)}`);
  console.log(`  E2 Ensemble Backtest   (6h candles · ~1 year)`);
  console.log(`${"═".repeat(W)}`);

  console.log(`\n  Starting capital  : $${STARTING_CAP.toLocaleString()}`);
  console.log(`  Final equity      : $${finalEquity.toFixed(2)}  (${Number(netPct) >= 0 ? "+" : ""}${netPct}%)`);
  console.log(`  Total realized P&L: ${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)}`);
  console.log(`  Max drawdown      : -$${maxDD.toFixed(2)}  (-${maxDDPct.toFixed(1)}%)`);

  if (equityCurve.length >= 2) {
    console.log(`  Period            : ${equityCurve[0].date} → ${equityCurve[equityCurve.length-1].date}`);
  }

  console.log(`\n  ${sep}`);
  console.log(`  TRADE SUMMARY`);
  console.log(`  ${sep}`);
  console.log(`  Total trades   : ${trades.length}  (${tpHits.length} TP · ${stops.length} stops)`);
  console.log(`  Win rate       : ${trades.length ? (wins.length/trades.length*100).toFixed(1) : 0}%  (${wins.length}W / ${losses.length}L)`);
  console.log(`  Avg win        : +${avgWin.toFixed(1)}%`);
  console.log(`  Avg loss       :  ${avgLoss.toFixed(1)}%`);
  console.log(`  Profit factor  : ${profFactor}`);
  console.log(`  Avg hold       : ${avgBars.toFixed(0)} bars  (~${(avgBars*6/24).toFixed(1)} days)`);

  console.log(`\n  ${sep}`);
  console.log(`  BY LEG`);
  console.log(`  ${sep}`);
  const legAWins = legATrades.filter(t => t.pnl > 0);
  const legBWins = legBTrades.filter(t => t.pnl > 0);
  const legAPnL  = legATrades.reduce((s, t) => s + t.pnl, 0);
  const legBPnL  = legBTrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`  Leg A (Trend)  : ${legATrades.length} trades · WR ${legATrades.length ? (legAWins.length/legATrades.length*100).toFixed(0) : 0}% · P&L ${legAPnL >= 0 ? "+" : ""}$${legAPnL.toFixed(2)}`);
  console.log(`  Leg B (M.Rev)  : ${legBTrades.length} trades · WR ${legBTrades.length ? (legBWins.length/legBTrades.length*100).toFixed(0) : 0}% · P&L ${legBPnL >= 0 ? "+" : ""}$${legBPnL.toFixed(2)}`);

  console.log(`\n  ${sep}`);
  console.log(`  BY SYMBOL`);
  console.log(`  ${sep}`);
  for (const [sym, d] of Object.entries(bySym).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const wr  = (d.wins / d.n * 100).toFixed(0);
    const pnl = (d.pnl >= 0 ? "+" : "") + "$" + d.pnl.toFixed(2);
    console.log(`  ${sym.padEnd(11)} ${String(d.n).padStart(3)} trades · WR ${wr.padStart(3)}% · P&L ${pnl.padStart(9)}  (A:${d.legA} B:${d.legB})`);
  }

  if (openPositions.length) {
    console.log(`\n  Still open (not realized): ${openPositions.join(", ")}`);
  }

  console.log(`\n  ${sep}`);
  console.log(`  ALL TRADES`);
  console.log(`  ${sep}`);
  console.log(`  ${"Date".padEnd(11)} ${"Symbol".padEnd(11)} Leg  ${"Reason".padEnd(6)}  ${"Entry".padStart(10)}  ${"Exit".padStart(10)}  ${"P&L".padStart(9)}  Pct`);
  console.log(`  ${sep}`);
  for (const t of trades) {
    const pnlStr = ((t.pnl >= 0 ? "+" : "") + "$" + t.pnl.toFixed(2)).padStart(9);
    const pctStr = ((t.pnlPct >= 0 ? "+" : "") + t.pnlPct.toFixed(1) + "%").padStart(7);
    console.log(`  ${t.exitDate}  ${t.sym.padEnd(11)} ${t.leg}    ${t.reason.padEnd(6)}  ${("$"+t.entry.toFixed(2)).padStart(10)}  ${("$"+t.exit.toFixed(2)).padStart(10)}  ${pnlStr}  ${pctStr}`);
  }

  console.log(`\n${"═".repeat(W)}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(`\n📥  Fetching ~1 year of 6h candles from Coinbase…\n`);

const allCandles = {};
for (const sym of SYMBOLS) {
  process.stdout.write(`  ${sym.padEnd(12)}`);
  try {
    const candles = await fetchCandles(sym, CANDLE_LIMIT);
    allCandles[sym] = candles;
    const from = new Date(candles[0].time).toISOString().slice(0, 10);
    const to   = new Date(candles[candles.length - 1].time).toISOString().slice(0, 10);
    console.log(`${candles.length} bars  (${from} → ${to})`);
  } catch (err) {
    console.log(`FAILED — ${err.message}`);
  }
  await new Promise(r => setTimeout(r, 400));
}

console.log(`\n⚙️   Running simulation…\n`);
const result = simulate(allCandles);
printReport(result);
