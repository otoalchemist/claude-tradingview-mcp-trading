#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// craig-cross-backtest.mjs
// Golden/Death Cross + CHOCH Contrarian Regime Strategy — 15m backtest
//
// BUY  REGIME: bearish CHOCH fires → wait for death cross (EMA9 < EMA21)
//              → BUY every bearish BOS until bullish CHOCH + golden cross
// SELL REGIME: bullish CHOCH fires → wait for golden cross (EMA9 > EMA21)
//              → SELL every bullish BOS until bearish CHOCH + death cross
//
// ENTRY : close of signal bar
// SL    : entry ± ATR(14) × SL_ATR_MULT
// TP    : entry ∓ ATR(14) × SL_ATR_MULT × RR
// BE    : move SL to entry on first BOS in trade direction
// ═══════════════════════════════════════════════════════════════════════════

// ── Config ────────────────────────────────────────────────────────────────────
const SYMBOLS         = ["BTC-USD"];
const DAYS            = 30;
const RISK_USD        = 15;
const MAX_POS_USD     = 200;
const INITIAL_CAPITAL = 500;

const EMA_FAST        = 9;     // "small" cross fast EMA
const EMA_SLOW        = 21;    // "small" cross slow EMA
const SWING_LB        = 5;     // pivot lookback bars each side
const ATR_PERIOD      = 14;
const SL_ATR_MULT     = 1.5;   // SL distance = ATR × this
const INITIAL_RR      = 3;     // TP = SL distance × RR

// ── RSI gate ──────────────────────────────────────────────────────────────────
// Only enter BUY when RSI is below threshold (oversold bias)
// Only enter SELL when RSI is above threshold (overbought bias)
const RSI_GATE        = false;
const RSI_PERIOD      = 14;
const RSI_BUY_MAX     = 45;   // only BUY  when RSI(14) < 45
const RSI_SELL_MIN    = 55;   // only SELL when RSI(14) > 55

// ── Direction filter ──────────────────────────────────────────────────────────
const LONG_ONLY       = true;   // skip SELL regime entirely

// ── Crypto session filter ─────────────────────────────────────────────────────
// Crypto trades 24/7 but volume clusters around traditional market hours.
// Active window: 6 AM – 5 PM ET  (London open through NY close)
// Dead zone:     5 PM – 6 AM ET  (post-NY, thin volume, fake BOS signals)
const SESSION_FILTER  = true;
const SESSION_START_H = 6;     // 6 AM ET
const SESSION_END_H   = 17;    // 5 PM ET  (17:00)

const GRAN_15M = { gran: "FIFTEEN_MINUTE", secs: 900 };
const CB_MAX   = 350;

// ── Coinbase candle fetch (time-window walking, matches craig-backtest.mjs) ───
async function fetchCandles(symbol, days) {
  const { gran, secs } = GRAN_15M;
  const totalBars  = Math.ceil(days * 86400 / secs) + 50; // +50 warmup
  let allCandles   = [];
  let batchEnd     = Math.floor(Date.now() / 1000);
  let emptyCount   = 0;

  process.stdout.write(`  Fetching ${symbol} 15m (${days}d)... `);

  while (allCandles.length < totalBars) {
    const need       = totalBars - allCandles.length;
    const batchSize  = Math.min(CB_MAX, need);
    const batchStart = batchEnd - batchSize * secs;

    const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${symbol}/candles` +
      `?start=${batchStart}&end=${batchEnd}&granularity=${gran}&limit=${batchSize}`;

    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Coinbase ${res.status} for ${symbol}`);
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

  // Deduplicate and sort ascending
  const seen = new Set();
  const candles = allCandles
    .filter(c => { if (seen.has(c.t)) return false; seen.add(c.t); return true; })
    .sort((a, b) => a.t - b.t);

  console.log(`${candles.length} candles`);
  return candles;
}

// ── Technical Indicators ──────────────────────────────────────────────────────
function calcRSI(closes, period) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain   = change > 0 ? change : 0;
    const loss   = change < 0 ? -change : 0;
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) {
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i]  = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

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

function calcATR(candles, period) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const pc = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  });
  const out = new Array(candles.length).fill(null);
  let atr   = null;
  for (let i = 0; i < trs.length; i++) {
    if (atr === null) {
      if (i < period - 1) continue;
      atr = trs.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0) / period;
    } else {
      atr = (atr * (period - 1) + trs[i]) / period;
    }
    out[i] = atr;
  }
  return out;
}

// ── Position sizing ───────────────────────────────────────────────────────────
function sizePosition(entry, sl) {
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return { qty: 0, sizeUSD: 0 };
  let qty     = RISK_USD / risk;
  let sizeUSD = qty * entry;
  if (sizeUSD > MAX_POS_USD) { sizeUSD = MAX_POS_USD; qty = sizeUSD / entry; }
  return { qty, sizeUSD };
}

// ── Core Simulation ───────────────────────────────────────────────────────────
function simulate(symbol, candles) {
  const closes = candles.map(c => c.c);
  const emaF   = calcEMA(closes, EMA_FAST);
  const emaS   = calcEMA(closes, EMA_SLOW);
  const atrArr = calcATR(candles, ATR_PERIOD);
  const rsiArr = calcRSI(closes, RSI_PERIOD);

  // Structure state
  let structure = 0;      // 0 neutral, 1 bullish, -1 bearish
  let lastSH    = null;   // most recent confirmed swing high { price, idx }
  let lastSL    = null;   // most recent confirmed swing low  { price, idx }

  // Regime state machine
  // pendingBuy  = bearish CHOCH fired, waiting for death cross to activate buy regime
  // pendingSell = bullish CHOCH fired, waiting for golden cross to activate sell regime
  let regime      = "neutral";  // "neutral" | "buy" | "sell"
  let pendingBuy  = false;
  let pendingSell = false;

  // Open position + break-even flag
  let pos   = null;
  let beHit = false;

  // Results collection
  const trades = [];
  let capital  = INITIAL_CAPITAL;
  let peak     = capital;
  let maxDD    = 0;

  const warmup = Math.max(EMA_SLOW, ATR_PERIOD, SWING_LB * 2 + 2);

  for (let i = warmup; i < candles.length; i++) {
    const bar    = candles[i];
    const ef     = emaF[i];
    const es     = emaS[i];
    const efPrev = emaF[i - 1];
    const esPrev = emaS[i - 1];
    const atr    = atrArr[i];
    const rsi    = rsiArr[i];

    if (!ef || !es || !efPrev || !esPrev || !atr || rsi === null) continue;

    // ── 1. Pivot detection (confirmed SWING_LB bars ago) ─────────────────────
    const pIdx = i - SWING_LB;
    if (pIdx >= SWING_LB) {
      const pb  = candles[pIdx];
      let isPH  = true;
      let isPL  = true;
      for (let j = 1; j <= SWING_LB; j++) {
        if (candles[pIdx - j].h >= pb.h || candles[pIdx + j].h >= pb.h) isPH = false;
        if (candles[pIdx - j].l <= pb.l || candles[pIdx + j].l <= pb.l) isPL = false;
      }
      if (isPH) lastSH = { price: pb.h, idx: pIdx };
      if (isPL) lastSL = { price: pb.l, idx: pIdx };
    }

    // ── 2. BOS / CHOCH detection ─────────────────────────────────────────────
    let bullBOS   = false;
    let bearBOS   = false;
    let bullCHOCH = false;
    let bearCHOCH = false;

    if (lastSH && lastSL) {
      const pc = candles[i - 1].c;

      // Bullish: close breaks above last swing high
      if (bar.c > lastSH.price && pc <= lastSH.price) {
        if (structure === -1) bullCHOCH = true;
        else bullBOS = true;
        structure = 1;
      }

      // Bearish: close breaks below last swing low
      if (bar.c < lastSL.price && pc >= lastSL.price) {
        if (structure === 1) bearCHOCH = true;
        else bearBOS = true;
        structure = -1;
      }
    }

    // ── 3. EMA cross status ───────────────────────────────────────────────────
    const isGolden = ef > es;   // EMA9 above EMA21 — golden cross active
    const isDeath  = ef < es;   // EMA9 below EMA21 — death cross active

    // ── 4. Regime state machine ───────────────────────────────────────────────
    // Step A: CHOCH arms pending state
    if (bearCHOCH) { pendingBuy = true;  pendingSell = false; }
    if (bullCHOCH) { pendingSell = true; pendingBuy  = false; }

    // Step B: if cross condition is already met when CHOCH fires, enter immediately
    //         otherwise wait for the cross
    if (pendingBuy  && isDeath)   { regime = "buy";  pendingBuy  = false; pendingSell = false; }
    if (pendingSell && isGolden)  { regime = "sell"; pendingSell = false; pendingBuy  = false; }

    // ── 5. Manage open position ───────────────────────────────────────────────
    if (pos) {
      // Break-even: first BOS in direction of trade
      if (!beHit) {
        if (pos.side === "long"  && bullBOS) { pos.sl = pos.entry; beHit = true; }
        if (pos.side === "short" && bearBOS) { pos.sl = pos.entry; beHit = true; }
      }

      // Exit check — SL before TP (conservative; if both hit same bar, SL wins)
      let exitPrice  = null;
      let exitReason = null;

      if (pos.side === "long") {
        if      (bar.l <= pos.sl)   { exitPrice = pos.sl; exitReason = beHit ? "break_even" : "stop_loss"; }
        else if (bar.h >= pos.tp)   { exitPrice = pos.tp; exitReason = "take_profit"; }
      } else {
        if      (bar.h >= pos.sl)   { exitPrice = pos.sl; exitReason = beHit ? "break_even" : "stop_loss"; }
        else if (bar.l <= pos.tp)   { exitPrice = pos.tp; exitReason = "take_profit"; }
      }

      if (exitPrice !== null) {
        const pnl = pos.side === "long"
          ? (exitPrice - pos.entry) * pos.qty
          : (pos.entry  - exitPrice) * pos.qty;

        capital += pnl;
        if (capital > peak) peak = capital;
        const dd = peak - capital;
        if (dd > maxDD) maxDD = dd;

        trades.push({ ...pos, exit: exitPrice, reason: exitReason, pnl, bars: i - pos.openBar });
        pos   = null;
        beHit = false;
      }
    }

    // ── 6. New entry signal ───────────────────────────────────────────────────
    // Session gate: only open new positions during active crypto hours
    const barHourET = new Date(bar.t).toLocaleString("en-US", {
      timeZone: "America/New_York", hour: "numeric", hour12: false,
    });
    const hourET    = parseInt(barHourET, 10);
    const inSession = !SESSION_FILTER ||
      (hourET >= SESSION_START_H && hourET < SESSION_END_H);

    if (!pos && inSession) {
      let side    = null;
      let trigger = null;

      // RSI gate: confirm oversold/overbought before entry
      const rsiOK_buy  = !RSI_GATE || rsi < RSI_BUY_MAX;
      const rsiOK_sell = !RSI_GATE || rsi > RSI_SELL_MIN;

      // BUY regime  → go LONG  on bearish BOS (contrarian: buy the breakdown)
      const rsiOkBuy  = !RSI_GATE || rsi < RSI_BUY_MAX;
      const rsiOkSell = !RSI_GATE || rsi > RSI_SELL_MIN;
      if (regime === "buy"  && bearBOS && rsiOkBuy)  { side = "long";  trigger = "bearish_BOS"; }
      // SELL regime → go SHORT on bullish BOS (skip if LONG_ONLY)
      if (!LONG_ONLY && regime === "sell" && bullBOS && rsiOkSell) { side = "short"; trigger = "bullish_BOS"; }

      if (side) {
        const entry = bar.c;
        const sl    = side === "long"
          ? entry - atr * SL_ATR_MULT
          : entry + atr * SL_ATR_MULT;
        const tp    = side === "long"
          ? entry + atr * SL_ATR_MULT * INITIAL_RR
          : entry - atr * SL_ATR_MULT * INITIAL_RR;

        const { qty, sizeUSD } = sizePosition(entry, sl);
        if (qty > 0) {
          pos   = { side, entry, sl, tp, qty, sizeUSD, regime, trigger, openBar: i };
          beHit = false;
        }
      }
    }
  }

  // Force-close any open position at end of data
  if (pos) {
    const last = candles.at(-1);
    const pnl  = pos.side === "long"
      ? (last.c - pos.entry) * pos.qty
      : (pos.entry - last.c) * pos.qty;
    capital += pnl;
    if (capital > peak) peak = capital;
    const dd = peak - capital;
    if (dd > maxDD) maxDD = dd;
    trades.push({ ...pos, exit: last.c, reason: "expired", pnl, bars: candles.length - 1 - pos.openBar });
  }

  // ── Statistics ────────────────────────────────────────────────────────────
  const wins     = trades.filter(t => t.pnl > 0);
  const losses   = trades.filter(t => t.pnl < 0);
  const tpCount  = trades.filter(t => t.reason === "take_profit").length;
  const slCount  = trades.filter(t => t.reason === "stop_loss").length;
  const beCount  = trades.filter(t => t.reason === "break_even").length;
  const expCount = trades.filter(t => t.reason === "expired").length;

  const totalPnl  = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf        = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
  const wr        = trades.length ? wins.length / trades.length : 0;
  const avgR      = trades.length
    ? trades.reduce((s, t) => s + t.pnl / RISK_USD, 0) / trades.length
    : 0;

  const daysCovered = candles.length > 0
    ? (candles.at(-1).t - candles[0].t) / 86_400_000
    : 0;

  const buyTrades  = trades.filter(t => t.regime === "buy");
  const sellTrades = trades.filter(t => t.regime === "sell");

  return {
    symbol,
    candleCount: candles.length,
    daysCovered,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    wr, pf, avgR,
    totalPnl,
    finalCapital: INITIAL_CAPITAL + totalPnl,
    maxDD,
    tpCount, slCount, beCount, expCount,
    buyTrades, sellTrades,
    tradeList: trades,
  };
}

// ── Reporting ─────────────────────────────────────────────────────────────────
const f2  = n  => n.toFixed(2);
const f1  = n  => n.toFixed(1);
const fp  = n  => (n >= 0 ? "+" : "") + "$" + Math.abs(n).toFixed(2);
const fpp = n  => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
const wr  = (arr) =>
  arr.length ? (arr.filter(t => t.pnl > 0).length / arr.length * 100).toFixed(0) + "%" : "–";

function printResult(r) {
  const retPct = (r.finalCapital - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  console.log(`\n${r.symbol}: ${r.trades} trades · ~${f1(r.daysCovered)} days`);
  console.log(`  Win Rate : ${f1(r.wr * 100)}% (${r.wins}W/${r.losses}L) | PF: ${f2(r.pf)} | Avg R: ${f2(r.avgR)}R`);
  console.log(`  PnL      : ${fp(r.totalPnl)} | $${INITIAL_CAPITAL} → $${f2(r.finalCapital)} (${fpp(retPct)})`);
  console.log(`  MaxDD    : $${f2(r.maxDD)}`);
  console.log(`  Exits    : TP×${r.tpCount}  SL×${r.slCount}  BE×${r.beCount}  Expired×${r.expCount}`);
  console.log(`  Regimes  : BUY ×${r.buyTrades.length} (${wr(r.buyTrades)} WR)` +
              ` | SELL ×${r.sellTrades.length} (${wr(r.sellTrades)} WR)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  Craig Cross-Regime Contrarian Backtest — 15m            ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  Strategy : bearish CHOCH + death cross  → BUY  bearish BOS`);
  console.log(`             bullish CHOCH + golden cross → SELL bullish BOS`);
  console.log(`  EMA      : ${EMA_FAST}/${EMA_SLOW} (small cross) | Swing: ${SWING_LB}b each side`);
  console.log(`  Risk/SL  : $${RISK_USD}/trade | SL = ${SL_ATR_MULT}×ATR | RR 1:${INITIAL_RR}`);
  console.log(`  Direction: ${LONG_ONLY ? "LONG ONLY (BUY regime only)" : "both long & short"}`);
  console.log(`  RSI gate : ${RSI_GATE ? `BUY when RSI<${RSI_BUY_MAX}, SELL when RSI>${RSI_SELL_MIN}` : "off"}`);
  console.log(`  Session  : ${SESSION_FILTER ? `${SESSION_START_H}:00–${SESSION_END_H}:00 ET (London open → NY close)` : "24/7 (no filter)"}`);
  console.log(`  Capital  : $${INITIAL_CAPITAL} | Max pos: $${MAX_POS_USD}\n`);

  const results = [];

  for (const sym of SYMBOLS) {
    console.log(`\n── ${sym} ${"─".repeat(50 - sym.length)}`);
    try {
      const candles = await fetchCandles(sym, DAYS);
      if (candles.length < 200) {
        console.log(`  ✗ Insufficient data (${candles.length} bars)`);
        continue;
      }
      const res = simulate(sym, candles);
      results.push(res);
      printResult(res);
    } catch (err) {
      console.error(`  ✗ ${sym} error: ${err.message}`);
    }
  }

  if (!results.length) { console.log("\nNo results."); return; }

  // ── Combined summary ────────────────────────────────────────────────────────
  const totTrades = results.reduce((s, r) => s + r.trades, 0);
  const totWins   = results.reduce((s, r) => s + r.wins, 0);
  const totPnl    = results.reduce((s, r) => s + r.totalPnl, 0);
  const totBE     = results.reduce((s, r) => s + r.beCount, 0);
  const combWR    = totTrades ? totWins / totTrades * 100 : 0;
  const finalCap  = INITIAL_CAPITAL + totPnl;
  const retPct    = (finalCap - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  COMBINED SUMMARY                                         ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  Trades : ${totTrades} | Win Rate: ${f1(combWR)}% | PnL: ${fp(totPnl)}`);
  console.log(`  Capital: $${INITIAL_CAPITAL} → $${f2(finalCap)} (${fpp(retPct)})`);

  // ── Dynamic suggestions ─────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  SUGGESTIONS FOR IMPROVEMENT                              ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  const bePct = totTrades ? totBE / totTrades * 100 : 0;

  if (combWR < 30) {
    console.log("  ① WIN RATE TOO LOW (<30%)");
    console.log(`    → Lower RR: change INITIAL_RR from ${INITIAL_RR} to 2 — catch reversals before they retrace`);
    console.log("    → RSI gate: only BUY when RSI(14) < 45, only SELL when RSI(14) > 55");
    console.log("    → Require CHOCH body ≥ 40% of bar range (stronger momentum)");
    console.log("    → Consider EMA 12/26 — fewer false crosses vs 9/21");
  } else if (combWR < 45) {
    console.log("  ① MODERATE WIN RATE — room to improve:");
    console.log("    → Partial TP: close 50% at 1.5R, trail remainder with BE stop");
    console.log("    → EMA 12/26 may reduce false cross signals vs 9/21");
  } else {
    console.log("  ① SOLID WIN RATE — protect edge:");
    console.log("    → Add partial TP (50% at 1.5R) to lock in gains on reversals");
    console.log("    → Consider widening TP to 1:4 when RSI is extreme (<30 or >70)");
  }

  if (bePct > 25) {
    console.log(`  ② HIGH BE RATE (${f1(bePct)}%) — price moves but stalls before TP`);
    console.log("    → Scale out: take 50% profit at 1R, move SL to +0.5R, trail remainder");
    console.log("    → BOS-triggered BE may be firing too early — require 2 BOS bars");
  }

  console.log("  ③ SESSION FILTER (biggest impact)");
  console.log("    → Only trade 8:00–11:30 AM ET and 1:00–3:30 PM ET");
  console.log("    → Overnight 15m candles are low-volume chop — avoid them");
  console.log("    → Expected improvement: ~15-25% fewer bad trades");

  console.log("  ④ EMA PERIOD TUNING");
  console.log("    → EMA 9/21  (current) — fast signals, more false crosses");
  console.log("    → EMA 12/26 (MACD)   — balanced speed vs noise");
  console.log("    → EMA 20/50          — slowest, highest quality, fewest signals");
  console.log("    → Run backtest with each to compare");

  console.log("  ⑤ TREND ALIGNMENT (higher-TF filter)");
  console.log("    → Add 4h EMA50/200 bias: only take BUY trades when 4h is bullish");
  console.log("    → Contrarian works best WITH higher-TF trend, not directly against it");

  console.log("  ⑥ ENTRY REFINEMENT");
  console.log("    → Instead of entering at BOS bar close, enter on next bar open");
  console.log("    → Or wait for a 1-bar pullback after BOS (tighter entry, smaller SL)");
  console.log("    → Smaller SL → larger position size → better R outcome on wins");

  console.log("  ⑦ STOP MANAGEMENT");
  console.log("    → Current SL: entry ± ATR×1.5 (fixed)");
  console.log("    → Alternative: SL just beyond the broken swing level (more meaningful)");
  console.log("    → Trailing stop after BE hit: trail by 0.5×ATR to capture extended moves");

  console.log("");
}

main().catch(console.error);
