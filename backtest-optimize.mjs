/**
 * E2 Parameter Optimization Backtest
 *
 * Tests systematic variations on the live strategy to find what actually helps.
 * Reuses the same candle fetch, runs all variants in one pass.
 *
 * Levers tested:
 *   A1. Leg A RSI filter (require RSI > 50 at entry — confirm momentum)
 *   A2. Leg A ATR buffer (price must clear Don20H by ≥ 0.5×ATR — avoid fake breakouts)
 *   A3. Leg A stop: replace Don10 with 2×ATR trailing stop below entry
 *   A4. Leg A stop: Don10 + ATR buffer (price must close < Don10L - 0.3×ATR)
 *   B1. Leg B allocation bump: 40% instead of 30%
 *   B2. Leg B RSI thresholds loosened (DC: ≤35, GC pullback: ≤50)
 *   C1. Drop Leg A entirely — run Leg B only at 100%
 *   C2. Flip allocation: Leg A 30%, Leg B 70%
 *   BASELINE. Current live config for comparison
 */

import "dotenv/config";

const SYMBOLS      = ["BTCUSDT","ETHUSDT","SOLUSDT","LINKUSDT","DOGEUSDT"];
const STARTING_CAP = 1163.14;
const SIZING_PCT   = 0.10;
const TP_ATR_MULT  = 5;
const FEE_RATE     = 0.006;
const MAX_CON      = 10;
const CANDLE_LIMIT = 1500;

// ─── Fetch ────────────────────────────────────────────────────────────────────

function toCB(s) {
  if (s.endsWith("USDT")) return s.slice(0,-4)+"-USD";
  if (s.endsWith("USD"))  return s.slice(0,-3)+"-USD";
  return s;
}

async function fetchCandles(sym, limit=CANDLE_LIMIT) {
  const secs=21600, maxPage=350;
  let all=[], end=Math.floor(Date.now()/1000);
  while (all.length < limit) {
    const sz   = Math.min(maxPage, limit-all.length);
    const start= end - sz*secs;
    const url  = `https://api.coinbase.com/api/v3/brokerage/market/products/${toCB(sym)}/candles`
               + `?start=${start}&end=${end}&granularity=SIX_HOUR&limit=${sz}`;
    const r    = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j    = await r.json();
    if (!j.candles?.length) break;
    const batch= j.candles.slice().reverse().map(c=>({
      time:parseInt(c.start)*1000, open:+c.open, high:+c.high, low:+c.low, close:+c.close
    }));
    all = [...batch,...all];
    end = start;
    if (j.candles.length < sz) break;
    if (all.length < limit) await new Promise(r=>setTimeout(r,200));
  }
  return all.slice(-limit);
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function emaArr(c,p) {
  const o=new Array(c.length).fill(null); if(c.length<p) return o;
  const k=2/(p+1); let v=c.slice(0,p).reduce((a,b)=>a+b,0)/p; o[p-1]=v;
  for(let i=p;i<c.length;i++){v=c[i]*k+v*(1-k);o[i]=v;} return o;
}
function rsiArr(c,p=14) {
  const o=new Array(c.length).fill(null);
  for(let i=p;i<c.length;i++){
    let g=0,l=0;
    for(let j=i-p+1;j<=i;j++){const d=c[j]-c[j-1];if(d>0)g+=d;else l-=d;}
    const ag=g/p,al=l/p; o[i]=al===0?100:100-100/(1+ag/al);
  } return o;
}
function atrArr(c,p=14) {
  const o=new Array(c.length).fill(null);
  for(let i=p;i<c.length;i++){
    let s=0;
    for(let j=i-p+1;j<=i;j++){const h=c[j].high,l=c[j].low,pc=c[j-1].close;
      s+=Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc));}
    o[i]=s/p;
  } return o;
}
function donHigh(c,p) {
  const o=new Array(c.length).fill(null);
  for(let i=p;i<c.length;i++){let m=-Infinity;for(let j=i-p;j<i;j++)m=Math.max(m,c[j].high);o[i]=m;}
  return o;
}
function donLow(c,p) {
  const o=new Array(c.length).fill(null);
  for(let i=p;i<c.length;i++){let m=Infinity;for(let j=i-p;j<i;j++)m=Math.min(m,c[j].low);o[i]=m;}
  return o;
}

// ─── Simulation engine ────────────────────────────────────────────────────────
// cfg controls the variant being tested

function simulate(allCandles, cfg) {
  const {
    legASplit, legBSplit,
    legARsiFilter,      // if true, require RSI>50 for Leg A entry
    legAAtrBuffer,      // if >0, price must be > don20H + legAAtrBuffer * ATR
    legAStopMode,       // "don10" | "atr2x" | "don10_atr_buf"
    legBRsiDC,          // RSI threshold for death-cross dip (default 30)
    legBRsiGC,          // RSI threshold for GC pullback (default 45)
  } = cfg;

  const legA = { cash: STARTING_CAP * legASplit };
  const legB = { cash: STARTING_CAP * legBSplit };
  const posA={}, posB={};
  const trades=[], equity=[];

  // Build indicators for all symbols
  const ind={};
  for(const sym of SYMBOLS) {
    if(!allCandles[sym]) continue;
    const c=allCandles[sym], cl=c.map(x=>x.close);
    ind[sym]={
      ema50:emaArr(cl,50), ema200:emaArr(cl,200),
      rsi14:rsiArr(cl,14), atr14:atrArr(c,14),
      don20H:donHigh(c,20), don10L:donLow(c,10),
    };
  }

  const anchor = allCandles["BTCUSDT"] || Object.values(allCandles)[0];
  const bidx={};
  for(const sym of SYMBOLS) {
    if(!allCandles[sym]) continue;
    bidx[sym]=new Map(allCandles[sym].map((c,i)=>[c.time,i]));
  }

  for(let bi=0;bi<anchor.length;bi++) {
    const t=anchor[bi].time;
    if(bi<210) continue;

    // ── Exits ───────────────────────────────────────────────────────────
    for(const sym of SYMBOLS) {
      if(!allCandles[sym]) continue;
      const i=bidx[sym].get(t); if(i==null||i<210) continue;
      const close=allCandles[sym][i].close;
      const d10l =ind[sym].don10L[i];
      const atr  =ind[sym].atr14[i];

      if(posA[sym]) {
        const pos=posA[sym];
        const tp=pos.entryPrice + TP_ATR_MULT*pos.atrAtEntry;
        let stop=false;
        if(legAStopMode==="don10") {
          stop = d10l!==null && close<d10l;
        } else if(legAStopMode==="atr2x") {
          stop = close < pos.entryPrice - 2*pos.atrAtEntry;
        } else if(legAStopMode==="don10_atr_buf") {
          stop = d10l!==null && close < (d10l - 0.3*atr);
        }
        const hitTP=close>=tp;
        if(hitTP||stop) {
          const ep=hitTP?tp:close;
          const net=pos.qty*ep*(1-FEE_RATE);
          const pnl=net-pos.cost;
          legA.cash+=net;
          trades.push({sym,leg:"A",entry:pos.entryPrice,exit:ep,pnl,pnlPct:pnl/pos.cost*100,
            bars:i-pos.entryBar,reason:hitTP?"TP":"STOP"});
          delete posA[sym];
        }
      }

      if(posB[sym]) {
        const pos=posB[sym];
        const tp=pos.entryPrice + TP_ATR_MULT*pos.atrAtEntry;
        if(close>=tp) {
          const net=pos.qty*tp*(1-FEE_RATE);
          const pnl=net-pos.cost;
          legB.cash+=net;
          trades.push({sym,leg:"B",entry:pos.entryPrice,exit:tp,pnl,pnlPct:pnl/pos.cost*100,
            bars:i-pos.entryBar,reason:"TP"});
          delete posB[sym];
        }
      }
    }

    // ── Entries ─────────────────────────────────────────────────────────
    for(const sym of SYMBOLS) {
      if(!allCandles[sym]) continue;
      const i=bidx[sym].get(t); if(i==null||i<210) continue;
      const close=allCandles[sym][i].close;
      const e50=ind[sym].ema50[i], e200=ind[sym].ema200[i];
      const rsi=ind[sym].rsi14[i], atr=ind[sym].atr14[i];
      const d20h=ind[sym].don20H[i];
      if(!e50||!e200||!atr) continue;
      const inGC=e50>e200;

      // Leg A
      if(legASplit>0 && !posA[sym] && Object.keys(posA).length<MAX_CON && legA.cash>5) {
        let entryOk = inGC && d20h!==null && close>d20h && close>e50;
        if(entryOk && legARsiFilter)  entryOk = rsi!==null && rsi>50;
        if(entryOk && legAAtrBuffer>0) entryOk = close > d20h + legAAtrBuffer*atr;
        if(entryOk) {
          const eq=legA.cash+Object.values(posA).reduce((s,p)=>s+p.qty*p.entryPrice,0);
          const sz=Math.min(eq*SIZING_PCT,legA.cash);
          if(sz>=5){
            const cost=sz*(1-FEE_RATE), qty=cost/close;
            legA.cash-=sz;
            posA[sym]={entryPrice:close,qty,cost,atrAtEntry:atr,entryBar:i};
          }
        }
      }

      // Leg B
      if(legBSplit>0 && !posB[sym] && Object.keys(posB).length<MAX_CON && legB.cash>5) {
        const dc  = !inGC && rsi!==null && rsi<=legBRsiDC;
        const pull= inGC && close<e50 && rsi!==null && rsi<=legBRsiGC;
        if(dc||pull) {
          const eq=legB.cash+Object.values(posB).reduce((s,p)=>s+p.qty*p.entryPrice,0);
          const sz=Math.min(eq*SIZING_PCT,legB.cash);
          if(sz>=5){
            const cost=sz*(1-FEE_RATE), qty=cost/close;
            legB.cash-=sz;
            posB[sym]={entryPrice:close,qty,cost,atrAtEntry:atr,entryBar:i};
          }
        }
      }
    }

    // Equity snapshot
    let open=0;
    for(const sym of SYMBOLS) {
      if(!allCandles[sym]) continue;
      const i=bidx[sym].get(t); if(i==null) continue;
      const cl=allCandles[sym][i].close;
      if(posA[sym]) open+=posA[sym].qty*cl;
      if(posB[sym]) open+=posB[sym].qty*cl;
    }
    equity.push({t, total:legA.cash+legB.cash+open});
  }

  // Final MTM
  let finalOpen=0;
  for(const sym of SYMBOLS) {
    if(!allCandles[sym]) continue;
    const last=allCandles[sym][allCandles[sym].length-1];
    if(posA[sym]) finalOpen+=posA[sym].qty*last.close;
    if(posB[sym]) finalOpen+=posB[sym].qty*last.close;
  }
  const finalEq=legA.cash+legB.cash+finalOpen;

  // Metrics
  const wins=trades.filter(t=>t.pnl>0), losses=trades.filter(t=>t.pnl<=0);
  const totalPnL=trades.reduce((s,t)=>s+t.pnl,0);
  const gw=wins.reduce((s,t)=>s+t.pnl,0), gl=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  const pf=gl>0?(gw/gl):Infinity;
  let peak=STARTING_CAP,maxDD=0;
  for(const {total} of equity) {
    if(total>peak) peak=total;
    maxDD=Math.max(maxDD,(peak-total)/peak*100);
  }
  const legAT=trades.filter(t=>t.leg==="A"), legBT=trades.filter(t=>t.leg==="B");
  const legAW=legAT.filter(t=>t.pnl>0), legBW=legBT.filter(t=>t.pnl>0);
  const tpCount=trades.filter(t=>t.reason==="TP").length;
  const stopCount=trades.filter(t=>t.reason==="STOP").length;

  return {
    finalEq, totalPnL, trades: trades.length, wins: wins.length,
    wr: trades.length ? (wins.length/trades.length*100).toFixed(1) : "0",
    pf: isFinite(pf) ? pf.toFixed(2) : "∞",
    maxDD: maxDD.toFixed(1),
    tpCount, stopCount,
    legAT: legAT.length, legAWR: legAT.length ? (legAW.length/legAT.length*100).toFixed(0) : "-",
    legAPnL: legAT.reduce((s,t)=>s+t.pnl,0),
    legBT: legBT.length, legBWR: legBT.length ? (legBW.length/legBT.length*100).toFixed(0) : "-",
    legBPnL: legBT.reduce((s,t)=>s+t.pnl,0),
    netPct: ((finalEq-STARTING_CAP)/STARTING_CAP*100).toFixed(1),
  };
}

// ─── Variants ─────────────────────────────────────────────────────────────────

const VARIANTS = [
  {
    id: "BASELINE",
    desc: "Current live config (70/30, Don10 stop, no filters)",
    legASplit:0.70, legBSplit:0.30, legARsiFilter:false, legAAtrBuffer:0,
    legAStopMode:"don10", legBRsiDC:30, legBRsiGC:45,
  },
  {
    id: "A1_RSI_FILTER",
    desc: "Leg A: require RSI > 50 at entry (momentum confirmation)",
    legASplit:0.70, legBSplit:0.30, legARsiFilter:true, legAAtrBuffer:0,
    legAStopMode:"don10", legBRsiDC:30, legBRsiGC:45,
  },
  {
    id: "A2_ATR_BUFFER",
    desc: "Leg A: price must clear Don20H by ≥ 0.5×ATR (filter fake breakouts)",
    legASplit:0.70, legBSplit:0.30, legARsiFilter:false, legAAtrBuffer:0.5,
    legAStopMode:"don10", legBRsiDC:30, legBRsiGC:45,
  },
  {
    id: "A3_ATR_STOP",
    desc: "Leg A: stop = entry - 2×ATR (replaces Don10 with tighter ATR stop)",
    legASplit:0.70, legBSplit:0.30, legARsiFilter:false, legAAtrBuffer:0,
    legAStopMode:"atr2x", legBRsiDC:30, legBRsiGC:45,
  },
  {
    id: "A4_DON_ATR_STOP",
    desc: "Leg A: stop = Don10L - 0.3×ATR (wider, less whipsaw)",
    legASplit:0.70, legBSplit:0.30, legARsiFilter:false, legAAtrBuffer:0,
    legAStopMode:"don10_atr_buf", legBRsiDC:30, legBRsiGC:45,
  },
  {
    id: "A1_A2_COMBINED",
    desc: "Leg A: RSI>50 AND ATR buffer (both entry filters)",
    legASplit:0.70, legBSplit:0.30, legARsiFilter:true, legAAtrBuffer:0.5,
    legAStopMode:"don10", legBRsiDC:30, legBRsiGC:45,
  },
  {
    id: "B1_FLIP_40_60",
    desc: "Flip allocation: Leg A 40%, Leg B 60%",
    legASplit:0.40, legBSplit:0.60, legARsiFilter:false, legAAtrBuffer:0,
    legAStopMode:"don10", legBRsiDC:30, legBRsiGC:45,
  },
  {
    id: "B2_LEG_B_ONLY",
    desc: "Leg B only at 100% (drop Leg A entirely)",
    legASplit:0.00, legBSplit:1.00, legARsiFilter:false, legAAtrBuffer:0,
    legAStopMode:"don10", legBRsiDC:30, legBRsiGC:45,
  },
  {
    id: "B3_LOOSE_RSI_B",
    desc: "Leg B: loosen RSI (DC≤35, GC pullback≤50) — more entries",
    legASplit:0.70, legBSplit:0.30, legARsiFilter:false, legAAtrBuffer:0,
    legAStopMode:"don10", legBRsiDC:35, legBRsiGC:50,
  },
  {
    id: "BEST_COMBO",
    desc: "A1+A2 entry filters + flip 40/60 allocation + loose Leg B RSI",
    legASplit:0.40, legBSplit:0.60, legARsiFilter:true, legAAtrBuffer:0.5,
    legAStopMode:"don10", legBRsiDC:35, legBRsiGC:50,
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(`\n📥  Fetching candles…\n`);
const allCandles={};
for(const sym of SYMBOLS) {
  process.stdout.write(`  ${sym.padEnd(12)}`);
  try {
    allCandles[sym] = await fetchCandles(sym);
    const c=allCandles[sym];
    console.log(`${c.length} bars  (${new Date(c[0].time).toISOString().slice(0,10)} → ${new Date(c[c.length-1].time).toISOString().slice(0,10)})`);
  } catch(e) { console.log(`FAILED — ${e.message}`); }
  await new Promise(r=>setTimeout(r,400));
}

console.log(`\n⚙️   Running ${VARIANTS.length} variants…\n`);

const results=[];
for(const v of VARIANTS) {
  const r=simulate(allCandles,v);
  results.push({...v,...r});
}

// ─── Report ───────────────────────────────────────────────────────────────────

const W=70;
console.log(`\n${"═".repeat(W)}`);
console.log(`  E2 Optimization Results   (starting capital $${STARTING_CAP.toLocaleString()})`);
console.log(`${"═".repeat(W)}`);

// Sort by final equity descending
results.sort((a,b)=>b.finalEq-a.finalEq);

const H = `  ${"ID".padEnd(18)} ${"Net%".padStart(6)} ${"Trades".padStart(7)} ${"WR".padStart(5)} ${"PF".padStart(5)} ${"MaxDD".padStart(7)} ${"A WR".padStart(6)} ${"B WR".padStart(6)}`;
console.log(`\n${H}`);
console.log(`  ${"─".repeat(66)}`);
for(const r of results) {
  const net=(Number(r.netPct)>=0?"+":"")+r.netPct+"%";
  const dd="-"+r.maxDD+"%";
  const base = r.id==="BASELINE" ? " ◄ baseline" : "";
  console.log(
    `  ${r.id.padEnd(18)} ${net.padStart(6)} ${String(r.trades).padStart(7)} ${(r.wr+"%").padStart(5)} ${r.pf.padStart(5)} ${dd.padStart(7)} ${(r.legAWR+"%").padStart(6)} ${(r.legBWR+"%").padStart(6)}${base}`
  );
}

console.log(`\n${"═".repeat(W)}`);
console.log(`  DETAILS — TOP 5 VARIANTS`);
console.log(`${"═".repeat(W)}`);

for(const r of results.slice(0,5)) {
  const net=(Number(r.netPct)>=0?"+":"")+r.netPct+"%";
  const pnl=(r.totalPnL>=0?"+":"")+"$"+r.totalPnL.toFixed(2);
  console.log(`\n  ▸ ${r.id}  (${net})`);
  console.log(`    ${r.desc}`);
  console.log(`    P&L: ${pnl}  |  Trades: ${r.trades} (${r.tpCount} TP · ${r.stopCount} stops)  |  WR: ${r.wr}%  |  PF: ${r.pf}  |  MaxDD: -${r.maxDD}%`);
  console.log(`    Leg A: ${r.legAT} trades · WR ${r.legAWR}% · P&L $${r.legAPnL.toFixed(2)}`);
  console.log(`    Leg B: ${r.legBT} trades · WR ${r.legBWR}% · P&L $${r.legBPnL.toFixed(2)}`);
}

console.log(`\n${"═".repeat(W)}\n`);
