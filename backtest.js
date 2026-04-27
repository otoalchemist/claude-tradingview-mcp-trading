/**
 * backtest.js — Multi-Confluence Contrarian (MCC) v2 Strategy Backtester
 *
 * Strategy overview:
 *   Regime : MA50/MA200 on 5m — death cross → BUY-only | golden cross → SELL-only
 *   Entry  : 9-indicator composite score (no hard gates, just composite avg):
 *              1. RSI(14) oversold depth       5. MACD histogram improving
 *              2. StochRSI(14,14,3) oversold   6. Volume spike vs 20-bar avg
 *              3. BB(20,2) lower band breach    7. CCI(20) oversold
 *              4. VWAP lower band breach        8. EMA9/21 microtrend
 *                                               9. MA50/MA200 regime depth
 *   Exits  : ATR-based TP + BB midline + RSI50 / MACD cross (variant-controlled)
 *   Sizing : Entry proportional to composite score (20%–100% of MAX_TRADE_USD)
 *
 * Usage:
 *   node backtest.js                   default: 90 days, BTC+ETH+SOL
 *   node backtest.js --days=30         shorter test
 *   node backtest.js --symbol=BTCUSDT  single symbol
 */

import "dotenv/config";

// ─── Config ───────────────────────────────────────────────────────────────────

const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith("--"))
    .map(a => a.slice(2).split("="))
);

const SYMBOLS       = ARGS.symbol
  ? [ARGS.symbol]
  : (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT").split(",").map(s => s.trim());
const BACKTEST_DAYS = parseInt(ARGS.days || "90");
const MAX_TRADE_USD = parseFloat(process.env.MAX_TRADE_SIZE_USD || "40");
const STARTING_CASH = 1000;
const CANDLE_MINS   = 5;

// ─── Coinbase Public Candle API ───────────────────────────────────────────────

function toCbSymbol(s) {
  if (s.endsWith("USDT")) return s.slice(0, -4) + "-USD";
  if (s.endsWith("USD"))  return s.slice(0, -3)  + "-USD";
  return s;
}

async function fetchCandles(symbol, totalLimit) {
  const cb   = toCbSymbol(symbol);
  const secs = 300; // 5 minutes
  const gran = "FIVE_MINUTE";
  const PAGE = 300;
  let all    = [];
  let end    = Math.floor(Date.now() / 1000);

  process.stdout.write(`  Fetching ${totalLimit} candles`);

  while (all.length < totalLimit) {
    const batchSize = Math.min(PAGE, totalLimit - all.length);
    const start     = end - batchSize * secs;
    const url =
      `https://api.coinbase.com/api/v3/brokerage/market/products/${cb}/candles` +
      `?start=${start}&end=${end}&granularity=${gran}&limit=${batchSize}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Coinbase ${res.status} for ${cb}`);
    const json = await res.json();
    if (!json.candles?.length) break;

    const batch = json.candles.slice().reverse().map(c => ({
      time:   parseInt(c.start) * 1000,
      open:   parseFloat(c.open),
      high:   parseFloat(c.high),
      low:    parseFloat(c.low),
      close:  parseFloat(c.close),
      volume: parseFloat(c.volume),
    }));

    all   = [...batch, ...all];
    end   = start;
    process.stdout.write(".");

    if (json.candles.length < batchSize) break;
    if (all.length < totalLimit) await new Promise(r => setTimeout(r, 180));
  }

  console.log(` done (${all.length})`);
  return all.slice(-totalLimit);
}

// ─── Classic Indicators ───────────────────────────────────────────────────────

function calcSMA(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function calcRSI(arr, n = 14) {
  if (arr.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = arr.length - n; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  const ag = g / n, al = l / n;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcBB(arr, n = 20, mult = 2) {
  if (arr.length < n) return null;
  const sl  = arr.slice(-n);
  const mid = sl.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(sl.reduce((s, v) => s + (v - mid) ** 2, 0) / n);
  return { upper: mid + mult * std, middle: mid, lower: mid - mult * std };
}

function calcStochRSI(arr, rp = 14, sp = 14, ks = 3) {
  if (arr.length < rp + sp + ks + 1) return null;
  const rs = [];
  for (let i = rp; i <= arr.length; i++) {
    const sl = arr.slice(i - rp - 1, i);
    let g = 0, l = 0;
    for (let j = 1; j < sl.length; j++) {
      const d = sl[j] - sl[j - 1]; if (d > 0) g += d; else l -= d;
    }
    const ag = g / rp, al = l / rp;
    rs.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  const ss = [];
  for (let i = sp; i <= rs.length; i++) {
    const sl = rs.slice(i - sp, i);
    const hi = Math.max(...sl), lo = Math.min(...sl);
    ss.push(hi === lo ? 50 : (rs[i - 1] - lo) / (hi - lo) * 100);
  }
  if (ss.length < ks) return null;
  return ss.slice(-ks).reduce((a, b) => a + b, 0) / ks;
}

function calcVolRatio(candles, n = 20) {
  if (candles.length < n + 1) return null;
  const avg = candles.slice(-n - 1, -1).reduce((s, c) => s + c.volume, 0) / n;
  return avg === 0 ? null : candles[candles.length - 1].volume / avg;
}

function calcATR(candles, n = 14) {
  if (candles.length < n + 1) return null;
  const trs = [];
  for (let i = candles.length - n; i < candles.length; i++) {
    const { high: h, low: l } = candles[i], pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.reduce((a, b) => a + b, 0) / n;
}

function calcVWAP(candles) {
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  let sess = candles.filter(c => c.time >= midnight.getTime());
  if (sess.length < 10) sess = candles.slice(-50);
  let cumTPV = 0, cumVol = 0;
  const tps = sess.map(c => {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume; cumVol += c.volume; return tp;
  });
  if (cumVol === 0) return null;
  const v   = cumTPV / cumVol;
  const std = Math.sqrt(tps.reduce((s, tp) => s + (tp - v) ** 2, 0) / tps.length);
  return { vwap: v, upper2: v + 2 * std, lower2: v - 2 * std };
}

// ─── New v2: EMA / MACD / CCI ─────────────────────────────────────────────────

/** Compute full-length EMA array aligned to input indices.
 *  Returns null until n bars are available. */
function runEMA(arr, n) {
  const k   = 2 / (n + 1);
  const out = new Array(arr.length).fill(null);
  if (arr.length < n) return out;
  let ema = arr.slice(0, n).reduce((s, v) => s + v, 0) / n;
  out[n - 1] = ema;
  for (let i = n; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/** EMA over a same-length array that may have leading nulls (e.g. MACD signal).
 *  Seeds from the first n non-null values; output index-aligned to input. */
function runEMANullable(arr, n) {
  const k   = 2 / (n + 1);
  const out = new Array(arr.length).fill(null);
  let buf = [], ema = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) continue;
    if (ema == null) {
      buf.push(arr[i]);
      if (buf.length === n) {
        ema = buf.reduce((s, v) => s + v, 0) / n;
        out[i] = ema;
      }
    } else {
      ema = arr[i] * k + ema * (1 - k);
      out[i] = ema;
    }
  }
  return out;
}

/** CCI(n) at index idx. O(n) per call — precomputed for all bars in precompute(). */
function calcCCI(candles, idx, n = 20) {
  if (idx < n - 1) return null;
  const sl  = candles.slice(idx - n + 1, idx + 1);
  const tps = sl.map(c => (c.high + c.low + c.close) / 3);
  const sma = tps.reduce((s, v) => s + v, 0) / n;
  const md  = tps.reduce((s, v) => s + Math.abs(v - sma), 0) / n;
  return md === 0 ? 0 : (tps[n - 1] - sma) / (0.015 * md);
}

// ─── Precompute all indicators in one forward pass ────────────────────────────

function precompute(candles) {
  const closes = candles.map(c => c.close);

  // Running EMAs — O(n) each
  const ema9arr  = runEMA(closes, 9);
  const ema21arr = runEMA(closes, 21);
  const ema12arr = runEMA(closes, 12);
  const ema26arr = runEMA(closes, 26);

  // MACD (12, 26, 9)
  const macdLineArr = closes.map((_, i) =>
    ema12arr[i] != null && ema26arr[i] != null ? ema12arr[i] - ema26arr[i] : null
  );
  const macdSigArr  = runEMANullable(macdLineArr, 9);
  const macdHistArr = macdLineArr.map((v, i) =>
    v != null && macdSigArr[i] != null ? v - macdSigArr[i] : null
  );

  // CCI(20) — O(20) per bar
  const cciArr = candles.map((_, i) => calcCCI(candles, i, 20));

  return candles.map((_, i) => {
    const w  = candles.slice(0, i + 1);
    const cl = closes.slice(0, i + 1);
    return {
      price:    closes[i],
      ma50:     calcSMA(cl, 50),
      ma200:    calcSMA(cl, 200),
      ema9:     ema9arr[i],
      ema21:    ema21arr[i],
      rsi14:    calcRSI(cl, 14),
      bbVal:    calcBB(cl, 20, 2),
      srsi:     calcStochRSI(cl, 14, 14, 3),
      vr:       calcVolRatio(w, 20),
      atr:      calcATR(w, 14),
      vb:       calcVWAP(w),
      macdLine: macdLineArr[i],
      macdSig:  macdSigArr[i],
      macdHist: macdHistArr[i],
      cci:      cciArr[i],
    };
  });
}

// ─── Entry Scoring: 9 indicators → composite 0–1 ─────────────────────────────
//
// Each indicator contributes 0–1 to scores[]; composite = average.
// No hard gates — everything is a soft score so near-misses still fire.
//
function calcEntryScore(price, bias, ind, prevInd) {
  const scores = [];
  const cl = v => Math.max(0, Math.min(1, v));

  if (bias === "bull") {
    // 1. RSI oversold — RSI < 40 starts scoring; RSI 0 = 1.0
    if (ind.rsi14 != null)
      scores.push(cl((40 - ind.rsi14) / 40));

    // 2. StochRSI oversold — < 25 strong signal
    if (ind.srsi != null)
      scores.push(cl((25 - ind.srsi) / 25));

    // 3. BB lower band — price below lower band (1.5% below = 1.0)
    if (ind.bbVal)
      scores.push(cl((ind.bbVal.lower - price) / (ind.bbVal.lower * 0.015)));

    // 4. VWAP lower band — price below lower 2σ band
    if (ind.vb?.lower2)
      scores.push(cl((ind.vb.lower2 - price) / (ind.vb.lower2 * 0.01)));

    // 5. MACD histogram improving (turning less negative = momentum shifting)
    if (ind.macdHist != null && prevInd?.macdHist != null) {
      scores.push(ind.macdHist > prevInd.macdHist ? 1.0 : 0.0);
    } else if (ind.macdHist != null) {
      // Seed bar: negative histogram = oversold momentum
      scores.push(cl(-ind.macdHist / (Math.abs(ind.macdHist) + 0.01)));
    }

    // 6. Volume spike — > 1.0× avg starts scoring; 2.5× = 1.0
    if (ind.vr != null)
      scores.push(cl((ind.vr - 1.0) / 1.5));

    // 7. CCI oversold — < −80 starts scoring; −200 = 1.0
    if (ind.cci != null)
      scores.push(cl((-80 - ind.cci) / 120));

    // 8. EMA microtrend — EMA9 below EMA21 confirms dip in micro downtrend
    if (ind.ema9 != null && ind.ema21 != null)
      scores.push(cl((ind.ema21 - ind.ema9) / ind.ema21 / 0.003));

    // 9. Regime depth — wider death cross gap = stronger regime confirmation
    if (ind.ma50 && ind.ma200 && ind.ma50 < ind.ma200)
      scores.push(cl((ind.ma200 - ind.ma50) / ind.ma200 / 0.02));

  } else {
    // Bear (golden cross: sell the top)
    // 1. RSI overbought — > 60 starts scoring
    if (ind.rsi14 != null)
      scores.push(cl((ind.rsi14 - 60) / 40));

    // 2. StochRSI overbought — > 75
    if (ind.srsi != null)
      scores.push(cl((ind.srsi - 75) / 25));

    // 3. BB upper band breach
    if (ind.bbVal)
      scores.push(cl((price - ind.bbVal.upper) / (ind.bbVal.upper * 0.015)));

    // 4. VWAP upper band
    if (ind.vb?.upper2)
      scores.push(cl((price - ind.vb.upper2) / (ind.vb.upper2 * 0.01)));

    // 5. MACD histogram declining
    if (ind.macdHist != null && prevInd?.macdHist != null) {
      scores.push(ind.macdHist < prevInd.macdHist ? 1.0 : 0.0);
    } else if (ind.macdHist != null) {
      scores.push(cl(ind.macdHist / (Math.abs(ind.macdHist) + 0.01)));
    }

    // 6. Volume spike
    if (ind.vr != null)
      scores.push(cl((ind.vr - 1.0) / 1.5));

    // 7. CCI overbought — > 80 starts scoring
    if (ind.cci != null)
      scores.push(cl((ind.cci - 80) / 120));

    // 8. EMA microtrend — EMA9 above EMA21 confirms top in micro uptrend
    if (ind.ema9 != null && ind.ema21 != null)
      scores.push(cl((ind.ema9 - ind.ema21) / ind.ema21 / 0.003));

    // 9. Regime depth
    if (ind.ma50 && ind.ma200 && ind.ma50 > ind.ma200)
      scores.push(cl((ind.ma50 - ind.ma200) / ind.ma200 / 0.02));
  }

  return scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : 0;
}

// ─── Position Sizing (identical to bot.js) ───────────────────────────────────

function calcTradeSize(score, maxUSD, cash) {
  const min = maxUSD * 0.20;
  const max = Math.min(maxUSD, cash * 0.10);
  return Math.max(0, Math.round((min + (max - min) * score) * 100) / 100);
}

function calcSellSize(score, qty) {
  return qty * (0.30 + 0.70 * Math.max(0, Math.min(1, score)));
}

// ─── Backtest Engine ──────────────────────────────────────────────────────────
//
// cfg: {
//   tpMult   : ATR multiplier for take-profit (default 3.0)
//   minScore : composite score threshold to enter (default 0.25)
//   exitMode : "bb_rsi50" | "bb_macd" | "bb_rsi50_macd" (default "bb_rsi50")
// }
//
// exitMode flags (can combine with "_"):
//   bb      — always on: exit when price >= BB middle
//   rsi50   — exit when RSI(14) crosses ≥ 50 (momentum normalized)
//   macd    — exit when MACD histogram crosses from positive to negative
//             (bounce peaked and failing)
//

function runBacktest(symbol, candles, inds, cfg = {}) {
  const WARMUP    = 220;
  const TP_MULT   = cfg.tpMult   ?? 3.0;
  const MIN_SCORE = cfg.minScore ?? 0.25;
  const EXIT_MODE = cfg.exitMode ?? "bb_rsi50";

  let cash  = STARTING_CASH;
  let pos   = null;
  const trades = [];
  let peak = STARTING_CASH;
  let maxDD = 0;

  for (let i = WARMUP; i < inds.length; i++) {
    const ind   = inds[i];
    const prev  = inds[i - 1];
    const price = ind.price;
    if (!ind.ma50 || !ind.ma200 || !ind.bbVal || !ind.atr) continue;

    // ── 1. Exit checks ─────────────────────────────────────────────────────
    if (pos) {
      const tp     = pos.entryPrice + TP_MULT * ind.atr;
      let reason   = null;

      if (price >= tp) {
        // Take profit: ATR-based hard target
        reason = "take_profit";
      } else if (price >= ind.bbVal.middle) {
        // BB midline: classic mean-reversion bounce target
        reason = "bb_midline";
      } else if (EXIT_MODE.includes("rsi50") && ind.rsi14 != null && ind.rsi14 >= 50) {
        // RSI 50 midline: momentum normalized — bounce complete
        reason = "rsi_50";
      } else if (EXIT_MODE.includes("macd") &&
                 ind.macdHist != null && prev?.macdHist != null &&
                 prev.macdHist > 0 && ind.macdHist <= 0) {
        // MACD histogram rolled over from positive: bounce peaked and failing
        reason = "macd_cross";
      }

      if (reason) {
        const proceeds = pos.qty * price;
        const pnl      = proceeds - pos.cost;
        cash += proceeds;
        trades.push({
          symbol, side: "sell", exitReason: reason,
          entryPrice: pos.entryPrice, exitPrice: price,
          qty: pos.qty, cost: pos.cost, proceeds, pnl,
          pnlPct: pnl / pos.cost * 100,
          held: i - pos.entryIdx,
          entryTime: candles[pos.entryIdx].time, exitTime: candles[i].time,
        });
        pos = null;
        const tv = cash;
        if (tv > peak) peak = tv; else maxDD = Math.max(maxDD, (peak - tv) / peak * 100);
        continue;
      }
    }

    const deathCross  = ind.ma50 < ind.ma200;
    const goldenCross = !deathCross;

    // ── 2. Signal sell in golden cross (contrarian short top) ──────────────
    if (pos && goldenCross && ind.rsi14 != null && ind.rsi14 >= 60) {
      const score   = calcEntryScore(price, "bear", ind, prev);
      const sQty    = calcSellSize(score, pos.qty);
      const cPart   = sQty / pos.qty * pos.cost;
      const proceeds = sQty * price;
      const pnl      = proceeds - cPart;
      cash += proceeds;
      trades.push({
        symbol, side: "sell", exitReason: "signal_sell",
        entryPrice: pos.entryPrice, exitPrice: price,
        qty: sQty, cost: cPart, proceeds, pnl,
        pnlPct: pnl / cPart * 100,
        held: i - pos.entryIdx,
        entryTime: candles[pos.entryIdx].time, exitTime: candles[i].time,
      });
      pos.qty  -= sQty;
      pos.cost -= cPart;
      if (pos.qty <= 1e-8) pos = null;
    }

    // ── 3. Entry: death cross + composite score ≥ MIN_SCORE ───────────────
    if (!pos && deathCross) {
      const score = calcEntryScore(price, "bull", ind, prev);
      if (score >= MIN_SCORE) {
        const size = calcTradeSize(score, MAX_TRADE_USD, cash);
        if (size >= 1 && cash >= size) {
          cash -= size;
          pos   = { qty: size / price, entryPrice: price, entryIdx: i, cost: size };
        }
      }
    }

    // Track portfolio value for drawdown
    const tv = cash + (pos ? pos.qty * price : 0);
    if (tv > peak) peak = tv; else maxDD = Math.max(maxDD, (peak - tv) / peak * 100);
  }

  // Close any open position at end of data (mark-to-market)
  if (pos) {
    const price    = inds[inds.length - 1].price;
    const proceeds = pos.qty * price;
    const pnl      = proceeds - pos.cost;
    cash += proceeds;
    trades.push({
      symbol, side: "sell", exitReason: "end_of_data",
      entryPrice: pos.entryPrice, exitPrice: price,
      qty: pos.qty, cost: pos.cost, proceeds, pnl,
      pnlPct: pnl / pos.cost * 100,
      held: inds.length - 1 - pos.entryIdx,
      entryTime: candles[pos.entryIdx].time, exitTime: candles[candles.length - 1].time,
    });
  }

  return { trades, finalCash: cash, maxDD };
}

// ─── Report ───────────────────────────────────────────────────────────────────

const W   = 64;
const f2  = n => n.toFixed(2);
const sgn = n => (n >= 0 ? `+$${f2(n)}` : `-$${f2(Math.abs(n))}`);

function printSymbolReport(symbol, result, candles, cfg = {}) {
  const { trades, finalCash, maxDD } = result;
  const exits   = trades.filter(t => t.side === "sell");
  const wins    = exits.filter(t => t.pnl > 0);
  const losses  = exits.filter(t => t.pnl <= 0);

  const totalPnL   = exits.reduce((s, t) => s + t.pnl, 0);
  const totalCost  = exits.reduce((s, t) => s + t.cost, 0);
  const avgHeld    = exits.length ? exits.reduce((s, t) => s + t.held, 0) / exits.length : 0;
  const winRate    = exits.length ? wins.length / exits.length * 100 : 0;
  const avgWinPct  = wins.length   ? wins.reduce((s, t)   => s + t.pnlPct, 0) / wins.length   : 0;
  const avgLossPct = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const grossWin   = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf         = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "inf";

  let maxCW = 0, maxCL = 0, cw = 0, cl = 0;
  exits.forEach(t => {
    if (t.pnl > 0) { cw++; cl = 0; if (cw > maxCW) maxCW = cw; }
    else            { cl++; cw = 0; if (cl > maxCL) maxCL = cl; }
  });

  const byReason = {};
  exits.forEach(t => {
    if (!byReason[t.exitReason]) byReason[t.exitReason] = { count: 0, pnl: 0, wins: 0 };
    byReason[t.exitReason].count++;
    byReason[t.exitReason].pnl += t.pnl;
    if (t.pnl > 0) byReason[t.exitReason].wins++;
  });

  const startDate = new Date(candles[220]?.time || 0).toISOString().slice(0, 10);
  const endDate   = new Date(candles[candles.length - 1]?.time || 0).toISOString().slice(0, 10);
  const netReturn = ((finalCash - STARTING_CASH) / STARTING_CASH * 100).toFixed(2);

  console.log(`\n${"=".repeat(W)}`);
  console.log(`  ${symbol}   ${startDate} -> ${endDate}`);
  if (cfg.label) console.log(`  Config: ${cfg.label}`);
  console.log(`${"=".repeat(W)}`);
  console.log(`  Total trades      : ${exits.length}`);
  console.log(`  Wins / Losses     : ${wins.length} / ${losses.length}   (win rate ${winRate.toFixed(1)}%)`);
  console.log(`  Total P&L         : ${sgn(totalPnL)}   (${totalCost > 0 ? (totalPnL / totalCost * 100).toFixed(2) : 0}% on capital deployed)`);
  console.log(`  Net account return: ${sgn(finalCash - STARTING_CASH)}   (${netReturn}%)`);
  console.log(`  Final cash        : $${f2(finalCash)}   started $${STARTING_CASH}`);
  console.log(`  Profit factor     : ${pf}`);
  console.log(`  Avg win           : +${avgWinPct.toFixed(2)}%`);
  console.log(`  Avg loss          : ${avgLossPct.toFixed(2)}%`);
  console.log(`  Avg hold time     : ${avgHeld.toFixed(1)} candles  (~${(avgHeld * CANDLE_MINS / 60).toFixed(1)}h)`);
  console.log(`  Max drawdown      : ${maxDD.toFixed(2)}%`);
  console.log(`  Max consec wins   : ${maxCW}   |   Max consec losses: ${maxCL}`);

  console.log(`\n  Exit Breakdown:`);
  console.log(`  ${"Reason".padEnd(16)} ${"Count".padEnd(7)} ${"Win%".padEnd(8)} P&L`);
  ["take_profit","bb_midline","rsi_50","macd_cross","signal_sell","end_of_data"].forEach(r => {
    if (!byReason[r]) return;
    const d  = byReason[r];
    const wr = d.count ? (d.wins / d.count * 100).toFixed(0) + "%" : "-";
    console.log(`  ${r.replace(/_/g, " ").padEnd(16)} ${String(d.count).padEnd(7)} ${wr.padEnd(8)} ${sgn(d.pnl)}`);
  });

  if (exits.length > 0) {
    console.log(`\n  Last 15 Trades:`);
    console.log(`  ${"Entry $".padEnd(11)} ${"Exit $".padEnd(11)} ${"P&L%".padEnd(10)} ${"Reason".padEnd(16)} Date`);
    exits.slice(-15).forEach(t => {
      const p    = (t.pnl >= 0 ? "+" : "") + t.pnlPct.toFixed(2) + "%";
      const date = new Date(t.exitTime).toISOString().slice(5, 16).replace("T", " ");
      console.log(
        `  ${"$" + t.entryPrice.toFixed(0)}`.padEnd(12) +
        `${"$" + t.exitPrice.toFixed(0)}`.padEnd(12) +
        `${p}`.padEnd(11) +
        `${t.exitReason}`.padEnd(17) +
        date
      );
    });
  }
}

// ─── Variant comparison table ─────────────────────────────────────────────────

const VARIANTS = [
  // Vary entry threshold (trade frequency vs quality)
  { label: "sc>=0.20 tp3 bb+rsi50",     minScore: 0.20, tpMult: 3.0, exitMode: "bb_rsi50" },
  { label: "sc>=0.25 tp3 bb+rsi50",     minScore: 0.25, tpMult: 3.0, exitMode: "bb_rsi50" },
  { label: "sc>=0.30 tp3 bb+rsi50",     minScore: 0.30, tpMult: 3.0, exitMode: "bb_rsi50" },
  // Vary TP multiplier
  { label: "sc>=0.25 tp2 bb+rsi50",     minScore: 0.25, tpMult: 2.0, exitMode: "bb_rsi50" },
  { label: "sc>=0.25 tp4 bb+rsi50",     minScore: 0.25, tpMult: 4.0, exitMode: "bb_rsi50" },
  // Vary exit mode
  { label: "sc>=0.25 tp3 bb+macd",      minScore: 0.25, tpMult: 3.0, exitMode: "bb_macd" },
  { label: "sc>=0.25 tp3 bb+rsi50+mac", minScore: 0.25, tpMult: 3.0, exitMode: "bb_rsi50_macd" },
  { label: "sc>=0.20 tp3 bb+rsi50+mac", minScore: 0.20, tpMult: 3.0, exitMode: "bb_rsi50_macd" },
];

function printVariantTable(candles, inds, symbol) {
  console.log(`\n  ${"Variant".padEnd(28)} ${"Trades".padEnd(8)} ${"WinRate".padEnd(9)} ${"PF".padEnd(7)} ${"P&L".padEnd(10)} MaxDD`);
  console.log(`  ${"-".repeat(74)}`);
  for (const v of VARIANTS) {
    const r      = runBacktest(symbol, candles, inds, v);
    const exits  = r.trades.filter(t => t.side === "sell");
    const wins   = exits.filter(t => t.pnl > 0);
    const gw     = wins.reduce((s, t) => s + t.pnl, 0);
    const gl     = Math.abs(exits.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf     = gl > 0 ? (gw / gl).toFixed(2) : "inf";
    const pnl    = exits.reduce((s, t) => s + t.pnl, 0);
    const wr     = exits.length ? (wins.length / exits.length * 100).toFixed(1) + "%" : "-";
    const pnlStr = (pnl >= 0 ? "+" : "") + "$" + Math.abs(pnl).toFixed(2);
    const dd     = r.maxDD.toFixed(2) + "%";
    console.log(`  ${v.label.padEnd(28)} ${String(exits.length).padEnd(8)} ${wr.padEnd(9)} ${pf.padEnd(7)} ${pnlStr.padEnd(10)} ${dd}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const needed = Math.ceil(BACKTEST_DAYS * 24 * 60 / CANDLE_MINS) + 250;

  console.log(`\n${"=".repeat(W)}`);
  console.log(`  Multi-Confluence Contrarian (MCC) v2 — Variant Sweep`);
  console.log(`  Regime : MA50/MA200 death cross→BUY | golden cross→SELL`);
  console.log(`  Entry  : 9-indicator composite score (RSI, StochRSI, BB,`);
  console.log(`           VWAP, MACD hist, Volume, CCI, EMA9/21, Regime gap)`);
  console.log(`  Exits  : ATR-TP + BB middle + RSI50/MACD (variant-controlled)`);
  console.log(`  Sizing : proportional to composite score (20%–100% of max trade)`);
  console.log(`  Period : last ${BACKTEST_DAYS} days   |   Candles: 5m`);
  console.log(`  Symbols: ${SYMBOLS.join(", ")}`);
  console.log(`  Max trade: $${MAX_TRADE_USD}   |   Starting cash: $${STARTING_CASH}`);
  console.log(`${"=".repeat(W)}\n`);

  const symbolData = [];
  for (const symbol of SYMBOLS) {
    console.log(`-- ${symbol}: fetching...`);
    let candles;
    try {
      candles = await fetchCandles(symbol, needed);
    } catch (err) {
      console.log(`  Failed: ${err.message}\n`); continue;
    }
    if (candles.length < 250) {
      console.log(`  Only ${candles.length} candles, skipping.\n`); continue;
    }
    process.stdout.write(`  Pre-computing ${candles.length} candles (EMA/MACD/CCI + all indicators)...`);
    const inds = precompute(candles);
    console.log(" done");
    symbolData.push({ symbol, candles, inds });

    if (symbolData.length < SYMBOLS.length) {
      process.stdout.write(`  Cooling down 8s...`);
      await new Promise(r => setTimeout(r, 8000));
      console.log(" ok");
    }
  }

  if (!symbolData.length) {
    console.log("No symbols loaded. Exiting."); return;
  }

  // ── Per-symbol variant table ────────────────────────────────────────────────
  for (const { symbol, candles, inds } of symbolData) {
    const startDate = new Date(candles[220]?.time || 0).toISOString().slice(0, 10);
    const endDate   = new Date(candles[candles.length - 1]?.time || 0).toISOString().slice(0, 10);
    console.log(`\n${"=".repeat(W)}`);
    console.log(`  ${symbol}   ${startDate} -> ${endDate}`);
    console.log(`${"=".repeat(W)}`);
    printVariantTable(candles, inds, symbol);
  }

  // ── Combined P&L across all symbols ────────────────────────────────────────
  if (symbolData.length > 1) {
    console.log(`\n${"=".repeat(W)}`);
    console.log(`  COMBINED (${symbolData.map(d => d.symbol).join(" + ")})`);
    console.log(`${"=".repeat(W)}`);
    console.log(`  ${"Variant".padEnd(28)} ${"Trades".padEnd(8)} ${"WinRate".padEnd(9)} ${"PF".padEnd(7)} ${"P&L".padEnd(10)} MaxDD`);
    console.log(`  ${"-".repeat(74)}`);

    const bestRow = { pf: 0, label: "", v: null };

    for (const v of VARIANTS) {
      let totalTrades = 0, totalWins = 0, totalPnL = 0, totalGW = 0, totalGL = 0, maxDD = 0;
      for (const { symbol, candles, inds } of symbolData) {
        const r     = runBacktest(symbol, candles, inds, v);
        const exits = r.trades.filter(t => t.side === "sell");
        totalTrades += exits.length;
        totalWins   += exits.filter(t => t.pnl > 0).length;
        totalPnL    += exits.reduce((s, t) => s + t.pnl, 0);
        totalGW     += exits.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
        totalGL     += Math.abs(exits.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
        maxDD        = Math.max(maxDD, r.maxDD);
      }
      const wr     = totalTrades ? (totalWins / totalTrades * 100).toFixed(1) + "%" : "-";
      const pfNum  = totalGL > 0 ? totalGW / totalGL : Infinity;
      const pf     = totalGL > 0 ? pfNum.toFixed(2) : "inf";
      const pnlStr = (totalPnL >= 0 ? "+" : "") + "$" + Math.abs(totalPnL).toFixed(2);
      console.log(`  ${v.label.padEnd(28)} ${String(totalTrades).padEnd(8)} ${wr.padEnd(9)} ${pf.padEnd(7)} ${pnlStr.padEnd(10)} ${maxDD.toFixed(2)}%`);

      if (pfNum > bestRow.pf && totalTrades >= 10) {
        bestRow.pf = pfNum; bestRow.label = v.label; bestRow.v = v;
      }
    }

    // ── Detailed report for the best variant ─────────────────────────────────
    if (bestRow.v) {
      console.log(`\n${"=".repeat(W)}`);
      console.log(`  ★ Best combined variant: ${bestRow.label}  (PF ${bestRow.pf.toFixed(2)})`);
      console.log(`${"=".repeat(W)}`);
      for (const { symbol, candles, inds } of symbolData) {
        const result = runBacktest(symbol, candles, inds, bestRow.v);
        printSymbolReport(symbol, result, candles, bestRow.v);
      }
    }
  } else {
    // Single symbol — detailed report for default config
    const defaultCfg = VARIANTS[1]; // sc>=0.25 tp3 bb+rsi50
    const { symbol, candles, inds } = symbolData[0];
    const result = runBacktest(symbol, candles, inds, defaultCfg);
    printSymbolReport(symbol, result, candles, defaultCfg);
  }

  console.log(`\n${"=".repeat(W)}\n`);
}

main().catch(err => {
  console.error("Backtest failed:", err.message);
  process.exit(1);
});
