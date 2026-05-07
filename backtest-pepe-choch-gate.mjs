#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// backtest-pepe-choch-gate.mjs — PEPE CHOCH Gate (isolated)
//
// Compares current PEPE trend-following strategy vs same strategy with
// gate-closed CHOCH filter across 30 / 60 / 90 / 180d periods.
//
// Gate logic for PEPE (trend-following, golden=BUY):
//   BUY  regime: gate CLOSED at start. bullCHOCH opens gate (local uptrend
//                confirmed → buy bullBOS). bearCHOCH closes gate (local dip
//                → pause, wait for next bullCHOCH before resuming buys).
//   SELL regime: gate CLOSED at start. bearCHOCH opens gate (local downtrend
//                confirmed → sell bearBOS). bullCHOCH closes gate.
//
// Usage: node backtest-pepe-choch-gate.mjs [days...]
// ═══════════════════════════════════════════════════════════════════════════

const EMA_FAST  = 50;
const EMA_SLOW  = 200;
const SWING_LB  = 5;
const WARMUP    = SWING_LB * 2 + 2;
const INIT_CAP  = 100;
const MIN_USD   = 1.00;
const MIN_QTY   = 1e-8;
const HOUR_MS   = 3_600_000;

const PERIODS = process.argv.slice(2).map(Number).filter(n=>n>0).length
  ? process.argv.slice(2).map(Number).filter(n=>n>0)
  : [30, 60, 90, 180];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchBars(symbol, granSec, totalDays, label) {
  const cutoff = Date.now() - totalDays * 86_400_000;
  const winMs  = 300 * granSec * 1000;
  const bars   = [];
  let   endMs  = Date.now();
  process.stdout.write(`  Fetching ${label} (${totalDays}d)`);
  let errors = 0;
  while (endMs > cutoff) {
    const startMs = Math.max(endMs - winMs, cutoff);
    const url = `https://api.exchange.coinbase.com/products/${symbol}/candles` +
      `?granularity=${granSec}&start=${Math.floor(startMs/1000)}&end=${Math.floor(endMs/1000)}`;
    try {
      const res  = await fetch(url, { headers: {"User-Agent":"craig-backtest"}, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("Bad response");
      if (data.length) bars.unshift(...data.map(k=>({t:+k[0]*1000,l:+k[1],h:+k[2],o:+k[3],c:+k[4]})));
      endMs = startMs - granSec*1000; process.stdout.write("."); errors=0;
    } catch(e) {
      process.stdout.write("!"); if(++errors>=5){console.error(`\n  ✗ ${e.message}`);break;}
      await sleep(2000); continue;
    }
    await sleep(130);
  }
  const seen=new Set();
  const out = bars.filter(b=>{if(seen.has(b.t))return false;seen.add(b.t);return true;}).sort((a,b)=>a.t-b.t);
  console.log(` → ${out.length} bars`);
  return out;
}

function calcEMA(closes, n) {
  const out=[]; const k=2/(n+1); let sum=0,cnt=0;
  for(let i=0;i<closes.length;i++){
    if(cnt<n){sum+=closes[i];cnt++;out.push(cnt===n?sum/n:null);}
    else out.push(closes[i]*k+out[i-1]*(1-k));
  }
  return out;
}

function buildRegimeMaps(candles, regMs) {
  const c=candles.map(x=>x.c), ef=calcEMA(c,EMA_FAST), es=calcEMA(c,EMA_SLOW);
  const crossMap=new Map(), stateMap=new Map();
  for(let i=1;i<candles.length;i++){
    if(!ef[i]||!es[i]||!ef[i-1]||!es[i-1]) continue;
    const ct=candles[i].t+regMs;
    stateMap.set(ct, ef[i]>es[i]?"golden":"death");
    if(ef[i-1]<=es[i-1]&&ef[i]>es[i]) crossMap.set(ct,"golden");
    else if(ef[i-1]>=es[i-1]&&ef[i]<es[i]) crossMap.set(ct,"death");
  }
  return {crossMap,stateMap};
}

// variant: "baseline" | "gate-closed"
function runSim(execBars, regimeBars, lookbackDays, variant) {
  const BUY_LADDER  = [60, 25, 10,  5];
  const SELL_LADDER = [33, 33, 33, 33];
  const buySlot  = n => BUY_LADDER [Math.min(n, BUY_LADDER.length  - 1)];
  const sellSlot = n => SELL_LADDER[Math.min(n, SELL_LADDER.length - 1)];

  const {crossMap, stateMap} = buildRegimeMaps(regimeBars, HOUR_MS);

  const startMs      = Date.now() - lookbackDays * 86_400_000;
  const bbars        = execBars.filter(b => b.t >= startMs);
  if (!bbars.length) return null;
  const firstBar     = bbars[0];

  // Init regime (PEPE is trend-following: golden=BUY, death=SELL)
  const initBucket = Math.floor(firstBar.t / HOUR_MS) * HOUR_MS;
  let regime = "neutral";
  for (let o=0; o<=3; o++) {
    const t = initBucket + o * HOUR_MS;
    if (stateMap.has(t)) { regime = stateMap.get(t)==="golden"?"buy":"sell"; break; }
    if (o>0 && stateMap.has(initBucket - o*HOUR_MS)) { regime = stateMap.get(initBucket-o*HOUR_MS)==="golden"?"buy":"sell"; break; }
  }

  let cash=INIT_CAP, crypto=0, bosCount=0;
  let regimeStartCap=regime==="buy"?INIT_CAP:0, regimeStartQty=0;
  let structure=0, lastSH=null, lastSL=null;
  const regimeCount={buy:0,sell:0};
  const trades=[];
  let peakVal=INIT_CAP, maxDD=0, crosses=0;
  let gatedBuys=0, gatedSells=0;
  // gate: closed at start (gate-closed variant), open at start (baseline = always open)
  let chochGated = variant==="gate-closed" ? false : true;

  // Track gate state changes for analysis
  const gateEvents = [];

  for (let i=0; i<bbars.length; i++) {
    const bar = bbars[i];

    // Regime change (golden=BUY, death=SELL for trend-following)
    if (bar.t % HOUR_MS === 0) {
      const cross = crossMap.get(bar.t);
      if (cross==="golden" && regime!=="buy") {
        regime="buy"; bosCount=0; regimeStartCap=cash+crypto*bar.c;
        structure=0; lastSH=null; lastSL=null; regimeCount.buy++; crosses++;
        chochGated = variant==="gate-closed" ? false : true;
      } else if (cross==="death" && regime!=="sell") {
        regime="sell"; bosCount=0; regimeStartQty=crypto;
        regimeStartCap=cash+crypto*bar.c;
        structure=0; lastSH=null; lastSL=null; regimeCount.sell++; crosses++;
        chochGated = variant==="gate-closed" ? false : true;
      }
    }

    if (i<WARMUP) continue;

    // Pivot detection
    const pIdx=i-SWING_LB;
    if (pIdx>=SWING_LB) {
      const pb=bbars[pIdx]; let isPH=true,isPL=true;
      for(let j=1;j<=SWING_LB;j++){
        const pv=bbars[pIdx-j],nx=bbars[pIdx+j];
        if(!pv||!nx){isPH=isPL=false;break;}
        if(pv.h>=pb.h||nx.h>=pb.h) isPH=false;
        if(pv.l<=pb.l||nx.l<=pb.l) isPL=false;
      }
      if(isPH&&(!lastSH||pb.t>=lastSH.t)) lastSH={price:pb.h,t:pb.t};
      if(isPL&&(!lastSL||pb.t>=lastSL.t)) lastSL={price:pb.l,t:pb.t};
    }

    // BOS/CHOCH detection
    let bullBOS=false,bearBOS=false,bullCHOCH=false,bearCHOCH=false;
    if (lastSH&&lastSL&&i>0) {
      const pc=bbars[i-1].c;
      if(bar.c>lastSH.price&&pc<=lastSH.price){if(structure===-1)bullCHOCH=true;else bullBOS=true;structure=1;}
      if(bar.c<lastSL.price&&pc>=lastSL.price){if(structure===1)bearCHOCH=true;else bearBOS=true;structure=-1;}
    }

    if (regime==="neutral") continue;

    // CHOCH gate toggling (PEPE trend-following)
    if (variant!=="baseline") {
      if (regime==="buy") {
        // Trend BUY: buy on bullBOS → bullCHOCH = aligned (gate open), bearCHOCH = reverse (gate close)
        if (bullCHOCH && !chochGated) { chochGated=true; gateEvents.push({t:bar.t,event:"OPEN (bullCHOCH)",price:bar.c,regime}); }
        if (bearCHOCH &&  chochGated) { chochGated=false; gateEvents.push({t:bar.t,event:"CLOSE (bearCHOCH)",price:bar.c,regime}); }
      } else {
        // Trend SELL: sell on bearBOS → bearCHOCH = aligned (gate open), bullCHOCH = reverse (gate close)
        if (bearCHOCH && !chochGated) { chochGated=true; gateEvents.push({t:bar.t,event:"OPEN (bearCHOCH)",price:bar.c,regime}); }
        if (bullCHOCH &&  chochGated) { chochGated=false; gateEvents.push({t:bar.t,event:"CLOSE (bullCHOCH)",price:bar.c,regime}); }
      }
    }

    // Execute trades
    if (regime==="buy" && bullBOS) {
      const usd = Math.min((regimeStartCap * buySlot(bosCount)) / 100, cash);
      if (usd>=MIN_USD) {
        if (chochGated) {
          crypto+=usd/bar.c; cash-=usd; bosCount++;
          trades.push({t:bar.t,type:"buy",price:bar.c,usd,gated:false});
        } else { gatedBuys++; trades.push({t:bar.t,type:"buy_GATED",price:bar.c,usd,gated:true}); }
      }
    }
    if (regime==="sell" && bearBOS) {
      const qty = Math.min((regimeStartQty * sellSlot(bosCount)) / 100, crypto);
      if (qty>=MIN_QTY) {
        if (chochGated) {
          cash+=qty*bar.c; crypto-=qty; bosCount++;
          trades.push({t:bar.t,type:"sell",price:bar.c,usd:qty*bar.c,gated:false});
        } else { gatedSells++; trades.push({t:bar.t,type:"sell_GATED",price:bar.c,usd:qty*bar.c,gated:true}); }
      }
    }

    const tv=cash+crypto*bar.c;
    if(tv>peakVal) peakVal=tv;
    const dd=peakVal>0?(peakVal-tv)/peakVal*100:0;
    if(dd>maxDD) maxDD=dd;
  }

  const lastBar  = bbars.at(-1);
  const finalVal = cash + crypto * lastBar.c;
  const pnlPct   = (finalVal - INIT_CAP) / INIT_CAP * 100;
  const bah      = (lastBar.c - firstBar.c) / firstBar.c * 100;

  return {
    finalVal, cash, crypto,
    pnlPct, bah, alpha: pnlPct - bah,
    maxDD, crosses, regimeCount,
    trades: trades.filter(t=>!t.gated).length,
    gatedBuys, gatedSells,
    firstPrice: firstBar.c, lastPrice: lastBar.c,
    currentRegime: regime,
    gateEvents,
    allTrades: trades,
  };
}

const s2 = n => (n>=0?"+":"")+n.toFixed(2)+"%";

async function main() {
  console.log(`\n╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║  PEPE CHOCH Gate — Isolated Backtest                         ║`);
  console.log(`║  Strategy: trend-following (1h regime, golden=BUY)           ║`);
  console.log(`║  Gate: closed at regime start; bullCHOCH opens / bearCHOCH  ║`);
  console.log(`║  closes in BUY regime (symmetric for SELL)                   ║`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝\n`);

  const maxDays  = Math.max(...PERIODS);
  console.log("─── Fetching PEPE-USD data ───────────────────────────────────────");
  const execBars   = await fetchBars("PEPE-USD", 300,  maxDays + 3,  "PEPE 5m");
  if (!execBars.length) { console.error("✗ No exec data"); process.exit(1); }
  await sleep(400);
  const regimeBars = await fetchBars("PEPE-USD", 3600, maxDays + 12, "PEPE 1h");
  if (regimeBars.length < EMA_SLOW + 10) { console.error("✗ Insufficient regime bars"); process.exit(1); }

  console.log(`\n${"═".repeat(90)}`);
  console.log(`  RESULTS  —  PEPE-USD  |  trend-following  |  1h regime  |  buy [60,25,10,5]  |  sell [33,33,33,33]`);
  console.log(`${"═".repeat(90)}`);
  console.log(`  ${"Period".padEnd(7)} ${"Variant".padEnd(14)} ${"P&L".padStart(9)} ${"vs B&H".padStart(9)} ${"B&H".padStart(8)} ${"MaxDD".padStart(8)} ${"Trades".padStart(7)} ${"Gated".padStart(8)} ${"Final$".padStart(9)}`);
  console.log(`  ${"-".repeat(88)}`);

  const summaryRows = [];

  for (const days of PERIODS) {
    for (const variant of ["baseline", "gate-closed"]) {
      const r = runSim(execBars, regimeBars, days, variant);
      if (!r) { console.log(`  ${days}d  ${variant}  — no data`); continue; }
      summaryRows.push({ days, variant, r });
      const base = summaryRows.find(x => x.days===days && x.variant==="baseline")?.r;
      const flag = variant==="baseline" ? "   "
        : r.pnlPct > (base?.pnlPct ?? 0) ? "✅ " : "❌ ";
      const gatedTotal = r.gatedBuys + r.gatedSells;
      const row = [
        `${days}d`.padEnd(7),
        variant.padEnd(14),
        s2(r.pnlPct).padStart(9),
        s2(r.alpha).padStart(9),
        s2(r.bah).padStart(8),
        ("-"+r.maxDD.toFixed(2)+"%").padStart(8),
        String(r.trades).padStart(7),
        (gatedTotal > 0 ? `-${gatedTotal}` : "-").padStart(8),
        ("$"+r.finalVal.toFixed(2)).padStart(9),
      ];
      console.log(`${flag} ${row.join(" ")}`);
    }
    console.log("");
  }

  // Delta summary
  console.log(`${"═".repeat(90)}`);
  console.log(`  GATE-CLOSED DELTA vs BASELINE  (P&L improvement)`);
  console.log(`${"═".repeat(90)}`);
  console.log(`  ${"Period".padEnd(8)} ${"Baseline P&L".padStart(14)} ${"Gate-Closed P&L".padStart(16)} ${"Delta".padStart(10)} ${"MaxDD Δ".padStart(10)} ${"Trades Δ".padStart(10)}`);
  console.log(`  ${"-".repeat(70)}`);
  for (const days of PERIODS) {
    const base  = summaryRows.find(x=>x.days===days&&x.variant==="baseline")?.r;
    const gated = summaryRows.find(x=>x.days===days&&x.variant==="gate-closed")?.r;
    if (!base||!gated) continue;
    const delta    = gated.pnlPct - base.pnlPct;
    const ddDelta  = gated.maxDD  - base.maxDD;
    const tradeDelta = gated.trades - base.trades;
    const flag = delta>0?"✅":"❌";
    console.log(`${flag}  ${`${days}d`.padEnd(8)} ${s2(base.pnlPct).padStart(14)} ${s2(gated.pnlPct).padStart(16)} ${((delta>=0?"+":"")+delta.toFixed(2)+"%").padStart(10)} ${((ddDelta>=0?"+":"")+ddDelta.toFixed(2)+"%").padStart(10)} ${String(tradeDelta).padStart(10)}`);
  }

  // Gate event analysis (longest period)
  const longestPeriod = Math.max(...PERIODS);
  const gatedResult = summaryRows.find(x=>x.days===longestPeriod&&x.variant==="gate-closed")?.r;
  if (gatedResult?.gateEvents.length) {
    console.log(`\n${"═".repeat(90)}`);
    console.log(`  GATE EVENTS  (${longestPeriod}d window)  — when gate opened/closed`);
    console.log(`${"═".repeat(90)}`);
    const toDate = t => new Date(t).toISOString().slice(0,16).replace("T"," ");
    console.log(`  ${"Date/Time (UTC)".padEnd(18)} ${"Regime".padEnd(8)} ${"Event".padEnd(22)} ${"Price".padStart(12)}`);
    console.log(`  ${"-".repeat(62)}`);
    for (const e of gatedResult.gateEvents.slice(-40)) {  // last 40 events
      console.log(`  ${toDate(e.t).padEnd(18)} ${e.regime.padEnd(8)} ${e.event.padEnd(22)} ${String(e.price.toFixed(6)).padStart(12)}`);
    }
    if (gatedResult.gateEvents.length > 40) {
      console.log(`  ... (${gatedResult.gateEvents.length - 40} earlier events omitted)`);
    }
  }

  // Gated signal analysis
  const base180  = summaryRows.find(x=>x.days===longestPeriod&&x.variant==="baseline")?.r;
  const gated180 = summaryRows.find(x=>x.days===longestPeriod&&x.variant==="gate-closed")?.r;
  if (base180 && gated180) {
    console.log(`\n${"═".repeat(90)}`);
    console.log(`  SIGNAL ANALYSIS  (${longestPeriod}d)`);
    console.log(`${"═".repeat(90)}`);
    const totalPotential = base180.trades + gated180.gatedBuys + gated180.gatedSells;
    console.log(`  Baseline executed:   ${base180.trades} trades`);
    console.log(`  Gate-closed executed:${gated180.trades} trades`);
    console.log(`  Filtered out:        ${gated180.gatedBuys + gated180.gatedSells} (${gated180.gatedBuys}B / ${gated180.gatedSells}S)`);
    console.log(`  Filter rate:         ${((gated180.gatedBuys+gated180.gatedSells)/totalPotential*100).toFixed(0)}% of potential signals skipped`);
    console.log(`  MaxDD improvement:   ${(base180.maxDD - gated180.maxDD).toFixed(2)}% (baseline -${base180.maxDD.toFixed(2)}% → gate -${gated180.maxDD.toFixed(2)}%)`);
    console.log(`  Final value Δ:       $${(gated180.finalVal - base180.finalVal).toFixed(2)}`);
  }
  console.log("");
}

main().catch(e => { console.error("✗ Fatal:", e.message, e.stack); process.exit(1); });
