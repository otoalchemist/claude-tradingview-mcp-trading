#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// backtest-all-v2.mjs  — Full strategy audit across all 6 live symbols
//
// CURRENT BASELINES (live bot as of today):
//   BTC  : 30m regime / 15m exec / EMA34/89  / bosOnly / buy[33,33,33]    / sell[10,15,25,50]
//   ETH  : 15m regime /  5m exec / EMA50/200 / BOS+CHOCH / buy[15,15,15,15] / sell[5,10,20,40]
//   SOL  : 30m regime /  5m exec / EMA50/200 / BOS+CHOCH / buy[60,25,10,5] / sell[5,10,20,40]
//   LINK : 30m regime /  5m exec / EMA50/200 / bosOnly   / buy[60,25,10,5] / sell[33,33,33,33]
//   PEPE : 1h  regime /  5m exec / EMA50/200 / trend+btcGate+chochGate / buy[60,25,10,5] / sell[5,10,20,40]
//   AKT  : 15m regime /  5m exec / EMA50/200 / BOS+CHOCH / buy[60,25,10,5] / sell[50,25,15,10]
//
// PARTS:
//   1. Baseline across 30/60/90/180d  (current live config for all 6)
//   2. Regime TF sweep   — test 15m/30m/1h per symbol (most impactful lever)
//   3. EMA pair sweep    — 50/200, 34/89, 50/100, 21/55 at each symbol's regime TF
//   4. BOS vs CHOCH      — re-check bosOnly flag per symbol on updated data
//   5. Sell ladder sweep — top 5 variants per symbol
//   6. Buy ladder sweep  — top 5 variants per symbol
//   7. Summary table     — best config vs baseline across all symbols
// ═══════════════════════════════════════════════════════════════════════════

const INIT_CAP = 100, MIN_USD = 1.00, MIN_QTY = 1e-8;
const PERIODS  = [30, 60, 90, 180];
const sleep    = ms => new Promise(r => setTimeout(r, ms));

// ── Fetch ─────────────────────────────────────────────────────────────────
async function fetchBars(symbol, granSec, totalDays, label='') {
  const cutoff = Date.now() - totalDays*86_400_000;
  const winMs  = 300*granSec*1000;
  const bars   = [];
  let   endMs  = Date.now(), errors = 0;
  if (label) process.stdout.write(`  ${label}`);
  while (endMs > cutoff) {
    const startMs = Math.max(endMs - winMs, cutoff);
    const url = `https://api.exchange.coinbase.com/products/${symbol}/candles` +
      `?granularity=${granSec}&start=${Math.floor(startMs/1000)}&end=${Math.floor(endMs/1000)}`;
    try {
      const res = await fetch(url, { headers:{"User-Agent":"craig-backtest"}, signal:AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("Bad response");
      if (data.length) bars.unshift(...data.map(k=>({t:+k[0]*1000,l:+k[1],h:+k[2],o:+k[3],c:+k[4]})));
      endMs = startMs - granSec*1000;
      if (label) process.stdout.write(".");
      errors = 0;
    } catch(e) {
      if (label) process.stdout.write("!");
      if (++errors >= 5) { console.error(`\n  ✗ ${e.message}`); break; }
      await sleep(2000); continue;
    }
    await sleep(120);
  }
  const seen = new Set();
  const out = bars.filter(b=>{ if(seen.has(b.t)) return false; seen.add(b.t); return true; })
    .sort((a,b)=>a.t-b.t);
  if (label) console.log(` → ${out.length} bars`);
  return out;
}

function aggregateBars(bars, ms) {
  const bkts = new Map();
  for (const b of bars) {
    const t = Math.floor(b.t/ms)*ms;
    if (!bkts.has(t)) bkts.set(t, {t,o:b.o,h:b.h,l:b.l,c:b.c});
    else { const bk=bkts.get(t); bk.h=Math.max(bk.h,b.h); bk.l=Math.min(bk.l,b.l); bk.c=b.c; }
  }
  return [...bkts.values()].sort((a,b)=>a.t-b.t);
}

// ── EMA + regime ─────────────────────────────────────────────────────────
function calcEMA(closes, n) {
  const out=[], k=2/(n+1); let sum=0, cnt=0;
  for (let i=0; i<closes.length; i++) {
    if (cnt<n) { sum+=closes[i]; cnt++; out.push(cnt===n ? sum/n : null); }
    else out.push(closes[i]*k + out[i-1]*(1-k));
  }
  return out;
}

function buildRegimeMaps(candles, regMs, emaFast, emaSlow) {
  const c=candles.map(x=>x.c), ef=calcEMA(c,emaFast), es=calcEMA(c,emaSlow);
  const crossMap=new Map(), stateMap=new Map();
  for (let i=1; i<candles.length; i++) {
    if (!ef[i]||!es[i]||!ef[i-1]||!es[i-1]) continue;
    const ct = candles[i].t + regMs;
    stateMap.set(ct, ef[i]>es[i] ? "golden" : "death");
    if (ef[i-1]<=es[i-1] && ef[i]>es[i]) crossMap.set(ct, "golden");
    else if (ef[i-1]>=es[i-1] && ef[i]<es[i]) crossMap.set(ct, "death");
  }
  return { crossMap, stateMap };
}

// ── Core backtest ─────────────────────────────────────────────────────────
function runBacktest(execBars, regimeBars, cfg, periodDays, btcRegimeBars=null) {
  const {
    regimeMs, emaFast=50, emaSlow=200, swingLb=5,
    buyLadder=[60,25,10,5], sellLadder=[5,10,20,40],
    bosOnly=false, trendFollowing=false, btcGate=false, useChochGate=false,
  } = cfg;

  const WARMUP = swingLb*2+2;
  const cutoff = Date.now() - periodDays*86_400_000;
  const bars   = execBars.filter(b => b.t >= cutoff);
  if (bars.length < 50) return null;

  const regBars = regimeBars.filter(b => b.t >= cutoff - regimeMs*400);
  const { crossMap, stateMap } = buildRegimeMaps(regBars, regimeMs, emaFast, emaSlow);

  // BTC gate regime map
  let btcStateMap = null;
  if (btcGate && btcRegimeBars) {
    const btcReg = buildRegimeMaps(btcRegimeBars, 1800_000, 50, 200);
    btcStateMap = btcReg.stateMap;
  }

  let cash=INIT_CAP, crypto=0, regime="neutral", bosCount=0;
  let regStartCap=INIT_CAP, regStartCrypto=0, regStartPrice=0;
  let structure=0, lastSH=null, lastSL=null, chochGate=false;
  const bIdx = new Map(execBars.map((b,i)=>[b.t,i]));

  for (const bar of bars) {
    const i = bIdx.get(bar.t);
    if (i===undefined || i<WARMUP) continue;

    // pivot detection
    const pIdx = i - swingLb;
    if (pIdx >= swingLb) {
      const pb = execBars[pIdx];
      let isPH=true, isPL=true;
      for (let j=1; j<=swingLb; j++) {
        const pv=execBars[pIdx-j], nx=execBars[pIdx+j];
        if (!pv||!nx){isPH=isPL=false;break;}
        if (pv.h>=pb.h||nx.h>=pb.h) isPH=false;
        if (pv.l<=pb.l||nx.l<=pb.l) isPL=false;
      }
      if (isPH && (!lastSH||pb.t>=lastSH.t)) lastSH={price:pb.h,t:pb.t};
      if (isPL && (!lastSL||pb.t>=lastSL.t)) lastSL={price:pb.l,t:pb.t};
    }

    // BOS/CHOCH
    let bullBOS=false,bearBOS=false,bullCHOCH=false,bearCHOCH=false;
    if (lastSH && lastSL && i>0) {
      const pc = execBars[i-1].c;
      if (bar.c>lastSH.price && pc<=lastSH.price) { structure===-1?(bullCHOCH=true):(bullBOS=true); structure=1; }
      if (bar.c<lastSL.price && pc>=lastSL.price) { structure===1?(bearCHOCH=true):(bearBOS=true); structure=-1; }
    }

    // regime change
    if (bar.t % regimeMs === 0) {
      const cross = crossMap.get(bar.t);
      const buyOn  = trendFollowing ? "golden" : "death";
      const sellOn = trendFollowing ? "death"  : "golden";
      if (cross===buyOn && regime!=="buy") {
        regime="buy"; bosCount=0; regStartCap=cash+crypto*bar.c;
        regStartPrice=bar.c; structure=0; lastSH=null; lastSL=null;
        if (useChochGate) chochGate=false;
      } else if (cross===sellOn && regime!=="sell") {
        regime="sell"; bosCount=0; regStartCrypto=crypto;
        regStartCap=cash+crypto*bar.c; regStartPrice=bar.c;
        structure=0; lastSH=null; lastSL=null;
        if (useChochGate) chochGate=false;
      }
    }
    if (regime==="neutral") {
      const rct = Math.floor(bar.t/regimeMs)*regimeMs;
      const initS = stateMap.get(rct) || stateMap.get(rct+regimeMs);
      const buyOn  = trendFollowing ? "golden" : "death";
      const sellOn = trendFollowing ? "death"  : "golden";
      if (initS===buyOn) { regime="buy"; regStartCap=cash; regStartPrice=bar.c; }
      else if (initS===sellOn) { regime="sell"; regStartCrypto=crypto; regStartCap=cash+crypto*bar.c; regStartPrice=bar.c; }
    }

    // CHOCH gate update (PEPE)
    if (useChochGate) {
      if (regime==="buy")  { if(bullCHOCH)chochGate=true; if(bearCHOCH)chochGate=false; }
      if (regime==="sell") { if(bearCHOCH)chochGate=true; if(bullCHOCH)chochGate=false; }
    }
    const gateOpen = !useChochGate || chochGate;

    // BTC gate check
    let btcGateOpen = true;
    if (btcGate && btcStateMap) {
      const btcRct = Math.floor(bar.t/1800_000)*1800_000;
      const btcS = btcStateMap.get(btcRct) || btcStateMap.get(btcRct+1800_000);
      btcGateOpen = (trendFollowing ? btcS==="golden" : btcS==="death"); // PEPE: open when BTC golden
    }

    const buySlot  = n => buyLadder [Math.min(n, buyLadder.length-1)];
    const sellSlot = n => sellLadder[Math.min(n, sellLadder.length-1)];

    // BUY regime
    if (regime==="buy") {
      const bosBuy  = trendFollowing ? bullBOS : bearBOS;
      const chochBuyArmed = bosCount>=1;
      if (bosBuy && gateOpen && btcGateOpen && cash>=MIN_USD) {
        const amt = Math.min(regStartCap*buySlot(bosCount)/100, cash);
        if (amt>=MIN_USD) { const qty=amt/bar.c; cash-=amt; crypto+=qty; bosCount++; }
      } else if (!bosOnly && bullCHOCH && chochBuyArmed && btcGateOpen && cash>=MIN_USD) {
        const amt = Math.min(regStartCap*buySlot(bosCount)/100, cash);
        if (amt>=MIN_USD) { const qty=amt/bar.c; cash-=amt; crypto+=qty; bosCount++; }
      }
    }
    // SELL regime
    if (regime==="sell") {
      const bosSell = trendFollowing ? bearBOS : bullBOS;
      const chochSellArmed = bosCount>=1;
      if (bosSell && gateOpen && crypto>=MIN_QTY) {
        const qty = Math.min(regStartCrypto*sellSlot(bosCount)/100, crypto);
        if (qty>=MIN_QTY) { cash+=qty*bar.c; crypto-=qty; bosCount++; }
      } else if (!bosOnly && bearCHOCH && chochSellArmed && crypto>=MIN_QTY) {
        const qty = Math.min(regStartCrypto*sellSlot(bosCount)/100, crypto);
        if (qty>=MIN_QTY) { cash+=qty*bar.c; crypto-=qty; bosCount++; }
      }
    }
  }

  const finalVal = cash + crypto*bars.at(-1).c;
  const pnlPct   = (finalVal/INIT_CAP-1)*100;
  const bah      = (bars.at(-1).c/bars[0].c-1)*100;
  const alpha    = pnlPct - bah;
  const dd = (() => {
    let peak=INIT_CAP, maxDD=0, c2=INIT_CAP, cr2=0;
    for (const b of bars) {
      const v=c2+cr2*b.c; if(v>peak)peak=v;
      maxDD=Math.min(maxDD,(v-peak)/peak*100);
    }
    return maxDD;
  })();
  return { pnlPct, bah, alpha, dd, finalVal };
}

function fmt(v,d=2) { if(v===null||v===undefined)return'  —  '; return (v>=0?'+':'')+v.toFixed(d)+'%'; }
function fmtA(a) {
  if(a===null) return '  —  ';
  const s=(a>=0?'+':'')+a.toFixed(2)+'%';
  return a>=2?'✅ '+s : a<=-2?'❌ '+s : '↔  '+s;
}
function avgAlpha(results) {
  const valid = results.filter(r=>r?.alpha!=null);
  return valid.length ? valid.reduce((s,r)=>s+r.alpha,0)/valid.length : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SYMBOL CONFIGS — baselines matching live bot exactly
// ═══════════════════════════════════════════════════════════════════════════
const BASELINES = {
  "BTC-USD": { regimeMs:1800_000, emaFast:34, emaSlow:89,  swingLb:5, bosOnly:true,  trendFollowing:false, btcGate:false, useChochGate:false, buyLadder:[33,33,33],    sellLadder:[10,15,25,50], execSec:900,  regSec:1800, label:"BTC" },
  "ETH-USD": { regimeMs:1800_000, emaFast:20, emaSlow:200, swingLb:5, bosOnly:true,  trendFollowing:false, btcGate:false, useChochGate:false, buyLadder:[15,15,15,15], sellLadder:[5,10,20,40],  execSec:300,  regSec:1800, label:"ETH" },
  "SOL-USD": { regimeMs:1800_000, emaFast:21, emaSlow:55,  swingLb:5, bosOnly:false, trendFollowing:false, btcGate:false, useChochGate:false, buyLadder:[60,25,10,5],  sellLadder:[5,10,20,40],  execSec:300,  regSec:1800, label:"SOL" },
  "LINK-USD":{ regimeMs:1800_000, emaFast:20, emaSlow:200, swingLb:5, bosOnly:true,  trendFollowing:false, btcGate:false, useChochGate:false, buyLadder:[60,25,10,5],  sellLadder:[33,33,33,33], execSec:300,  regSec:1800, label:"LINK"},
  "PEPE-USD":{ regimeMs:3600_000, emaFast:50, emaSlow:200, swingLb:5, bosOnly:false, trendFollowing:true,  btcGate:true,  useChochGate:true,  buyLadder:[60,25,10,5],  sellLadder:[5,10,20,40],  execSec:300,  regSec:3600, label:"PEPE"},
  "AKT-USD": { regimeMs: 900_000, emaFast:21, emaSlow:55,  swingLb:5, bosOnly:false, trendFollowing:false, btcGate:false, useChochGate:false, buyLadder:[80,10,5,5],   sellLadder:[33,33,33,33], execSec:300,  regSec:900,  label:"AKT" },
};

const SYMBOLS = Object.keys(BASELINES);
const MAX_DAYS = 190;

async function main() {
  console.log("╔═══════════════════════════════════════════════════════════════════════╗");
  console.log("║  Full Strategy Audit — All 6 Symbols                                ║");
  console.log("║  Current live baselines vs optimization sweeps                       ║");
  console.log("╚═══════════════════════════════════════════════════════════════════════╝\n");

  // ── Fetch all data ────────────────────────────────────────────────────────
  // NOTE: Coinbase Exchange API only supports granularities: 60, 300, 900, 3600, 21600, 86400
  // 30m (1800s) is NOT natively supported — fetch 15m and aggregate to 30m.
  console.log("─── Fetching data ────────────────────────────────────────────────────────");
  const data = {};
  for (const sym of SYMBOLS) {
    const cfg = BASELINES[sym];
    data[sym] = {};
    // exec TF: 15m for BTC, 5m for rest
    data[sym].exec  = await fetchBars(sym, cfg.execSec, MAX_DAYS, `${cfg.label} ${cfg.execSec===900?'15m':'5m'} (exec)`);
    // always fetch 15m as base for regime — use to build 30m via aggregation
    data[sym].reg15 = await fetchBars(sym, 900,  MAX_DAYS, `${cfg.label} 15m (regime base)`);
    data[sym].reg30 = aggregateBars(data[sym].reg15, 1800_000);  // aggregate 15m→30m
    // 1h natively
    data[sym].reg1h = await fetchBars(sym, 3600, MAX_DAYS, `${cfg.label} 1h  (regime alt)`);
    await sleep(400);
  }
  // BTC 30m for PEPE gate (aggregate from 15m)
  data["BTC-GATE"] = data["BTC-USD"].reg30;
  console.log(`  BTC 30m (PEPE gate, aggregated) → ${data["BTC-GATE"].length} bars`);

  // helper: get regime bars for a given granSec
  function getRegBars(sym, granSec) {
    if (granSec===900)  return data[sym].reg15;
    if (granSec===1800) return data[sym].reg30;
    if (granSec===3600) return data[sym].reg1h;
    return data[sym].reg15;
  }

  // helper: run backtest across all periods and return array of results
  function sweep(sym, cfg) {
    return PERIODS.map(d => runBacktest(
      data[sym].exec, getRegBars(sym, cfg.regimeMs/1000),
      cfg, d, data["BTC-GATE"]
    ));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PART 1 — BASELINE PERFORMANCE
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════════════════════════════");
  console.log("  PART 1 — BASELINE PERFORMANCE  (current live config)");
  console.log("══════════════════════════════════════════════════════════════════════════\n");

  const baselineResults = {};
  const hdr = "  Symbol   │  30d α       60d α       90d α       180d α    │  Avg α    MaxDD";
  console.log(hdr);
  console.log("  " + "─".repeat(75));

  for (const sym of SYMBOLS) {
    const base = BASELINES[sym];
    const res  = sweep(sym, base);
    baselineResults[sym] = res;
    const avg  = avgAlpha(res);
    const dd   = res.find(r=>r)?.dd ?? 0;
    const cols = res.map(r=>fmtA(r?.alpha??null).padEnd(12)).join('');
    console.log(`  ${base.label.padEnd(5)}  │  ${cols}│  ${fmt(avg)}  ${fmt(dd)}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PART 2 — REGIME TF SWEEP
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════════════════════════════");
  console.log("  PART 2 — REGIME TIMEFRAME SWEEP  (most impactful lever)");
  console.log("══════════════════════════════════════════════════════════════════════════");

  const regTFs = { 900: "15m", 1800: "30m", 3600: "1h" };
  for (const sym of SYMBOLS) {
    const base = BASELINES[sym];
    console.log(`\n  ${base.label}  (current: ${regTFs[base.regSec]})`);
    console.log(`  ${"TF".padEnd(5)}  ${"30d α".padEnd(12)}  ${"60d α".padEnd(12)}  ${"90d α".padEnd(12)}  ${"180d α".padEnd(12)}  Avg α`);
    console.log("  " + "─".repeat(70));
    for (const [granSec, tfLabel] of [[900,"15m"],[1800,"30m"],[3600,"1h"]]) {
      const regB = getRegBars(sym, granSec);
      if (!regB) continue;
      const cfg = { ...base, regimeMs: granSec*1000 };
      const res = PERIODS.map(d => runBacktest(data[sym].exec, regB, cfg, d, data["BTC-GATE"]));
      const avg = avgAlpha(res);
      const marker = granSec===base.regSec ? " ★" : "";
      const cols = res.map(r=>fmtA(r?.alpha??null).padEnd(14)).join('');
      console.log(`  ${(tfLabel+marker).padEnd(5)}  ${cols}  ${fmt(avg)}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PART 3 — EMA PAIR SWEEP  (at each symbol's current regime TF)
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════════════════════════════");
  console.log("  PART 3 — EMA PAIR SWEEP  (at current regime TF per symbol)");
  console.log("══════════════════════════════════════════════════════════════════════════");

  const EMA_PAIRS = [[50,200],[34,89],[50,100],[21,55],[20,200]];

  for (const sym of SYMBOLS) {
    const base = BASELINES[sym];
    const regB = getRegBars(sym, base.regSec);
    console.log(`\n  ${base.label}  (regime ${regTFs[base.regSec]})`);
    console.log(`  ${"EMA".padEnd(8)}  ${"30d α".padEnd(12)}  ${"60d α".padEnd(12)}  ${"90d α".padEnd(12)}  ${"180d α".padEnd(12)}  Avg α`);
    console.log("  " + "─".repeat(72));
    for (const [ef, es] of EMA_PAIRS) {
      const cfg = { ...base, emaFast:ef, emaSlow:es };
      const res = PERIODS.map(d => runBacktest(data[sym].exec, regB, cfg, d, data["BTC-GATE"]));
      const avg = avgAlpha(res);
      const marker = (ef===50&&es===200) ? " ★" : "";
      const cols = res.map(r=>fmtA(r?.alpha??null).padEnd(14)).join('');
      console.log(`  ${(`${ef}/${es}`+marker).padEnd(8)}  ${cols}  ${fmt(avg)}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PART 4 — BOS vs BOS+CHOCH  (per symbol)
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════════════════════════════");
  console.log("  PART 4 — BOS-ONLY vs BOS+CHOCH  (per symbol)");
  console.log("══════════════════════════════════════════════════════════════════════════\n");
  console.log(`  ${"Symbol".padEnd(6)}  ${"Mode".padEnd(12)}  ${"30d α".padEnd(12)}  ${"60d α".padEnd(12)}  ${"90d α".padEnd(12)}  ${"180d α".padEnd(12)}  Avg α   Δ`);
  console.log("  " + "─".repeat(88));

  const chochResults = {};
  for (const sym of ["BTC-USD","ETH-USD","SOL-USD","LINK-USD","AKT-USD"]) {
    const base = BASELINES[sym];
    for (const bosOnly of [true, false]) {
      const cfg = { ...base, bosOnly };
      const res = PERIODS.map(d => runBacktest(data[sym].exec, getRegBars(sym, base.regSec), cfg, d, data["BTC-GATE"]));
      const avg = avgAlpha(res);
      if (!chochResults[sym]) chochResults[sym] = {};
      chochResults[sym][bosOnly?"bos":"choch"] = { res, avg };
      const marker = (bosOnly===base.bosOnly) ? " ★" : "";
      const cols   = res.map(r=>fmtA(r?.alpha??null).padEnd(14)).join('');
      const mode   = (bosOnly ? "BOS-only" : "BOS+CHOCH") + marker;
      console.log(`  ${base.label.padEnd(6)}  ${mode.padEnd(14)}  ${cols}  ${fmt(avg)}`);
    }
    // delta line
    const bos   = chochResults[sym].bos?.avg;
    const choch = chochResults[sym].choch?.avg;
    const delta = (choch!=null && bos!=null) ? choch-bos : null;
    const winner = delta>0 ? "→ BOS+CHOCH wins" : delta<0 ? "→ BOS-only wins" : "→ tied";
    console.log(`  ${" ".repeat(6)}  ${winner}  (Δ${fmt(delta)})`);
    console.log("");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PART 5 — SELL LADDER SWEEP
  // ══════════════════════════════════════════════════════════════════════════
  console.log("══════════════════════════════════════════════════════════════════════════");
  console.log("  PART 5 — SELL LADDER SWEEP");
  console.log("══════════════════════════════════════════════════════════════════════════");

  const SELL_LADDERS = [
    [5,10,20,40],   // back-steep (default ETH/SOL/PEPE)
    [10,15,25,50],  // back-mid   (BTC)
    [33,33,33,33],  // flat-33    (LINK)
    [50,25,15,10],  // front-50   (AKT)
    [25,25,25,25],  // flat-25
    [15,25,35,25],  // mid-peak
    [20,20,30,30],  // mild-back
    [40,30,20,10],  // front-40
  ];

  for (const sym of SYMBOLS) {
    const base = BASELINES[sym];
    console.log(`\n  ${base.label}`);
    console.log(`  ${"Sell".padEnd(14)}  ${"30d α".padEnd(12)}  ${"60d α".padEnd(12)}  ${"90d α".padEnd(12)}  ${"180d α".padEnd(12)}  Avg α`);
    console.log("  " + "─".repeat(74));
    let bestAvg = -Infinity, bestLadder = null;
    for (const sl of SELL_LADDERS) {
      const cfg = { ...base, sellLadder: sl };
      const res = PERIODS.map(d => runBacktest(data[sym].exec, getRegBars(sym, base.regSec), cfg, d, data["BTC-GATE"]));
      const avg = avgAlpha(res);
      const marker = JSON.stringify(sl)===JSON.stringify(base.sellLadder) ? " ★" : "";
      const cols   = res.map(r=>fmtA(r?.alpha??null).padEnd(14)).join('');
      console.log(`  ${(`[${sl}]`+marker).padEnd(16)} ${cols}  ${fmt(avg)}`);
      if (avg!=null && avg>bestAvg) { bestAvg=avg; bestLadder=sl; }
    }
    const baseAvg = avgAlpha(PERIODS.map(d => runBacktest(data[sym].exec, getRegBars(sym, base.regSec), base, d, data["BTC-GATE"])));
    const delta = bestAvg - (baseAvg??0);
    console.log(`  → Best: [${bestLadder}]  avg α ${fmt(bestAvg)}  (Δ${delta>=0?'+':''}${delta.toFixed(2)}%)`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PART 6 — BUY LADDER SWEEP
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════════════════════════════");
  console.log("  PART 6 — BUY LADDER SWEEP");
  console.log("══════════════════════════════════════════════════════════════════════════");

  const BUY_LADDERS = [
    [60,25,10,5],   // front-60  (default SOL/LINK/PEPE/AKT)
    [15,15,15,15],  // flat-15   (ETH)
    [33,33,33,33],  // flat-33
    [50,30,15,5],   // front-50
    [40,30,20,10],  // mild-front
    [25,25,25,25],  // flat-25
    [10,20,30,40],  // back-heavy
    [80,10,5,5],    // aggressive-front
  ];

  for (const sym of SYMBOLS) {
    const base = BASELINES[sym];
    const buyList = base.label==="BTC"
      ? [[33,33,33],[50,25,25],[40,30,30],[25,25,25],[20,40,40],[60,20,20],[33,33,33,33]]
      : BUY_LADDERS;
    console.log(`\n  ${base.label}`);
    console.log(`  ${"Buy".padEnd(16)}  ${"30d α".padEnd(12)}  ${"60d α".padEnd(12)}  ${"90d α".padEnd(12)}  ${"180d α".padEnd(12)}  Avg α`);
    console.log("  " + "─".repeat(76));
    let bestAvg=-Infinity, bestLadder=null;
    for (const bl of buyList) {
      const cfg = { ...base, buyLadder: bl };
      const res = PERIODS.map(d => runBacktest(data[sym].exec, getRegBars(sym, base.regSec), cfg, d, data["BTC-GATE"]));
      const avg = avgAlpha(res);
      const marker = JSON.stringify(bl)===JSON.stringify(base.buyLadder) ? " ★" : "";
      const cols   = res.map(r=>fmtA(r?.alpha??null).padEnd(14)).join('');
      console.log(`  ${(`[${bl}]`+marker).padEnd(18)} ${cols}  ${fmt(avg)}`);
      if (avg!=null && avg>bestAvg) { bestAvg=avg; bestLadder=bl; }
    }
    const baseAvg = avgAlpha(PERIODS.map(d => runBacktest(data[sym].exec, getRegBars(sym, base.regSec), base, d, data["BTC-GATE"])));
    const delta = bestAvg - (baseAvg??0);
    console.log(`  → Best: [${bestLadder}]  avg α ${fmt(bestAvg)}  (Δ${delta>=0?'+':''}${delta.toFixed(2)}%)`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PART 7 — SUMMARY: best opportunity per symbol
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════════════════════════════");
  console.log("  PART 7 — SUMMARY: TOP OPPORTUNITIES PER SYMBOL");
  console.log("══════════════════════════════════════════════════════════════════════════\n");

  for (const sym of SYMBOLS) {
    const base = BASELINES[sym];
    const baseAvg = avgAlpha(baselineResults[sym]);
    console.log(`  ${base.label}  (baseline avg α: ${fmt(baseAvg)})`);

    // Collect best from each dimension
    const opps = [];

    // regime TF
    let bestRegAvg=-Infinity, bestReg=null;
    for (const granSec of [900,1800,3600]) {
      const regB = getRegBars(sym, granSec);
      if (!regB) continue;
      const cfg = { ...base, regimeMs: granSec*1000 };
      const avg = avgAlpha(PERIODS.map(d => runBacktest(data[sym].exec, regB, cfg, d, data["BTC-GATE"])));
      if (avg!=null && avg>bestRegAvg) { bestRegAvg=avg; bestReg=granSec; }
    }
    if (bestReg && bestReg!==base.regSec) {
      opps.push({ dim:"Regime TF", change:`${regTFs[base.regSec]}→${regTFs[bestReg]}`, delta:bestRegAvg-(baseAvg??0), avg:bestRegAvg });
    }

    // EMA pair
    let bestEmaAvg=-Infinity, bestEma=null;
    for (const [ef,es] of EMA_PAIRS) {
      const cfg = { ...base, emaFast:ef, emaSlow:es };
      const avg = avgAlpha(PERIODS.map(d => runBacktest(data[sym].exec, getRegBars(sym, base.regSec), cfg, d, data["BTC-GATE"])));
      if (avg!=null && avg>bestEmaAvg) { bestEmaAvg=avg; bestEma=[ef,es]; }
    }
    if (bestEma && !(bestEma[0]===50&&bestEma[1]===200)) {
      opps.push({ dim:"EMA pair", change:`50/200→${bestEma[0]}/${bestEma[1]}`, delta:bestEmaAvg-(baseAvg??0), avg:bestEmaAvg });
    }

    // CHOCH (non-PEPE only)
    if (sym !== "PEPE-USD") {
      const altBosOnly = !base.bosOnly;
      const cfg = { ...base, bosOnly:altBosOnly };
      const avg = avgAlpha(PERIODS.map(d => runBacktest(data[sym].exec, getRegBars(sym, base.regSec), cfg, d, data["BTC-GATE"])));
      if (avg!=null && avg>(baseAvg??0)) {
        opps.push({ dim:"CHOCH mode", change:base.bosOnly?"BOS-only→BOS+CHOCH":"BOS+CHOCH→BOS-only", delta:avg-(baseAvg??0), avg });
      }
    }

    // Sell ladder
    let bestSellAvg=-Infinity, bestSell=null;
    const sellList = base.label==="BTC" ? SELL_LADDERS : SELL_LADDERS;
    for (const sl of sellList) {
      const cfg = { ...base, sellLadder:sl };
      const avg = avgAlpha(PERIODS.map(d => runBacktest(data[sym].exec, getRegBars(sym, base.regSec), cfg, d, data["BTC-GATE"])));
      if (avg!=null && avg>bestSellAvg) { bestSellAvg=avg; bestSell=sl; }
    }
    if (bestSell && JSON.stringify(bestSell)!==JSON.stringify(base.sellLadder)) {
      opps.push({ dim:"Sell ladder", change:`[${base.sellLadder}]→[${bestSell}]`, delta:bestSellAvg-(baseAvg??0), avg:bestSellAvg });
    }

    // Buy ladder
    let bestBuyAvg=-Infinity, bestBuy=null;
    const buyList2 = base.label==="BTC"
      ? [[33,33,33],[50,25,25],[40,30,30],[25,25,25],[20,40,40],[60,20,20]]
      : BUY_LADDERS;
    for (const bl of buyList2) {
      const cfg = { ...base, buyLadder:bl };
      const avg = avgAlpha(PERIODS.map(d => runBacktest(data[sym].exec, getRegBars(sym, base.regSec), cfg, d, data["BTC-GATE"])));
      if (avg!=null && avg>bestBuyAvg) { bestBuyAvg=avg; bestBuy=bl; }
    }
    if (bestBuy && JSON.stringify(bestBuy)!==JSON.stringify(base.buyLadder)) {
      opps.push({ dim:"Buy ladder", change:`[${base.buyLadder}]→[${bestBuy}]`, delta:bestBuyAvg-(baseAvg??0), avg:bestBuyAvg });
    }

    opps.sort((a,b)=>b.delta-a.delta);
    if (opps.length===0) {
      console.log(`    ✅ Already optimal across all dimensions tested\n`);
    } else {
      opps.slice(0,3).forEach((o,i)=>{
        const icon = o.delta>=3?'🟢':o.delta>=1?'🟡':'⚪';
        console.log(`    ${i+1}. ${icon} ${o.dim.padEnd(12)} ${o.change.padEnd(28)} avg α ${fmt(o.avg)}  (Δ${o.delta>=0?'+':''}${o.delta.toFixed(2)}%)`);
      });
      console.log("");
    }
  }

  console.log("══════════════════════════════════════════════════════════════════════════");
  console.log("  Done.\n");
}

main().catch(console.error);
