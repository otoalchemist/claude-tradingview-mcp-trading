#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// backtest-pepe-combo.mjs — PEPE optimization sweep
//
// Current live config:
//   Exec: 5m  Regime: 1h  EMA: 50/200  trendFollowing  btcGate  useChochGate
//   buy:[60,25,10,5]  sell:[5,10,20,40]
//
// Tests (do NOT implement anything — analysis only):
//   1. EMA sweep           — does faster EMA catch PEPE trends earlier?
//   2. Regime TF sweep     — 1h / 2h / 4h  × best EMA
//   3. CHOCH gate on vs off
//   4. BTC gate  on vs off
//   5. Sell ladder variants
//   6. Buy  ladder variants
//   7. Full stack: best from each part combined
//
// PEPE data note: Coinbase only has PEPE history from ~mid-2023.
// Windows: 30 / 60 / 90 / 180 days (recent — all should have data).
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

// ── EMA ───────────────────────────────────────────────────────────────────
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
    stateMap.set(ct, ef[i] > es[i] ? "golden" : "death");
    if (ef[i-1] <= es[i-1] && ef[i] > es[i]) crossMap.set(ct, "golden");
    else if (ef[i-1] >= es[i-1] && ef[i] < es[i]) crossMap.set(ct, "death");
  }
  return { crossMap, stateMap };
}

// BTC EMA state map (50/200 on 1h) — returns a Set of bar timestamps when BTC gate is OPEN
function buildBtcGateMap(btcBars1h) {
  const c   = btcBars1h.map(x => x.c);
  const e50 = calcEMA(c, 50), e200 = calcEMA(c, 200);
  const open = new Set();
  for (let i = 0; i < btcBars1h.length; i++) {
    if (e50[i] != null && e200[i] != null && e50[i] > e200[i]) open.add(btcBars1h[i].t);
  }
  return open;   // timestamps (1h bar opens) when BTC is in golden cross
}

// ── Core backtest ──────────────────────────────────────────────────────────
// PEPE is trend-following: golden cross = BUY, death cross = SELL
// btcGateMap: Set of 1h timestamps when gate is open; null = gate disabled
// chochGate: if true, require aligned CHOCH before first BOS buy
function runBacktest(execBars, regimeBars, cfg, periodDays, btcGateMap = null) {
  const {
    regimeMs,
    emaFast    = 50,
    emaSlow    = 200,
    swingLb    = 5,
    buyLadder  = [60, 25, 10,  5],
    sellLadder = [ 5, 10, 20, 40],
    chochGate  = true,   // PEPE default: gate-closed until aligned CHOCH fires
    bosOnly    = false,
  } = cfg;

  const WARMUP = swingLb * 2 + 2;
  const cutoff = Date.now() - periodDays * 86_400_000;
  const bars   = execBars.filter(b => b.t >= cutoff);
  if (bars.length < 50) return null;

  const regBars = regimeBars.filter(b => b.t >= cutoff - regimeMs * 400);
  const { crossMap, stateMap } = buildRegimeMaps(regBars, regimeMs, emaFast, emaSlow);

  let cash = INIT_CAP, crypto = 0, regime = "neutral", bosCount = 0;
  let regStartCap = INIT_CAP, regStartCrypto = 0;
  let structure = 0, lastSH = null, lastSL = null;
  let chochGateOpen = !chochGate;   // if chochGate=false, gate starts open
  const bIdx = new Map(execBars.map((b, i) => [b.t, i]));

  for (const bar of bars) {
    const i = bIdx.get(bar.t);
    if (i === undefined || i < WARMUP) continue;

    // ── Swing pivot detection ──────────────────────────────────────────────
    const pIdx = i - swingLb;
    if (pIdx >= swingLb) {
      const pb = execBars[pIdx];
      let isPH = true, isPL = true;
      for (let j = 1; j <= swingLb; j++) {
        const pv = execBars[pIdx - j], nx = execBars[pIdx + j];
        if (!pv || !nx) { isPH = isPL = false; break; }
        if (pv.h >= pb.h || nx.h >= pb.h) isPH = false;
        if (pv.l <= pb.l || nx.l <= pb.l) isPL = false;
      }
      if (isPH && (!lastSH || pb.t >= lastSH.t)) lastSH = { price: pb.h, t: pb.t };
      if (isPL && (!lastSL || pb.t >= lastSL.t)) lastSL = { price: pb.l, t: pb.t };
    }

    // ── BOS / CHOCH detection ──────────────────────────────────────────────
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

    // ── Regime transitions (trend-following: golden=BUY, death=SELL) ───────
    if (bar.t % regimeMs === 0) {
      const cross = crossMap.get(bar.t);
      if (cross === "golden" && regime !== "buy") {
        regime = "buy"; bosCount = 0; regStartCap = cash + crypto * bar.c;
        structure = 0; lastSH = null; lastSL = null;
        chochGateOpen = !chochGate;  // reset gate on each new BUY regime
      } else if (cross === "death" && regime !== "sell") {
        regime = "sell"; bosCount = 0; regStartCrypto = crypto;
        regStartCap = cash + crypto * bar.c;
        structure = 0; lastSH = null; lastSL = null;
      }
    }
    if (regime === "neutral") {
      const rct   = Math.floor(bar.t / regimeMs) * regimeMs;
      const initS = stateMap.get(rct) || stateMap.get(rct + regimeMs);
      if (initS === "golden") {
        regime = "buy"; regStartCap = cash;
        chochGateOpen = !chochGate;
      } else if (initS === "death") {
        regime = "sell"; regStartCrypto = crypto; regStartCap = cash + crypto * bar.c;
      }
    }

    // ── BTC gate: find most recent 1h bar open at or before this bar ────────
    let btcOpen = true;
    if (btcGateMap !== null) {
      // round bar timestamp down to nearest hour boundary
      const nearestHour = Math.floor(bar.t / 3_600_000) * 3_600_000;
      btcOpen = btcGateMap.has(nearestHour);
    }

    const buySlot  = n => buyLadder [Math.min(n, buyLadder.length  - 1)];
    const sellSlot = n => sellLadder[Math.min(n, sellLadder.length - 1)];

    // ── BUY regime: bullBOS buys the upswing; bullCHOCH = gate-open trigger or continuation
    if (regime === "buy") {
      // CHOCH gate logic: bullCHOCH opens the gate; bearCHOCH re-closes it
      if (chochGate) {
        if (bullCHOCH) chochGateOpen = true;
        if (bearCHOCH && bosCount === 0) chochGateOpen = false;  // only re-close before first buy
      }
      const gateOk = btcOpen && chochGateOpen;
      if (bullBOS && gateOk && cash >= MIN_USD) {
        const amt = Math.min(regStartCap * buySlot(bosCount) / 100, cash);
        if (amt >= MIN_USD) { cash -= amt; crypto += amt / bar.c; bosCount++; }
      } else if (!bosOnly && bullCHOCH && gateOk && bosCount >= 1 && cash >= MIN_USD) {
        const amt = Math.min(regStartCap * buySlot(bosCount) / 100, cash);
        if (amt >= MIN_USD) { cash -= amt; crypto += amt / bar.c; bosCount++; }
      }
    }

    // ── SELL regime: bearBOS sells into the downswing
    if (regime === "sell") {
      if (bearBOS && crypto >= MIN_QTY) {
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
  return { pnlPct, bah, alpha: pnlPct - bah, finalVal };
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
  console.log("\n══════════════════════════════════════════════════════════════════════════");
  console.log(`  ${title}`);
  console.log("══════════════════════════════════════════════════════════════════════════");
  const header = `  ${"Config".padEnd(46)}  ${"30d α".padEnd(12)}  ${"60d α".padEnd(12)}  ${"90d α".padEnd(12)}  ${"180d α".padEnd(12)}  Avg α`;
  console.log(header);
  console.log("  " + "─".repeat(104));
  for (const { label, results, isCurrent } of rows) {
    const a = avg(results);
    const cols = results.map(r => fmtA(r?.alpha ?? null).padEnd(14)).join('  ');
    const delta = (!isCurrent && baselineAvg !== null && a !== null)
      ? `  Δ${a >= baselineAvg ? '+' : ''}${(a - baselineAvg).toFixed(2)}pt`
      : '';
    console.log(`  ${label.padEnd(46)}  ${cols}  ${fmt(a)}${delta}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  PEPE Combo Backtest — Optimization sweep                    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log("  Trend-following: golden=BUY, death=SELL");
  console.log("  BTC gate: buys suppressed when BTC EMA50 < EMA200\n");

  // ── Fetch all data ─────────────────────────────────────────────────────
  console.log("─── Fetching data ──────────────────────────────────────────────");
  const [pepe5m, pepe1h, btc1h] = await Promise.all([
    fetchBars("PEPE-USD", 300,  200, "PEPE  5m exec  "),
    fetchBars("PEPE-USD", 3600, 200, "PEPE  1h regime"),
    fetchBars("BTC-USD",  3600, 200, "BTC   1h (gate)"),
  ]);
  const pepe2h = aggregateBars(pepe1h, 7_200_000);
  const pepe4h = aggregateBars(pepe1h, 14_400_000);
  console.log(`  PEPE  2h (aggregated from 1h) → ${pepe2h.length} bars`);
  console.log(`  PEPE  4h (aggregated from 1h) → ${pepe4h.length} bars`);

  if (pepe5m.length < 100 || pepe1h.length < 50) {
    console.error("\n  ✗ Insufficient PEPE data — cannot run backtest"); process.exit(1);
  }

  const btcGateMap = buildBtcGateMap(btc1h);
  console.log(`  BTC gate open bars: ${btcGateMap.size} / ${btc1h.length} hours (${(btcGateMap.size/btc1h.length*100).toFixed(0)}% of time in golden cross)\n`);

  // ── Current baseline ──────────────────────────────────────────────────
  const BASE = {
    regimeMs:  3_600_000,   // 1h
    emaFast:   50,
    emaSlow:   200,
    buyLadder: [60, 25, 10, 5],
    sellLadder: [5, 10, 20, 40],
    chochGate: true,
    bosOnly:   false,
  };
  const baseResults = PERIODS.map(d => runBacktest(pepe5m, pepe1h, BASE, d, btcGateMap));
  const baseAvg     = avg(baseResults);
  console.log(`  Baseline avg α: ${fmt(baseAvg)}\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // PART 1: EMA sweep  (1h regime, chochGate on, btcGate on, current ladders)
  // ══════════════════════════════════════════════════════════════════════════
  const emaPairs = [
    { label: "1h EMA50/200  ★ current",  f:  50, s: 200 },
    { label: "1h EMA20/50",              f:  20, s:  50 },
    { label: "1h EMA21/55",              f:  21, s:  55 },
    { label: "1h EMA34/89",              f:  34, s:  89 },
    { label: "1h EMA20/100",             f:  20, s: 100 },
    { label: "1h EMA50/100",             f:  50, s: 100 },
  ];
  const emaRows = emaPairs.map(e => ({
    label:     e.label,
    isCurrent: e.label.includes("★"),
    results:   PERIODS.map(d => runBacktest(pepe5m, pepe1h, { ...BASE, emaFast: e.f, emaSlow: e.s }, d, btcGateMap)),
  }));
  printSection("PART 1 — EMA SWEEP  (1h regime, chochGate on, btcGate on)", emaRows, baseAvg);

  const bestEmaRow  = emaRows.reduce((b, r) => (avg(r.results) ?? -999) > (avg(b.results) ?? -999) ? r : b);
  const bestEmaMatch = emaPairs.find(e => bestEmaRow.label.includes(e.label.split(" ")[2]));
  const bestEmaFast  = bestEmaMatch?.f ?? 50;
  const bestEmaSlow  = bestEmaMatch?.s ?? 200;
  console.log(`\n  → Best EMA: ${bestEmaFast}/${bestEmaSlow}  (avg α ${fmt(avg(bestEmaRow.results))})`);

  // ══════════════════════════════════════════════════════════════════════════
  // PART 2: Regime TF sweep  (best EMA, chochGate on, btcGate on)
  // ══════════════════════════════════════════════════════════════════════════
  const tfRows = [
    { label: "1h regime  ★ current",     bars: pepe1h,  ms: 3_600_000 },
    { label: "2h regime  (agg from 1h)", bars: pepe2h,  ms: 7_200_000 },
    { label: "4h regime  (agg from 1h)", bars: pepe4h,  ms: 14_400_000 },
  ].map(t => ({
    label:     t.label,
    isCurrent: t.label.includes("★"),
    results:   PERIODS.map(d => runBacktest(pepe5m, t.bars, { ...BASE, regimeMs: t.ms, emaFast: bestEmaFast, emaSlow: bestEmaSlow }, d, btcGateMap)),
  }));
  printSection(`PART 2 — REGIME TF SWEEP  (EMA${bestEmaFast}/${bestEmaSlow}, chochGate on, btcGate on)`, tfRows, baseAvg);

  const bestTfRow  = tfRows.reduce((b, r) => (avg(r.results) ?? -999) > (avg(b.results) ?? -999) ? r : b);
  const bestTfMs   = bestTfRow.label.includes("4h") ? 14_400_000 : bestTfRow.label.includes("2h") ? 7_200_000 : 3_600_000;
  const bestTfBars = bestTfMs === 14_400_000 ? pepe4h : bestTfMs === 7_200_000 ? pepe2h : pepe1h;
  console.log(`\n  → Best TF: ${bestTfRow.label.split(" ")[0]}  (avg α ${fmt(avg(bestTfRow.results))})`);

  // ══════════════════════════════════════════════════════════════════════════
  // PART 3: CHOCH gate  (best EMA + TF, btcGate on)
  // ══════════════════════════════════════════════════════════════════════════
  const BEST_SO_FAR = { ...BASE, regimeMs: bestTfMs, emaFast: bestEmaFast, emaSlow: bestEmaSlow };
  const chochRows = [
    { label: "chochGate ON   ★ current", gate: true  },
    { label: "chochGate OFF",            gate: false },
  ].map(c => ({
    label:     c.label,
    isCurrent: c.label.includes("★"),
    results:   PERIODS.map(d => runBacktest(pepe5m, bestTfBars, { ...BEST_SO_FAR, chochGate: c.gate }, d, btcGateMap)),
  }));
  printSection(`PART 3 — CHOCH GATE  (EMA${bestEmaFast}/${bestEmaSlow}, ${bestTfRow.label.split(" ")[0]} regime, btcGate on)`, chochRows, baseAvg);

  const bestChochGate = avg(chochRows[1].results) > avg(chochRows[0].results) ? false : true;
  console.log(`\n  → Best chochGate: ${bestChochGate ? "ON" : "OFF"}  (${fmt(avg(chochRows[bestChochGate ? 0 : 1].results))})`);

  // ══════════════════════════════════════════════════════════════════════════
  // PART 4: BTC gate  (best EMA + TF + chochGate)
  // ══════════════════════════════════════════════════════════════════════════
  const BEST2 = { ...BEST_SO_FAR, chochGate: bestChochGate };
  const btcRows = [
    { label: "btcGate ON   ★ current", gateMap: btcGateMap },
    { label: "btcGate OFF",            gateMap: null       },
  ].map(b => ({
    label:     b.label,
    isCurrent: b.label.includes("★"),
    results:   PERIODS.map(d => runBacktest(pepe5m, bestTfBars, BEST2, d, b.gateMap)),
  }));
  printSection(`PART 4 — BTC GATE  (EMA${bestEmaFast}/${bestEmaSlow}, ${bestTfRow.label.split(" ")[0]} regime, chochGate ${bestChochGate ? "on" : "off"})`, btcRows, baseAvg);

  const bestBtcGate = avg(btcRows[1].results) > avg(btcRows[0].results) ? null : btcGateMap;
  console.log(`\n  → Best btcGate: ${bestBtcGate ? "ON" : "OFF"}  (${fmt(avg(btcRows[bestBtcGate ? 0 : 1].results))})`);

  // ══════════════════════════════════════════════════════════════════════════
  // PART 5: Sell ladder  (best config so far)
  // ══════════════════════════════════════════════════════════════════════════
  const BEST3 = BEST2;
  const sellLadders = [
    { label: "sell [5,10,20,40]  ★ current (back-steep)", ladder: [5, 10, 20, 40] },
    { label: "sell [10,15,25,50]  (back-mid)",            ladder: [10, 15, 25, 50] },
    { label: "sell [33,33,33,33]  (flat-33)",             ladder: [33, 33, 33, 33] },
    { label: "sell [40,30,20,10]  (front-40)",            ladder: [40, 30, 20, 10] },
    { label: "sell [50,25,15,10]  (front-50)",            ladder: [50, 25, 15, 10] },
  ].map(s => ({
    label:     s.label,
    isCurrent: s.label.includes("★"),
    results:   PERIODS.map(d => runBacktest(pepe5m, bestTfBars, { ...BEST3, sellLadder: s.ladder }, d, bestBtcGate)),
  }));
  printSection(`PART 5 — SELL LADDER  (best EMA/TF/choch/btcGate stack)`, sellLadders, baseAvg);

  const bestSellRow    = sellLadders.reduce((b, r) => (avg(r.results) ?? -999) > (avg(b.results) ?? -999) ? r : b);
  const sellMatch      = sellLadders.find(s => s.label === bestSellRow.label);
  const bestSellLadder = [5,10,20,40]; // default, overridden below
  const sellExtract    = { "[5,10,20,40]":[5,10,20,40], "[10,15,25,50]":[10,15,25,50],
                           "[33,33,33,33]":[33,33,33,33], "[40,30,20,10]":[40,30,20,10],
                           "[50,25,15,10]":[50,25,15,10] };
  const bestSellKey    = Object.keys(sellExtract).find(k => bestSellRow.label.includes(k));
  const resolvedSellLadder = sellExtract[bestSellKey] ?? [5,10,20,40];
  console.log(`\n  → Best sell ladder: ${JSON.stringify(resolvedSellLadder)}  (avg α ${fmt(avg(bestSellRow.results))})`);

  // ══════════════════════════════════════════════════════════════════════════
  // PART 6: Buy ladder  (best config so far)
  // ══════════════════════════════════════════════════════════════════════════
  const BEST4 = { ...BEST3, sellLadder: resolvedSellLadder };
  const buyLadders = [
    { label: "buy [60,25,10,5]   ★ current (front-60)", ladder: [60, 25, 10, 5] },
    { label: "buy [80,10,5,5]    (front-80)",            ladder: [80, 10,  5, 5] },
    { label: "buy [50,25,15,10]  (front-50)",            ladder: [50, 25, 15, 10] },
    { label: "buy [33,33,33,33]  (flat-33)",             ladder: [33, 33, 33, 33] },
    { label: "buy [25,25,25,25]  (flat-25)",             ladder: [25, 25, 25, 25] },
  ].map(b => ({
    label:     b.label,
    isCurrent: b.label.includes("★"),
    results:   PERIODS.map(d => runBacktest(pepe5m, bestTfBars, { ...BEST4, buyLadder: b.ladder }, d, bestBtcGate)),
  }));
  printSection(`PART 6 — BUY LADDER  (best EMA/TF/choch/btcGate/sell stack)`, buyLadders, baseAvg);

  const bestBuyRow    = buyLadders.reduce((b, r) => (avg(r.results) ?? -999) > (avg(b.results) ?? -999) ? r : b);
  const buyExtract    = { "[60,25,10,5]":[60,25,10,5], "[80,10,5,5]":[80,10,5,5],
                          "[50,25,15,10]":[50,25,15,10], "[33,33,33,33]":[33,33,33,33],
                          "[25,25,25,25]":[25,25,25,25] };
  const bestBuyKey    = Object.keys(buyExtract).find(k => bestBuyRow.label.includes(k));
  const resolvedBuyLadder = buyExtract[bestBuyKey] ?? [60,25,10,5];
  console.log(`\n  → Best buy ladder: ${JSON.stringify(resolvedBuyLadder)}  (avg α ${fmt(avg(bestBuyRow.results))})`);

  // ══════════════════════════════════════════════════════════════════════════
  // PART 7: Full stack verdict
  // ══════════════════════════════════════════════════════════════════════════
  const FULL_STACK = { ...BEST4, buyLadder: resolvedBuyLadder };
  const stackRows = [
    { label: "★ Current live config",
      results: PERIODS.map(d => runBacktest(pepe5m, pepe1h, BASE, d, btcGateMap)),
      isCurrent: true },
    { label: `EMA${bestEmaFast}/${bestEmaSlow} only`,
      results: PERIODS.map(d => runBacktest(pepe5m, pepe1h, { ...BASE, emaFast: bestEmaFast, emaSlow: bestEmaSlow }, d, btcGateMap)),
      isCurrent: false },
    { label: `EMA + ${bestTfRow.label.split(" ")[0]} regime`,
      results: PERIODS.map(d => runBacktest(pepe5m, bestTfBars, { ...BASE, regimeMs: bestTfMs, emaFast: bestEmaFast, emaSlow: bestEmaSlow }, d, btcGateMap)),
      isCurrent: false },
    { label: `+ chochGate ${bestChochGate ? "ON" : "OFF"} + btcGate ${bestBtcGate ? "ON" : "OFF"}`,
      results: PERIODS.map(d => runBacktest(pepe5m, bestTfBars, BEST3, d, bestBtcGate)),
      isCurrent: false },
    { label: `+ sell ${JSON.stringify(resolvedSellLadder)}`,
      results: PERIODS.map(d => runBacktest(pepe5m, bestTfBars, BEST4, d, bestBtcGate)),
      isCurrent: false },
    { label: `FULL STACK (all best) ← candidate`,
      results: PERIODS.map(d => runBacktest(pepe5m, bestTfBars, FULL_STACK, d, bestBtcGate)),
      isCurrent: false },
  ];
  printSection("PART 7 — FULL STACK VERDICT  (additive improvement check)", stackRows, baseAvg);

  // ── Summary ──────────────────────────────────────────────────────────────
  const currentAvg = avg(stackRows[0].results);
  const fullAvg    = avg(stackRows.at(-1).results);
  console.log("\n══════════════════════════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("══════════════════════════════════════════════════════════════════════════");
  console.log(`  Current avg α:     ${fmt(currentAvg)}`);
  console.log(`  Full stack avg α:  ${fmt(fullAvg)}`);
  if (fullAvg !== null && currentAvg !== null) {
    const gain = fullAvg - currentAvg;
    console.log(`  Net improvement:   ${gain >= 0 ? '+' : ''}${gain.toFixed(2)}pt`);
  }
  console.log(`\n  Best individual changes vs current:`);
  console.log(`    EMA:       ${fmt(avg(bestEmaRow.results))}  (${bestEmaFast}/${bestEmaSlow})`);
  console.log(`    Regime TF: ${fmt(avg(bestTfRow.results))}  (${bestTfRow.label.split(" ")[0]})`);
  console.log(`    ChochGate: ${fmt(avg(chochRows[bestChochGate ? 0 : 1].results))}  (${bestChochGate ? "ON" : "OFF"})`);
  console.log(`    BTC gate:  ${fmt(avg(btcRows[bestBtcGate ? 0 : 1].results))}  (${bestBtcGate ? "ON" : "OFF"})`);
  console.log(`    Sell:      ${fmt(avg(bestSellRow.results))}  (${JSON.stringify(resolvedSellLadder)})`);
  console.log(`    Buy:       ${fmt(avg(bestBuyRow.results))}  (${JSON.stringify(resolvedBuyLadder)})`);
  console.log("\n  Done.");
}

main().catch(console.error);
