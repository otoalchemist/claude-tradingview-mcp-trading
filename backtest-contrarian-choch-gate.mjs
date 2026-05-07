#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// backtest-contrarian-choch-gate.mjs
//
// Tests gate-closed CHOCH filter for contrarian symbols only (BTC/ETH/SOL/LINK/AKT).
// PEPE is excluded — it's trend-following and its gate is already being implemented.
//
// Gate-closed: starts CLOSED at regime start.
//   Contrarian BUY:  bearCHOCH opens gate, bullCHOCH closes gate
//   Contrarian SELL: bullCHOCH opens gate, bearCHOCH closes gate
//
// Usage:  node backtest-contrarian-choch-gate.mjs [days1 days2 ...]
// ═══════════════════════════════════════════════════════════════════════════

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

const HOUR_MS        = 3_600_000;
const THIRTY_MIN_MS  = 1_800_000;
const FIFTEEN_MIN_MS =   900_000;

// ── Contrarian symbols only ───────────────────────────────────────────────────
const CONFIGS = [
  {
    sym: "BTC-USD",
    execLabel: "15m", regimeLabel: "1h",
    execFetch:   { gran: 900,  extraDays: 3  },
    regimeFetch: { gran: 3600, extraDays: 12 },
    regimeMs: HOUR_MS,
    regimeFromExec: false,
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
    buyLadder:  [15, 15, 15, 15],
    sellLadder: [33, 33, 33, 33],
  },
  {
    sym: "AKT-USD",
    execLabel: "5m", regimeLabel: "15m",
    execFetch:   { gran: 300, extraDays: 6 },
    regimeFetch: null,
    regimeMs: FIFTEEN_MIN_MS,
    regimeFromExec: true,
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
// variant: "baseline" | "gate-closed"
// All symbols here are contrarian (death=BUY, golden=SELL)
function runSim(cfg, execBars, regimeBars, lookbackDays, variant) {
  const { regimeMs, buyLadder, sellLadder } = cfg;
  const buySlot  = n => buyLadder [Math.min(n, buyLadder.length  - 1)];
  const sellSlot = n => sellLadder[Math.min(n, sellLadder.length - 1)];

  const { crossMap, stateMap } = buildRegimeMaps(regimeBars, regimeMs);

  const startMs      = Date.now() - lookbackDays * 86_400_000;
  const backtestBars = execBars.filter(b => b.t >= startMs);
  if (!backtestBars.length) return null;

  // Init regime from stateMap at backtest start (contrarian: death=buy, golden=sell)
  const firstBar   = backtestBars[0];
  const initBucket = Math.floor(firstBar.t / regimeMs) * regimeMs;
  let initRegime   = "neutral";
  for (let offset = 0; offset <= 3; offset++) {
    const t = initBucket + offset * regimeMs;
    if (stateMap.has(t)) {
      const s = stateMap.get(t);
      initRegime = s === "death" ? "buy" : "sell";
      break;
    }
    if (offset > 0 && stateMap.has(initBucket - offset * regimeMs)) {
      const s = stateMap.get(initBucket - offset * regimeMs);
      initRegime = s === "death" ? "buy" : "sell";
      break;
    }
  }

  let cash                 = INITIAL_CAP;
  let cryptoQty            = 0;
  let regime               = initRegime;
  let bosCount             = 0;
  let regimeStartCapital   = regime === "buy" ? INITIAL_CAP : 0;
  let regimeStartCryptoQty = 0;
  let structure            = 0;
  let lastSH               = null;
  let lastSL               = null;
  const trades             = [];

  // gate-closed: starts false; aligned CHOCH opens it; reverse CHOCH closes it
  // baseline: always gated open
  let chochGated   = variant === "gate-closed" ? false : true;
  let gatedOutBuys = 0, gatedOutSells = 0;

  let peakValue = INITIAL_CAP, maxDrawdown = 0;
  let gateEvents = [];

  for (let i = 0; i < backtestBars.length; i++) {
    const bar = backtestBars[i];

    // ── Regime change ──────────────────────────────────────────────────────────
    if (bar.t % regimeMs === 0) {
      const cross = crossMap.get(bar.t);
      if (cross === "death" && regime !== "buy") {
        regime               = "buy";
        bosCount             = 0;
        regimeStartCapital   = cash + cryptoQty * bar.c;
        structure = 0; lastSH = null; lastSL = null;
        chochGated = variant === "gate-closed" ? false : true;
      } else if (cross === "golden" && regime !== "sell") {
        regime                = "sell";
        bosCount              = 0;
        regimeStartCryptoQty  = cryptoQty;
        regimeStartCapital    = cash + cryptoQty * bar.c;
        structure = 0; lastSH = null; lastSL = null;
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

    // ── CHOCH gate toggling (contrarian only) ──────────────────────────────────
    // Contrarian BUY  → trade on bearBOS → aligned=bearCHOCH opens gate, bullCHOCH closes gate
    // Contrarian SELL → trade on bullBOS → aligned=bullCHOCH opens gate, bearCHOCH closes gate
    if (variant === "gate-closed") {
      const prevGated = chochGated;
      if (regime === "buy") {
        if (bearCHOCH && !chochGated) { chochGated = true;  gateEvents.push({ t: bar.t, regime, event: "OPEN (bearCHOCH)",  price: bar.c }); }
        if (bullCHOCH &&  chochGated) { chochGated = false; gateEvents.push({ t: bar.t, regime, event: "CLOSE (bullCHOCH)", price: bar.c }); }
      } else {
        if (bullCHOCH && !chochGated) { chochGated = true;  gateEvents.push({ t: bar.t, regime, event: "OPEN (bullCHOCH)",  price: bar.c }); }
        if (bearCHOCH &&  chochGated) { chochGated = false; gateEvents.push({ t: bar.t, regime, event: "CLOSE (bearCHOCH)", price: bar.c }); }
      }
    }

    // ── BUY regime ─────────────────────────────────────────────────────────────
    if (regime === "buy") {
      if (bearBOS) {
        const buyUSD = Math.min((regimeStartCapital * buySlot(bosCount)) / 100, cash);
        if (buyUSD >= MIN_ORDER_USD) {
          if (chochGated) {
            cryptoQty += buyUSD / bar.c;
            cash      -= buyUSD;
            bosCount++;
            trades.push({ t: bar.t, type: "buy_bos", price: bar.c, usd: buyUSD });
          } else {
            gatedOutBuys++;
          }
        }
      }
      // bearCHOCH in buy regime: gate was already opened above, now execute buy
      if (bearCHOCH && chochGated) {
        const buyUSD = Math.min((regimeStartCapital * buySlot(bosCount)) / 100, cash);
        if (buyUSD >= MIN_ORDER_USD) {
          cryptoQty += buyUSD / bar.c;
          cash      -= buyUSD;
          bosCount++;
          trades.push({ t: bar.t, type: "buy_choch", price: bar.c, usd: buyUSD });
        }
      }
    }

    // ── SELL regime ────────────────────────────────────────────────────────────
    if (regime === "sell") {
      if (bullBOS) {
        const sellQty = Math.min((regimeStartCryptoQty * sellSlot(bosCount)) / 100, cryptoQty);
        if (sellQty >= MIN_ORDER_QTY) {
          if (chochGated) {
            cash      += sellQty * bar.c;
            cryptoQty -= sellQty;
            bosCount++;
            trades.push({ t: bar.t, type: "sell_bos", price: bar.c, qty: sellQty, usd: sellQty * bar.c });
          } else {
            gatedOutSells++;
          }
        }
      }
      // bullCHOCH in sell regime: gate was already opened above, now execute sell
      if (bullCHOCH && chochGated) {
        const sellQty = Math.min((regimeStartCryptoQty * sellSlot(bosCount)) / 100, cryptoQty);
        if (sellQty >= MIN_ORDER_QTY) {
          cash      += sellQty * bar.c;
          cryptoQty -= sellQty;
          bosCount++;
          trades.push({ t: bar.t, type: "sell_choch", price: bar.c, qty: sellQty, usd: sellQty * bar.c });
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

  return {
    finalVal, pnlPct, bah, maxDrawdown,
    trades: trades.length,
    gatedOutBuys, gatedOutSells,
    gateEvents,
  };
}

const s2 = n => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const pad = (s, w) => String(s).padStart(w);

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  Contrarian CHOCH Gate — Baseline vs Gate-Closed                ║`);
  console.log(`║  Symbols: BTC / ETH / SOL / LINK / AKT  (no PEPE)              ║`);
  console.log(`║  Periods: ${PERIODS.join("d / ")}d                                          ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝\n`);

  const maxDays   = Math.max(...PERIODS);
  const dataCache = new Map();

  for (const cfg of CONFIGS) {
    console.log(`\n─── Fetching ${cfg.sym} ──────────────────────────────────────────────`);
    const execDays = maxDays + cfg.execFetch.extraDays;
    const execBars = await fetchAllBars(cfg.sym, cfg.execFetch.gran, execDays, `${cfg.sym} ${cfg.execLabel}`);
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

  // ── Run and collect ───────────────────────────────────────────────────────────
  const allResults = {};
  for (const days of PERIODS) {
    allResults[days] = {};
    for (const cfg of CONFIGS) {
      if (!dataCache.has(cfg.sym)) continue;
      const { execBars, regimeBars } = dataCache.get(cfg.sym);
      allResults[days][cfg.sym] = {
        baseline:     runSim(cfg, execBars, regimeBars, days, "baseline"),
        "gate-closed": runSim(cfg, execBars, regimeBars, days, "gate-closed"),
      };
    }
  }

  // ── Print per-period tables ───────────────────────────────────────────────────
  for (const days of PERIODS) {
    const W = 104;
    console.log(`\n\n${"═".repeat(W)}`);
    console.log(`  ${days}d  —  Contrarian CHOCH Gate-Closed vs Baseline`);
    console.log(`${"═".repeat(W)}`);
    console.log(`  ${"Symbol".padEnd(10)} ${"Variant".padEnd(12)} ${"P&L".padStart(8)} ${"B&H".padStart(8)} ${"MaxDD".padStart(8)} ${"Trades".padStart(7)} ${"Gated".padStart(7)} ${"Final$".padStart(9)}`);
    console.log(`  ${"-".repeat(W - 2)}`);

    let baseTotal = 0, gateTotal = 0, baseCount = 0;
    for (const cfg of CONFIGS) {
      const symR = allResults[days][cfg.sym];
      if (!symR) continue;
      const b = symR["baseline"];
      const g = symR["gate-closed"];
      if (!b || !g) continue;
      baseTotal += b.pnlPct; gateTotal += g.pnlPct; baseCount++;

      const flag = g.pnlPct > b.pnlPct ? "✅" : "❌";
      const gatedTotal = g.gatedOutBuys + g.gatedOutSells;
      const rows = [
        ["baseline",    s2(b.pnlPct), s2(b.bah), "-"+b.maxDrawdown.toFixed(2)+"%", b.trades, "-",         `$${b.finalVal.toFixed(2)}`],
        ["gate-closed", s2(g.pnlPct), s2(g.bah), "-"+g.maxDrawdown.toFixed(2)+"%", g.trades, `-${gatedTotal}`, `$${g.finalVal.toFixed(2)}`],
      ];
      for (let ri = 0; ri < rows.length; ri++) {
        const [v, pnl, bah, dd, tr, gt, fin] = rows[ri];
        const marker = ri === 1 ? `${flag} ` : "   ";
        console.log(`  ${marker}${cfg.sym.padEnd(10)} ${v.padEnd(12)} ${pad(pnl,8)} ${pad(bah,8)} ${pad(dd,8)} ${pad(tr,7)} ${pad(gt,7)} ${pad(fin,9)}`);
      }
      console.log("");
    }
    if (baseCount > 0) {
      console.log(`  ${"Portfolio average".padEnd(23)} baseline: ${s2(baseTotal/baseCount).padStart(8)}   gate-closed: ${s2(gateTotal/baseCount).padStart(8)}   delta: ${s2((gateTotal-baseTotal)/baseCount).padStart(8)}`);
    }
  }

  // ── Per-symbol delta summary ──────────────────────────────────────────────────
  console.log(`\n\n${"═".repeat(70)}`);
  console.log(`  DELTA SUMMARY  (gate-closed P&L − baseline P&L)`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  ${"Symbol".padEnd(10)} ${PERIODS.map(d=>(d+"d").padStart(10)).join("")}`);
  console.log(`  ${"-".repeat(68)}`);

  for (const cfg of CONFIGS) {
    const deltas = PERIODS.map(days => {
      const symR = allResults[days]?.[cfg.sym];
      if (!symR?.baseline || !symR?.["gate-closed"]) return "  N/A";
      const d = symR["gate-closed"].pnlPct - symR["baseline"].pnlPct;
      return (d >= 0 ? "✅" : "❌") + (d >= 0 ? "+" : "") + d.toFixed(2) + "%";
    });
    console.log(`  ${cfg.sym.padEnd(10)} ${deltas.map(d=>d.padStart(10)).join("")}`);
  }

  // ── Portfolio totals ──────────────────────────────────────────────────────────
  console.log(`\n\n${"═".repeat(70)}`);
  console.log(`  PORTFOLIO TOTALS  (5 symbols, avg P&L)`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  ${"Variant".padEnd(14)} ${PERIODS.map(d=>(d+"d").padStart(10)).join("")}`);
  console.log(`  ${"-".repeat(68)}`);

  for (const variant of ["baseline", "gate-closed"]) {
    const avgs = PERIODS.map(days => {
      let sum = 0, count = 0;
      for (const cfg of CONFIGS) {
        const r = allResults[days]?.[cfg.sym]?.[variant];
        if (r) { sum += r.pnlPct; count++; }
      }
      return count ? s2(sum / count) : "N/A";
    });
    console.log(`  ${variant.padEnd(14)} ${avgs.map(a=>a.padStart(10)).join("")}`);
  }
  const deltaAvgs = PERIODS.map(days => {
    let sum = 0, count = 0;
    for (const cfg of CONFIGS) {
      const b = allResults[days]?.[cfg.sym]?.["baseline"];
      const g = allResults[days]?.[cfg.sym]?.["gate-closed"];
      if (b && g) { sum += g.pnlPct - b.pnlPct; count++; }
    }
    return count ? s2(sum / count) : "N/A";
  });
  console.log(`  ${"delta".padEnd(14)} ${deltaAvgs.map(a=>a.padStart(10)).join("")}`);

  console.log(`\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
