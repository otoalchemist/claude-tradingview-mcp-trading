#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// craig-bot-backtest.mjs — SMC/ICT 3-Step Strategy Backtest
//
// Mirrors craig-bot.js exactly:
//   STEP 1  15m BOS structure → bias (bullish / bearish / neutral)
//   STEP 2  1m CHOCH aligned with bias + high-impact candle + FVG + LIL
//   STEP 3  Entry on FVG pullback | SL at LIL±0.15% | TP 1:4 R:R
//           Break-even: new 1m swing low above entry (long) / high below (short)
//
// SYMBOLS: BTC-USD  ETH-USD  SOL-USD  AKT-USD  PEPE-USD
// ═══════════════════════════════════════════════════════════════════════════

// ── Config (mirrors craig-bot.js defaults) ────────────────────────────────────
const SYMBOLS         = ["BTC-USD", "ETH-USD", "SOL-USD", "AKT-USD", "PEPE-USD"];
const RISK_USD        = 15;
const MAX_POS_USD     = 200;
const SWING_LB        = 5;
const FVG_MIN_GAP_PCT = 0.05 / 100;   // expressed as fraction of price
const CHOCH_BODY_PCT  = 0.40;
const FVG_MAX_AGE_MS  = 30 * 60 * 1000;
const SETUP_EXPIRY_MS = 30 * 60 * 1000;
const SL_BUFFER_PCT   = 0.15 / 100;
const INITIAL_RR      = 4;
const WIN_1M          = 250;           // 1m sliding window
const WIN_15M         = 200;           // 15m sliding window
const MS_15M          = 900_000;
const CB_MAX          = 350;

// How far back to fetch 1m data. Coinbase typically retains ~7–14 days of 1m.
const DAYS_1M  = 14;
const DAYS_15M = 30;

// ── Candle fetch ──────────────────────────────────────────────────────────────
async function fetchCandles(symbol, gran, secsPerBar, days) {
  const totalBars = Math.ceil(days * 86400 / secsPerBar) + 50;
  let allCandles = [];
  let batchEnd   = Math.floor(Date.now() / 1000);
  let emptyCount = 0;

  process.stdout.write(`  Fetching ${symbol} ${gran} (${days}d)... `);

  while (allCandles.length < totalBars) {
    const need       = totalBars - allCandles.length;
    const batchSize  = Math.min(CB_MAX, need);
    const batchStart = batchEnd - batchSize * secsPerBar;

    const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${symbol}/candles`
      + `?start=${batchStart}&end=${batchEnd}&granularity=${gran}&limit=${batchSize}`;

    const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Coinbase ${res.status}`);
    const json = await res.json();

    if (!json.candles?.length) {
      if (++emptyCount >= 2) break;
      batchEnd = batchStart;
      continue;
    }
    emptyCount = 0;

    const batch = json.candles.slice().reverse().map(c => ({
      t: parseInt(c.start) * 1000,
      o: parseFloat(c.open),  h: parseFloat(c.high),
      l: parseFloat(c.low),   c: parseFloat(c.close),
    }));
    allCandles = [...batch, ...allCandles];
    batchEnd   = batchStart;

    // Brief throttle to avoid rate limits on 1m (many requests)
    await new Promise(r => setTimeout(r, 80));
  }

  const seen = new Set();
  const out  = allCandles
    .filter(c => { if (seen.has(c.t)) return false; seen.add(c.t); return true; })
    .sort((a, b) => a.t - b.t);

  console.log(`${out.length} candles  (${(out.length * secsPerBar / 86400).toFixed(1)} days)`);
  return out;
}

// ── Indicator helpers ─────────────────────────────────────────────────────────

function isHighImpact(bar) {
  const range = bar.h - bar.l;
  if (range === 0) return false;
  return Math.abs(bar.c - bar.o) / range >= CHOCH_BODY_PCT;
}

// Detect swing highs/lows in a window (excludes the last SWING_LB bars).
// Returns arrays of { price, idx, t }.
function detectSwings(arr) {
  const highs = [], lows = [];
  const end = arr.length - SWING_LB;
  for (let i = SWING_LB; i < end; i++) {
    let isPH = true, isPL = true;
    for (let j = 1; j <= SWING_LB; j++) {
      if (arr[i-j].h >= arr[i].h || arr[i+j].h >= arr[i].h) isPH = false;
      if (arr[i-j].l <= arr[i].l || arr[i+j].l <= arr[i].l) isPL = false;
    }
    if (isPH) highs.push({ price: arr[i].h, idx: i, t: arr[i].t });
    if (isPL) lows.push({  price: arr[i].l, idx: i, t: arr[i].t });
  }
  return { highs, lows };
}

// 15m bias from the last two confirmed swing highs & lows.
function detect15mBias(win15m) {
  const { highs, lows } = detectSwings(win15m);
  if (highs.length < 2 || lows.length < 2) return "neutral";
  const [pH0, pH1] = highs.slice(-2);
  const [pL0, pL1] = lows.slice(-2);
  if (pH1.price > pH0.price && pL1.price > pL0.price) return "bullish";
  if (pH1.price < pH0.price && pL1.price < pL0.price) return "bearish";
  return "neutral";
}

// FVG scan on win1m.
// Bullish FVG: win1m[i-1].h < win1m[i+1].l (gap above c0)
// Bearish FVG: win1m[i-1].l > win1m[i+1].h (gap below c0)
function detectFVGs(win1m, direction) {
  const avgP   = win1m.slice(-20).reduce((s, b) => s + b.c, 0) / 20;
  const minGap = avgP * FVG_MIN_GAP_PCT;
  const fvgs   = [];

  for (let i = 1; i < win1m.length - 1; i++) {
    const c0 = win1m[i-1], c1 = win1m[i], c2 = win1m[i+1];
    if (direction === "bullish") {
      const gap = c2.l - c0.h;
      if (gap < minGap) continue;
      let filled = false;
      for (let j = i + 2; j < win1m.length; j++) {
        if (win1m[j].c < c0.h) { filled = true; break; }
      }
      if (!filled) fvgs.push({ bottom: c0.h, top: c2.l, mid: (c0.h + c2.l) / 2, idx: i, t: c1.t });
    } else {
      const gap = c0.l - c2.h;
      if (gap < minGap) continue;
      let filled = false;
      for (let j = i + 2; j < win1m.length; j++) {
        if (win1m[j].c > c0.l) { filled = true; break; }
      }
      if (!filled) fvgs.push({ bottom: c2.h, top: c0.l, mid: (c2.h + c0.l) / 2, idx: i, t: c1.t });
    }
  }
  return fvgs; // oldest first (we'll take newest valid one near CHOCH)
}

// ── Simulation ────────────────────────────────────────────────────────────────
function simulate(symbol, candles1m, candles15m) {
  let win1m  = [];   // sliding 1m window
  let win15m = [];   // sliding 15m window of COMPLETED bars

  // 1m incremental pivot state
  let lastSH = null; // { price, t, winIdx }
  let lastSL = null;
  let struct  = 0;   // -1 bearish / 0 neutral / 1 bullish

  // Phase machine
  let phase   = "idle";  // idle | setup | trade
  let setup   = null;    // { direction, fvg, lil, chochT, chochBar }
  let trade   = null;    // { side, entry, sl, tp, qty, sizeUSD, entryT, beTriggered }
  const dbg   = { biasCheck:0, biasNonNeutral:0, chochAligned:0, highImpact:0, fvgFound:0, lilFound:0, setupsDetected:0 };

  const trades     = [];
  const equityCurve = [];
  let totalPnL      = 0;
  let ptr15m        = 0; // pointer into candles15m

  const WARMUP = SWING_LB * 2 + 2;

  for (let i = 0; i < candles1m.length; i++) {
    const bar = candles1m[i];

    // ── Step 1: Advance completed 15m bars ────────────────────────────────────
    while (ptr15m < candles15m.length && candles15m[ptr15m].t + MS_15M <= bar.t) {
      win15m.push(candles15m[ptr15m]);
      if (win15m.length > WIN_15M) win15m.shift();
      ptr15m++;
    }

    // ── Step 2: Add bar to 1m window ──────────────────────────────────────────
    win1m.push(bar);
    if (win1m.length > WIN_1M) win1m.shift();
    if (win1m.length < WARMUP) continue;

    // ── Step 3: Update 1m pivot state (confirm pivot at i - SWING_LB) ─────────
    const pIdx = win1m.length - 1 - SWING_LB;
    if (pIdx >= SWING_LB) {
      const pb = win1m[pIdx];
      let isPH = true, isPL = true;
      for (let j = 1; j <= SWING_LB; j++) {
        if (win1m[pIdx-j].h >= pb.h || win1m[pIdx+j].h >= pb.h) isPH = false;
        if (win1m[pIdx-j].l <= pb.l || win1m[pIdx+j].l <= pb.l) isPL = false;
      }
      if (isPH && (!lastSH || pb.t >= lastSH.t)) lastSH = { price: pb.h, t: pb.t };
      if (isPL && (!lastSL || pb.t >= lastSL.t)) lastSL = { price: pb.l, t: pb.t };
    }

    const prevBar = win1m[win1m.length - 2];

    // ── Step 4: Detect 1m BOS / CHOCH (read struct BEFORE updating it) ────────
    let bullBreak = false, bearBreak = false, bullCHOCH = false, bearCHOCH = false;
    if (lastSH && lastSL && prevBar) {
      if (bar.c > lastSH.price && prevBar.c <= lastSH.price) {
        if (struct === -1) bullCHOCH = true; else bullBreak = true;
        struct = 1;
      }
      if (bar.c < lastSL.price && prevBar.c >= lastSL.price) {
        if (struct === 1) bearCHOCH = true; else bearBreak = true;
        struct = -1;
      }
    }

    // ── Step 5: State machine ──────────────────────────────────────────────────

    // ─ IDLE ─────────────────────────────────────────────────────────────────
    if (phase === "idle") {
      if (win15m.length < WIN_15M * 0.5) continue; // need enough 15m history
      dbg.biasCheck++;

      const bias = detect15mBias(win15m);
      if (bias === "neutral") continue;
      dbg.biasNonNeutral++;

      // Check if this bar formed a CHOCH aligned with the 15m bias
      const alignedCHOCH =
        (bias === "bullish" && bullCHOCH) ||
        (bias === "bearish" && bearCHOCH);

      if (!alignedCHOCH) continue;
      dbg.chochAligned++;

      // Must be a high-impact CHOCH candle
      if (!isHighImpact(bar)) continue;
      dbg.highImpact++;

      const direction = bias === "bullish" ? "bullish" : "bearish";

      // Find FVGs in the last 10 1m bars, not filled, < 30 min old
      const allFVGs = detectFVGs(win1m, direction);
      const chochWinIdx = win1m.length - 1;
      const now = bar.t;
      const nearFVGs = allFVGs.filter(fvg =>
        Math.abs(fvg.idx - chochWinIdx) <= 5 &&
        (now - fvg.t) <= FVG_MAX_AGE_MS
      );
      if (!nearFVGs.length) continue;
      dbg.fvgFound++;
      const bestFVG = nearFVGs[nearFVGs.length - 1]; // newest

      // LIL: most recent 1m swing before CHOCH (in win1m)
      let lil = null;
      if (direction === "bullish") {
        // LIL = most recent swing LOW before CHOCH bar in win1m
        const { lows: swLows } = detectSwings(win1m.slice(0, -1));
        if (!swLows.length) continue;
        lil = swLows[swLows.length - 1];
      } else {
        const { highs: swHighs } = detectSwings(win1m.slice(0, -1));
        if (!swHighs.length) continue;
        lil = swHighs[swHighs.length - 1];
      }
      dbg.lilFound++;

      // NOTE: At CHOCH detection, price is by definition ABOVE the FVG top (bullish)
      // or BELOW the FVG bottom (bearish) — that's expected.  We want to WAIT for
      // a pullback into the FVG.  The SETUP phase handles that with fvgMissed.
      dbg.setupsDetected++;

      setup = { direction, fvg: bestFVG, lil, chochT: bar.t, chochBar: bar };
      phase = "setup";
      continue;
    }

    // ─ SETUP ────────────────────────────────────────────────────────────────
    if (phase === "setup") {
      const age = bar.t - setup.chochT;

      // Expiry check
      if (age > SETUP_EXPIRY_MS) {
        setup = null; phase = "idle"; continue;
      }

      // FVG filled check: price crashed through the FVG without a clean entry
      const fvgFilled = setup.direction === "bullish"
        ? bar.c < setup.fvg.bottom * 0.998
        : bar.c > setup.fvg.top   * 1.002;
      // FVG missed: price ran far ABOVE the CHOCH high (bullish) / below CHOCH low (bearish)
      // without ever retracing to the FVG — setup opportunity gone.
      const fvgMissed = setup.direction === "bullish"
        ? bar.c > setup.chochBar.h * 1.005
        : bar.c < setup.chochBar.l * 0.995;
      if (fvgFilled || fvgMissed) {
        setup = null; phase = "idle"; continue;
      }

      // Entry trigger: price pulled back into FVG zone
      const triggered = setup.direction === "bullish"
        ? bar.l <= setup.fvg.mid   // bar dipped to or below midpoint
        : bar.h >= setup.fvg.mid;

      if (!triggered) continue;

      // Enter
      const entry = setup.fvg.mid;
      let sl, tp, qty, sizeUSD;

      if (setup.direction === "bullish") {
        sl      = setup.lil.price * (1 - SL_BUFFER_PCT);
        tp      = entry + INITIAL_RR * (entry - sl);
        const riskPerUnit = entry - sl;
        if (riskPerUnit <= 0) { setup = null; phase = "idle"; continue; }
        qty     = RISK_USD / riskPerUnit;
        sizeUSD = Math.min(qty * entry, MAX_POS_USD);
        qty     = sizeUSD / entry;
      } else {
        sl      = setup.lil.price * (1 + SL_BUFFER_PCT);
        tp      = entry - INITIAL_RR * (sl - entry);
        const riskPerUnit = sl - entry;
        if (riskPerUnit <= 0) { setup = null; phase = "idle"; continue; }
        qty     = RISK_USD / riskPerUnit;
        sizeUSD = Math.min(qty * entry, MAX_POS_USD);
        qty     = sizeUSD / entry;
      }

      trade = {
        side:        setup.direction === "bullish" ? "long" : "short",
        entry,
        sl, tp, qty, sizeUSD,
        entryT:      bar.t,
        beTriggered: false,
        setupDir:    setup.direction,
      };
      phase = "trade";
      setup = null;
      continue;
    }

    // ─ TRADE ────────────────────────────────────────────────────────────────
    if (phase === "trade" && trade) {
      // Check break-even: new swing in direction of trade, beyond entry
      if (!trade.beTriggered) {
        if (trade.side === "long") {
          // New confirmed 1m swing LOW above entry
          if (lastSL && lastSL.price > trade.entry && lastSL.t > trade.entryT) {
            trade.sl = trade.entry;
            trade.beTriggered = true;
          }
        } else {
          // New confirmed 1m swing HIGH below entry
          if (lastSH && lastSH.price < trade.entry && lastSH.t > trade.entryT) {
            trade.sl = trade.entry;
            trade.beTriggered = true;
          }
        }
      }

      // Check TP / SL hit (use bar high/low for worst-case fill)
      let exitPrice = null, exitReason = null;

      if (trade.side === "long") {
        if (bar.l <= trade.sl && bar.h >= trade.tp) {
          // Both hit same bar — conservative: SL (price could have dropped first)
          exitPrice  = trade.sl; exitReason = trade.beTriggered ? "break_even" : "stop_loss";
        } else if (bar.l <= trade.sl) {
          exitPrice  = trade.sl; exitReason = trade.beTriggered ? "break_even" : "stop_loss";
        } else if (bar.h >= trade.tp) {
          exitPrice  = trade.tp; exitReason = "take_profit";
        }
      } else {
        if (bar.h >= trade.sl && bar.l <= trade.tp) {
          exitPrice  = trade.sl; exitReason = trade.beTriggered ? "break_even" : "stop_loss";
        } else if (bar.h >= trade.sl) {
          exitPrice  = trade.sl; exitReason = trade.beTriggered ? "break_even" : "stop_loss";
        } else if (bar.l <= trade.tp) {
          exitPrice  = trade.tp; exitReason = "take_profit";
        }
      }

      if (exitPrice !== null) {
        const pnl = trade.side === "long"
          ? (exitPrice - trade.entry) * trade.qty
          : (trade.entry - exitPrice) * trade.qty;
        totalPnL += pnl;

        trades.push({
          side:      trade.side,
          entry:     trade.entry,
          exit:      exitPrice,
          sl:        trade.sl,
          tp:        trade.tp,
          qty:       trade.qty,
          sizeUSD:   trade.sizeUSD,
          pnl,
          reason:    exitReason,
          entryT:    trade.entryT,
          exitT:     bar.t,
          be:        trade.beTriggered,
        });

        trade = null; phase = "idle";
      }

      equityCurve.push({ t: bar.t, equity: totalPnL });
      continue;
    }

    equityCurve.push({ t: bar.t, equity: totalPnL });
  }

  // Close any open trade at last bar price
  if (trade && phase === "trade") {
    const lastBar  = candles1m.at(-1);
    const exitP    = lastBar.c;
    const pnl = trade.side === "long"
      ? (exitP - trade.entry) * trade.qty
      : (trade.entry - exitP) * trade.qty;
    totalPnL += pnl;
    trades.push({
      side: trade.side, entry: trade.entry, exit: exitP,
      sl: trade.sl, tp: trade.tp, qty: trade.qty, sizeUSD: trade.sizeUSD,
      pnl, reason: "open_at_end", entryT: trade.entryT, exitT: lastBar.t, be: trade.beTriggered,
    });
  }

  // Stats
  const wins   = trades.filter(t => t.reason === "take_profit");
  const losses = trades.filter(t => t.reason === "stop_loss");
  const bes    = trades.filter(t => t.reason === "break_even");
  const opens  = trades.filter(t => t.reason === "open_at_end");

  const winPnl  = wins.reduce((s, t) => s + t.pnl, 0);
  const lossPnl = losses.reduce((s, t) => s + t.pnl, 0);
  const grossPnl = wins.length ? winPnl : 0;
  const grossLoss = Math.abs(lossPnl);
  const profitFactor = grossLoss > 0 ? grossPnl / grossLoss : wins.length ? Infinity : 0;
  const wr = trades.length ? wins.length / (wins.length + losses.length + bes.length) * 100 : 0;

  let peak = 0, maxDD = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak - pt.equity;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    trades, totalPnL, wins: wins.length, losses: losses.length,
    bes: bes.length, opens: opens.length,
    winPnl, lossPnl, profitFactor, wr, maxDD, dbg,
    days: (candles1m.at(-1).t - candles1m[0].t) / 86_400_000,
    startT: candles1m[0].t, endT: candles1m.at(-1).t,
  };
}

// ── Reporting ─────────────────────────────────────────────────────────────────
const f2  = n => n.toFixed(2);
// Smart price formatter: auto-adjusts decimals for micro-priced tokens
function fPrice(n) {
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1)    return "$" + n.toFixed(2);
  if (Math.abs(n) >= 0.01) return "$" + n.toFixed(4);
  if (Math.abs(n) >= 0.001)return "$" + n.toFixed(5);
  return "$" + n.toFixed(8);
}
const fp  = n => (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2);
const fpp = n => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";

function printResult(symbol, r) {
  const startDate = new Date(r.startT).toISOString().slice(0, 10);
  const endDate   = new Date(r.endT).toISOString().slice(0, 10);
  const totalTrades = r.wins + r.losses + r.bes + r.opens;

  console.log(`\n${"═".repeat(62)}`);
  console.log(`  ${symbol}  |  ${startDate} → ${endDate}  (${r.days.toFixed(1)}d)`);
  console.log(`${"═".repeat(62)}`);
  console.log(`  Trades    : ${totalTrades}  (${r.wins}W / ${r.losses}L / ${r.bes}BE / ${r.opens} open)`);
  console.log(`  Win rate  : ${r.wr.toFixed(1)}%`);
  console.log(`  Prof. fac.: ${isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "∞"}`);
  console.log(`  Total PnL : ${fp(r.totalPnL)}`);
  console.log(`  Win PnL   : ${fp(r.winPnl)}`);
  console.log(`  Loss PnL  : ${fp(r.lossPnl)}`);
  console.log(`  Max DD    : $${f2(r.maxDD)}`);

  const d = r.dbg;
  console.log(`\n  Filter funnel:`);
  console.log(`    bars checked       : ${d.biasCheck}`);
  console.log(`    15m bias non-neutral: ${d.biasNonNeutral}`);
  console.log(`    CHOCH aligned      : ${d.chochAligned}`);
  console.log(`    high-impact candle : ${d.highImpact}`);
  console.log(`    FVG found near CHOCH: ${d.fvgFound}`);
  console.log(`    LIL found          : ${d.lilFound}`);
  console.log(`    setups detected    : ${d.setupsDetected}`);

  if (r.trades.length === 0) {
    console.log(`  → 0 trades triggered from setups`);
    return;
  }

  console.log(`\n  ${"Date/Time".padEnd(18)} ${"Side".padEnd(6)} ${"Entry".padStart(10)} ${"Exit".padStart(10)} ${"Reason".padEnd(12)} ${"PnL".padStart(9)}`);
  console.log(`  ${"-".repeat(68)}`);
  for (const t of r.trades) {
    const date = new Date(t.entryT).toISOString().slice(5, 16).replace("T", " ");
    const side = t.side.toUpperCase();
    const reason = t.reason === "take_profit" ? "TP ✅" :
                   t.reason === "stop_loss"   ? "SL ❌" :
                   t.reason === "break_even"  ? "BE ↔" : "OPEN →";
    console.log(
      `  ${date.padEnd(18)} ${side.padEnd(6)}` +
      ` ${fPrice(t.entry).padStart(12)}` +
      ` ${fPrice(t.exit ).padStart(12)}` +
      ` ${reason.padEnd(12)}` +
      ` ${fp(t.pnl).padStart(9)}`
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  Craig Bot Backtest — SMC/ICT 3-Step Strategy            ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  15m bias  : BOS structure (swing ${SWING_LB} bars each side)`);
  console.log(`  1m exec   : CHOCH (body≥${(CHOCH_BODY_PCT*100).toFixed(0)}%) + FVG + LIL`);
  console.log(`  Entry     : FVG midpoint pullback  (setup expires ${SETUP_EXPIRY_MS/60000}min)`);
  console.log(`  Risk/trade: $${RISK_USD} | Max pos: $${MAX_POS_USD} | R:R 1:${INITIAL_RR}`);
  console.log(`  SL buffer : ${SL_BUFFER_PCT * 100}% beyond LIL\n`);

  const summary = [];

  for (const symbol of SYMBOLS) {
    console.log(`\n▸ ${symbol}`);
    let candles1m, candles15m;

    try {
      [candles1m, candles15m] = await Promise.all([
        fetchCandles(symbol, "ONE_MINUTE",     60,  DAYS_1M),
        fetchCandles(symbol, "FIFTEEN_MINUTE", 900, DAYS_15M),
      ]);
    } catch (e) {
      console.log(`  ❌ Fetch failed: ${e.message}`);
      summary.push({ symbol, error: e.message });
      continue;
    }

    if (candles1m.length < 500 || candles15m.length < 50) {
      console.log(`  ⚠ Insufficient data — 1m:${candles1m.length}  15m:${candles15m.length}`);
      summary.push({ symbol, error: "insufficient data" });
      continue;
    }

    const r = simulate(symbol, candles1m, candles15m);
    printResult(symbol, r);
    summary.push({ symbol, r });
  }

  // ── Summary table ───────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  SUMMARY`);
  console.log(`${"═".repeat(72)}`);
  console.log(`  ${"Symbol".padEnd(12)} ${"Trades".padStart(7)} ${"WR%".padStart(6)} ${"PF".padStart(6)} ${"PnL".padStart(10)} ${"MaxDD".padStart(8)}  Result`);
  console.log(`  ${"-".repeat(68)}`);

  for (const s of summary) {
    if (s.error) {
      console.log(`  ${s.symbol.padEnd(12)} ERROR: ${s.error}`);
      continue;
    }
    const { r } = s;
    const total = r.wins + r.losses + r.bes + r.opens;
    const icon = r.totalPnL > 0 ? "✅" : r.totalPnL < 0 ? "❌" : "↔";
    console.log(
      `  ${s.symbol.padEnd(12)}` +
      ` ${String(total).padStart(7)}` +
      ` ${r.wr.toFixed(1).padStart(6)}` +
      ` ${(isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "∞").padStart(6)}` +
      ` ${fp(r.totalPnL).padStart(10)}` +
      ` ${("$" + f2(r.maxDD)).padStart(8)}` +
      `  ${icon}`
    );
  }
  console.log("");
}

main().catch(console.error);
