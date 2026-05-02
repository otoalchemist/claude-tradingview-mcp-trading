#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// craig-accumulation-backtest-1m15m.mjs
// Accumulation / Distribution — 1m entries / 15m regime
// Targets volatile small-caps:  AKT-USD  PEPE-USD
//
// REGIME (15m EMA50/EMA200 cross):
//   Death cross  → BUY  regime (accumulate)
//   Golden cross → SELL regime (distribute)
//
// EXECUTION (1m BOS/CHOCH detection):
//   BUY  regime: bearish BOS → scaled buy  |  bullish CHOCH → continues scale
//   SELL regime: bullish BOS → scaled sell |  bearish CHOCH → continues scale
//
// UNLIMITED slots: slots 5+ repeat at 27% until capital exhausted
// Both LIMITED (4 slots) and UNLIMITED are run for each scenario.
//
// NOTE: Coinbase retains ~4 days of 1m data.
//       Scenarios are capped at 4d exec window.
// ═══════════════════════════════════════════════════════════════════════════

// ── Config ────────────────────────────────────────────────────────────────────
const SYMBOLS         = ["AKT-USD", "PEPE-USD"];
const INITIAL_CAPITAL = 500;

const EMA_FAST  = 50;    // on 15m → 50 × 15m = 12.5h lookback
const EMA_SLOW  = 200;   // on 15m → 200 × 15m = 50h  lookback
const SWING_LB  = 5;     // 1m pivot: 5 bars each side → 5 min confirmation

const BOS_SCALE_PCT            = [8, 12, 18, 27];
const REQUIRE_BOS_BEFORE_CHOCH = true;
const CHOCH_CONTINUE_SCALE     = true;

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const CB_MAX         = 300;

// ── Test scenarios ────────────────────────────────────────────────────────────
// daysBias = exec days + 40d buffer so EMA200 (50h) warms up fully
const SCENARIOS = [
  { label: "Last  1d",  daysExec:  1, daysBias: 41 },
  { label: "Last  2d",  daysExec:  2, daysBias: 42 },
  { label: "Last  3d",  daysExec:  3, daysBias: 43 },
  { label: "Last  4d",  daysExec:  4, daysBias: 44 },
];

const TF = {
  exec: { gran: "ONE_MINUTE",      secs:  60, label: "1m"  },
  bias: { gran: "FIFTEEN_MINUTE",  secs: 900, label: "15m" },
};

// ── Micro-price formatter (PEPE trades at ~$0.000008) ─────────────────────────
function fPrice(n) {
  if (n === 0)              return "$0";
  if (Math.abs(n) >= 1)    return "$" + n.toFixed(2);
  if (Math.abs(n) >= 0.01) return "$" + n.toFixed(4);
  if (Math.abs(n) >= 0.001)return "$" + n.toFixed(5);
  return "$" + n.toFixed(8);
}

// ── Coinbase candle fetch (multi-batch) ───────────────────────────────────────
async function fetchCandles(symbol, tfConfig, days, endMs = Date.now()) {
  const { gran, secs, label } = tfConfig;
  const totalBars = Math.ceil(days * 86400 / secs) + 50;
  let allCandles  = [];
  let batchEnd    = Math.floor(endMs / 1000);
  let emptyCount  = 0;

  process.stdout.write(`  Fetching ${symbol} ${label} (${days}d)... `);

  while (allCandles.length < totalBars) {
    const need       = totalBars - allCandles.length;
    const batchSize  = Math.min(CB_MAX, need);
    const batchStart = batchEnd - batchSize * secs;

    const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${symbol}/candles` +
      `?start=${batchStart}&end=${batchEnd}&granularity=${gran}&limit=${batchSize}`;

    const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
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
    await new Promise(r => setTimeout(r, 80));
  }

  const seen = new Set();
  const candles = allCandles
    .filter(c => { if (seen.has(c.t)) return false; seen.add(c.t); return true; })
    .sort((a, b) => a.t - b.t);

  const windowStart = endMs - days * 86400 * 1000;
  const trimmed     = candles.filter(c => c.t >= windowStart && c.t <= endMs);
  console.log(`${trimmed.length} bars`);
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

// ── 15m Regime map ────────────────────────────────────────────────────────────
function buildRegime(candles15m) {
  const closes   = candles15m.map(c => c.c);
  const emaF     = calcEMA(closes, EMA_FAST);
  const emaS     = calcEMA(closes, EMA_SLOW);
  const crossMap = new Map();
  const stateMap = new Map();

  for (let i = 1; i < candles15m.length; i++) {
    const ef = emaF[i], es = emaS[i], efP = emaF[i - 1], esP = emaS[i - 1];
    if (!ef || !es || !efP || !esP) continue;
    const closeTime = candles15m[i].t + FIFTEEN_MIN_MS;
    stateMap.set(closeTime, ef > es ? "golden" : "death");
    if      (efP <= esP && ef > es) crossMap.set(closeTime, "golden");
    else if (efP >= esP && ef < es) crossMap.set(closeTime, "death");
  }
  return { crossMap, stateMap };
}

// ── Simulation ────────────────────────────────────────────────────────────────
// unlimitedSlots = false → cap at BOS_SCALE_PCT.length (4 slots)
// unlimitedSlots = true  → no cap; slots 5+ repeat at 27% until capital exhausted
function simulate(candles1m, candles15m, unlimitedSlots = false) {
  const { crossMap, stateMap } = buildRegime(candles15m);

  let structure = 0;
  let lastSH    = null;
  let lastSL    = null;

  let cash      = INITIAL_CAPITAL;
  let cryptoQty = 0;
  let regime    = "neutral";
  let bosCount  = 0;
  let regimeStartCapital   = INITIAL_CAPITAL;
  let regimeStartCryptoQty = 0;

  const trades      = [];
  const equityCurve = [];
  const regimeCount = { buy: 0, sell: 0 };
  let initialized   = false;

  const warmup   = SWING_LB * 2 + 2;
  const slotPct  = idx => BOS_SCALE_PCT[Math.min(idx, BOS_SCALE_PCT.length - 1)];
  const slotOpen = () => unlimitedSlots || bosCount < BOS_SCALE_PCT.length;

  for (let i = warmup; i < candles1m.length; i++) {
    const bar = candles1m[i];

    // ── 1. Pivot detection (1m) ───────────────────────────────────────────────
    const pIdx = i - SWING_LB;
    if (pIdx >= SWING_LB) {
      const pb = candles1m[pIdx];
      let isPH = true, isPL = true;
      for (let j = 1; j <= SWING_LB; j++) {
        if (candles1m[pIdx - j].h >= pb.h || candles1m[pIdx + j].h >= pb.h) isPH = false;
        if (candles1m[pIdx - j].l <= pb.l || candles1m[pIdx + j].l <= pb.l) isPL = false;
      }
      if (isPH) lastSH = { price: pb.h, idx: pIdx };
      if (isPL) lastSL = { price: pb.l, idx: pIdx };
    }

    // ── 2. BOS / CHOCH detection (1m) ────────────────────────────────────────
    let bullBOS = false, bearBOS = false, bullCHOCH = false, bearCHOCH = false;
    if (lastSH && lastSL) {
      const pc = candles1m[i - 1].c;
      if (bar.c > lastSH.price && pc <= lastSH.price) {
        if (structure === -1) bullCHOCH = true; else bullBOS = true;
        structure = 1;
      }
      if (bar.c < lastSL.price && pc >= lastSL.price) {
        if (structure === 1) bearCHOCH = true; else bearBOS = true;
        structure = -1;
      }
    }

    // ── 3. Initialize regime on first eligible bar ────────────────────────────
    if (!initialized) {
      const recentClose = Math.floor(bar.t / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS;
      const state       = stateMap.get(recentClose);
      if (state === "death") {
        regime = "buy"; bosCount = 0;
        regimeStartCapital = cash + cryptoQty * bar.c;
        regimeCount.buy++;
        trades.push({ idx: i, t: bar.t, type: "regime_change", to: "buy", price: bar.c, source: "init" });
      } else if (state === "golden") {
        regime = "sell"; bosCount = 0;
        regimeStartCryptoQty = cryptoQty;
        regimeCount.sell++;
        trades.push({ idx: i, t: bar.t, type: "regime_change", to: "sell", price: bar.c, source: "init" });
      }
      initialized = true;
    }

    // ── 4. 15m regime change check ────────────────────────────────────────────
    if (bar.t % FIFTEEN_MIN_MS === 0) {
      const cross = crossMap.get(bar.t);
      if (cross === "death") {
        regime = "buy"; bosCount = 0;
        regimeStartCapital = cash + cryptoQty * bar.c;
        regimeCount.buy++;
        trades.push({ idx: i, t: bar.t, type: "regime_change", to: "buy", price: bar.c });
      } else if (cross === "golden") {
        regime = "sell"; bosCount = 0;
        regimeStartCryptoQty = cryptoQty;
        regimeCount.sell++;
        trades.push({ idx: i, t: bar.t, type: "regime_change", to: "sell", price: bar.c });
      }
    }

    // ── 5. Execute trades ─────────────────────────────────────────────────────
    if (regime === "buy") {
      // BOS scaled buy
      if (bearBOS && slotOpen() && cash > 0.01) {
        const buyUSD = Math.min((regimeStartCapital * slotPct(bosCount)) / 100, cash);
        if (buyUSD > 0.01) {
          const qty = buyUSD / bar.c;
          cash      -= buyUSD;
          cryptoQty += qty;
          trades.push({ idx: i, t: bar.t, type: "scaled_buy",  price: bar.c, qty, usd: buyUSD, bosNum: bosCount + 1 });
          bosCount++;
        }
      }
      // CHOCH buy
      const chochArmedB = !REQUIRE_BOS_BEFORE_CHOCH || bosCount >= 1;
      if (bullCHOCH && chochArmedB && cash > 0.01) {
        const buyUSD = unlimitedSlots || bosCount < BOS_SCALE_PCT.length
          ? Math.min((regimeStartCapital * slotPct(bosCount)) / 100, cash)
          : cash;
        if (buyUSD > 0.01) {
          const qty = buyUSD / bar.c;
          cash      -= buyUSD;
          cryptoQty += qty;
          trades.push({ idx: i, t: bar.t, type: "choch_buy",   price: bar.c, qty, usd: buyUSD, bosNum: bosCount + 1 });
          bosCount++;
        }
      }
    }

    if (regime === "sell") {
      // BOS scaled sell
      if (bullBOS && slotOpen() && cryptoQty > 1e-10) {
        const sellQty = Math.min((regimeStartCryptoQty * slotPct(bosCount)) / 100, cryptoQty);
        if (sellQty > 1e-10) {
          const usd = sellQty * bar.c;
          cash      += usd;
          cryptoQty -= sellQty;
          trades.push({ idx: i, t: bar.t, type: "scaled_sell", price: bar.c, qty: sellQty, usd, bosNum: bosCount + 1 });
          bosCount++;
        }
      }
      // CHOCH sell
      const chochArmedS = !REQUIRE_BOS_BEFORE_CHOCH || bosCount >= 1;
      if (bearCHOCH && chochArmedS && cryptoQty > 1e-10) {
        const sellQty = unlimitedSlots || bosCount < BOS_SCALE_PCT.length
          ? Math.min((regimeStartCryptoQty * slotPct(bosCount)) / 100, cryptoQty)
          : cryptoQty;
        if (sellQty > 1e-10) {
          const usd = sellQty * bar.c;
          cash      += usd;
          cryptoQty -= sellQty;
          trades.push({ idx: i, t: bar.t, type: "choch_sell",  price: bar.c, qty: sellQty, usd, bosNum: bosCount + 1 });
          bosCount++;
        }
      }
    }

    equityCurve.push({ t: bar.t, equity: cash + cryptoQty * bar.c });
  }

  const finalPrice = candles1m.at(-1).c;
  const finalValue = cash + cryptoQty * finalPrice;

  const startBar   = candles1m[warmup] || candles1m[0];
  const startPrice = startBar.c;
  const hodlValue  = (INITIAL_CAPITAL / startPrice) * finalPrice;

  let peak = INITIAL_CAPITAL, maxDD = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak - pt.equity;
    if (dd > maxDD) maxDD = dd;
  }

  const buys  = trades.filter(t => t.type === "scaled_buy"  || t.type === "choch_buy");
  const sells = trades.filter(t => t.type === "scaled_sell" || t.type === "choch_sell");

  // Avg buy/sell price (weighted by qty)
  const avgBuy  = buys.length
    ? buys.reduce((s, t) => s + t.usd, 0) / buys.reduce((s, t) => s + t.qty, 0) : 0;
  const avgSell = sells.length
    ? sells.reduce((s, t) => s + t.usd, 0) / sells.reduce((s, t) => s + t.qty, 0) : 0;

  // Signals per day
  const daysCovered = (candles1m.at(-1).t - candles1m[0].t) / 86_400_000;
  const sigsPerDay  = daysCovered > 0 ? (buys.length + sells.length) / daysCovered : 0;

  return {
    candleCount: candles1m.length,
    daysCovered, startPrice, endPrice: finalPrice,
    cash, cryptoQty, finalValue,
    pnl:     finalValue - INITIAL_CAPITAL,
    pnlPct: (finalValue - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100,
    hodlValue, hodlPnl: hodlValue - INITIAL_CAPITAL,
    hodlPnlPct: (hodlValue - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100,
    maxDD, regimeCount, trades, buys, sells,
    avgBuy, avgSell, sigsPerDay,
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────
const f2  = n => n.toFixed(2);
const fpp = n => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const fp  = n => (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2);

function printResult(label, r, symbol) {
  const counts   = r.trades.reduce((m, t) => ((m[t.type] = (m[t.type] || 0) + 1), m), {});
  const edge     = r.pnl - r.hodlPnl;
  const edgePct  = r.pnlPct - r.hodlPnlPct;

  console.log(`\n${"═".repeat(64)}`);
  console.log(`  SCENARIO: ${label}`);
  console.log(`${"═".repeat(64)}`);

  console.log(`\n── Period ──────────────────────────────────────────────────`);
  console.log(`  Days        : ${r.daysCovered.toFixed(2)}`);
  console.log(`  ${symbol} start  : ${fPrice(r.startPrice)}`);
  console.log(`  ${symbol} end    : ${fPrice(r.endPrice)}  (${fpp((r.endPrice / r.startPrice - 1) * 100)})`);

  console.log(`\n── Trades ──────────────────────────────────────────────────`);
  console.log(`  Regime cycles : ${r.regimeCount.buy} BUY, ${r.regimeCount.sell} SELL`);
  console.log(`  Total signals : ${r.buys.length + r.sells.length}  (~${r.sigsPerDay.toFixed(1)}/day)`);
  console.log(`    BOS buys    : ${counts.scaled_buy  || 0}`);
  console.log(`    CHOCH buys  : ${counts.choch_buy   || 0}`);
  console.log(`    BOS sells   : ${counts.scaled_sell || 0}`);
  console.log(`    CHOCH sells : ${counts.choch_sell  || 0}`);
  if (r.avgBuy)  console.log(`  Avg buy price : ${fPrice(r.avgBuy)}`);
  if (r.avgSell) console.log(`  Avg sell price: ${fPrice(r.avgSell)}`);
  if (r.avgBuy && r.avgSell) {
    const spread = ((r.avgSell / r.avgBuy) - 1) * 100;
    console.log(`  Buy→Sell edge : ${fpp(spread)}`);
  }

  console.log(`\n── Result ──────────────────────────────────────────────────`);
  console.log(`  Cash      : $${f2(r.cash)}`);
  console.log(`  Crypto    : ${r.cryptoQty.toFixed(6)} (${fPrice(r.cryptoQty * r.endPrice)})`);
  console.log(`  Total     : $${f2(r.finalValue)}`);
  console.log(`  Strategy  : ${fp(r.pnl)} (${fpp(r.pnlPct)})`);
  console.log(`  HODL      : ${fp(r.hodlPnl)} (${fpp(r.hodlPnlPct)})`);
  console.log(`  Edge      : ${fp(edge)} (${fpp(edgePct)} pts)`);
  console.log(`  Max DD    : $${f2(r.maxDD)}`);
  if      (edgePct > 1)  console.log(`  ✅ Strategy OUTPERFORMED HODL`);
  else if (edgePct < -1) console.log(`  ❌ Strategy UNDERPERFORMED HODL`);
  else                   console.log(`  ↔  Strategy ≈ HODL (within 1pt)`);

  // Show last 10 trades in the log to keep output manageable
  if (r.trades.length > 0) {
    const tradesToShow = r.trades.slice(-12);
    const skipped      = r.trades.length - tradesToShow.length;
    console.log(`\n── Trade Log (last 12 of ${r.trades.length}) ${"─".repeat(20)}`);
    if (skipped > 0) console.log(`  ... ${skipped} earlier trades not shown ...`);
    for (const t of tradesToShow) {
      const date = new Date(t.t).toISOString().slice(0, 16).replace("T", " ");
      if (t.type === "regime_change") {
        console.log(`  ${date}  >>> ${t.to.toUpperCase()} REGIME${t.source ? " (init)" : ""}  @ ${fPrice(t.price)}`);
      } else {
        const tag  = (t.type === "scaled_buy"   ? `BUY  BOS  #${t.bosNum}`
                    : t.type === "choch_buy"    ? `BUY  CHOCH #${t.bosNum}`
                    : t.type === "scaled_sell"  ? `SELL BOS  #${t.bosNum}`
                    : t.type === "choch_sell"   ? `SELL CHOCH #${t.bosNum}`
                    : t.type).padEnd(20);
        console.log(`  ${date}  ${tag}  ${fPrice(t.price).padStart(14)}  $${f2(t.usd).padStart(8)}`);
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║  Craig Accum Backtest — 1m entries / 15m regime                ║");
  console.log("║  Volatile coins: AKT-USD  PEPE-USD  |  LIMITED vs UNLIMITED    ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log(`  Regime    : EMA${EMA_FAST}/EMA${EMA_SLOW} on 15m (${EMA_FAST * 0.25}h / ${EMA_SLOW * 0.25}h lookback)`);
  console.log(`  Execution : 1m BOS/CHOCH  (swing ${SWING_LB} bars = ${SWING_LB} min confirmation)`);
  console.log(`  LIMITED   : max ${BOS_SCALE_PCT.length} slots  [${BOS_SCALE_PCT.join(", ")}]%`);
  console.log(`  UNLIMITED : no cap — slots 5+ repeat at ${BOS_SCALE_PCT.at(-1)}%`);
  console.log(`  Capital   : $${INITIAL_CAPITAL} per symbol`);
  console.log(`  NOTE: Coinbase retains ~4d of 1m data — max window is 4d.\n`);

  const symbolResults = {};

  for (const symbol of SYMBOLS) {
    console.log(`\n${"▓".repeat(66)}`);
    console.log(`  SYMBOL: ${symbol}`);
    console.log(`${"▓".repeat(66)}`);

    symbolResults[symbol] = {};

    for (const sc of SCENARIOS) {
      const endMs = Date.now();
      console.log(`\n  ▸ ${sc.label}`);

      const candles1m  = await fetchCandles(symbol, TF.exec, sc.daysExec, endMs);
      const candles15m = await fetchCandles(symbol, TF.bias, sc.daysBias, endMs);

      // 1m: need at least 50% bar fill; 15m: need EMA200 warmup (220 bars)
      const minBars1m  = sc.daysExec * 24 * 60 * 0.5;
      const minBars15m = EMA_SLOW + 20;

      if (candles1m.length < minBars1m || candles15m.length < minBars15m) {
        console.log(`    ⚠ Skipped — insufficient data (1m: ${candles1m.length} need ${Math.round(minBars1m)}, 15m: ${candles15m.length} need ${minBars15m})`);
        symbolResults[symbol][sc.label] = { skipped: true };
        continue;
      }

      const rLim   = simulate(candles1m, candles15m, false);
      const rUnlim = simulate(candles1m, candles15m, true);

      printResult(`${symbol} — ${sc.label}  [LIMITED  4 slots]`, rLim,   symbol);
      printResult(`${symbol} — ${sc.label}  [UNLIMITED slots ]`, rUnlim, symbol);

      const limSigs   = rLim.buys.length   + rLim.sells.length;
      const unlimSigs = rUnlim.buys.length + rUnlim.sells.length;
      console.log(`\n  ── Comparison ──────────────────────────────────────────────`);
      console.log(`  LIMITED   : ${limSigs.toString().padStart(4)} signals  (${rLim.sigsPerDay.toFixed(1)}/day)  | edge ${fpp(rLim.pnlPct - rLim.hodlPnlPct)}`);
      console.log(`  UNLIMITED : ${unlimSigs.toString().padStart(4)} signals  (${rUnlim.sigsPerDay.toFixed(1)}/day)  | edge ${fpp(rUnlim.pnlPct - rUnlim.hodlPnlPct)}`);
      console.log(`  Extra from unlimited: ${unlimSigs - limSigs}`);

      symbolResults[symbol][sc.label] = { limited: rLim, unlimited: rUnlim };
    }
  }

  // ── Master comparison table ───────────────────────────────────────────────
  const W = 20;
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  MASTER SUMMARY  —  Edge vs HODL (% pts)  |  1m exec / 15m regime`);
  console.log(`${"═".repeat(72)}`);

  for (const symbol of SYMBOLS) {
    console.log(`\n  ${symbol}`);
    console.log(`  ${"─".repeat(68)}`);
    console.log(`  ${"Scenario".padEnd(12)} ${"Sigs/day".padStart(10)} ${"LIMITED edge".padStart(W)} ${"UNLIMITED edge".padStart(W)} ${"Δ".padStart(12)}`);
    console.log(`  ${"─".repeat(68)}`);

    for (const sc of SCENARIOS) {
      const entry = symbolResults[symbol][sc.label];
      if (!entry || entry.skipped) {
        console.log(`  ${sc.label.padEnd(12)} ${"SKIP".padStart(10)}`);
        continue;
      }
      const { limited: rl, unlimited: ru } = entry;
      const edgeLim   = rl.pnlPct  - rl.hodlPnlPct;
      const edgeUnlim = ru.pnlPct  - ru.hodlPnlPct;
      const delta     = edgeUnlim  - edgeLim;
      const sigsDay   = ru.sigsPerDay.toFixed(1);
      const iconL = edgeLim   > 1 ? "✅" : edgeLim   < -1 ? "❌" : "↔";
      const iconU = edgeUnlim > 1 ? "✅" : edgeUnlim < -1 ? "❌" : "↔";
      const iconD = delta > 0.5 ? "▲" : delta < -0.5 ? "▼" : "─";
      console.log(
        `  ${sc.label.padEnd(12)}` +
        ` ${sigsDay.padStart(10)}` +
        ` ${(fpp(edgeLim)   + " " + iconL).padStart(W)}` +
        ` ${(fpp(edgeUnlim) + " " + iconU).padStart(W)}` +
        ` ${(fpp(delta)     + " " + iconD).padStart(12)}`
      );
    }
  }

  // ── Signals/day comparison vs 5m/30m ─────────────────────────────────────
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  SIGNAL FREQUENCY NOTE`);
  console.log(`${"═".repeat(72)}`);
  console.log(`  1m/15m  → swing ${SWING_LB} × 1m = ${SWING_LB} min confirmation each side`);
  console.log(`  5m/30m  → swing ${SWING_LB} × 5m = ${SWING_LB * 5} min confirmation each side`);
  console.log(`  15m/1h  → swing ${SWING_LB} × 15m = ${SWING_LB * 15} min confirmation each side`);
  console.log(`  Faster timeframe = more signals = more chop exposure = faster capital deployment`);

  // ── Winner tally ──────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  WINNER TALLY  (UNLIMITED vs LIMITED across all scenarios × symbols)`);
  console.log(`${"═".repeat(72)}`);
  let limWins = 0, unlimWins = 0, ties = 0, total = 0;
  for (const symbol of SYMBOLS) {
    for (const sc of SCENARIOS) {
      const entry = symbolResults[symbol][sc.label];
      if (!entry || entry.skipped) continue;
      const { limited: rl, unlimited: ru } = entry;
      const edgeLim   = rl.pnlPct - rl.hodlPnlPct;
      const edgeUnlim = ru.pnlPct - ru.hodlPnlPct;
      total++;
      if      (edgeUnlim > edgeLim + 0.5) unlimWins++;
      else if (edgeLim   > edgeUnlim + 0.5) limWins++;
      else ties++;
    }
  }
  console.log(`  LIMITED   wins: ${limWins}/${total}`);
  console.log(`  UNLIMITED wins: ${unlimWins}/${total}`);
  console.log(`  Ties           : ${ties}/${total}`);
  console.log("");
}

main().catch(console.error);
