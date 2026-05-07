#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// backtest-choch-gate.mjs — CHOCH Gate Filter Backtest
//
// Tests whether pausing BOS signals after a "reverse CHOCH" improves P&L.
//
// LOGIC:
//   A "reverse CHOCH" is a CHOCH that goes AGAINST the active trade direction:
//     Contrarian BUY  regime (buy on bearBOS) → bullCHOCH is the reverse
//     Contrarian SELL regime (sell on bullBOS) → bearCHOCH is the reverse
//     Trend-following BUY  (buy on bullBOS)   → bearCHOCH is the reverse
//     Trend-following SELL (sell on bearBOS)  → bullCHOCH is the reverse
//
//   Gate OPEN  = aligned CHOCH fires → BOS signals resume
//   Gate CLOSED= reverse CHOCH fires → BOS signals paused
//
// THREE VARIANTS per symbol:
//   baseline    : current live strategy (no gate)
//   gate-open   : gate starts OPEN at regime start; reverse CHOCH pauses orders;
//                 aligned CHOCH resumes them
//   gate-closed : gate starts CLOSED at regime start; aligned CHOCH required
//                 before first order; same toggle after that
//
// Usage:  node backtest-choch-gate.mjs [days1 days2 ...]
//   e.g.  node backtest-choch-gate.mjs 30 60 90 180
// ═══════════════════════════════════════════════════════════════════════════

// ── Strategy constants ────────────────────────────────────────────────────────
const EMA_FAST      = 50;
const EMA_SLOW      = 200;
const SWING_LB      = 5;
const WARMUP        = SWING_LB * 2 + 2;
const INITIAL_CAP   = 100;
const MIN_ORDER_USD = 1.00;
const MIN_ORDER_QTY = 1e-8;

const PERIODS = (process.argv.slice(2).map(Number).filter(n => n > 0).length
  ? process.argv.slice(2).map(Number).filter(n => n > 0)
  : [30, 60, 90, 180]);

const HOUR_MS       = 3_600_000;
const THIRTY_MIN_MS = 1_800_000;
const FIFTEEN_MIN_MS=   900_000;

// ── Symbol configs — mirrors current SYMBOL_CONFIG in live bot ────────────────
const CONFIGS = [
  {
    sym: "BTC-USD",
    execLabel: "15m", regimeLabel: "1h",
    execFetch:   { gran: 900,  extraDays: 3  },
    regimeFetch: { gran: 3600, extraDays: 12 },
    regimeMs: HOUR_MS,
    regimeFromExec: false,
    trendFollowing: false,
    buyLadder:  [15, 15, 15, 15],
    sellLadder: [ 5, 10, 20, 40],
  },
  {
    sym: "ETH-USD",
    execLabel: "5m", regimeLabel: "30m",
    execFetch:   { gran: 300, extraDays: 6 },
    regimeFetch: null,
    regimeMs: THIRTY_MIN_MS,
    regimeFromExec: true,
    trendFollowing: false,
    buyLadder:  [15, 15, 15, 15],
    sellLadder: [ 5, 10, 20, 40],
  },
  {
    sym: "SOL-USD",
    execLabel: "5m", regimeLabel: "30m",
    execFetch:   { gran: 300, extraDays: 6 },
    regimeFetch: null,
    regimeMs: THIRTY_MIN_MS,
    regimeFromExec: true,
    trendFollowing: false,
    buyLadder:  [15, 15, 15, 15],
    sellLadder: [ 5, 10, 20, 40],
  },
  {
    sym: "LINK-USD",
    execLabel: "5m", regimeLabel: "30m",
    execFetch:   { gran: 300, extraDays: 6 },
    regimeFetch: null,
    regimeMs: THIRTY_MIN_MS,
    regimeFromExec: true,
    trendFollowing: false,
    buyLadder:  [15, 15, 15, 15],
    sellLadder: [33, 33, 33, 33],
  },
  {
    sym: "PEPE-USD",
    execLabel: "5m", regimeLabel: "1h",
    execFetch:   { gran: 300,  extraDays: 3  },
    regimeFetch: { gran: 3600, extraDays: 12 },
    regimeMs: HOUR_MS,
    regimeFromExec: false,
    trendFollowing: true,   // golden=BUY, death=SELL
    buyLadder:  [60, 25, 10,  5],
    sellLadder: [33, 33, 33, 33],
  },
  {
    sym: "AKT-USD",
    execLabel: "5m", regimeLabel: "15m",
    execFetch:   { gran: 300, extraDays: 6 },
    regimeFetch: null,
    regimeMs: FIFTEEN_MIN_MS,
    regimeFromExec: true,
    trendFollowing: false,
    buyLadder:  [60, 25, 10,  5],
    sellLadder: [50, 25, 15, 10],
  },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Data fetch ────────────────────────────────────────────────────────────────
async function fetchAllBars(symbol, granSec, totalDays, label) {
  const cutoff   = Date.now() - totalDays * 86_400_000;
  const windowMs = 300 * granSec * 1000;
  const bars     = [];
  let   endMs    = Date.now();
  process.stdout.write(`  Fetching ${label} (${totalDays}d)`);
  let errors = 0;
  while (endMs > cutoff) {
    const startMs = Math.max(endMs - windowMs, cutoff);
    const url = `https://api.exchange.coinbase.com/products/${symbol}/candles` +
      `?granularity=${granSec}&start=${Math.floor(startMs/1000)}&end=${Math.floor(endMs/1000)}`;
    try {
      const res  = await fetch(url, { headers: {"User-Agent":"craig-backtest/2.0"},
                                      signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("Unexpected response");
      if (data.length) bars.unshift(...data.map(k=>({t:+k[0]*1000,l:+k[1],h:+k[2],o:+k[3],c:+k[4],v:+k[5]})));
      endMs = startMs - granSec * 1000;
      process.stdout.write(".");
      errors = 0;
    } catch(e) {
      process.stdout.write("!");
      if (++errors >= 5) { console.error(`\n  ✗ Too many errors: ${e.message}`); break; }
      await sleep(2000); continue;
    }
    await sleep(130);
  }
  const seen = new Set();
  const result = bars
    .filter(b => { if (seen.has(b.t)) return false; seen.add(b.t); return true; })
    .sort((a,b) => a.t - b.t);
  console.log(` → ${result.length} bars`);
  return result;
}

function aggregateBars(bars, targetMs) {
  const buckets = new Map();
  for (const b of bars) {
    const k = Math.floor(b.t / targetMs) * targetMs;
    if (!buckets.has(k)) buckets.set(k, { t:k, o:b.o, h:b.h, l:b.l, c:b.c, v:b.v??0 });
    else { const a=buckets.get(k); a.h=Math.max(a.h,b.h); a.l=Math.min(a.l,b.l); a.c=b.c; a.v+=b.v??0; }
  }
  return [...buckets.values()].sort((a,b)=>a.t-b.t);
}

// ── EMA ───────────────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  const out=[]; const k=2/(period+1); let sum=0,count=0;
  for (let i=0;i<closes.length;i++) {
    if (count<period) { sum+=closes[i]; count++; out.push(count===period ? sum/period : null); }
    else { out.push(closes[i]*k+out[i-1]*(1-k)); }
  }
  return out;
}

function buildRegimeMaps(candles, regimeMs) {
  const closes=candles.map(c=>c.c), emaF=calcEMA(closes,EMA_FAST), emaS=calcEMA(closes,EMA_SLOW);
  const crossMap=new Map(), stateMap=new Map();
  for (let i=1;i<candles.length;i++) {
    const ef=emaF[i],es=emaS[i],efP=emaF[i-1],esP=emaS[i-1];
    if (!ef||!es||!efP||!esP) continue;
    const ct=candles[i].t+regimeMs;
    stateMap.set(ct, ef>es?"golden":"death");
    if      (efP<=esP&&ef>es) crossMap.set(ct,"golden");
    else if (efP>=esP&&ef<es) crossMap.set(ct,"death");
  }
  return {crossMap,stateMap};
}

// ── Core simulation ───────────────────────────────────────────────────────────
// variant: "baseline" | "gate-open" | "gate-closed"
function runSim(cfg, execBars, regimeBars, lookbackDays, variant) {
  const { regimeMs, buyLadder, sellLadder, trendFollowing } = cfg;
  const buySlot  = n => buyLadder [Math.min(n, buyLadder.length  - 1)];
  const sellSlot = n => sellLadder[Math.min(n, sellLadder.length - 1)];

  const { crossMap, stateMap } = buildRegimeMaps(regimeBars, regimeMs);

  const startMs       = Date.now() - lookbackDays * 86_400_000;
  const backtestBars  = execBars.filter(b => b.t >= startMs);
  if (!backtestBars.length) return null;

  // Init regime from stateMap at backtest start
  const firstBar   = backtestBars[0];
  const initBucket = Math.floor(firstBar.t / regimeMs) * regimeMs;
  let initRegime   = "neutral";
  for (let offset = 0; offset <= 3; offset++) {
    const t = initBucket + offset * regimeMs;
    if (stateMap.has(t)) {
      const s = stateMap.get(t);
      initRegime = trendFollowing ? (s==="golden"?"buy":"sell") : (s==="death"?"buy":"sell");
      break;
    }
    if (offset > 0 && stateMap.has(initBucket - offset * regimeMs)) {
      const s = stateMap.get(initBucket - offset * regimeMs);
      initRegime = trendFollowing ? (s==="golden"?"buy":"sell") : (s==="death"?"buy":"sell");
      break;
    }
  }

  // Simulation state
  let cash                 = INITIAL_CAP;
  let cryptoQty            = 0;
  let regime               = initRegime;
  let bosCount             = 0;
  let regimeStartCapital   = regime === "buy"  ? INITIAL_CAP : 0;
  let regimeStartCryptoQty = 0;
  let structure            = 0;
  let lastSH               = null;
  let lastSL               = null;
  const regimeCount        = { buy: 0, sell: 0 };
  const trades             = [];

  // CHOCH gate state:
  //   baseline   → chochGated always true (no filtering)
  //   gate-open  → starts true at regime start; reverse CHOCH closes it; aligned CHOCH opens it
  //   gate-closed→ starts false at regime start; aligned CHOCH opens it; reverse CHOCH closes it
  let chochGated = variant === "gate-closed" ? false : true;

  let peakValue = INITIAL_CAP, maxDrawdown = 0, crosses = 0;
  let gatedOutBuys = 0, gatedOutSells = 0;  // count of signals skipped due to gate

  for (let i = 0; i < backtestBars.length; i++) {
    const bar = backtestBars[i];

    // ── Regime change ──────────────────────────────────────────────────────────
    if (bar.t % regimeMs === 0) {
      const cross = crossMap.get(bar.t);
      const buyOnCross  = trendFollowing ? "golden" : "death";
      const sellOnCross = trendFollowing ? "death"  : "golden";

      if (cross === buyOnCross && regime !== "buy") {
        regime               = "buy";
        bosCount             = 0;
        regimeStartCapital   = cash + cryptoQty * bar.c;
        structure = 0; lastSH = null; lastSL = null;
        regimeCount.buy++;
        crosses++;
        // Reset gate on regime change
        chochGated = variant === "gate-closed" ? false : true;
      } else if (cross === sellOnCross && regime !== "sell") {
        regime                = "sell";
        bosCount              = 0;
        regimeStartCryptoQty  = cryptoQty;
        regimeStartCapital    = cash + cryptoQty * bar.c;
        structure = 0; lastSH = null; lastSL = null;
        regimeCount.sell++;
        crosses++;
        // Reset gate on regime change
        chochGated = variant === "gate-closed" ? false : true;
      }
    }

    if (i < WARMUP) continue;

    // ── Swing pivot detection ──────────────────────────────────────────────────
    const pIdx = i - SWING_LB;
    if (pIdx >= SWING_LB) {
      const pb = backtestBars[pIdx];
      let isPH = true, isPL = true;
      for (let j = 1; j <= SWING_LB; j++) {
        const prev = backtestBars[pIdx - j], next = backtestBars[pIdx + j];
        if (!prev || !next) { isPH = isPL = false; break; }
        if (prev.h >= pb.h || next.h >= pb.h) isPH = false;
        if (prev.l <= pb.l || next.l <= pb.l) isPL = false;
      }
      if (isPH && (!lastSH || pb.t >= lastSH.t)) lastSH = { price: pb.h, t: pb.t };
      if (isPL && (!lastSL || pb.t >= lastSL.t)) lastSL = { price: pb.l, t: pb.t };
    }

    // ── BOS / CHOCH detection ──────────────────────────────────────────────────
    let bullBOS = false, bearBOS = false, bullCHOCH = false, bearCHOCH = false;
    if (lastSH && lastSL && i > 0) {
      const pc = backtestBars[i - 1].c;
      if (bar.c > lastSH.price && pc <= lastSH.price) {
        if (structure === -1) bullCHOCH = true; else bullBOS = true;
        structure = 1;
      }
      if (bar.c < lastSL.price && pc >= lastSL.price) {
        if (structure === 1) bearCHOCH = true; else bearBOS = true;
        structure = -1;
      }
    }

    if (regime === "neutral") continue;

    // ── CHOCH gate toggling ────────────────────────────────────────────────────
    // "Aligned CHOCH" = CHOCH in the same direction as the trade signal → opens gate
    // "Reverse CHOCH" = CHOCH opposing the trade direction → closes gate
    if (variant !== "baseline") {
      if (regime === "buy") {
        // Contrarian BUY: trade on bearBOS → aligned = bearCHOCH, reverse = bullCHOCH
        // Trend-following BUY: trade on bullBOS → aligned = bullCHOCH, reverse = bearCHOCH
        const alignedCHOCH = trendFollowing ? bullCHOCH : bearCHOCH;
        const reverseCHOCH = trendFollowing ? bearCHOCH : bullCHOCH;
        if (alignedCHOCH) chochGated = true;
        if (reverseCHOCH) chochGated = false;
      } else {
        // Contrarian SELL: trade on bullBOS → aligned = bullCHOCH, reverse = bearCHOCH
        // Trend-following SELL: trade on bearBOS → aligned = bearCHOCH, reverse = bullCHOCH
        const alignedCHOCH = trendFollowing ? bearCHOCH : bullCHOCH;
        const reverseCHOCH = trendFollowing ? bullCHOCH : bearCHOCH;
        if (alignedCHOCH) chochGated = true;
        if (reverseCHOCH) chochGated = false;
      }
    }

    // ── BUY regime ─────────────────────────────────────────────────────────────
    if (regime === "buy") {
      const bosBuySignal = trendFollowing ? bullBOS : bearBOS;
      if (bosBuySignal) {
        const buyUSD = Math.min((regimeStartCapital * buySlot(bosCount)) / 100, cash);
        if (buyUSD >= MIN_ORDER_USD) {
          if (variant === "baseline" || chochGated) {
            cryptoQty += buyUSD / bar.c;
            cash      -= buyUSD;
            bosCount++;
            trades.push({ t: bar.t, type: "buy_bos", price: bar.c, usd: buyUSD });
          } else {
            gatedOutBuys++;
          }
        }
      }
    }

    // ── SELL regime ────────────────────────────────────────────────────────────
    if (regime === "sell") {
      const bosSellSignal = trendFollowing ? bearBOS : bullBOS;
      if (bosSellSignal) {
        const sellQty = Math.min((regimeStartCryptoQty * sellSlot(bosCount)) / 100, cryptoQty);
        if (sellQty >= MIN_ORDER_QTY) {
          if (variant === "baseline" || chochGated) {
            cash      += sellQty * bar.c;
            cryptoQty -= sellQty;
            bosCount++;
            trades.push({ t: bar.t, type: "sell_bos", price: bar.c, qty: sellQty, usd: sellQty * bar.c });
          } else {
            gatedOutSells++;
          }
        }
      }
    }

    // ── Drawdown tracking ──────────────────────────────────────────────────────
    const tv = cash + cryptoQty * bar.c;
    if (tv > peakValue) peakValue = tv;
    const dd = peakValue > 0 ? (peakValue - tv) / peakValue * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const lastBar  = backtestBars.at(-1);
  const finalVal = cash + cryptoQty * lastBar.c;
  const pnlPct   = (finalVal - INITIAL_CAP) / INITIAL_CAP * 100;
  const bah      = (lastBar.c - firstBar.c) / firstBar.c * 100;
  const alpha    = pnlPct - bah;

  return {
    finalVal, cash, cryptoQty,
    pnlPct, bah, alpha,
    maxDrawdown,
    trades: trades.length,
    buys:   trades.filter(t => t.type.startsWith("buy")).length,
    sells:  trades.filter(t => t.type.startsWith("sell")).length,
    gatedOutBuys, gatedOutSells,
    crosses, regimeCount,
    currentRegime: regime,
    firstPrice: firstBar.c,
    lastPrice:  lastBar.c,
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────
const s2 = n => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  CHOCH Gate Filter Backtest                                        ║`);
  console.log(`║  Variants: baseline | gate-open | gate-closed                      ║`);
  console.log(`║  Periods: ${PERIODS.join("d / ")}d                                              ║`);
  console.log(`╚════════════════════════════════════════════════════════════════════╝\n`);

  // ── Fetch all data once across all periods ────────────────────────────────────
  const maxDays = Math.max(...PERIODS);
  const dataCache = new Map(); // sym → { execBars, regimeBars }

  for (const cfg of CONFIGS) {
    console.log(`\n─── Fetching ${cfg.sym} ─────────────────────────────────────────────`);
    const execDays   = maxDays + cfg.execFetch.extraDays;
    const execBars   = await fetchAllBars(cfg.sym, cfg.execFetch.gran, execDays, `${cfg.sym} ${cfg.execLabel}`);
    if (!execBars.length) { console.log(`  ✗ No exec data`); continue; }

    let regimeBars;
    if (cfg.regimeFromExec) {
      regimeBars = aggregateBars(execBars, cfg.regimeMs);
      console.log(`  Aggregated → ${regimeBars.length} × ${cfg.regimeLabel} bars`);
    } else {
      await sleep(400);
      const regimeDays = maxDays + cfg.regimeFetch.extraDays;
      regimeBars = await fetchAllBars(cfg.sym, cfg.regimeFetch.gran, regimeDays, `${cfg.sym} ${cfg.regimeLabel}`);
    }
    if (regimeBars.length < EMA_SLOW + 10) { console.log(`  ✗ Insufficient regime bars`); continue; }

    dataCache.set(cfg.sym, { execBars, regimeBars });
    await sleep(600);
  }

  const VARIANTS = ["baseline", "gate-open", "gate-closed"];

  // ── Run all combinations ──────────────────────────────────────────────────────
  // results[period][sym][variant] = simResult
  const allResults = {};

  for (const days of PERIODS) {
    allResults[days] = {};
    for (const cfg of CONFIGS) {
      if (!dataCache.has(cfg.sym)) continue;
      const { execBars, regimeBars } = dataCache.get(cfg.sym);
      allResults[days][cfg.sym] = {};
      for (const variant of VARIANTS) {
        const r = runSim(cfg, execBars, regimeBars, days, variant);
        allResults[days][cfg.sym][variant] = r;
      }
    }
  }

  // ── Print results ─────────────────────────────────────────────────────────────
  for (const days of PERIODS) {
    const W = 108;
    console.log(`\n\n${"═".repeat(W)}`);
    console.log(`  ${days}d BACKTEST — CHOCH Gate Comparison  ($${INITIAL_CAP}/symbol)`);
    console.log(`${"═".repeat(W)}`);

    const hdr = [
      "Symbol".padEnd(10),
      "Variant".padEnd(12),
      "P&L".padStart(9),
      "vs B&H".padStart(9),
      "B&H".padStart(8),
      "MaxDD".padStart(8),
      "Trades".padStart(7),
      "Gated".padStart(7),
      "Final$".padStart(9),
    ];
    console.log(`  ${hdr.join(" ")}`);
    console.log(`  ${"-".repeat(W - 2)}`);

    const periodTotals = {};
    for (const v of VARIANTS) periodTotals[v] = { finalVal: 0, count: 0, alpha: 0, gatedOut: 0 };

    for (const cfg of CONFIGS) {
      if (!allResults[days][cfg.sym]) continue;
      const symResults = allResults[days][cfg.sym];
      let rowIdx = 0;
      for (const variant of VARIANTS) {
        const r = symResults[variant];
        if (!r) continue;
        const flag = variant === "baseline" ? "   "
          : r.pnlPct > symResults["baseline"].pnlPct ? "✅ " : "❌ ";
        const gatedTotal = r.gatedOutBuys + r.gatedOutSells;
        const row = [
          (rowIdx === 0 ? cfg.sym : "").padEnd(10),
          variant.padEnd(12),
          s2(r.pnlPct).padStart(9),
          s2(r.alpha).padStart(9),
          s2(r.bah).padStart(8),
          ("-" + r.maxDrawdown.toFixed(2) + "%").padStart(8),
          String(r.trades).padStart(7),
          (gatedTotal > 0 ? `-${gatedTotal}` : "-").padStart(7),
          ("$" + r.finalVal.toFixed(2)).padStart(9),
        ];
        console.log(`${flag} ${row.join(" ")}`);
        periodTotals[variant].finalVal += r.finalVal;
        periodTotals[variant].count++;
        periodTotals[variant].alpha += r.alpha;
        periodTotals[variant].gatedOut += gatedTotal;
        rowIdx++;
      }
      console.log(`     ${" ".repeat(W - 5)}`);
    }

    // Portfolio summary row
    console.log(`  ${"-".repeat(W - 2)}`);
    console.log(`  PORTFOLIO TOTAL (${Object.keys(allResults[days]).length} symbols × $${INITIAL_CAP}):`);
    for (const variant of VARIANTS) {
      const t = periodTotals[variant];
      const totalStart = t.count * INITIAL_CAP;
      const totalPnl   = (t.finalVal - totalStart) / totalStart * 100;
      const avgAlpha   = t.alpha / t.count;
      const flag = variant === "baseline" ? "   "
        : t.finalVal > periodTotals["baseline"].finalVal ? "✅ " : "❌ ";
      console.log(`${flag}  ${variant.padEnd(12)}  Total: $${t.finalVal.toFixed(2).padStart(8)}  P&L: ${s2(totalPnl).padStart(8)}  AvgAlpha: ${s2(avgAlpha).padStart(8)}  TotalGated: ${t.gatedOut}`);
    }
    console.log(`${"═".repeat(W)}`);
  }

  // ── Cross-period alpha delta summary ─────────────────────────────────────────
  console.log(`\n\n${"═".repeat(70)}`);
  console.log(`  CHOCH GATE ALPHA DELTA vs BASELINE  (gate P&L − baseline P&L)`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  ${"Symbol".padEnd(10)} ${"Variant".padEnd(14)} ${PERIODS.map(d => String(d+"d").padStart(8)).join(" ")}`);
  console.log(`  ${"-".repeat(68)}`);

  for (const cfg of CONFIGS) {
    for (const variant of ["gate-open", "gate-closed"]) {
      const deltas = PERIODS.map(days => {
        const base  = allResults[days]?.[cfg.sym]?.["baseline"];
        const gated = allResults[days]?.[cfg.sym]?.[variant];
        if (!base || !gated) return "  N/A  ";
        const delta = gated.pnlPct - base.pnlPct;
        return (delta >= 0 ? "+" : "") + delta.toFixed(2) + "%";
      });
      const anyBetter = deltas.some(d => d.startsWith("+"));
      const flag = anyBetter ? "✅" : "❌";
      console.log(`${flag} ${cfg.sym.padEnd(10)} ${variant.padEnd(14)} ${deltas.map(d => d.padStart(8)).join(" ")}`);
    }
    console.log("");
  }

  // ── Gated signals summary (how many signals were filtered per symbol) ─────────
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  SIGNALS FILTERED BY GATE  (buys+sells skipped / total signals)`);
  console.log(`${"═".repeat(70)}`);
  const longestPeriod = Math.max(...PERIODS);
  console.log(`  (using ${longestPeriod}d window)`);
  console.log(`  ${"Symbol".padEnd(10)} ${"gate-open".padEnd(20)} ${"gate-closed".padEnd(20)}`);
  console.log(`  ${"-".repeat(50)}`);
  for (const cfg of CONFIGS) {
    const r = allResults[longestPeriod]?.[cfg.sym];
    if (!r) continue;
    const base  = r["baseline"];
    const go    = r["gate-open"];
    const gc    = r["gate-closed"];
    if (!base || !go || !gc) continue;
    const goGated  = go.gatedOutBuys + go.gatedOutSells;
    const gcGated  = gc.gatedOutBuys + gc.gatedOutSells;
    const total    = base.trades;
    const goPct    = total > 0 ? (goGated  / (total + goGated)  * 100).toFixed(0) : "0";
    const gcPct    = total > 0 ? (gcGated  / (total + gcGated)  * 100).toFixed(0) : "0";
    console.log(`  ${cfg.sym.padEnd(10)} ${`-${goGated} (${goPct}% filtered)`.padEnd(20)} ${`-${gcGated} (${gcPct}% filtered)`.padEnd(20)}`);
  }
  console.log(`${"═".repeat(70)}\n`);
}

main().catch(e => { console.error("\n✗ Fatal:", e.message, e.stack); process.exit(1); });
