#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// backtest-audit-pepe-ladders.mjs
//
// Tests PEPE buy and sell ladder shape WITH both gates active
// (btcGate=true, chochGate=true — current live setting).
//
// Without gates, flat-15 buy and back-steep sell outperformed the current
// front-60 buy + flat-33 sell.  This test checks whether that holds once
// the BTC gate and CHOCH gate filter the signal stream.
//
// PART 1 — BUY ladder variants  (sell=[33,33,33] held constant)
//   back-heavy  : [10,15,20,25,30]
//   flat-15     : [15,15,15,15]
//   flat-25     : [25,25,25,25]
//   flat-33     : [33,33,33]
//   front-40    : [40,30,20,10]
//   front-50    : [50,25,15,10]
//   front-60 ←  : [60,25,10,5]     current
//
// PART 2 — SELL ladder variants  (buy=[60,25,10,5] held constant)
//   back-steep  : [5,10,20,40]
//   back-mid    : [10,15,25,50]
//   flat-25     : [25,25,25,25]
//   flat-33 ←   : [33,33,33]       current
//   front-40    : [40,30,20,10]
//   front-50    : [50,25,15,10]
//
// Both gates active throughout: BTC gate (EMA50>EMA200) + CHOCH gate.
// Periods: 30/60/90/180d.
// ═══════════════════════════════════════════════════════════════════════════

const EMA_FAST    = 50;
const EMA_SLOW    = 200;
const INITIAL_CAP = 100;
const MIN_ORDER_USD = 1.00;
const MIN_ORDER_QTY = 1e-8;
const SWING_LB    = 5;
const REQUIRE_BOS_BEFORE_CHOCH = true;

const PERIODS  = [30, 60, 90, 180];
const HOUR_MS  = 3_600_000;

const BUY_VARIANTS = [
  { label: "back-heavy  ", ladder: [10,15,20,25,30] },
  { label: "flat-15     ", ladder: [15,15,15,15]    },
  { label: "flat-25     ", ladder: [25,25,25,25]    },
  { label: "flat-33     ", ladder: [33,33,33]       },
  { label: "front-40    ", ladder: [40,30,20,10]    },
  { label: "front-50    ", ladder: [50,25,15,10]    },
  { label: "front-60 ←  ", ladder: [60,25,10,5]    },
];

const SELL_VARIANTS = [
  { label: "back-steep  ", ladder: [5,10,20,40]    },
  { label: "back-mid    ", ladder: [10,15,25,50]   },
  { label: "flat-25     ", ladder: [25,25,25,25]   },
  { label: "flat-33  ←  ", ladder: [33,33,33]      },
  { label: "front-40    ", ladder: [40,30,20,10]   },
  { label: "front-50    ", ladder: [50,25,15,10]   },
];

const CURRENT_BUY  = [60,25,10,5];
const CURRENT_SELL = [33,33,33];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchAllBars(symbol, granSec, totalDays, label) {
  const cutoff   = Date.now() - totalDays * 86_400_000;
  const windowMs = 300 * granSec * 1000;
  const bars = []; let endMs = Date.now();
  process.stdout.write(`  Fetching ${label} (${totalDays}d)`);
  let errors = 0;
  while (endMs > cutoff) {
    const startMs = Math.max(endMs - windowMs, cutoff);
    const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${granSec}&start=${Math.floor(startMs/1000)}&end=${Math.floor(endMs/1000)}`;
    try {
      const res = await fetch(url, { headers:{"User-Agent":"craig-backtest/2.0"}, signal:AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("Bad response");
      if (data.length) bars.unshift(...data.map(k=>({t:+k[0]*1000,l:+k[1],h:+k[2],o:+k[3],c:+k[4]})));
      endMs = startMs - granSec * 1000;
      process.stdout.write(".");  errors = 0;
    } catch(e) {
      process.stdout.write("!");
      if (++errors >= 5) { console.error(`\n  ✗ ${e.message}`); break; }
      await sleep(2000); continue;
    }
    await sleep(130);
  }
  const seen = new Set();
  const result = bars.filter(b=>{ if(seen.has(b.t)) return false; seen.add(b.t); return true; }).sort((a,b)=>a.t-b.t);
  console.log(` → ${result.length} bars`);
  return result;
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

function runSim(execBars, regimeBars, btcStateMap, lookbackDays, buyLadder, sellLadder) {
  const buySlot  = n => buyLadder [Math.min(n, buyLadder.length  - 1)];
  const sellSlot = n => sellLadder[Math.min(n, sellLadder.length - 1)];
  const warmup   = SWING_LB * 2 + 2;
  const { crossMap, stateMap } = buildRegimeMaps(regimeBars, HOUR_MS);

  const startMs = Date.now() - lookbackDays * 86_400_000;
  const bars    = execBars.filter(b => b.t >= startMs);
  if (!bars.length) return null;

  const initBucket = Math.floor(bars[0].t / HOUR_MS) * HOUR_MS;
  let regime = "neutral";
  for (let off = 0; off <= 3; off++) {
    const t = initBucket + off * HOUR_MS;
    if (stateMap.has(t)) { const s=stateMap.get(t); regime = s==="golden"?"buy":"sell"; break; }
    if (off>0 && stateMap.has(initBucket-off*HOUR_MS)) { const s=stateMap.get(initBucket-off*HOUR_MS); regime = s==="golden"?"buy":"sell"; break; }
  }

  let cash=INITIAL_CAP, cryptoQty=0, bosCount=0;
  let regimeStartCapital=regime==="buy"?INITIAL_CAP:0, regimeStartCryptoQty=0;
  let structure=0, lastSH=null, lastSL=null;
  let peakValue=INITIAL_CAP, maxDrawdown=0;
  let chochGate=false, btcGateOpen=true;

  for (let i=0; i<bars.length; i++) {
    const bar = bars[i];

    // BTC gate: golden = EMA50>EMA200 = crypto bull = PEPE gate open
    if (btcStateMap) {
      const btcBucket = Math.floor(bar.t / HOUR_MS) * HOUR_MS;
      let btcState = null;
      for (let off=0; off<=3; off++) {
        if (btcStateMap.has(btcBucket+off*HOUR_MS)) { btcState=btcStateMap.get(btcBucket+off*HOUR_MS); break; }
        if (off>0 && btcStateMap.has(btcBucket-off*HOUR_MS)) { btcState=btcStateMap.get(btcBucket-off*HOUR_MS); break; }
      }
      btcGateOpen = btcState === "golden";
    }

    if (bar.t % HOUR_MS === 0) {
      const cross = crossMap.get(bar.t);
      if (cross==="golden" && regime!=="buy")  { regime="buy";  bosCount=0; regimeStartCapital=cash+cryptoQty*bar.c; structure=0; lastSH=null; lastSL=null; chochGate=false; }
      if (cross==="death"  && regime!=="sell") { regime="sell"; bosCount=0; regimeStartCryptoQty=cryptoQty; regimeStartCapital=cash+cryptoQty*bar.c; structure=0; lastSH=null; lastSL=null; chochGate=false; }
    }
    if (i < warmup) continue;

    const pIdx = i - SWING_LB;
    if (pIdx >= SWING_LB) {
      const pb = bars[pIdx]; let isPH=true, isPL=true;
      for (let j=1;j<=SWING_LB;j++) {
        const prev=bars[pIdx-j],next=bars[pIdx+j];
        if (!prev||!next){isPH=isPL=false;break;}
        if (prev.h>=pb.h||next.h>=pb.h) isPH=false;
        if (prev.l<=pb.l||next.l<=pb.l) isPL=false;
      }
      if (isPH&&(!lastSH||pb.t>=lastSH.t)) lastSH={price:pb.h,t:pb.t};
      if (isPL&&(!lastSL||pb.t>=lastSL.t)) lastSL={price:pb.l,t:pb.t};
    }

    let bullBOS=false,bearBOS=false,bullCHOCH=false,bearCHOCH=false;
    if (lastSH && lastSL && i>0) {
      const pc=bars[i-1].c;
      if (bar.c>lastSH.price&&pc<=lastSH.price) { if(structure===-1)bullCHOCH=true;else bullBOS=true; structure=1; }
      if (bar.c<lastSL.price&&pc>=lastSL.price) { if(structure===1) bearCHOCH=true;else bearBOS=true; structure=-1; }
    }
    if (regime==="neutral") continue;

    // CHOCH gate (trend-following PEPE: bullCHOCH opens, bearCHOCH closes)
    if (regime==="buy")  { if (bullCHOCH) chochGate=true;  if (bearCHOCH) chochGate=false; }
    if (regime==="sell") { if (bearCHOCH) chochGate=true;  if (bullCHOCH) chochGate=false; }

    const bosGateOpen = chochGate;
    const chochArmed  = !REQUIRE_BOS_BEFORE_CHOCH || bosCount >= 1;

    if (regime==="buy") {
      // Trend-following: bullBOS fires when gate open + BTC gate open
      if (bullBOS && btcGateOpen && bosGateOpen) {
        const usd = Math.min((regimeStartCapital*buySlot(bosCount))/100, cash);
        if (usd>=MIN_ORDER_USD) { cryptoQty+=usd/bar.c; cash-=usd; bosCount++; }
      }
      // bullCHOCH: BTC gate applies, CHOCH gate not (CHOCH is the gate opener)
      if (bullCHOCH && btcGateOpen && chochArmed) {
        const usd = Math.min((regimeStartCapital*buySlot(bosCount))/100, cash);
        if (usd>=MIN_ORDER_USD) { cryptoQty+=usd/bar.c; cash-=usd; bosCount++; }
      }
    }
    if (regime==="sell") {
      if (bearBOS && bosGateOpen) {
        const qty = Math.min((regimeStartCryptoQty*sellSlot(bosCount))/100, cryptoQty);
        if (qty>=MIN_ORDER_QTY) { cash+=qty*bar.c; cryptoQty-=qty; bosCount++; }
      }
      if (bearCHOCH && chochArmed) {
        const qty = Math.min((regimeStartCryptoQty*sellSlot(bosCount))/100, cryptoQty);
        if (qty>=MIN_ORDER_QTY) { cash+=qty*bar.c; cryptoQty-=qty; bosCount++; }
      }
    }

    const tv = cash+cryptoQty*bar.c;
    if (tv>peakValue) peakValue=tv;
    const dd = peakValue>0?(peakValue-tv)/peakValue*100:0;
    if (dd>maxDrawdown) maxDrawdown=dd;
  }

  const lastBar  = bars.at(-1);
  const finalVal = cash+cryptoQty*lastBar.c;
  return { pnlPct:(finalVal-INITIAL_CAP)/INITIAL_CAP*100, maxDrawdown, finalVal };
}

const s2  = n => (n>=0?"+":"")+n.toFixed(2)+"%";
const pad = (s,n) => String(s).padStart(n);

function printTable(variants, execBars, regimeBars, btcStateMap, holdLadder, holdSide) {
  const rows = [];
  for (const v of variants) {
    const buyL  = holdSide==="sell" ? holdLadder  : v.ladder;
    const sellL = holdSide==="sell" ? v.ladder    : holdLadder;
    const vals  = PERIODS.map(days => {
      const r = runSim(execBars, regimeBars, btcStateMap, days, buyL, sellL);
      return r ? r.pnlPct : null;
    });
    rows.push({ label: v.label, ladder: v.ladder, vals });
  }

  // Find best per period
  const best = PERIODS.map((_, pi) => {
    let max = -Infinity;
    for (const r of rows) { if (r.vals[pi]!==null && r.vals[pi]>max) max=r.vals[pi]; }
    return max;
  });

  console.log(`  ${"Ladder".padEnd(14)}  ${PERIODS.map(d=>pad(d+"d P&L",11)).join("  ")}   MaxDD(180d)  delta vs curr`);
  console.log(`  ${"-".repeat(80)}`);

  const currentKey = JSON.stringify(holdSide==="sell" ? CURRENT_BUY : CURRENT_SELL);
  let currentVals = null;
  for (const row of rows) {
    if (JSON.stringify(row.ladder) === currentKey) currentVals = row.vals;
  }

  for (const row of rows) {
    const isCurrent = JSON.stringify(row.ladder) === currentKey;
    const buyL  = holdSide==="sell" ? holdLadder : row.ladder;
    const sellL = holdSide==="sell" ? row.ladder : holdLadder;
    const r180  = runSim(execBars, regimeBars, btcStateMap, 180, buyL, sellL);
    const ddStr = r180 ? `-${r180.maxDrawdown.toFixed(2)}%` : "N/A";

    const cols = row.vals.map((v, pi) => {
      if (v===null) return pad("N/A",11);
      const isBest = Math.abs(v - best[pi]) < 0.005;
      return pad((isBest?"🏆":"")+s2(v), isBest?13:11);
    });

    const avgDelta = currentVals
      ? row.vals.reduce((s,v,i) => currentVals[i]!==null && v!==null ? s+(v-currentVals[i]) : s, 0) / PERIODS.length
      : 0;
    const deltaStr = isCurrent ? "  (baseline)" : ` ${avgDelta>=0?"+":""}${avgDelta.toFixed(2)}% avg`;

    console.log(`  ${row.label}${isCurrent?"←":" "}  ${cols.join("  ")}   ${pad(ddStr,10)}  ${deltaStr}`);
  }
}

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  PEPE Ladder Audit WITH Both Gates (BTC gate + CHOCH gate)        ║`);
  console.log(`║  Part 1: buy variants (sell=[33,33,33] fixed)                     ║`);
  console.log(`║  Part 2: sell variants (buy=[60,25,10,5] fixed)                   ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝`);

  const maxDays = Math.max(...PERIODS);

  console.log(`\n─── Fetching data ────────────────────────────────────────────────────`);
  const pepeExec   = await fetchAllBars("PEPE-USD", 300,  maxDays +  3, "PEPE-USD 5m");
  await sleep(400);
  const pepeRegime = await fetchAllBars("PEPE-USD", 3600, maxDays + 12, "PEPE-USD 1h");
  await sleep(400);
  const btcRegime  = await fetchAllBars("BTC-USD",  3600, maxDays + 12, "BTC-USD 1h");

  if (!pepeExec.length || !pepeRegime.length || !btcRegime.length) {
    console.error("Data fetch failed"); process.exit(1);
  }

  const { stateMap: btcStateMap } = buildRegimeMaps(btcRegime, HOUR_MS);

  const bh = {};
  for (const days of PERIODS) {
    const bars = pepeExec.filter(b => b.t >= Date.now() - days*86_400_000);
    bh[days] = bars.length>=2 ? (bars.at(-1).c-bars[0].c)/bars[0].c*100 : 0;
  }
  const bhStr = PERIODS.map(d=>pad(s2(bh[d]),11)).join("  ");

  // ── PART 1: BUY ladder ────────────────────────────────────────────────────
  console.log(`\n\n${"═".repeat(96)}`);
  console.log(`  PART 1 — PEPE BUY LADDER  (sell=[33,33,33] fixed, both gates ON)`);
  console.log(`${"═".repeat(96)}\n`);
  printTable(BUY_VARIANTS, pepeExec, pepeRegime, btcStateMap, CURRENT_SELL, "buy");
  console.log(`  ${"B&H (ref)".padEnd(16)}  ${bhStr}`);

  // ── PART 2: SELL ladder ───────────────────────────────────────────────────
  console.log(`\n\n${"═".repeat(96)}`);
  console.log(`  PART 2 — PEPE SELL LADDER  (buy=[60,25,10,5] fixed, both gates ON)`);
  console.log(`${"═".repeat(96)}\n`);
  printTable(SELL_VARIANTS, pepeExec, pepeRegime, btcStateMap, CURRENT_BUY, "sell");
  console.log(`  ${"B&H (ref)".padEnd(16)}  ${bhStr}`);

  console.log(`\n`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
