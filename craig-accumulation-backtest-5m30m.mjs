#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// craig-accumulation-backtest-5m30m.mjs
// Accumulation / Distribution — 5m entries / 30m regime
//
// REGIME (30m EMA50/EMA200 cross):
//   Death cross  → BUY  regime (accumulate)
//   Golden cross → SELL regime (distribute)
//
// EXECUTION (5m BOS/CHOCH detection):
//   BUY regime:
//     • Each bearish BOS  → scaled buy  [8/12/18/27% of regime-start capital]
//     • Bullish CHOCH     → continues scale (next slot, not all-in)
//   SELL regime:
//     • Each bullish BOS  → scaled sell [8/12/18/27% of regime-start crypto]
//     • Bearish CHOCH     → continues scale
//
// UNLIMITED_SLOTS mode:
//   Removes the 4-slot cap — every BOS/CHOCH signal fires regardless of bosCount.
//   Slots 5+ repeat at the last ladder percentage (27%) until capital is exhausted.
//   Both LIMITED and UNLIMITED are run per scenario for direct comparison.
//
// NOTE: Coinbase retains ~30–60 days of 5m data.
//       Scenarios > 60d or historical slices will auto-skip if data is unavailable.
// ═══════════════════════════════════════════════════════════════════════════

// ── Config ────────────────────────────────────────────────────────────────────
const SYMBOLS         = ["ETH-USD", "SOL-USD", "LINK-USD", "AKT-USD"];  // 5m exec / 30m regime
const INITIAL_CAPITAL = 500;

const EMA_FAST  = 50;   // on 30m candles → 50 × 30m = 25h lookback
const EMA_SLOW  = 200;  // on 30m candles → 200 × 30m = 100h lookback
const SWING_LB  = 5;    // 5m pivot: 5 bars each side → 25 min confirmation

const BOS_SCALE_PCT_BUY        = [8, 12, 18, 27];   // buy scale-in
const BOS_SCALE_PCT_SELL       = [15, 18, 27, 27];  // sell scale-out (larger first exit)
const REQUIRE_BOS_BEFORE_CHOCH = true;
const CHOCH_CONTINUE_SCALE     = true;  // CHOCH uses next scale slot, not all-in

const THIRTY_MIN_MS = 30 * 60 * 1000;
const CB_MAX        = 350;

// ── Test scenarios ────────────────────────────────────────────────────────────
// daysBias = exec window + 30d warmup buffer for EMA200 on 30m
// 5m data availability: Coinbase retains ~30–60 days; longer windows auto-skip.
const SCENARIOS = [
  { label: "Last  14d",  daysExec:  14, daysBias:  44 },
  { label: "Last  30d",  daysExec:  30, daysBias:  60 },
  { label: "Last  45d",  daysExec:  45, daysBias:  75 },
  { label: "Last  60d",  daysExec:  60, daysBias:  90 },
];

const TF = {
  exec: { gran: "FIVE_MINUTE",    secs:   300, label: "5m"  },
  bias: { gran: "THIRTY_MINUTE",  secs:  1800, label: "30m" },
};

// ── Coinbase candle fetch ─────────────────────────────────────────────────────
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
    await new Promise(r => setTimeout(r, 60)); // gentle throttle
  }

  const seen = new Set();
  const candles = allCandles
    .filter(c => { if (seen.has(c.t)) return false; seen.add(c.t); return true; })
    .sort((a, b) => a.t - b.t);

  const windowStart = endMs - days * 86400 * 1000;
  const trimmed = candles.filter(c => c.t >= windowStart && c.t <= endMs);
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

// ── 30m Regime pre-computation ────────────────────────────────────────────────
function buildRegime(candles30m) {
  const closes = candles30m.map(c => c.c);
  const emaF   = calcEMA(closes, EMA_FAST);
  const emaS   = calcEMA(closes, EMA_SLOW);

  const crossMap = new Map();
  const stateMap = new Map();

  for (let i = 1; i < candles30m.length; i++) {
    const ef = emaF[i],  es = emaS[i];
    const efP= emaF[i-1],esP= emaS[i-1];
    if (!ef || !es || !efP || !esP) continue;

    // Key = timestamp at which the 30m bar CLOSES (start + 30m)
    const closeTime = candles30m[i].t + THIRTY_MIN_MS;
    stateMap.set(closeTime, ef > es ? "golden" : "death");

    if (efP <= esP && ef > es) crossMap.set(closeTime, "golden");
    else if (efP >= esP && ef < es) crossMap.set(closeTime, "death");
  }

  return { crossMap, stateMap };
}

// ── Simulation ────────────────────────────────────────────────────────────────
// unlimitedSlots = false → cap at BOS_SCALE_PCT.length (4)
// unlimitedSlots = true  → every BOS/CHOCH fires; slots 5+ repeat at last pct (27%)
function simulate(candles5m, candles30m, unlimitedSlots = false) {
  const { crossMap, stateMap } = buildRegime(candles30m);

  let structure = 0;
  let lastSH    = null;
  let lastSL    = null;

  let cash      = INITIAL_CAPITAL;
  let cryptoQty = 0;
  let regime    = "neutral";
  let bosCount  = 0;
  let regimeStartCapital  = INITIAL_CAPITAL;
  let regimeStartCryptoQty = 0;

  const trades      = [];
  const equityCurve = [];
  const regimeCount = { buy: 0, sell: 0 };
  let initialized   = false;

  const warmup = SWING_LB * 2 + 2;

  for (let i = warmup; i < candles5m.length; i++) {
    const bar = candles5m[i];

    // ── 1. Pivot detection (5m) ───────────────────────────────────────────────
    const pIdx = i - SWING_LB;
    if (pIdx >= SWING_LB) {
      const pb = candles5m[pIdx];
      let isPH = true, isPL = true;
      for (let j = 1; j <= SWING_LB; j++) {
        if (candles5m[pIdx-j].h >= pb.h || candles5m[pIdx+j].h >= pb.h) isPH = false;
        if (candles5m[pIdx-j].l <= pb.l || candles5m[pIdx+j].l <= pb.l) isPL = false;
      }
      if (isPH) lastSH = { price: pb.h, idx: pIdx };
      if (isPL) lastSL = { price: pb.l, idx: pIdx };
    }

    // ── 2. BOS / CHOCH detection (5m) ────────────────────────────────────────
    let bullBOS = false, bearBOS = false, bullCHOCH = false, bearCHOCH = false;
    if (lastSH && lastSL) {
      const pc = candles5m[i-1].c;
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
      const recentClose = Math.floor(bar.t / THIRTY_MIN_MS) * THIRTY_MIN_MS;
      const state = stateMap.get(recentClose);
      if (state === "death") {
        regime = "buy";
        bosCount = 0;
        regimeStartCapital = cash + cryptoQty * bar.c;
        regimeCount.buy++;
        trades.push({ idx: i, t: bar.t, type: "regime_change", to: "buy", price: bar.c, source: "init" });
      } else if (state === "golden") {
        regime = "sell";
        bosCount = 0;
        regimeStartCryptoQty = cryptoQty;
        regimeCount.sell++;
        trades.push({ idx: i, t: bar.t, type: "regime_change", to: "sell", price: bar.c, source: "init" });
      }
      initialized = true;
    }

    // ── 4. 30m regime change check ────────────────────────────────────────────
    if (bar.t % THIRTY_MIN_MS === 0) {
      const cross = crossMap.get(bar.t);
      if (cross === "death") {
        regime = "buy";
        bosCount = 0;
        regimeStartCapital = cash + cryptoQty * bar.c;
        regimeCount.buy++;
        trades.push({ idx: i, t: bar.t, type: "regime_change", to: "buy", price: bar.c });
      } else if (cross === "golden") {
        regime = "sell";
        bosCount = 0;
        regimeStartCryptoQty = cryptoQty;
        regimeCount.sell++;
        trades.push({ idx: i, t: bar.t, type: "regime_change", to: "sell", price: bar.c });
      }
    }

    // ── 5. Execute trades ─────────────────────────────────────────────────────
    // Helper: pick allocation pct — uses regime-appropriate ladder, clamps to last slot on overflow
    const ladder   = regime === "sell" ? BOS_SCALE_PCT_SELL : BOS_SCALE_PCT_BUY;
    const allocPct = idx => ladder[Math.min(idx, ladder.length - 1)];
    // Whether a BOS/CHOCH slot is available to trade
    const slotOpen = unlimitedSlots
      ? () => true
      : () => bosCount < ladder.length;

    if (regime === "buy") {
      // BOS scaled buy
      if (bearBOS && slotOpen() && cash > 0.01) {
        const buyUSD = Math.min((regimeStartCapital * allocPct(bosCount)) / 100, cash);
        if (buyUSD > 0.01) {
          const qty = buyUSD / bar.c;
          cash      -= buyUSD;
          cryptoQty += qty;
          trades.push({ idx: i, t: bar.t, type: "scaled_buy", price: bar.c, qty, usd: buyUSD, bosNum: bosCount + 1 });
          bosCount++;
        }
      }
      // CHOCH — continue scale (unlimited: repeats last pct; limited: deploys remaining on overflow)
      const chochArmed = !REQUIRE_BOS_BEFORE_CHOCH || bosCount >= 1;
      if (bullCHOCH && chochArmed && cash > 0.01) {
        let buyUSD;
        if (unlimitedSlots || bosCount < ladder.length) {
          buyUSD = Math.min((regimeStartCapital * allocPct(bosCount)) / 100, cash);
        } else {
          buyUSD = cash; // limited overflow: deploy all remaining
        }
        if (buyUSD > 0.01) {
          const qty = buyUSD / bar.c;
          cash      -= buyUSD;
          cryptoQty += qty;
          trades.push({ idx: i, t: bar.t, type: "choch_buy", price: bar.c, qty, usd: buyUSD, bosNum: bosCount + 1 });
          bosCount++;
        }
      }
    }

    if (regime === "sell") {
      // BOS scaled sell
      if (bullBOS && slotOpen() && cryptoQty > 1e-8) {
        const sellQty = Math.min((regimeStartCryptoQty * allocPct(bosCount)) / 100, cryptoQty);
        if (sellQty > 1e-8) {
          const usd = sellQty * bar.c;
          cash      += usd;
          cryptoQty -= sellQty;
          trades.push({ idx: i, t: bar.t, type: "scaled_sell", price: bar.c, qty: sellQty, usd, bosNum: bosCount + 1 });
          bosCount++;
        }
      }
      // CHOCH — continue scale (unlimited: repeats last pct; limited: deploys remaining on overflow)
      const chochArmed = !REQUIRE_BOS_BEFORE_CHOCH || bosCount >= 1;
      if (bearCHOCH && chochArmed && cryptoQty > 1e-8) {
        let sellQty;
        if (unlimitedSlots || bosCount < ladder.length) {
          sellQty = Math.min((regimeStartCryptoQty * allocPct(bosCount)) / 100, cryptoQty);
        } else {
          sellQty = cryptoQty; // limited overflow: sell all remaining
        }
        if (sellQty > 1e-8) {
          const usd = sellQty * bar.c;
          cash      += usd;
          cryptoQty -= sellQty;
          trades.push({ idx: i, t: bar.t, type: "choch_sell", price: bar.c, qty: sellQty, usd, bosNum: bosCount + 1 });
          bosCount++;
        }
      }
    }

    equityCurve.push({ t: bar.t, equity: cash + cryptoQty * bar.c });
  }

  const finalPrice = candles5m.at(-1).c;
  const finalValue = cash + cryptoQty * finalPrice;

  const startBar   = candles5m[warmup] || candles5m[0];
  const startPrice = startBar.c;
  const hodlQty    = INITIAL_CAPITAL / startPrice;
  const hodlValue  = hodlQty * finalPrice;

  let peak = INITIAL_CAPITAL, maxDD = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak - pt.equity;
    if (dd > maxDD) maxDD = dd;
  }

  const buys  = trades.filter(t => t.type === "scaled_buy"  || t.type === "choch_buy");
  const sells = trades.filter(t => t.type === "scaled_sell" || t.type === "choch_sell");

  return {
    candleCount: candles5m.length,
    daysCovered: (candles5m.at(-1).t - candles5m[0].t) / 86_400_000,
    startPrice, endPrice: finalPrice,
    cash, cryptoQty, finalValue,
    pnl:     finalValue - INITIAL_CAPITAL,
    pnlPct: (finalValue - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100,
    hodlValue, hodlPnl: hodlValue - INITIAL_CAPITAL,
    hodlPnlPct: (hodlValue - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100,
    maxDD, regimeCount, trades, buys, sells,
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
  if (t.type === "scaled_sell")   return `SELL BOS  #${t.bosNum}`;
  if (t.type === "choch_sell")    return `SELL CHOCH #${t.bosNum}`;
  if (t.type === "regime_change") return `>>> ${t.to.toUpperCase()} REGIME${t.source ? ` (${t.source})` : ""}`;
  return t.type;
}

function printResult(label, r, symbol) {
  const counts  = r.trades.reduce((m, t) => ((m[t.type] = (m[t.type] || 0) + 1), m), {});
  const avgBuy  = r.buys.length
    ? r.buys.reduce((s, t) => s + t.usd, 0) / r.buys.reduce((s, t) => s + t.qty, 0) : 0;
  const avgSell = r.sells.length
    ? r.sells.reduce((s, t) => s + t.usd, 0) / r.sells.reduce((s, t) => s + t.qty, 0) : 0;
  const edge    = r.pnl - r.hodlPnl;
  const edgePct = r.pnlPct - r.hodlPnlPct;

  console.log(`\n${"═".repeat(62)}`);
  console.log(`  SCENARIO: ${label}`);
  console.log(`${"═".repeat(62)}`);

  console.log(`\n── Period ─────────────────────────────────────────────────`);
  console.log(`  Days       : ${r.daysCovered.toFixed(1)}`);
  console.log(`  ${symbol} start : $${f2(r.startPrice)}`);
  console.log(`  ${symbol} end   : $${f2(r.endPrice)}  (${fpp((r.endPrice / r.startPrice - 1) * 100)})`);

  console.log(`\n── Trades ─────────────────────────────────────────────────`);
  console.log(`  Regime cycles : ${r.regimeCount.buy} BUY, ${r.regimeCount.sell} SELL`);
  console.log(`  Total signals : ${r.buys.length + r.sells.length}`);
  console.log(`    BOS buys    : ${counts.scaled_buy  || 0}`);
  console.log(`    CHOCH buys  : ${counts.choch_buy   || 0}`);
  console.log(`    BOS sells   : ${counts.scaled_sell || 0}`);
  console.log(`    CHOCH sells : ${counts.choch_sell  || 0}`);
  if (avgBuy)  console.log(`  Avg buy price : $${f2(avgBuy)}`);
  if (avgSell) console.log(`  Avg sell price: $${f2(avgSell)}`);
  if (avgBuy && avgSell) console.log(`  Avg spread    : $${f2(avgSell - avgBuy)}`);

  console.log(`\n── Result ─────────────────────────────────────────────────`);
  console.log(`  Cash      : $${f2(r.cash)}`);
  console.log(`  Crypto    : ${f6(r.cryptoQty)} ($${f2(r.cryptoQty * r.endPrice)})`);
  console.log(`  Total     : $${f2(r.finalValue)}`);
  console.log(`  Strategy  : ${fp(r.pnl)} (${fpp(r.pnlPct)})`);
  console.log(`  HODL      : ${fp(r.hodlPnl)} (${fpp(r.hodlPnlPct)})`);
  console.log(`  Edge      : ${fp(edge)} (${fpp(edgePct)} pts)`);
  console.log(`  Max DD    : $${f2(r.maxDD)}`);
  if      (edgePct > 1)  console.log(`  ✅ Strategy OUTPERFORMED HODL`);
  else if (edgePct < -1) console.log(`  ❌ Strategy UNDERPERFORMED HODL`);
  else                   console.log(`  ↔  Strategy ≈ HODL (within 1pt)`);

  if (r.trades.length > 0) {
    console.log(`\n── Trade Log ──────────────────────────────────────────────`);
    for (const t of r.trades) {
      const date = new Date(t.t).toISOString().slice(0, 16).replace("T", " ");
      const tag  = tradeTag(t).padEnd(26);
      if (t.type === "regime_change") {
        console.log(`  ${date}  ${tag} @ $${f2(t.price)}`);
      } else {
        console.log(`  ${date}  ${tag} @ $${f2(t.price).padStart(10)}  $${f2(t.usd).padStart(8)}  (${f6(t.qty)})`);
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Craig Accum Backtest — 5m/30m  —  LIMITED vs UNLIMITED      ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Symbols   : ${SYMBOLS.join(", ")}`);
  console.log(`  Regime    : EMA${EMA_FAST}/EMA${EMA_SLOW} on 30m (${EMA_FAST * 0.5}h / ${EMA_SLOW * 0.5}h lookback)`);
  console.log(`  Execution : 5m BOS/CHOCH  (swing ${SWING_LB} bars = ${SWING_LB * 5} min confirmation)`);
  console.log(`  LIMITED   : max 4 slots — BUY [${BOS_SCALE_PCT_BUY.join(", ")}]%  SELL [${BOS_SCALE_PCT_SELL.join(", ")}]%`);
  console.log(`  UNLIMITED : no slot cap — slots 5+ repeat at last ladder % until capital exhausted`);
  console.log(`  Capital   : $${INITIAL_CAPITAL} per symbol`);
  console.log(`  NOTE: 5m data availability limits backtest to ~30–60 days.\n`);

  // Store both variants: symbolResults[symbol][scenarioLabel] = { limited: r, unlimited: r }
  const symbolResults = {};

  for (const symbol of SYMBOLS) {
    console.log(`\n${"▓".repeat(66)}`);
    console.log(`  SYMBOL: ${symbol}`);
    console.log(`${"▓".repeat(66)}`);

    symbolResults[symbol] = {};

    for (const sc of SCENARIOS) {
      const endMs = sc.endDate
        ? new Date(sc.endDate + "T23:59:59Z").getTime()
        : Date.now();

      console.log(`\n  ▸ ${sc.label}`);

      const candles5m  = await fetchCandles(symbol, TF.exec, sc.daysExec, endMs);
      const candles30m = await fetchCandles(symbol, TF.bias, sc.daysBias, endMs);

      const minBars5m  = sc.daysExec * 24 * 12 * 0.5;
      const minBars30m = EMA_SLOW + 20;

      if (candles5m.length < minBars5m || candles30m.length < minBars30m) {
        console.log(`    ⚠ Skipped — insufficient data (5m: ${candles5m.length} need ${Math.round(minBars5m)}, 30m: ${candles30m.length} need ${minBars30m})`);
        symbolResults[symbol][sc.label] = { skipped: true };
        continue;
      }

      const rLim  = simulate(candles5m, candles30m, false);
      const rUnlim = simulate(candles5m, candles30m, true);

      // Print detailed results for both variants
      printResult(`${symbol} — ${sc.label}  [LIMITED  4 slots]`, rLim,   symbol);
      printResult(`${symbol} — ${sc.label}  [UNLIMITED slots ]`, rUnlim, symbol);

      // Trade count delta
      const limTrades   = rLim.buys.length   + rLim.sells.length;
      const unlimTrades = rUnlim.buys.length + rUnlim.sells.length;
      console.log(`\n  ── Slot comparison ───────────────────────────────────────────`);
      console.log(`  LIMITED   : ${limTrades.toString().padStart(3)} signals  | edge ${fpp(rLim.pnlPct - rLim.hodlPnlPct)}`);
      console.log(`  UNLIMITED : ${unlimTrades.toString().padStart(3)} signals  | edge ${fpp(rUnlim.pnlPct - rUnlim.hodlPnlPct)}`);
      console.log(`  Extra signals from unlimited: ${unlimTrades - limTrades}`);

      symbolResults[symbol][sc.label] = { limited: rLim, unlimited: rUnlim };
    }
  }

  // ── Master comparison table ───────────────────────────────────────────────
  const W = 20;
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  MASTER SUMMARY  —  Edge vs HODL (% pts)`);
  console.log(`${"═".repeat(72)}`);

  for (const symbol of SYMBOLS) {
    console.log(`\n  ${symbol}`);
    console.log(`  ${"─".repeat(66)}`);
    console.log(`  ${"Scenario".padEnd(14)} ${"LIMITED edge".padStart(W)} ${"UNLIMITED edge".padStart(W)} ${"Δ (Unlim−Lim)".padStart(W)}`);
    console.log(`  ${"─".repeat(66)}`);

    for (const sc of SCENARIOS) {
      const entry = symbolResults[symbol][sc.label];
      if (!entry || entry.skipped) {
        console.log(`  ${sc.label.padEnd(14)} ${"SKIP".padStart(W)} ${"SKIP".padStart(W)}`);
        continue;
      }
      const { limited: rl, unlimited: ru } = entry;
      const edgeLim   = rl.pnlPct  - rl.hodlPnlPct;
      const edgeUnlim = ru.pnlPct  - ru.hodlPnlPct;
      const delta     = edgeUnlim  - edgeLim;
      const iconL = edgeLim   > 1 ? "✅" : edgeLim   < -1 ? "❌" : "↔";
      const iconU = edgeUnlim > 1 ? "✅" : edgeUnlim < -1 ? "❌" : "↔";
      const iconD = delta > 0.5 ? "▲" : delta < -0.5 ? "▼" : "─";
      console.log(
        `  ${sc.label.padEnd(14)}` +
        ` ${(fpp(edgeLim)   + " " + iconL).padStart(W)}` +
        ` ${(fpp(edgeUnlim) + " " + iconU).padStart(W)}` +
        ` ${(fpp(delta)     + " " + iconD).padStart(W)}`
      );
    }
  }

  // ── Win-count summary ─────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  WINNER TALLY  (by edge vs HODL across all scenarios × symbols)`);
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
