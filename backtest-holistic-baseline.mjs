#!/usr/bin/env node
// backtest-holistic-baseline.mjs
// Current production config — clean performance snapshot across all 6 symbols.
// BTC 30m/bosOnly  ETH bosOnly  SOL  LINK bosOnly  PEPE trend+gates  AKT

const EMA_FAST=50, EMA_SLOW=200, SWING_LB=5, WARMUP=SWING_LB*2+2;
const INITIAL_CAP=100, MIN_ORDER_USD=1.00, MIN_ORDER_QTY=1e-8;
const PERIODS=[30,60,90,180];
const HOUR_MS=3_600_000, THIRTY_MIN_MS=1_800_000, FIFTEEN_MIN_MS=900_000;
const ADV_GRAN={300:"FIVE_MINUTE",900:"FIFTEEN_MINUTE",1800:"THIRTY_MINUTE",3600:"ONE_HOUR"};

const CONFIGS=[
  { sym:"BTC-USD",  execGran:900,  execExtra:3,  regimeMs:THIRTY_MIN_MS,  regimeFromExec:true,
    trendFollowing:false, btcGate:false, chochGate:false, bosOnly:true,
    buyLadder:[33,33,33], sellLadder:[10,15,25,50] },
  { sym:"ETH-USD",  execGran:300,  execExtra:6,  regimeMs:THIRTY_MIN_MS,  regimeFromExec:true,
    trendFollowing:false, btcGate:false, chochGate:false, bosOnly:true,
    buyLadder:[15,15,15,15], sellLadder:[5,10,20,40] },
  { sym:"SOL-USD",  execGran:300,  execExtra:6,  regimeMs:THIRTY_MIN_MS,  regimeFromExec:true,
    trendFollowing:false, btcGate:false, chochGate:false, bosOnly:false,
    buyLadder:[15,15,15,15], sellLadder:[5,10,20,40] },
  { sym:"LINK-USD", execGran:300,  execExtra:6,  regimeMs:THIRTY_MIN_MS,  regimeFromExec:true,
    trendFollowing:false, btcGate:false, chochGate:false, bosOnly:true,
    buyLadder:[60,25,10,5], sellLadder:[33,33,33,33] },
  { sym:"PEPE-USD", execGran:300,  execExtra:3,  regimeMs:HOUR_MS, regimeFromExec:false, regimeGran:3600,
    trendFollowing:true,  btcGate:true,  chochGate:true,  bosOnly:false,
    buyLadder:[60,25,10,5], sellLadder:[5,10,20,40] },
  { sym:"AKT-USD",  execGran:300,  execExtra:6,  regimeMs:FIFTEEN_MIN_MS, regimeFromExec:true,
    trendFollowing:false, btcGate:false, chochGate:false, bosOnly:false,
    buyLadder:[60,25,10,5], sellLadder:[50,25,15,10] },
];

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function fetchAllBars(symbol,granSec,totalDays,label){
  const cutoff=Date.now()-totalDays*86_400_000, windowMs=300*granSec*1000;
  const bars=[]; let endMs=Date.now(), errors=0, useAdv=false;
  process.stdout.write(`  Fetching ${label} (${totalDays}d)`);
  while(endMs>cutoff){
    const startMs=Math.max(endMs-windowMs,cutoff);
    try{
      let data;
      if(!useAdv){
        const res=await fetch(`https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${granSec}&start=${Math.floor(startMs/1000)}&end=${Math.floor(endMs/1000)}`,
          {headers:{"User-Agent":"craig-backtest/2.0"},signal:AbortSignal.timeout(15_000)});
        if(res.status===503||res.status===429){useAdv=true;throw new Error(`HTTP ${res.status}`);}
        if(!res.ok) throw new Error(`HTTP ${res.status}`);
        data=(await res.json()).map(k=>({t:+k[0]*1000,l:+k[1],h:+k[2],o:+k[3],c:+k[4]}));
      } else {
        const res=await fetch(`https://api.coinbase.com/api/v3/brokerage/market/products/${symbol}/candles?granularity=${ADV_GRAN[granSec]??'ONE_HOUR'}&start=${Math.floor(startMs/1000)}&end=${Math.floor(endMs/1000)}`,
          {headers:{"User-Agent":"craig-backtest/2.0"},signal:AbortSignal.timeout(15_000)});
        if(!res.ok) throw new Error(`HTTP ${res.status}`);
        const j=await res.json(); const arr=j.candles??j;
        data=arr.map(k=>({t:+k.start*1000,l:+k.low,h:+k.high,o:+k.open,c:+k.close}));
      }
      if(data.length) bars.unshift(...data);
      endMs=startMs-granSec*1000; process.stdout.write("."); errors=0;
    } catch(e){
      process.stdout.write("!");
      if(++errors>=5){console.error(`\n  ✗ ${e.message}`);break;}
      await sleep(2000); continue;
    }
    await sleep(130);
  }
  const seen=new Set();
  const result=bars.filter(b=>{if(seen.has(b.t))return false;seen.add(b.t);return true;}).sort((a,b)=>a.t-b.t);
  console.log(` → ${result.length} bars`); return result;
}

function aggregateBars(bars,targetMs){
  const bk=new Map();
  for(const b of bars){
    const k=Math.floor(b.t/targetMs)*targetMs;
    if(!bk.has(k)) bk.set(k,{t:k,o:b.o,h:b.h,l:b.l,c:b.c});
    else{const a=bk.get(k);a.h=Math.max(a.h,b.h);a.l=Math.min(a.l,b.l);a.c=b.c;}
  }
  return [...bk.values()].sort((a,b)=>a.t-b.t);
}

function calcEMA(closes,p){
  const out=[],k=2/(p+1);let sum=0,cnt=0;
  for(const c of closes){
    if(cnt<p){sum+=c;cnt++;out.push(cnt===p?sum/p:null);}
    else out.push(c*k+out.at(-1)*(1-k));
  }
  return out;
}

function buildRegimeMaps(candles,regimeMs){
  const cl=candles.map(c=>c.c),ef=calcEMA(cl,EMA_FAST),es=calcEMA(cl,EMA_SLOW);
  const crossMap=new Map(),stateMap=new Map();
  for(let i=1;i<candles.length;i++){
    const f=ef[i],s=es[i],fp=ef[i-1],sp=es[i-1];
    if(!f||!s||!fp||!sp) continue;
    const ct=candles[i].t+regimeMs;
    stateMap.set(ct,f>s?"golden":"death");
    if(fp<=sp&&f>s) crossMap.set(ct,"golden");
    else if(fp>=sp&&f<s) crossMap.set(ct,"death");
  }
  return{crossMap,stateMap};
}

function buildBtcStateArr(btcBars){
  const cl=btcBars.map(b=>b.c),ef=calcEMA(cl,EMA_FAST),es=calcEMA(cl,EMA_SLOW);
  const arr=[];
  for(let i=0;i<btcBars.length;i++) if(ef[i]!=null&&es[i]!=null) arr.push({t:btcBars[i].t,golden:ef[i]>es[i]});
  return arr;
}
function btcStateAt(arr,ts){
  let lo=0,hi=arr.length-1,best=null;
  while(lo<=hi){const mid=(lo+hi)>>1;if(arr[mid].t<=ts){best=arr[mid];lo=mid+1;}else hi=mid-1;}
  return best?best.golden:true;
}

function runSim(cfg,execBars,regimeBars,btcSArr,days){
  const{regimeMs,trendFollowing,btcGate,chochGate,bosOnly,buyLadder,sellLadder}=cfg;
  const buySlot=n=>buyLadder[Math.min(n,buyLadder.length-1)];
  const sellSlot=n=>sellLadder[Math.min(n,sellLadder.length-1)];
  const{crossMap,stateMap}=buildRegimeMaps(regimeBars,regimeMs);
  const startMs=Date.now()-days*86_400_000;
  const bars=execBars.filter(b=>b.t>=startMs);
  if(!bars.length) return null;
  const firstBar=bars[0];

  const initBucket=Math.floor(firstBar.t/regimeMs)*regimeMs;
  let regime="neutral";
  for(let off=0;off<=3;off++){
    const t=initBucket+off*regimeMs;
    if(stateMap.has(t)){const s=stateMap.get(t);regime=trendFollowing?(s==="golden"?"buy":"sell"):(s==="death"?"buy":"sell");break;}
    if(off>0&&stateMap.has(initBucket-off*regimeMs)){const s=stateMap.get(initBucket-off*regimeMs);regime=trendFollowing?(s==="golden"?"buy":"sell"):(s==="death"?"buy":"sell");break;}
  }

  let cash=INITIAL_CAP,cryptoQty=0,bosCount=0;
  let regCapital=regime==="buy"?INITIAL_CAP:0,regQty=0;
  let structure=0,lastSH=null,lastSL=null;
  let chochGateOpen=false,peakValue=INITIAL_CAP,maxDD=0,trades=0;

  for(let i=0;i<bars.length;i++){
    const bar=bars[i];
    if(bar.t%regimeMs===0){
      const cross=crossMap.get(bar.t);
      const buyOn=trendFollowing?"golden":"death",sellOn=trendFollowing?"death":"golden";
      if(cross===buyOn&&regime!=="buy"){regime="buy";bosCount=0;regCapital=cash+cryptoQty*bar.c;structure=0;lastSH=null;lastSL=null;chochGateOpen=false;}
      if(cross===sellOn&&regime!=="sell"){regime="sell";bosCount=0;regQty=cryptoQty;regCapital=cash+cryptoQty*bar.c;structure=0;lastSH=null;lastSL=null;chochGateOpen=false;}
    }
    if(i<WARMUP) continue;

    const pIdx=i-SWING_LB;
    if(pIdx>=SWING_LB){
      const pb=bars[pIdx];let isPH=true,isPL=true;
      for(let j=1;j<=SWING_LB;j++){
        const pv=bars[pIdx-j],nx=bars[pIdx+j];
        if(!pv||!nx){isPH=isPL=false;break;}
        if(pv.h>=pb.h||nx.h>=pb.h) isPH=false;
        if(pv.l<=pb.l||nx.l<=pb.l) isPL=false;
      }
      if(isPH&&(!lastSH||pb.t>=lastSH.t)) lastSH={price:pb.h,t:pb.t};
      if(isPL&&(!lastSL||pb.t>=lastSL.t)) lastSL={price:pb.l,t:pb.t};
    }

    let bullBOS=false,bearBOS=false,bullCHOCH=false,bearCHOCH=false;
    if(lastSH&&lastSL&&i>0){
      const pc=bars[i-1].c;
      if(bar.c>lastSH.price&&pc<=lastSH.price){if(structure===-1)bullCHOCH=true;else bullBOS=true;structure=1;}
      if(bar.c<lastSL.price&&pc>=lastSL.price){if(structure===1)bearCHOCH=true;else bearBOS=true;structure=-1;}
    }
    if(regime==="neutral") continue;

    const btcPass=!btcGate||btcStateAt(btcSArr,bar.t);
    const chochArmed=bosCount>=1;

    if(regime==="buy"){
      const aligned=bullCHOCH,reverse=bearCHOCH;
      if(chochGate){if(aligned)chochGateOpen=true;if(reverse)chochGateOpen=false;}
      const gatePass=!chochGate||chochGateOpen;
      const bosBuy=trendFollowing?bullBOS:bearBOS;
      if(!bosOnly&&aligned&&chochArmed&&btcPass){
        const usd=Math.min((regCapital*buySlot(bosCount))/100,cash);
        if(usd>=MIN_ORDER_USD){cryptoQty+=usd/bar.c;cash-=usd;bosCount++;trades++;}
      }
      if(bosBuy&&gatePass&&btcPass){
        const usd=Math.min((regCapital*buySlot(bosCount))/100,cash);
        if(usd>=MIN_ORDER_USD){cryptoQty+=usd/bar.c;cash-=usd;bosCount++;trades++;}
      }
    }
    if(regime==="sell"){
      const aligned=bearCHOCH,reverse=bullCHOCH;
      if(chochGate){if(aligned)chochGateOpen=true;if(reverse)chochGateOpen=false;}
      const gatePass=!chochGate||chochGateOpen;
      const bosSell=trendFollowing?bearBOS:bullBOS;
      if(!bosOnly&&aligned&&chochArmed){
        const qty=Math.min((regQty*sellSlot(bosCount))/100,cryptoQty);
        if(qty>=MIN_ORDER_QTY){cash+=qty*bar.c;cryptoQty-=qty;bosCount++;trades++;}
      }
      if(bosSell&&gatePass){
        const qty=Math.min((regQty*sellSlot(bosCount))/100,cryptoQty);
        if(qty>=MIN_ORDER_QTY){cash+=qty*bar.c;cryptoQty-=qty;bosCount++;trades++;}
      }
    }

    const tv=cash+cryptoQty*bar.c;
    if(tv>peakValue)peakValue=tv;
    const dd=peakValue>0?(peakValue-tv)/peakValue*100:0;
    if(dd>maxDD)maxDD=dd;
  }

  const last=bars.at(-1);
  const finalVal=cash+cryptoQty*last.c;
  const pnl=(finalVal-INITIAL_CAP)/INITIAL_CAP*100;
  const bah=(last.c-firstBar.c)/firstBar.c*100;
  return{pnl,bah,maxDD,trades,finalVal};
}

const s2=n=>(n>=0?"+":"")+n.toFixed(2)+"%";
const pad=(s,w)=>String(s).padStart(w);

async function main(){
  console.log(`\n╔══════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  Holistic Audit — Current Strategy Baseline                          ║`);
  console.log(`║  Production config: BTC/ETH/LINK bosOnly · PEPE trend+gates          ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════╝\n`);

  const maxDays=Math.max(...PERIODS);
  const dataCache=new Map();

  console.log(`─── Fetching BTC-USD 1h (PEPE BTC gate) ─────────────────────────────`);
  const btcHour=await fetchAllBars("BTC-USD",3600,maxDays+12,"BTC-USD 1h");
  const btcSArr=buildBtcStateArr(btcHour);
  await sleep(600);

  for(const cfg of CONFIGS){
    console.log(`\n─── Fetching ${cfg.sym} ─────────────────────────────────────────────`);
    const execBars=await fetchAllBars(cfg.sym,cfg.execGran,maxDays+cfg.execExtra,`${cfg.sym} exec`);
    if(!execBars.length){console.log(`  ✗ No data`);continue;}
    let regimeBars;
    if(cfg.regimeFromExec){
      regimeBars=aggregateBars(execBars,cfg.regimeMs);
      console.log(`  Aggregated → ${regimeBars.length} regime bars`);
    } else {
      await sleep(400);
      regimeBars=await fetchAllBars(cfg.sym,cfg.regimeGran,maxDays+12,`${cfg.sym} regime`);
    }
    if(!regimeBars||regimeBars.length<EMA_SLOW+10){console.log(`  ✗ Insufficient regime bars`);continue;}
    dataCache.set(cfg.sym,{execBars,regimeBars});
    await sleep(600);
  }

  // Print results table
  const W=100;
  for(const days of PERIODS){
    console.log(`\n\n${"═".repeat(W)}`);
    console.log(`  ${days}d  —  Current Production Config`);
    console.log(`${"═".repeat(W)}`);
    console.log(`  ${"Symbol".padEnd(10)} ${"Mode".padEnd(12)} ${"P&L".padStart(9)} ${"B&H".padStart(9)} ${"Alpha".padStart(8)} ${"MaxDD".padStart(8)} ${"Trades".padStart(7)} ${"Final$".padStart(9)}`);
    console.log(`  ${"-".repeat(W-2)}`);

    let pnlSum=0,cnt=0;
    for(const cfg of CONFIGS){
      if(!dataCache.has(cfg.sym)) continue;
      const{execBars,regimeBars}=dataCache.get(cfg.sym);
      const r=runSim(cfg,execBars,regimeBars,btcSArr,days);
      if(!r) continue;
      const mode=(cfg.trendFollowing?"TREND":"CONT")+(cfg.bosOnly?" BOS-only":cfg.chochGate?" +gates":"");
      const alpha=r.pnl-r.bah;
      const alphaStr=(alpha>=0?"✅":"  ")+(alpha>=0?"+":"")+alpha.toFixed(2)+"%";
      console.log(`  ${cfg.sym.padEnd(10)} ${mode.padEnd(12)} ${pad(s2(r.pnl),9)} ${pad(s2(r.bah),9)} ${alphaStr.padStart(10)} ${pad("-"+r.maxDD.toFixed(2)+"%",8)} ${pad(r.trades,7)} ${pad("$"+r.finalVal.toFixed(2),9)}`);
      pnlSum+=r.pnl; cnt++;
    }
    console.log(`\n  Portfolio avg P&L: ${s2(pnlSum/cnt).padStart(9)}`);
  }

  // Portfolio summary across all periods
  console.log(`\n\n${"═".repeat(72)}`);
  console.log(`  PORTFOLIO SUMMARY`);
  console.log(`${"═".repeat(72)}`);
  console.log(`  ${"Symbol".padEnd(10)} ${PERIODS.map(d=>(d+"d").padStart(9)).join(" ")}`);
  console.log(`  ${"-".repeat(70)}`);
  for(const cfg of CONFIGS){
    if(!dataCache.has(cfg.sym)) continue;
    const{execBars,regimeBars}=dataCache.get(cfg.sym);
    const cols=PERIODS.map(days=>{
      const r=runSim(cfg,execBars,regimeBars,btcSArr,days);
      return r?pad(s2(r.pnl),9):" ".repeat(9);
    });
    console.log(`  ${cfg.sym.padEnd(10)} ${cols.join(" ")}`);
  }
  const portAvgs=PERIODS.map(days=>{
    let sum=0,n=0;
    for(const cfg of CONFIGS){
      if(!dataCache.has(cfg.sym)) continue;
      const{execBars,regimeBars}=dataCache.get(cfg.sym);
      const r=runSim(cfg,execBars,regimeBars,btcSArr,days);
      if(r){sum+=r.pnl;n++;}
    }
    return n?pad(s2(sum/n),9):" ".repeat(9);
  });
  console.log(`  ${"Portfolio avg".padEnd(10)} ${portAvgs.join(" ")}`);
  console.log(`\n`);
}

main().catch(e=>{console.error(e);process.exit(1);});
