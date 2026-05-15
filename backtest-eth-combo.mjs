#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// backtest-eth-combo.mjs — ETH optimization sweep
//
// Current live config:
//   Exec: 5m  Regime: 30m  EMA: 20/200  BOS-only  buy:[15,15,15,15]  sell:[5,10,20,40]
//   Contrarian: death cross = BUY, golden cross = SELL
//
// Tests (analysis only — do NOT implement):
//   1. EMA sweep           — broader pair comparison at 30m
//   2. Regime TF sweep     — 15m / 30m / 1h  × best EMA
//   3. BOS-only vs BOS+CHOCH  (re-confirm with current EMA)
//   4. Buy  ladder variants
//   5. Sell ladder variants
//   6. Full stack: best from each part combined
// ═══════════════════════════════════════════════════════════════════════════

const INIT_CAP = 100, MIN_USD = 1.00, MIN_QTY = 1e-8;
const PERIODS  = [30, 60, 90, 180];
const sleep    = ms => new Promise(r => setTimeout(r, ms));

// ── Fetch ──────────────────────────────────────────────────────────────────
async function fetchBars(symbol, granSec, totalDays, label = '') {
  const cutoff = Date.now() - totalDays * 86_400_000;
  const winMs  = 300 * granSec * 1000;
  const bars   = [];
  let   endMs  = Date.now(), errors = 0;
  if (label) process.stdout.write(`  ${label}`);
  while (endMs > cutoff) {
    const startMs = Math.max(endMs - winMs, cutoff);
    const url = `https://api.exchange.coinbase.com/products/${symbol}/candles` +
      `?granularity=${granSec}&start=${Math.floor(startMs/1000)}&end=${Math.floor(endMs/1000)}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "craig-backtest" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("Bad response");
      if (data.length) bars.unshift(...data.map(k => ({ t: +k[0]*1000, l: +k[1], h: +k[2], o: +k[3], c: +k[4] })));
      endMs = startMs - granSec * 1000;
      if (label) process.stdout.write('.');
      errors = 0;
    } catch(e) {
      if (label) process.stdout.write('!');
      if (++errors >= 5) { console.error(`\n  ✗ ${e.message}`); break; }
      await sleep(2000); continue;
    }
    await sleep(120);
  }
  const seen = new Set();
  const out = bars.filter(b => { if (seen.has(b.t)) return false; seen.add(b.t); return true; })
    .sort((a, b) => a.t - b.t);
  if (label) console.log(` → ${out.length} bars`);
  return out;
}

function aggregateBars(bars, ms) {
  const bkts = new Map();
  for (const b of bars) {
    const t = Math.floor(b.t / ms) * ms;
    if (!bkts.has(t)) bkts.set(t, { t, o: b.o, h: b.h, l: b.l, c: b.c });
    else { const bk = bkts.get(t); bk.h = Math.max(bk.h, b.h); bk.l = Math.min(bk.l, b.l); bk.c = b.c; }
  }
  return [...bkts.values()].sort((a, b) => a.t - b.t);
}

// ── EMA + regime ──────────────────────────────────────────────────────────
function calcEMA(closes, n) {
  const out = [], k = 2 / (n + 1); let sum = 0, cnt = 0;
  for (let i = 0; i < closes.length; i++) {
    if (cnt < n) { sum += closes[i]; cnt++; out.push(cnt === n ? sum / n : null); }
    else out.push(closes[i] * k + out[i-1] * (1-k));
  }
  return out;
}

function buildRegimeMaps(candles, regMs, emaFast, emaSlow) {
  const c = candles.map(x => x.c), ef = calcEMA(c, emaFast), es = calcEMA(c, emaSlow);
  const crossMap = new Map(), stateMap = new Map();
  for (let i = 1; i < candles.length; i++) {
    if (!ef[i] || !es[i] || !ef[i-1] || !es[i-1]) continue;
    const ct = candles[i].t + regMs;
    stateMap.set(ct, ef[i] > es[i] ? 'golden' : 'death');
    if (ef[i-1] <= es[i-1] && ef[i] > es[i]) crossMap.set(ct, 'golden');
    else if (ef[i-1] >= es[i-1] && ef[i] < es[i]) crossMap.set(ct, 'death');
  }
  return { crossMap, stateMap };
}

// ── Core backtest (contrarian) ─────────────────────────────────────────────
function runBacktest(execBars, regimeBars, cfg, periodDays) {
  const {
    regimeMs,
    emaFast    = 20,
    emaSlow    = 200,
    swingLb    = 5,
    buyLadder  = [15, 15, 15, 15],
    sellLadder = [ 5, 10, 20, 40],
    bosOnly    = true,
  } = cfg;

  const WARMUP = swingLb * 2 + 2;
  const cutoff = Date.now() - periodDays * 86_400_000;
  const bars   = execBars.filter(b => b.t >= cutoff);
  if (bars.length < 50) return null;

  const regBars = regimeBars.filter(b => b.t >= cutoff - regimeMs * 400);
  const { crossMap, stateMap } = buildRegimeMaps(regBars, regimeMs, emaFast, emaSlow);

  let cash = INIT_CAP, crypto = 0, regime = 'neutral', bosCount = 0;
  let regStartCap = INIT_CAP, regStartCrypto = 0;
  let structure = 0, lastSH = null, lastSL = null;
  const bIdx = new Map(execBars.map((b, i) => [b.t, i]));

  for (const bar of bars) {
    const i = bIdx.get(bar.t);
    if (i === undefined || i < WARMUP) continue;

    const pIdx = i - swingLb;
    if (pIdx >= swingLb) {
      const pb = execBars[pIdx];
      let isPH = true, isPL = true;
      for (let j = 1; j <= swingLb; j++) {
        const pv = execBars[pIdx-j], nx = execBars[pIdx+j];
        if (!pv || !nx) { isPH = isPL = false; break; }
        if (pv.h >= pb.h || nx.h >= pb.h) isPH = false;
        if (pv.l <= pb.l || nx.l <= pb.l) isPL = false;
      }
      if (isPH && (!lastSH || pb.t >= lastSH.t)) lastSH = { price: pb.h, t: pb.t };
      if (isPL && (!lastSL || pb.t >= lastSL.t)) lastSL = { price: pb.l, t: pb.t };
    }

    let bullBOS = false, bearBOS = false, bullCHOCH = false, bearCHOCH = false;
    if (lastSH && lastSL && i > 0) {
      const pc = execBars[i-1].c;
      if (bar.c > lastSH.price && pc <= lastSH.price) {
        structure === -1 ? (bullCHOCH = true) : (bullBOS = true); structure = 1;
      }
      if (bar.c < lastSL.price && pc >= lastSL.price) {
        structure === 1 ? (bearCHOCH = true) : (bearBOS = true); structure = -1;
      }
    }

    // Contrarian: death cross = BUY, golden cross = SELL
    if (bar.t % regimeMs === 0) {
      const cross = crossMap.get(bar.t);
      if (cross === 'death' && regime !== 'buy') {
        regime = 'buy'; bosCount = 0; regStartCap = cash + crypto * bar.c;
        structure = 0; lastSH = null; lastSL = null;
      } else if (cross === 'golden' && regime !== 'sell') {
        regime = 'sell'; bosCount = 0; regStartCrypto = crypto;
        regStartCap = cash + crypto * bar.c;
        structure = 0; lastSH = null; lastSL = null;
      }
    }
    if (regime === 'neutral') {
      const rct   = Math.floor(bar.t / regimeMs) * regimeMs;
      const initS = stateMap.get(rct) || stateMap.get(rct + regimeMs);
      if (initS === 'death')  { regime = 'buy';  regStartCap = cash; }
      else if (initS === 'golden') { regime = 'sell'; regStartCrypto = crypto; regStartCap = cash + crypto * bar.c; }
    }

    const buySlot  = n => buyLadder [Math.min(n, buyLadder.length  - 1)];
    const sellSlot = n => sellLadder[Math.min(n, sellLadder.length - 1)];

    if (regime === 'buy') {
      if (bearBOS && cash >= MIN_USD) {
        const amt = Math.min(regStartCap * buySlot(bosCount) / 100, cash);
        if (amt >= MIN_USD) { cash -= amt; crypto += amt / bar.c; bosCount++; }
      } else if (!bosOnly && bullCHOCH && bosCount >= 1 && cash >= MIN_USD) {
        const amt = Math.min(regStartCap * buySlot(bosCount) / 100, cash);
        if (amt >= MIN_USD) { cash -= amt; crypto += amt / bar.c; bosCount++; }
      }
    }
    if (regime === 'sell') {
      if (bullBOS && crypto >= MIN_QTY) {
        const qty = Math.min(regStartCrypto * sellSlot(bosCount) / 100, crypto);
        if (qty >= MIN_QTY) { cash += qty * bar.c; crypto -= qty; bosCount++; }
      } else if (!bosOnly && bearCHOCH && bosCount >= 1 && crypto >= MIN_QTY) {
        const qty = Math.min(regStartCrypto * sellSlot(bosCount) / 100, crypto);
        if (qty >= MIN_QTY) { cash += qty * bar.c; crypto -= qty; bosCount++; }
      }
    }
  }

  const finalVal = cash + crypto * bars.at(-1).c;
  const pnlPct   = (finalVal / INIT_CAP - 1) * 100;
  const bah      = (bars.at(-1).c / bars[0].c - 1) * 100;
  return { pnlPct, bah, alpha: pnlPct - bah };
}

// ── Helpers ────────────────────────────────────────────────────────────────
function avg(results) {
  const v = results.filter(r => r?.alpha != null);
  return v.length ? v.reduce((s, r) => s + r.alpha, 0) / v.length : null;
}
function fmt(v)  { return v === null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
function fmtA(a) {
  if (a === null) return '  —  ';
  const s = (a >= 0 ? '+' : '') + a.toFixed(2) + '%';
  return (a >= 2 ? '✅ ' : a <= -2 ? '❌ ' : '↔  ') + s;
}
function printSection(title, rows, baselineAvg) {
  console.log('\n══════════════════════════════════════════════════════════════════════════');
  console.log(`  ${title}`);
  console.log('══════════════════════════════════════════════════════════════════════════');
  const hdr = `  ${'Config'.padEnd(46)}  ${'30d α'.padEnd(12)}  ${'60d α'.padEnd(12)}  ${'90d α'.padEnd(12)}  ${'180d α'.padEnd(12)}  Avg α`;
  console.log(hdr);
  console.log('  ' + '─'.repeat(104));
  for (const { label, results, isCurrent } of rows) {
    const a    = avg(results);
    const cols = results.map(r => fmtA(r?.alpha ?? null).padEnd(14)).join('  ');
    const delta = (!isCurrent && baselineAvg !== null && a !== null)
      ? `  Δ${a >= baselineAvg ? '+' : ''}${(a - baselineAvg).toFixed(2)}pt`
      : '';
    console.log(`  ${label.padEnd(46)}  ${cols}  ${fmt(a)}${delta}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  ETH Combo Backtest — Optimization sweep                     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  console.log('  Contrarian: death cross = BUY, golden cross = SELL\n');

  // ── Fetch ────────────────────────────────────────────────────────────────
  console.log('─── Fetching ETH data ───────────────────────────────────────────');
  const [exec5m, reg15m, reg1h] = await Promise.all([
    fetchBars('ETH-USD',  300, 200, 'ETH  5m exec  '),
    fetchBars('ETH-USD',  900, 200, 'ETH 15m regime'),
    fetchBars('ETH-USD', 3600, 200, 'ETH  1h regime'),
  ]);
  const reg30m    = aggregateBars(reg15m, 1_800_000);
  const reg1hAgg  = aggregateBars(reg15m, 3_600_000);
  console.log(`  ETH 30m (aggregated from 15m) → ${reg30m.length} bars`);
  console.log(`  ETH  1h (aggregated from 15m) → ${reg1hAgg.length} bars\n`);

  // ── Baseline ─────────────────────────────────────────────────────────────
  const BASE = {
    regimeMs:   1_800_000,
    emaFast:    20,
    emaSlow:    200,
    buyLadder:  [15, 15, 15, 15],
    sellLadder: [ 5, 10, 20, 40],
    bosOnly:    true,
  };
  const baseResults = PERIODS.map(d => runBacktest(exec5m, reg30m, BASE, d));
  const baseAvg     = avg(baseResults);
  console.log(`  Baseline avg α: ${fmt(baseAvg)}\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // PART 1 — EMA sweep  (30m regime, bosOnly, current ladders)
  // ══════════════════════════════════════════════════════════════════════════
  const emaPairs = [
    { label: '30m EMA20/200  ★ current',  f: 20,  s: 200 },
    { label: '30m EMA50/200',             f: 50,  s: 200 },
    { label: '30m EMA21/55',              f: 21,  s:  55 },
    { label: '30m EMA34/89',              f: 34,  s:  89 },
    { label: '30m EMA20/100',             f: 20,  s: 100 },
    { label: '30m EMA20/50',              f: 20,  s:  50 },
    { label: '30m EMA13/48',              f: 13,  s:  48 },
  ];
  const emaRows = emaPairs.map(e => ({
    label:     e.label,
    isCurrent: e.label.includes('★'),
    results:   PERIODS.map(d => runBacktest(exec5m, reg30m, { ...BASE, emaFast: e.f, emaSlow: e.s }, d)),
  }));
  printSection('PART 1 — EMA SWEEP  (30m regime, BOS-only, buy:[15,15,15,15], sell:[5,10,20,40])', emaRows, baseAvg);

  const bestEmaRow   = emaRows.reduce((b, r) => (avg(r.results) ?? -999) > (avg(b.results) ?? -999) ? r : b);
  const bestEmaPair  = emaPairs.find(e => e.label === bestEmaRow.label) ?? emaPairs[0];
  console.log(`\n  → Best EMA: ${bestEmaPair.f}/${bestEmaPair.s}  (avg α ${fmt(avg(bestEmaRow.results))})`);

  // ══════════════════════════════════════════════════════════════════════════
  // PART 2 — Regime TF sweep  (best EMA, bosOnly)
  // ══════════════════════════════════════════════════════════════════════════
  const tfRows = [
    { label: '15m regime',              bars: reg15m,   ms: 900_000   },
    { label: '30m regime  ★ current',   bars: reg30m,   ms: 1_800_000 },
    { label: '1h  regime',              bars: reg1hAgg, ms: 3_600_000 },
  ].map(t => ({
    label:     t.label,
    isCurrent: t.label.includes('★'),
    results:   PERIODS.map(d => runBacktest(exec5m, t.bars,
      { ...BASE, regimeMs: t.ms, emaFast: bestEmaPair.f, emaSlow: bestEmaPair.s }, d)),
  }));
  printSection(`PART 2 — REGIME TF SWEEP  (EMA${bestEmaPair.f}/${bestEmaPair.s}, BOS-only)`, tfRows, baseAvg);

  const bestTfRow  = tfRows.reduce((b, r) => (avg(r.results) ?? -999) > (avg(b.results) ?? -999) ? r : b);
  const bestTfMs   = bestTfRow.label.startsWith('15m') ? 900_000 : bestTfRow.label.startsWith('1h') ? 3_600_000 : 1_800_000;
  const bestTfBars = bestTfRow.label.startsWith('15m') ? reg15m : bestTfRow.label.startsWith('1h') ? reg1hAgg : reg30m;
  console.log(`\n  → Best TF: ${bestTfRow.label.split(' ')[0]}  (avg α ${fmt(avg(bestTfRow.results))})`);

  // ══════════════════════════════════════════════════════════════════════════
  // PART 3 — BOS-only vs BOS+CHOCH  (best EMA + TF)
  // ══════════════════════════════════════════════════════════════════════════
  const BEST2 = { ...BASE, regimeMs: bestTfMs, emaFast: bestEmaPair.f, emaSlow: bestEmaPair.s };
  const bosRows = [
    { label: 'BOS-only  ★ current',   bosOnly: true  },
    { label: 'BOS+CHOCH',             bosOnly: false },
  ].map(b => ({
    label:     b.label,
    isCurrent: b.label.includes('★'),
    results:   PERIODS.map(d => runBacktest(exec5m, bestTfBars, { ...BEST2, bosOnly: b.bosOnly }, d)),
  }));
  printSection(`PART 3 — BOS-only vs BOS+CHOCH  (EMA${bestEmaPair.f}/${bestEmaPair.s}, ${bestTfRow.label.split(' ')[0]} regime)`, bosRows, baseAvg);

  const bestBosOnly = avg(bosRows[0].results) >= avg(bosRows[1].results);
  console.log(`\n  → Best mode: ${bestBosOnly ? 'BOS-only' : 'BOS+CHOCH'}  (avg α ${fmt(avg(bosRows[bestBosOnly ? 0 : 1].results))})`);

  // ══════════════════════════════════════════════════════════════════════════
  // PART 4 — Buy ladder  (best EMA + TF + mode)
  // ══════════════════════════════════════════════════════════════════════════
  const BEST3 = { ...BEST2, bosOnly: bestBosOnly };
  const buyLadders = [
    { label: 'buy [15,15,15,15]  ★ current (flat-15)', ladder: [15, 15, 15, 15] },
    { label: 'buy [33,33,33]       (flat-33)',          ladder: [33, 33, 33]     },
    { label: 'buy [60,25,10,5]     (front-60)',         ladder: [60, 25, 10,  5] },
    { label: 'buy [80,10,5,5]      (front-80)',         ladder: [80, 10,  5,  5] },
    { label: 'buy [50,25,15,10]    (front-50)',         ladder: [50, 25, 15, 10] },
    { label: 'buy [25,25,25,25]    (flat-25)',          ladder: [25, 25, 25, 25] },
  ].map(b => ({
    label:     b.label,
    isCurrent: b.label.includes('★'),
    results:   PERIODS.map(d => runBacktest(exec5m, bestTfBars, { ...BEST3, buyLadder: b.ladder }, d)),
  }));
  printSection(`PART 4 — BUY LADDER  (EMA${bestEmaPair.f}/${bestEmaPair.s}, ${bestTfRow.label.split(' ')[0]} regime, ${bestBosOnly ? 'BOS-only' : 'BOS+CHOCH'})`, buyLadders, baseAvg);

  const bestBuyRow    = buyLadders.reduce((b, r) => (avg(r.results) ?? -999) > (avg(b.results) ?? -999) ? r : b);
  const buyMap        = { '[15,15,15,15]':[15,15,15,15], '[33,33,33]':[33,33,33], '[60,25,10,5]':[60,25,10,5],
                          '[80,10,5,5]':[80,10,5,5], '[50,25,15,10]':[50,25,15,10], '[25,25,25,25]':[25,25,25,25] };
  const bestBuyKey    = Object.keys(buyMap).find(k => bestBuyRow.label.includes(k));
  const bestBuyLadder = buyMap[bestBuyKey] ?? [15,15,15,15];
  console.log(`\n  → Best buy ladder: ${JSON.stringify(bestBuyLadder)}  (avg α ${fmt(avg(bestBuyRow.results))})`);

  // ══════════════════════════════════════════════════════════════════════════
  // PART 5 — Sell ladder  (best config so far)
  // ══════════════════════════════════════════════════════════════════════════
  const BEST4 = { ...BEST3, buyLadder: bestBuyLadder };
  const sellLadders = [
    { label: 'sell [5,10,20,40]   ★ current (back-steep)', ladder: [ 5, 10, 20, 40] },
    { label: 'sell [10,15,25,50]    (back-mid)',            ladder: [10, 15, 25, 50] },
    { label: 'sell [33,33,33,33]    (flat-33)',             ladder: [33, 33, 33, 33] },
    { label: 'sell [50,25,15,10]    (front-50)',            ladder: [50, 25, 15, 10] },
    { label: 'sell [25,25,25,25]    (flat-25)',             ladder: [25, 25, 25, 25] },
  ].map(s => ({
    label:     s.label,
    isCurrent: s.label.includes('★'),
    results:   PERIODS.map(d => runBacktest(exec5m, bestTfBars, { ...BEST4, sellLadder: s.ladder }, d)),
  }));
  printSection(`PART 5 — SELL LADDER  (best EMA/TF/mode/buy stack)`, sellLadders, baseAvg);

  const bestSellRow    = sellLadders.reduce((b, r) => (avg(r.results) ?? -999) > (avg(b.results) ?? -999) ? r : b);
  const sellMap        = { '[5,10,20,40]':[5,10,20,40], '[10,15,25,50]':[10,15,25,50],
                           '[33,33,33,33]':[33,33,33,33], '[50,25,15,10]':[50,25,15,10], '[25,25,25,25]':[25,25,25,25] };
  const bestSellKey    = Object.keys(sellMap).find(k => bestSellRow.label.includes(k));
  const bestSellLadder = sellMap[bestSellKey] ?? [5,10,20,40];
  console.log(`\n  → Best sell ladder: ${JSON.stringify(bestSellLadder)}  (avg α ${fmt(avg(bestSellRow.results))})`);

  // ══════════════════════════════════════════════════════════════════════════
  // PART 6 — Full stack verdict
  // ══════════════════════════════════════════════════════════════════════════
  const FULL = { ...BEST4, sellLadder: bestSellLadder };
  const stackRows = [
    { label: '★ Current live config',
      isCurrent: true,
      results: PERIODS.map(d => runBacktest(exec5m, reg30m, BASE, d)) },
    { label: `EMA${bestEmaPair.f}/${bestEmaPair.s} only`,
      isCurrent: false,
      results: PERIODS.map(d => runBacktest(exec5m, reg30m,
        { ...BASE, emaFast: bestEmaPair.f, emaSlow: bestEmaPair.s }, d)) },
    { label: `+ ${bestTfRow.label.split(' ')[0]} regime`,
      isCurrent: false,
      results: PERIODS.map(d => runBacktest(exec5m, bestTfBars,
        { ...BASE, regimeMs: bestTfMs, emaFast: bestEmaPair.f, emaSlow: bestEmaPair.s }, d)) },
    { label: `+ ${bestBosOnly ? 'BOS-only' : 'BOS+CHOCH'}`,
      isCurrent: false,
      results: PERIODS.map(d => runBacktest(exec5m, bestTfBars, BEST3, d)) },
    { label: `+ buy ${JSON.stringify(bestBuyLadder)}`,
      isCurrent: false,
      results: PERIODS.map(d => runBacktest(exec5m, bestTfBars, BEST4, d)) },
    { label: `FULL STACK (all best)  ← candidate`,
      isCurrent: false,
      results: PERIODS.map(d => runBacktest(exec5m, bestTfBars, FULL, d)) },
  ];
  printSection('PART 6 — FULL STACK VERDICT  (additive improvement check)', stackRows, baseAvg);

  // ── Summary ───────────────────────────────────────────────────────────────
  const currAvg = avg(stackRows[0].results);
  const fullAvg = avg(stackRows.at(-1).results);
  console.log('\n══════════════════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('══════════════════════════════════════════════════════════════════════════');
  console.log(`  Current avg α:     ${fmt(currAvg)}`);
  console.log(`  Full stack avg α:  ${fmt(fullAvg)}`);
  if (currAvg !== null && fullAvg !== null)
    console.log(`  Net improvement:   ${fullAvg >= currAvg ? '+' : ''}${(fullAvg - currAvg).toFixed(2)}pt`);
  console.log(`\n  Best individual changes vs current:`);
  console.log(`    EMA:      ${fmt(avg(bestEmaRow.results))}  (${bestEmaPair.f}/${bestEmaPair.s})`);
  console.log(`    TF:       ${fmt(avg(bestTfRow.results))}  (${bestTfRow.label.split(' ')[0]})`);
  console.log(`    Mode:     ${fmt(avg(bosRows[bestBosOnly ? 0 : 1].results))}  (${bestBosOnly ? 'BOS-only' : 'BOS+CHOCH'})`);
  console.log(`    Buy:      ${fmt(avg(bestBuyRow.results))}  (${JSON.stringify(bestBuyLadder)})`);
  console.log(`    Sell:     ${fmt(avg(bestSellRow.results))}  (${JSON.stringify(bestSellLadder)})`);
  console.log('\n  Done.');
}

main().catch(console.error);
