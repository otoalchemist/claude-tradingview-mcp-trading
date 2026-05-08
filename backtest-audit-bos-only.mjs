#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// backtest-audit-bos-only.mjs
//
// Tests whether removing CHOCH-triggered trades (bos-only mode) improves
// P&L vs the current strategy (BOS + CHOCH both fire).
//
// Uses CURRENT production config:
//   BTC  : 30m regime / 15m exec  |  buy [33,33,33]     sell [10,15,25,50]
//   ETH  : 30m regime /  5m exec  |  buy [15,15,15,15]  sell [5,10,20,40]
//   SOL  : 30m regime /  5m exec  |  buy [15,15,15,15]  sell [5,10,20,40]
//   LINK : 30m regime /  5m exec  |  buy [60,25,10,5]   sell [33,33,33,33]
//   PEPE :  1h regime /  5m exec  |  buy [60,25,10,5]   sell [5,10,20,40]
//           [TREND-FOLLOWING + BTC gate + CHOCH gate]
//   AKT  : 15m regime /  5m exec  |  buy [60,25,10,5]   sell [50,25,15,10]
//
// Variants compared:
//   current  : BOS fires trade + CHOCH fires trade (aligned CHOCH)
//   bos-only : BOS fires trade only; CHOCH updates gate state but no trade
//
// "Reverse CHOCH" = the CHOCH that fires in the current strategy:
//   contrarian coins: bullCHOCH fires buy, bearCHOCH fires sell
//   PEPE (trend):     bullCHOCH fires buy, bearCHOCH fires sell
//   bos-only removes those CHOCH trades; gate mechanics remain intact for PEPE.
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

const CONFIGS = [
  {
    sym: "BTC-USD",
    execLabel: "15m", regimeLabel: "30m",
    execFetch:   { gran: 900, extraDays: 3 },
    regimeFetch: null,
    regimeMs: THIRTY_MIN_MS, regimeFromExec: true,
    trendFollowing: false,
    btcGate:   false,
    chochGate: false,
    buyLadder:  [33, 33, 33],
    sellLadder: [10, 15, 25, 50],
  },
  {
    sym: "ETH-USD",
    execLabel: "5m", regimeLabel: "30m",
    execFetch:   { gran: 300, extraDays: 6 },
    regimeFetch: null,
    regimeMs: THIRTY_MIN_MS, regimeFromExec: true,
    trendFollowing: false,
    btcGate:   false,
    chochGate: false,
    buyLadder:  [15, 15, 15, 15],
    sellLadder: [ 5, 10, 20, 40],
  },
  {
    sym: "SOL-USD",
    execLabel: "5m", regimeLabel: "30m",
    execFetch:   { gran: 300, extraDays: 6 },
    regimeFetch: null,
    regimeMs: THIRTY_MIN_MS, regimeFromExec: true,
    trendFollowing: false,
    btcGate:   false,
    chochGate: false,
    buyLadder:  [15, 15, 15, 15],
    sellLadder: [ 5, 10, 20, 40],
  },
  {
    sym: "LINK-USD",
    execLabel: "5m", regimeLabel: "30m",
    execFetch:   { gran: 300, extraDays: 6 },
    regimeFetch: null,
    regimeMs: THIRTY_MIN_MS, regimeFromExec: true,
    trendFollowing: false,
    btcGate:   false,
    chochGate: false,
    buyLadder:  [60, 25, 10,  5],
    sellLadder: [33, 33, 33, 33],
  },
  {
    sym: "PEPE-USD",
    execLabel: "5m", regimeLabel: "1h",
    execFetch:   { gran: 300,  extraDays: 3  },
    regimeFetch: { gran: 3600, extraDays: 12 },
    regimeMs: HOUR_MS, regimeFromExec: false,
    trendFollowing: true,
    btcGate:   true,   // suppress buys when BTC EMA50 < EMA200
    chochGate: true,   // gate-closed: BOS blocked until aligned CHOCH opens gate
    buyLadder:  [60, 25, 10,  5],
    sellLadder: [ 5, 10, 20, 40],
  },
  {
    sym: "AKT-USD",
    execLabel: "5m", regimeLabel: "15m",
    execFetch:   { gran: 300, extraDays: 6 },
    regimeFetch: null,
    regimeMs: FIFTEEN_MIN_MS, regimeFromExec: true,
    trendFollowing: false,
    btcGate:   false,
    chochGate: false,
    buyLadder:  [60, 25, 10,  5],
    sellLadder: [50, 25, 15, 10],
  },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Granularity map: seconds → Advanced Trade API string
const ADV_GRAN = { 300:"FIVE_MINUTE", 900:"FIFTEEN_MINUTE", 1800:"THIRTY_MINUTE", 3600:"ONE_HOUR" };

async function fetchAllBars(symbol, granSec, totalDays, label) {
  const cutoff   = Date.now() - totalDays * 86_400_000;
  const windowMs = 300 * granSec * 1000;
  const bars     = [];
  let   endMs    = Date.now();
  process.stdout.write(`  Fetching ${label} (${totalDays}d)`);
  let errors = 0;
  // Detect which API to use (exchange API may be rate-limited / down)
  let useAdvanced = false;
  while (endMs > cutoff) {
    const startMs = Math.max(endMs - windowMs, cutoff);
    try {
      let data;
      if (!useAdvanced) {
        const url = `https://api.exchange.coinbase.com/products/${symbol}/candles` +
          `?granularity=${granSec}&start=${Math.floor(startMs/1000)}&end=${Math.floor(endMs/1000)}`;
        const res = await fetch(url, { headers:{"User-Agent":"craig-backtest/2.0"},
                                       signal: AbortSignal.timeout(15_000) });
        if (res.status === 503 || res.status === 429) {
          useAdvanced = true; // fall back silently
          throw new Error(`HTTP ${res.status} — switching to Advanced Trade API`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = (await res.json()).map(k=>({t:+k[0]*1000,l:+k[1],h:+k[2],o:+k[3],c:+k[4],v:+k[5]}));
      } else {
        const gran = ADV_GRAN[granSec] ?? "ONE_HOUR";
        const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${symbol}/candles` +
          `?granularity=${gran}&start=${Math.floor(startMs/1000)}&end=${Math.floor(endMs/1000)}`;
        const res = await fetch(url, { headers:{"User-Agent":"craig-backtest/2.0"},
                                       signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const arr = json.candles ?? json;
        data = arr.map(k=>({t:+k.start*1000,l:+k.low,h:+k.high,o:+k.open,c:+k.close,v:+k.volume}));
      }
      if (data.length) bars.unshift(...data);
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

// Build a sorted array of BTC state entries for fast lookup
function buildBtcStateArr(btcBars) {
  const closes = btcBars.map(b => b.c);
  const emaF = calcEMA(closes, EMA_FAST);
  const emaS = calcEMA(closes, EMA_SLOW);
  const arr = [];
  for (let i = 0; i < btcBars.length; i++) {
    if (emaF[i] != null && emaS[i] != null) {
      arr.push({ t: btcBars[i].t, golden: emaF[i] > emaS[i] });
    }
  }
  return arr; // already sorted ascending by t
}

// Binary search: find latest BTC state entry at or before `ts`
function btcStateAt(arr, ts) {
  let lo = 0, hi = arr.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= ts) { best = arr[mid]; lo = mid + 1; }
    else                  { hi = mid - 1; }
  }
  return best ? best.golden : true; // default to golden (gate open) if no data
}

// variant: "current" | "bos-only"
function runSim(cfg, execBars, regimeBars, btcStateArr, lookbackDays, variant) {
  const { regimeMs, buyLadder, sellLadder, trendFollowing, btcGate, chochGate } = cfg;
  const buySlot  = n => buyLadder [Math.min(n, buyLadder.length  - 1)];
  const sellSlot = n => sellLadder[Math.min(n, sellLadder.length - 1)];

  const { crossMap, stateMap } = buildRegimeMaps(regimeBars, regimeMs);

  const startMs      = Date.now() - lookbackDays * 86_400_000;
  const backtestBars = execBars.filter(b => b.t >= startMs);
  if (!backtestBars.length) return null;
  const firstBar = backtestBars[0];

  // Init regime
  const initBucket = Math.floor(firstBar.t / regimeMs) * regimeMs;
  let initRegime = "neutral";
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
  let chochTrades          = 0;
  let gatedChoch           = 0;  // CHOCH signals blocked in bos-only mode

  // CHOCH gate state (PEPE only)
  let chochGateOpen = false;

  let peakValue = INITIAL_CAP, maxDrawdown = 0;

  for (let i = 0; i < backtestBars.length; i++) {
    const bar = backtestBars[i];

    // Regime change
    if (bar.t % regimeMs === 0) {
      const cross      = crossMap.get(bar.t);
      const buyOnCross  = trendFollowing ? "golden" : "death";
      const sellOnCross = trendFollowing ? "death"  : "golden";
      if (cross === buyOnCross && regime !== "buy") {
        regime = "buy"; bosCount = 0;
        regimeStartCapital = cash + cryptoQty * bar.c;
        structure = 0; lastSH = null; lastSL = null;
        chochGateOpen = false;
      } else if (cross === sellOnCross && regime !== "sell") {
        regime = "sell"; bosCount = 0;
        regimeStartCryptoQty = cryptoQty;
        regimeStartCapital   = cash + cryptoQty * bar.c;
        structure = 0; lastSH = null; lastSL = null;
        chochGateOpen = false;
      }
    }

    if (i < WARMUP) continue;

    // Swing pivots
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

    // BOS / CHOCH detection
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

    const chochTradeEnabled = variant === "current";

    // BTC gate: passes if BTC EMA50 > EMA200 at bar time (buy only)
    const btcPass = !btcGate || btcStateAt(btcStateArr, bar.t);

    // ── BUY regime ──────────────────────────────────────────────────────────
    if (regime === "buy") {
      // Aligned CHOCH = bullCHOCH for both contrarian and trend-following
      const chochAligned = bullCHOCH;
      const chochReverse = bearCHOCH;

      // Update CHOCH gate state (both variants — gate still tracks CHOCH in bos-only)
      if (chochGate) {
        if (chochAligned) chochGateOpen = true;
        if (chochReverse) chochGateOpen = false;
      }

      const gateOpen   = !chochGate || chochGateOpen;
      const chochArmed = bosCount >= 1;
      const bosBuy     = trendFollowing ? bullBOS : bearBOS;

      // CHOCH trade (current only)
      if (chochTradeEnabled && chochAligned && chochArmed && btcPass) {
        const buyUSD = Math.min((regimeStartCapital * buySlot(bosCount)) / 100, cash);
        if (buyUSD >= MIN_ORDER_USD) {
          cryptoQty += buyUSD / bar.c;
          cash      -= buyUSD;
          bosCount++;
          trades.push({ t: bar.t, type: "buy_choch" });
          chochTrades++;
        }
      } else if (!chochTradeEnabled && chochAligned && chochArmed && btcPass) {
        gatedChoch++;  // count CHOCHs that would have traded
      }

      // BOS trade (gated by chochGate and btcGate)
      if (bosBuy && gateOpen && btcPass) {
        const buyUSD = Math.min((regimeStartCapital * buySlot(bosCount)) / 100, cash);
        if (buyUSD >= MIN_ORDER_USD) {
          cryptoQty += buyUSD / bar.c;
          cash      -= buyUSD;
          bosCount++;
          trades.push({ t: bar.t, type: "buy_bos" });
        }
      }
    }

    // ── SELL regime ─────────────────────────────────────────────────────────
    if (regime === "sell") {
      // Aligned CHOCH = bearCHOCH for both contrarian and trend-following
      const chochAligned = bearCHOCH;
      const chochReverse = bullCHOCH;

      // Update CHOCH gate state
      if (chochGate) {
        if (chochAligned) chochGateOpen = true;
        if (chochReverse) chochGateOpen = false;
      }

      const gateOpen   = !chochGate || chochGateOpen;
      const chochArmed = bosCount >= 1;
      const bosSell    = trendFollowing ? bearBOS : bullBOS;

      // CHOCH trade (current only)
      if (chochTradeEnabled && chochAligned && chochArmed) {
        const sellQty = Math.min((regimeStartCryptoQty * sellSlot(bosCount)) / 100, cryptoQty);
        if (sellQty >= MIN_ORDER_QTY) {
          cash      += sellQty * bar.c;
          cryptoQty -= sellQty;
          bosCount++;
          trades.push({ t: bar.t, type: "sell_choch" });
          chochTrades++;
        }
      } else if (!chochTradeEnabled && chochAligned && chochArmed) {
        gatedChoch++;
      }

      // BOS trade
      if (bosSell && gateOpen) {
        const sellQty = Math.min((regimeStartCryptoQty * sellSlot(bosCount)) / 100, cryptoQty);
        if (sellQty >= MIN_ORDER_QTY) {
          cash      += sellQty * bar.c;
          cryptoQty -= sellQty;
          bosCount++;
          trades.push({ t: bar.t, type: "sell_bos" });
        }
      }
    }

    // Drawdown
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
    trades:      trades.length,
    bosTrades:   trades.filter(t => t.type.endsWith("_bos")).length,
    chochTrades,
    gatedChoch,
  };
}

const s2 = n => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const pad = (s, w) => String(s).padStart(w);

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  BOS-Only vs Current — CURRENT production config                     ║`);
  console.log(`║  BTC=30m/flat-33  LINK=front-60  PEPE=front-60/back-steep+gates      ║`);
  console.log(`║  All 6 symbols  |  ${PERIODS.join("d / ")}d periods                              ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════╝\n`);

  const maxDays   = Math.max(...PERIODS);
  const dataCache = new Map();

  // Fetch BTC 1h data separately for PEPE btcGate
  console.log(`─── Fetching BTC-USD 1h (for PEPE BTC gate) ─────────────────────────`);
  const btcHourBars = await fetchAllBars("BTC-USD", 3600, maxDays + 12, "BTC-USD 1h");
  const btcSArr = buildBtcStateArr(btcHourBars);
  await sleep(600);

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

  // Run sims
  const allResults = {};
  for (const days of PERIODS) {
    allResults[days] = {};
    for (const cfg of CONFIGS) {
      if (!dataCache.has(cfg.sym)) continue;
      const { execBars, regimeBars } = dataCache.get(cfg.sym);
      allResults[days][cfg.sym] = {
        current:    runSim(cfg, execBars, regimeBars, btcSArr, days, "current"),
        "bos-only": runSim(cfg, execBars, regimeBars, btcSArr, days, "bos-only"),
      };
    }
  }

  // Print per-period tables
  for (const days of PERIODS) {
    const W = 108;
    console.log(`\n\n${"═".repeat(W)}`);
    console.log(`  ${days}d  —  BOS-Only vs Current (BOS + CHOCH)`);
    console.log(`${"═".repeat(W)}`);
    console.log(`  ${"Symbol".padEnd(10)} ${"Variant".padEnd(10)} ${"P&L".padStart(8)} ${"B&H".padStart(8)} ${"MaxDD".padStart(8)} ${"Total".padStart(7)} ${"BOS".padStart(5)} ${"CHOCH".padStart(6)} ${"GatedCH".padStart(9)} ${"Final$".padStart(9)}`);
    console.log(`  ${"-".repeat(W - 2)}`);

    let curTotal = 0, bosTotal = 0, count = 0;

    for (const cfg of CONFIGS) {
      const symR = allResults[days][cfg.sym];
      if (!symR) continue;
      const c = symR["current"];
      const b = symR["bos-only"];
      if (!c || !b) continue;
      curTotal += c.pnlPct; bosTotal += b.pnlPct; count++;

      const flag = b.pnlPct > c.pnlPct ? "✅" : "❌";
      const pepeSuffix = cfg.trendFollowing ? " (trend)" : "";
      console.log(
        `     ${(cfg.sym+pepeSuffix).padEnd(16)} ${"current".padEnd(10)} ${pad(s2(c.pnlPct),8)} ${pad(s2(c.bah),8)} ${pad("-"+c.maxDrawdown.toFixed(2)+"%",8)} ${pad(c.trades,7)} ${pad(c.bosTrades,5)} ${pad(c.chochTrades,6)} ${pad("n/a",9)} ${pad("$"+c.finalVal.toFixed(2),9)}`
      );
      console.log(
        `  ${flag}  ${(cfg.sym+pepeSuffix).padEnd(16)} ${"bos-only".padEnd(10)} ${pad(s2(b.pnlPct),8)} ${pad(s2(b.bah),8)} ${pad("-"+b.maxDrawdown.toFixed(2)+"%",8)} ${pad(b.trades,7)} ${pad(b.bosTrades,5)} ${pad(b.chochTrades,6)} ${pad("-"+b.gatedChoch,9)} ${pad("$"+b.finalVal.toFixed(2),9)}`
      );
      console.log("");
    }

    if (count > 0) {
      console.log(`  Portfolio avg  current: ${s2(curTotal/count).padStart(8)}   bos-only: ${s2(bosTotal/count).padStart(8)}   delta: ${s2((bosTotal-curTotal)/count).padStart(8)}`);
    }
  }

  // Delta summary
  console.log(`\n\n${"═".repeat(72)}`);
  console.log(`  DELTA SUMMARY  (bos-only P&L − current P&L)`);
  console.log(`${"═".repeat(72)}`);
  console.log(`  ${"Symbol".padEnd(18)} ${PERIODS.map(d=>(d+"d").padStart(10)).join("")}`);
  console.log(`  ${"-".repeat(70)}`);

  for (const cfg of CONFIGS) {
    const deltas = PERIODS.map(days => {
      const r = allResults[days]?.[cfg.sym];
      if (!r?.current || !r?.["bos-only"]) return "  N/A";
      const d = r["bos-only"].pnlPct - r["current"].pnlPct;
      return (d >= 0 ? "✅" : "❌") + (d >= 0 ? "+" : "") + d.toFixed(2) + "%";
    });
    const mode = cfg.trendFollowing ? " (trend)" : "";
    console.log(`  ${(cfg.sym + mode).padEnd(18)} ${deltas.map(d=>d.padStart(10)).join("")}`);
  }

  // Portfolio totals
  console.log(`\n\n${"═".repeat(72)}`);
  console.log(`  PORTFOLIO TOTALS  (6 symbols avg P&L)`);
  console.log(`${"═".repeat(72)}`);
  console.log(`  ${"Variant".padEnd(12)} ${PERIODS.map(d=>(d+"d").padStart(10)).join("")}`);
  console.log(`  ${"-".repeat(70)}`);

  for (const variant of ["current", "bos-only"]) {
    const avgs = PERIODS.map(days => {
      let sum = 0, count = 0;
      for (const cfg of CONFIGS) {
        const r = allResults[days]?.[cfg.sym]?.[variant];
        if (r) { sum += r.pnlPct; count++; }
      }
      return count ? s2(sum/count) : "N/A";
    });
    console.log(`  ${variant.padEnd(12)} ${avgs.map(a=>a.padStart(10)).join("")}`);
  }
  const deltaAvgs = PERIODS.map(days => {
    let sum = 0, count = 0;
    for (const cfg of CONFIGS) {
      const c = allResults[days]?.[cfg.sym]?.["current"];
      const b = allResults[days]?.[cfg.sym]?.["bos-only"];
      if (c && b) { sum += b.pnlPct - c.pnlPct; count++; }
    }
    return count ? s2(sum/count) : "N/A";
  });
  console.log(`  ${"delta".padEnd(12)} ${deltaAvgs.map(a=>a.padStart(10)).join("")}`);
  console.log(`\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
