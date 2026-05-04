#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// craig-backtest-multi.mjs — Multi-Period Portfolio Backtest
//
// Runs the full 5-symbol backtest across multiple lookback windows and
// prints a side-by-side comparison table to understand how the strategy
// performs at different time horizons.
//
// Usage:  node craig-backtest-multi.mjs [period1 period2 ...]
//   e.g.  node craig-backtest-multi.mjs 30 60 90 180 365
//         node craig-backtest-multi.mjs 90           ← single period
//
// Default periods: 30 60 90 180 365
//
// Per-symbol ladder config (matches live bot):
//   BTC-USD  : buy=[15,15,15,15]   sell=[5,10,20,40]  (flat-15 / back-steep)
//   ETH-USD  : buy=[15,15,15,15]   sell=[5,10,20,40]
//   SOL-USD  : buy=[15,15,15,15]   sell=[5,10,20,40]
//   LINK-USD : buy=[15,15,15,15]   sell=[33,33,33,33] (flat-33 — LINK specific)
//   PEPE-USD : buy=[33,33,33,33]   sell=[30,25,20,10] (front-steep — meme spikes)
// ═══════════════════════════════════════════════════════════════════════════

// ── Strategy constants ────────────────────────────────────────────────────────
const EMA_FAST      = 50;
const EMA_SLOW      = 200;
const SWING_LB      = 5;
const WARMUP        = SWING_LB * 2 + 2;
const INITIAL_CAP   = 100;
const MIN_ORDER_USD = 1.00;
const MIN_ORDER_QTY = 1e-8;
const REQUIRE_BOS_BEFORE_CHOCH = true;
const CHOCH_CONTINUE_SCALE     = true;

// Parse CLI periods; default = 30 60 90 180 365
const PERIODS = process.argv.slice(2).map(Number).filter(n => n > 0 && n <= 730);
const PERIODS_TO_RUN = PERIODS.length ? PERIODS : [30, 60, 90, 180, 365];

// ── Per-symbol configs (mirrors live SYMBOL_CONFIG) ───────────────────────────
const BASE_CONFIGS = [
  {
    sym: "BTC-USD",   execLabel: "15m", regimeLabel: "1h",
    execGran: 900, regimeGran: 3600, regimeMs: 3_600_000,
    regimeFromExec: false,
    extraExecDays:  3,   extraRegimeDays: 12,
    buyLadder:  [15, 15, 15, 15],
    sellLadder: [5, 10, 20, 40],
  },
  {
    sym: "ETH-USD",   execLabel: "5m",  regimeLabel: "30m",
    execGran: 300, regimeGran: null,   regimeMs: 1_800_000,
    regimeFromExec: true,
    extraExecDays:  6,   extraRegimeDays: 0,
    buyLadder:  [15, 15, 15, 15],
    sellLadder: [5, 10, 20, 40],
  },
  {
    sym: "SOL-USD",   execLabel: "5m",  regimeLabel: "30m",
    execGran: 300, regimeGran: null,   regimeMs: 1_800_000,
    regimeFromExec: true,
    extraExecDays:  6,   extraRegimeDays: 0,
    buyLadder:  [15, 15, 15, 15],
    sellLadder: [5, 10, 20, 40],
  },
  {
    sym: "LINK-USD",  execLabel: "5m",  regimeLabel: "30m",
    execGran: 300, regimeGran: null,   regimeMs: 1_800_000,
    regimeFromExec: true,
    extraExecDays:  6,   extraRegimeDays: 0,
    buyLadder:  [15, 15, 15, 15],
    sellLadder: [33, 33, 33, 33],
  },
  {
    sym: "PEPE-USD",  execLabel: "5m",  regimeLabel: "4h",
    execGran: 300, regimeGran: 3600,   regimeMs: 14_400_000,
    regimeFromExec: false,
    regimeAggFromSecs: 3600,
    extraExecDays:  3,   extraRegimeDays: 40,
    buyLadder:  [33, 33, 33, 33],
    sellLadder: [30, 25, 20, 10],
  },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Data fetch ────────────────────────────────────────────────────────────────
async function fetchAllBars(symbol, granSec, totalDays, label) {
  const cutoff   = Date.now() - totalDays * 86_400_000;
  const windowMs = 300 * granSec * 1000;
  const bars     = [];
  let   endMs    = Date.now();
  let   errors   = 0;
  process.stdout.write(`  Fetch ${label} (${totalDays}d)`);

  while (endMs > cutoff) {
    const startMs = Math.max(endMs - windowMs, cutoff);
    const url = `https://api.exchange.coinbase.com/products/${symbol}/candles` +
      `?granularity=${granSec}&start=${Math.floor(startMs/1000)}&end=${Math.floor(endMs/1000)}`;
    try {
      const res  = await fetch(url, { headers: { "User-Agent": "craig-multi-bt/1.0" },
                                      signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("Bad response");
      if (data.length) bars.unshift(...data.map(k => ({ t:+k[0]*1000, l:+k[1], h:+k[2], o:+k[3], c:+k[4] })));
      endMs  = startMs - granSec * 1000;
      errors = 0;
      process.stdout.write(".");
    } catch (e) {
      process.stdout.write("!");
      if (++errors >= 5) { console.error(`\n  ✗ Too many errors: ${e.message}`); break; }
      await sleep(2000); continue;
    }
    await sleep(130);
  }

  const seen = new Set();
  const out  = bars
    .filter(b => { if (seen.has(b.t)) return false; seen.add(b.t); return true; })
    .sort((a, b) => a.t - b.t);
  console.log(` → ${out.length} bars`);
  return out;
}

// ── Aggregation ───────────────────────────────────────────────────────────────
function aggregateBars(bars, targetMs) {
  const buckets = new Map();
  for (const b of bars) {
    const k = Math.floor(b.t / targetMs) * targetMs;
    if (!buckets.has(k)) buckets.set(k, { t:k, o:b.o, h:b.h, l:b.l, c:b.c });
    else {
      const a = buckets.get(k);
      a.h = Math.max(a.h, b.h); a.l = Math.min(a.l, b.l); a.c = b.c;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

// ── EMA ───────────────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  const out = new Array(closes.length).fill(null);
  const k   = 2 / (period + 1);
  let sum = 0, count = 0;
  for (let i = 0; i < closes.length; i++) {
    if (count < period) {
      sum += closes[i]; count++;
      if (count === period) out[i] = sum / period;
    } else {
      out[i] = closes[i] * k + out[i-1] * (1-k);
    }
  }
  return out;
}

// ── Regime maps ───────────────────────────────────────────────────────────────
function buildRegimeMaps(candles, regimeMs) {
  const closes   = candles.map(c => c.c);
  const emaF     = calcEMA(closes, EMA_FAST);
  const emaS     = calcEMA(closes, EMA_SLOW);
  const crossMap = new Map(), stateMap = new Map();
  for (let i = 1; i < candles.length; i++) {
    const ef=emaF[i], es=emaS[i], efP=emaF[i-1], esP=emaS[i-1];
    if (!ef||!es||!efP||!esP) continue;
    const ct = candles[i].t + regimeMs;
    stateMap.set(ct, ef>es ? "golden" : "death");
    if      (efP<=esP && ef>es) crossMap.set(ct, "golden");
    else if (efP>=esP && ef<es) crossMap.set(ct, "death");
  }
  return { crossMap, stateMap };
}

// ── Simulation ────────────────────────────────────────────────────────────────
function runSim(execBars, crossMap, stateMap, regimeMs, buyLadder, sellLadder, lookbackDays) {
  const buySlot  = n => buyLadder [Math.min(n, buyLadder.length  - 1)];
  const sellSlot = n => sellLadder[Math.min(n, sellLadder.length - 1)];

  const startMs = Date.now() - lookbackDays * 86_400_000;
  const bars    = execBars.filter(b => b.t >= startMs);
  if (bars.length < 20) return null;

  const firstBar   = bars[0];
  const initBucket = Math.floor(firstBar.t / regimeMs) * regimeMs;
  let initRegime   = "neutral";
  for (let off = 0; off <= 4; off++) {
    const fwd = initBucket + off * regimeMs;
    const bwd = initBucket - off * regimeMs;
    if (stateMap.has(fwd))       { initRegime = stateMap.get(fwd) ==="death"?"buy":"sell"; break; }
    if (off>0&&stateMap.has(bwd)){ initRegime = stateMap.get(bwd) ==="death"?"buy":"sell"; break; }
  }

  let cash=INITIAL_CAP, cryptoQty=0, regime=initRegime, bosCount=0;
  let regimeStartCapital   = regime==="buy" ? INITIAL_CAP : 0;
  let regimeStartCryptoQty = 0;
  let structure=0, lastSH=null, lastSL=null;
  let peakVal=INITIAL_CAP, maxDD=0;
  let trades=0, buys=0, sells=0, crosses=0;
  const regimeCount = { buy:0, sell:0 };

  for (let i=0; i<bars.length; i++) {
    const bar = bars[i];

    if (bar.t % regimeMs === 0) {
      const cross = crossMap.get(bar.t);
      if (cross==="death" && regime!=="buy") {
        regime="buy"; bosCount=0; regimeStartCapital=cash+cryptoQty*bar.c;
        structure=0; lastSH=null; lastSL=null; crosses++; regimeCount.buy++;
      } else if (cross==="golden" && regime!=="sell") {
        regime="sell"; bosCount=0; regimeStartCryptoQty=cryptoQty;
        structure=0; lastSH=null; lastSL=null; crosses++; regimeCount.sell++;
      }
    }

    if (i < WARMUP) continue;

    const pIdx = i - SWING_LB;
    if (pIdx >= SWING_LB) {
      const pb = bars[pIdx];
      let isPH=true, isPL=true;
      for (let j=1;j<=SWING_LB;j++) {
        const prev=bars[pIdx-j], next=bars[pIdx+j];
        if (!prev||!next){isPH=isPL=false;break;}
        if (prev.h>=pb.h||next.h>=pb.h) isPH=false;
        if (prev.l<=pb.l||next.l<=pb.l) isPL=false;
      }
      if (isPH&&(!lastSH||pb.t>=lastSH.t)) lastSH={price:pb.h,t:pb.t};
      if (isPL&&(!lastSL||pb.t>=lastSL.t)) lastSL={price:pb.l,t:pb.t};
    }

    let bullBOS=false,bearBOS=false,bullCHOCH=false,bearCHOCH=false;
    if (lastSH&&lastSL&&i>0) {
      const pc=bars[i-1].c;
      if (bar.c>lastSH.price&&pc<=lastSH.price){if(structure===-1)bullCHOCH=true;else bullBOS=true;structure=1;}
      if (bar.c<lastSL.price&&pc>=lastSL.price){if(structure===1)bearCHOCH=true;else bearBOS=true;structure=-1;}
    }

    if (regime==="neutral") continue;
    const chochArmed = !REQUIRE_BOS_BEFORE_CHOCH || bosCount>=1;

    if (regime==="buy") {
      if (bearBOS||(CHOCH_CONTINUE_SCALE&&bullCHOCH&&chochArmed)) {
        const buyUSD=Math.min((regimeStartCapital*buySlot(bosCount))/100,cash);
        if (buyUSD>=MIN_ORDER_USD){cryptoQty+=buyUSD/bar.c;cash-=buyUSD;bosCount++;trades++;buys++;}
      }
    }
    if (regime==="sell") {
      if (bullBOS||(CHOCH_CONTINUE_SCALE&&bearCHOCH&&chochArmed)) {
        const sellQty=Math.min((regimeStartCryptoQty*sellSlot(bosCount))/100,cryptoQty);
        if (sellQty>=MIN_ORDER_QTY){cash+=sellQty*bar.c;cryptoQty-=sellQty;bosCount++;trades++;sells++;}
      }
    }

    const tv=cash+cryptoQty*bar.c;
    if (tv>peakVal) peakVal=tv;
    const dd=peakVal>0?(peakVal-tv)/peakVal*100:0;
    if (dd>maxDD) maxDD=dd;
  }

  const lastBar  = bars.at(-1);
  const finalVal = cash + cryptoQty*lastBar.c;
  const pnl      = (finalVal-INITIAL_CAP)/INITIAL_CAP*100;
  const bah      = (lastBar.c-firstBar.c)/firstBar.c*100;
  const alpha    = pnl - bah;

  return { finalVal, pnl, bah, alpha, maxDD, trades, buys, sells, crosses, regimeCount, regime };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const maxDays = Math.max(...PERIODS_TO_RUN);

  console.log(`\n╔══════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  Craig Accumulation Bot — Multi-Period Backtest                              ║`);
  console.log(`║  Periods: ${PERIODS_TO_RUN.join("d / ")}d${" ".repeat(Math.max(0, 62 - PERIODS_TO_RUN.join("d / ").length))}║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════════════╝\n`);

  // ── Fetch data once per symbol (longest window + warmup) ──────────────────
  console.log(`Fetching data (${maxDays}d window + warmup)...\n`);
  const symbolData = [];
  for (const cfg of BASE_CONFIGS) {
    console.log(`  ${cfg.sym}  (${cfg.execLabel} exec / ${cfg.regimeLabel} regime)`);

    const execDays   = maxDays + cfg.extraExecDays;
    const execBars   = await fetchAllBars(cfg.sym, cfg.execGran, execDays, `${cfg.sym} ${cfg.execLabel}`);
    if (!execBars.length) { console.log("  ✗ No exec data\n"); continue; }

    let regimeBars;
    if (cfg.regimeFromExec) {
      regimeBars = aggregateBars(execBars, cfg.regimeMs);
      console.log(`  Aggregated ${execBars.length} → ${regimeBars.length} ${cfg.regimeLabel} bars`);
    } else {
      await sleep(400);
      const regimeDays = maxDays + cfg.extraRegimeDays;
      const rawRegime  = await fetchAllBars(cfg.sym, cfg.regimeGran, regimeDays, `${cfg.sym} ${cfg.regimeLabel} raw`);
      regimeBars = cfg.regimeAggFromSecs
        ? aggregateBars(rawRegime, cfg.regimeMs)
        : rawRegime;
      if (cfg.regimeAggFromSecs) console.log(`  Aggregated ${rawRegime.length} → ${regimeBars.length} ${cfg.regimeLabel} bars`);
    }

    if (regimeBars.length < EMA_SLOW + 10) {
      console.log(`  ✗ Insufficient regime bars (${regimeBars.length})\n`); continue;
    }

    const { crossMap, stateMap } = buildRegimeMaps(regimeBars, cfg.regimeMs);
    symbolData.push({ cfg, execBars, crossMap, stateMap });
    console.log();
    await sleep(600);
  }

  if (!symbolData.length) { console.log("✗ No data — check network."); return; }

  // ── Run simulations for each period ────────────────────────────────────────
  // Results structure: periodResults[periodIdx][symbolIdx] = simResult
  const periodResults = PERIODS_TO_RUN.map(() => []);

  for (const { cfg, execBars, crossMap, stateMap } of symbolData) {
    for (let pi = 0; pi < PERIODS_TO_RUN.length; pi++) {
      const days = PERIODS_TO_RUN[pi];
      const r    = runSim(execBars, crossMap, stateMap, cfg.regimeMs,
                          cfg.buyLadder, cfg.sellLadder, days);
      periodResults[pi].push(r ? { ...r, sym: cfg.sym, cfg } : null);
    }
  }

  // ── Per-symbol comparison table ────────────────────────────────────────────
  const s = (n, d=2) => (n>=0?"+":"")+n.toFixed(d)+"%";
  const W = 80;

  for (let si = 0; si < symbolData.length; si++) {
    const { cfg } = symbolData[si];
    console.log(`\n${"─".repeat(W)}`);
    console.log(`  ${cfg.sym}  (${cfg.execLabel} exec / ${cfg.regimeLabel} regime)`);
    console.log(`  Buy: [${cfg.buyLadder.join(",")}]%   Sell: [${cfg.sellLadder.join(",")}]%`);
    console.log(`${"─".repeat(W)}`);

    const hdr = ["Period".padEnd(7), "P&L".padStart(9), "vs B&H".padStart(9),
                 "B&H".padStart(8), "MaxDD".padStart(8), "Trades".padStart(7),
                 "Crosses".padStart(8), "Regime".padStart(9), "Final$".padStart(9)];
    console.log(`  ${hdr.join(" ")}`);
    console.log(`  ${"-".repeat(W-2)}`);

    for (let pi = 0; pi < PERIODS_TO_RUN.length; pi++) {
      const r = periodResults[pi][si];
      if (!r) { console.log(`  ${(PERIODS_TO_RUN[pi]+"d").padEnd(7)}  (no data)`); continue; }
      const flag = r.pnl>0?"✅":r.pnl>-10?"⚠️ ":"❌";
      const row = [
        (PERIODS_TO_RUN[pi]+"d").padEnd(7),
        s(r.pnl).padStart(9), s(r.alpha).padStart(9), s(r.bah).padStart(8),
        ("-"+r.maxDD.toFixed(1)+"%").padStart(8),
        String(r.trades).padStart(7), String(r.crosses).padStart(8),
        (`${r.regimeCount.buy}B/${r.regimeCount.sell}S`).padStart(9),
        ("$"+r.finalVal.toFixed(2)).padStart(9),
      ];
      console.log(`${flag} ${row.join(" ")}`);
    }
  }

  // ── Portfolio summary per period ───────────────────────────────────────────
  console.log(`\n\n${"═".repeat(W)}`);
  console.log(`  PORTFOLIO SUMMARY  (all 5 symbols combined, $${INITIAL_CAP}/symbol)`);
  console.log(`${"═".repeat(W)}`);

  const phdr = ["Period".padEnd(7), "PortP&L".padStart(9), "PortFinal".padStart(11),
                "PortB&H".padStart(9), "Alpha".padStart(8), "AvgDD".padStart(8),
                "Wins".padStart(6), "Trades".padStart(7)];
  console.log(`  ${phdr.join(" ")}`);
  console.log(`  ${"-".repeat(W-2)}`);

  const portRows = [];

  for (let pi = 0; pi < PERIODS_TO_RUN.length; pi++) {
    const days    = PERIODS_TO_RUN[pi];
    const results = periodResults[pi].filter(Boolean);
    if (!results.length) continue;

    const totalStart = results.length * INITIAL_CAP;
    const totalFinal = results.reduce((s, r) => s + r.finalVal, 0);
    const portPnl    = (totalFinal - totalStart) / totalStart * 100;
    const totalBah   = results.reduce((s, r) => s + (INITIAL_CAP * (1 + r.bah/100)), 0);
    const bahPnl     = (totalBah - totalStart) / totalStart * 100;
    const alpha      = portPnl - bahPnl;
    const avgDD      = results.reduce((s, r) => s + r.maxDD, 0) / results.length;
    const wins       = results.filter(r => r.pnl > 0).length;
    const totalTrades= results.reduce((s, r) => s + r.trades, 0);

    const flag = portPnl>0?"✅":portPnl>-10?"⚠️ ":"❌";
    const row  = [
      (days+"d").padEnd(7),
      s(portPnl).padStart(9),
      ("$"+totalFinal.toFixed(2)).padStart(11),
      s(bahPnl).padStart(9),
      s(alpha).padStart(8),
      ("-"+avgDD.toFixed(1)+"%").padStart(8),
      (`${wins}/${results.length}`).padStart(6),
      String(totalTrades).padStart(7),
    ];
    console.log(`${flag} ${row.join(" ")}`);
    portRows.push({ days, portPnl, totalFinal, bahPnl, alpha, avgDD, wins, totalTrades, symbols: results.length });
  }

  console.log(`${"═".repeat(W)}`);

  // ── Consistency analysis ───────────────────────────────────────────────────
  const profitable = portRows.filter(r => r.portPnl > 0);
  const bestPeriod = portRows.reduce((a, b) => a.portPnl > b.portPnl ? a : b, portRows[0]);
  const worstPeriod= portRows.reduce((a, b) => a.portPnl < b.portPnl ? a : b, portRows[0]);

  console.log(`\n  Profitable across: ${profitable.length}/${portRows.length} periods`);
  console.log(`  Best period:  ${bestPeriod.days}d  → +${bestPeriod.portPnl.toFixed(2)}%  (alpha ${bestPeriod.alpha>=0?"+":""}${bestPeriod.alpha.toFixed(2)}%)`);
  console.log(`  Worst period: ${worstPeriod.days}d → ${worstPeriod.portPnl>=0?"+":""}${worstPeriod.portPnl.toFixed(2)}%  (alpha ${worstPeriod.alpha>=0?"+":""}${worstPeriod.alpha.toFixed(2)}%)`);

  const positiveAlpha = portRows.filter(r => r.alpha > 0);
  console.log(`  Beats B&H in: ${positiveAlpha.length}/${portRows.length} periods`);

  if (portRows.length >= 2) {
    const trend = portRows.at(-1).portPnl > portRows[0].portPnl ? "🔺 improves with longer horizon"
                : portRows.at(-1).portPnl < portRows[0].portPnl ? "🔻 decays with longer horizon"
                : "→ flat across horizons";
    console.log(`  Horizon trend: ${trend}`);
  }

  console.log();
}

main().catch(e => { console.error("\n✗", e.message, e.stack); process.exit(1); });
