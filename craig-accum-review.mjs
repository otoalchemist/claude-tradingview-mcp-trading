#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// craig-accum-review.mjs  — End-of-Day Paper Trading Review
//
// Reads live bot state files + trade log, fetches current prices,
// prints a full P&L breakdown, and sends a Telegram summary.
//
// Run nightly at 11 PM PST (07:00 UTC next day).
// ═══════════════════════════════════════════════════════════════════════════

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";

const SYMBOLS         = ["BTC-USD", "ETH-USD", "SOL-USD", "AKT-USD", "PEPE-USD"];
const INITIAL_CAPITAL = 500;
const TRADES_LOG      = "craig-accum-trades.jsonl";

// ── Helpers ───────────────────────────────────────────────────────────────────
const f2  = n => n.toFixed(2);
const f6  = n => n.toFixed(6);
const fp  = n => (n >= 0 ? "+" : "") + "$" + Math.abs(n).toFixed(2);
const fpp = n => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";

function stateFile(symbol) { return `craig-state-${symbol.replace("/", "-")}.json`; }

function loadState(symbol) {
  const f = stateFile(symbol);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}

async function getLivePrice(symbol) {
  try {
    const res  = await fetch(
      `https://api.coinbase.com/api/v3/brokerage/market/products/${symbol}`,
      { signal: AbortSignal.timeout(5000) }
    );
    const d = await res.json();
    return parseFloat(d.price || 0);
  } catch { return 0; }
}

async function getStartPrice(symbol, startTs) {
  // Fetch 1h candle at or near startTs to get entry price for HODL calc
  try {
    const end   = Math.floor(startTs / 1000) + 3600;
    const start = Math.floor(startTs / 1000) - 3600;
    const url   = `https://api.coinbase.com/api/v3/brokerage/market/products/${symbol}/candles`
      + `?start=${start}&end=${end}&granularity=ONE_HOUR&limit=2`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const json = await res.json();
    if (json.candles?.length) return parseFloat(json.candles[0].close);
    return 0;
  } catch { return 0; }
}

async function sendTelegram(msg) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "HTML" }),
    });
  } catch (e) { console.error("Telegram:", e.message); }
}

// ── Today's trade filter ──────────────────────────────────────────────────────
function todaysPST() {
  // Returns the start-of-day PST (UTC-8 / UTC-7 summer) in ms
  const now = new Date();
  // Simple: today's date in PST = UTC - 8h
  const pstOffset = 8 * 3600 * 1000;
  const pstNow = new Date(now.getTime() - pstOffset);
  const pstMidnight = new Date(pstNow.getFullYear(), pstNow.getMonth(), pstNow.getDate());
  return pstMidnight.getTime() + pstOffset; // back to UTC ms
}

// ── Main review ───────────────────────────────────────────────────────────────
async function main() {
  const dayStart = todaysPST();
  const now      = new Date();
  const dateStr  = now.toISOString().slice(0, 10);

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Craig Accumulation Bot  —  END-OF-DAY REVIEW               ║");
  console.log(`║  ${dateStr} PST                                               ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Load all today's trades from the append log
  let allTrades = [];
  if (existsSync(TRADES_LOG)) {
    allTrades = readFileSync(TRADES_LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }
  const todaysTrades = allTrades.filter(t => t.t >= dayStart);

  const symbolRows = [];
  let telegramLines = [
    `📊 <b>Craig Accum Bot — EOD Review ${dateStr}</b>\n`
  ];
  let grandStratTotal = 0, grandHodlTotal = 0;

  for (const symbol of SYMBOLS) {
    const state = loadState(symbol);
    if (!state || !state.initialized) {
      console.log(`  [${symbol}] No state — bot not started yet`);
      telegramLines.push(`  ${symbol}: not initialized`);
      continue;
    }

    const livePrice = await getLivePrice(symbol);
    if (!livePrice) { console.log(`  [${symbol}] Could not fetch price`); continue; }

    const totalValue = state.cash + state.cryptoQty * livePrice;
    const pnl        = totalValue - INITIAL_CAPITAL;
    const pnlPct     = pnl / INITIAL_CAPITAL * 100;

    // HODL: estimate from first trade or bot-start time
    const firstTrade = state.trades[0];
    const hodlBuyPrice = firstTrade ? firstTrade.price : livePrice;
    const hodlQty   = INITIAL_CAPITAL / hodlBuyPrice;
    const hodlValue = hodlQty * livePrice;
    const hodlPnl   = hodlValue - INITIAL_CAPITAL;
    const hodlPct   = hodlPnl / INITIAL_CAPITAL * 100;
    const edge      = pnlPct - hodlPct;

    grandStratTotal += totalValue;
    grandHodlTotal  += hodlValue;

    // Today's trades for this symbol
    const sysTrades = todaysTrades.filter(t => t.symbol === symbol);
    const buysToday  = sysTrades.filter(t => t.type === "scaled_buy" || t.type === "final_buy");
    const sellsToday = sysTrades.filter(t => t.type === "scaled_sell" || t.type === "final_sell");

    const icon = edge > 1 ? "✅" : edge < -1 ? "❌" : "↔";

    console.log(`\n── ${symbol} ${"─".repeat(50)}`);
    console.log(`  Regime    : ${state.regime.toUpperCase()}  (${state.regimeCount.buy} buy / ${state.regimeCount.sell} sell cycles)`);
    console.log(`  Cash      : $${f2(state.cash)}`);
    console.log(`  Crypto    : ${f6(state.cryptoQty)} @ $${f2(livePrice)} = $${f2(state.cryptoQty * livePrice)}`);
    console.log(`  Total     : $${f2(totalValue)}   Strategy: ${fp(pnl)} (${fpp(pnlPct)})`);
    console.log(`  HODL ref  : $${f2(hodlValue)}   HODL: ${fp(hodlPnl)} (${fpp(hodlPct)})`);
    console.log(`  Edge      : ${fp(pnl - hodlPnl)} (${fpp(edge)} pts)  ${icon}`);
    console.log(`  BOS count : ${state.bosCount} (current regime)`);
    if (buysToday.length || sellsToday.length) {
      console.log(`  Today     : ${buysToday.length} buys, ${sellsToday.length} sells`);
      for (const t of sysTrades.filter(t => t.type !== "regime")) {
        const tag = t.type === "scaled_buy"  ? `BUY  #${t.bosNum}` :
                    t.type === "final_buy"   ? `BUY  CHOCH ★` :
                    t.type === "scaled_sell" ? `SELL #${t.bosNum}` : `SELL CHOCH ★`;
        console.log(`    ${new Date(t.t).toISOString().slice(11,16)} UTC  ${tag.padEnd(14)} @ $${f2(t.price).padStart(12)}  $${f2(t.usd).padStart(8)}`);
      }
    } else {
      console.log(`  Today     : no trades fired`);
    }

    telegramLines.push(
      `<b>${symbol}</b>  ${icon}\n` +
      `Regime: ${state.regime.toUpperCase()} | Cash: $${f2(state.cash)} | ${f6(state.cryptoQty)} coins\n` +
      `Strategy: ${fp(pnl)} (${fpp(pnlPct)}) vs HODL ${fpp(hodlPct)}\n` +
      `Edge: ${fpp(edge)} | Today: ${buysToday.length}B ${sellsToday.length}S`
    );

    symbolRows.push({ symbol, pnlPct, hodlPct, edge, icon });
  }

  // ── Grand total ──────────────────────────────────────────────────────────
  if (symbolRows.length) {
    const grandPnl    = grandStratTotal - INITIAL_CAPITAL * symbolRows.length;
    const grandHodlPnl = grandHodlTotal - INITIAL_CAPITAL * symbolRows.length;
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  PORTFOLIO TOTAL`);
    console.log(`  Strategy : $${f2(grandStratTotal)}  (${fp(grandPnl)})`);
    console.log(`  HODL ref : $${f2(grandHodlTotal)}  (${fp(grandHodlPnl)})`);
    console.log(`  Net Edge : ${fp(grandPnl - grandHodlPnl)}`);
  }

  // ── Today's signal quality review ────────────────────────────────────────
  const regimesToday   = todaysTrades.filter(t => t.type === "regime");
  const tradesToday    = todaysTrades.filter(t => t.type !== "regime");
  const buysTodayAll   = tradesToday.filter(t => t.type.includes("buy"));
  const sellsTodayAll  = tradesToday.filter(t => t.type.includes("sell"));

  console.log(`\n── Today's Activity (since ${new Date(dayStart).toISOString().slice(11,16)} UTC) ──`);
  console.log(`  Regime flips   : ${regimesToday.length}`);
  console.log(`  Total signals  : ${tradesToday.length} (${buysTodayAll.length} buys, ${sellsTodayAll.length} sells)`);

  if (regimesToday.length > 3) {
    console.log(`  ⚠  ${regimesToday.length} regime flips today — EMA50/200 may be choppy`);
    console.log(`     Consider: cooldown between flips, or require cross to hold for N bars`);
  }

  const bosFired    = tradesToday.filter(t => t.type === "scaled_buy" || t.type === "scaled_sell");
  const chochFired  = tradesToday.filter(t => t.type === "final_buy"  || t.type === "final_sell");
  if (bosFired.length === 0 && chochFired.length > 0) {
    console.log(`  ⚠  All signals were CHOCH-only (no BOS scaling fired)`);
    console.log(`     Regime may be changing too fast to catch BOS first`);
  }

  // ── What to watch tomorrow ───────────────────────────────────────────────
  console.log(`\n── Tomorrow's Watchlist ──`);
  for (const symbol of SYMBOLS) {
    const s = loadState(symbol);
    if (!s || !s.initialized) continue;
    if (s.regime === "buy") {
      const scaleDone = s.bosCount;
      const scaleLeft = BOS_SCALE_PCT.length - scaleDone;
      console.log(`  ${symbol.padEnd(12)} BUY regime  — ${scaleDone} BOS done, ${scaleLeft} scale slots left + CHOCH final`);
    } else if (s.regime === "sell") {
      const scaleDone = s.bosCount;
      const scaleLeft = BOS_SCALE_PCT.length - scaleDone;
      console.log(`  ${symbol.padEnd(12)} SELL regime — ${scaleDone} BOS done, ${scaleLeft} scale slots left + CHOCH final`);
    } else {
      console.log(`  ${symbol.padEnd(12)} NEUTRAL     — waiting for 1h EMA50/200 cross`);
    }
  }

  // ── Save daily snapshot ───────────────────────────────────────────────────
  const snapshot = {
    date:     dateStr,
    symbols:  symbolRows,
    tradesToday: tradesToday.length,
    regimesToday: regimesToday.length,
    grandStratTotal,
    grandHodlTotal,
  };
  const snapFile = `craig-review-${dateStr}.json`;
  writeFileSync(snapFile, JSON.stringify(snapshot, null, 2));
  console.log(`\n  Snapshot saved → ${snapFile}`);

  // ── Telegram send ─────────────────────────────────────────────────────────
  telegramLines.push(
    `\n📋 Today: ${tradesToday.length} trades, ${regimesToday.length} regime flips\n` +
    `Portfolio: $${f2(grandStratTotal)} strategy vs $${f2(grandHodlTotal)} HODL`
  );
  if (regimesToday.length > 3) telegramLines.push(`⚠️ Choppy regime today (${regimesToday.length} flips)`);

  await sendTelegram(telegramLines.join("\n"));
  console.log("\n  Telegram report sent.\n");
}

const f2 = n => n.toFixed(2);
const f6 = n => n.toFixed(6);
const fp  = n => (n >= 0 ? "+" : "") + "$" + Math.abs(n).toFixed(2);
const fpp = n => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const BOS_SCALE_PCT = [8, 12, 18, 27];

main().catch(console.error);
