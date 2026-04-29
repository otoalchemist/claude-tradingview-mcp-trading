/**
 * Claude Trading Bot — E2 Swing Ensemble (6h candles)
 *
 * TWO-LEG ENSEMBLE STRATEGY
 * ─────────────────────────
 * Leg A — Donchian-GC Trend (70% of portfolio equity)
 *   Entry : last completed 6h close > 20-bar Donchian high + 0.5×ATR  ← ATR buffer filters fake breakouts
 *           AND EMA50 > EMA200 (golden cross)
 *           AND close > EMA50
 *   Exit  : last completed 6h close < 10-bar Donchian low
 *           OR live price ≥ entry + 5×ATR
 *
 * Leg B — Hybrid Mean-Reversion Contrarian (30% of portfolio equity)
 *   Entry : (EMA50 < EMA200 AND RSI14 ≤ 30)              ← death cross dip-buy
 *           OR (EMA50 > EMA200 AND close < EMA50 AND RSI14 ≤ 45)  ← GC pullback
 *   Exit  : live price ≥ entry + 5×ATR
 *
 * COMPOUNDING SIZING
 *   Trade size = 10% of leg's current equity (cash + open positions MTM).
 *   As the portfolio grows, each trade grows proportionally — automatic compounding.
 *   Max 10 concurrent positions per leg.
 *
 * PORTFOLIO STRUCTURE (portfolio.json)
 *   legs.A.cash  — cash available to Leg A
 *   legs.B.cash  — cash available to Leg B
 *   positions[sym].leg — which leg owns this position
 *   positions[sym].atrAtEntry — ATR stored at entry for TP calculation
 *
 * SCAN SCHEDULE
 *   Full scan (exits + entries): every 6 hours
 *   Quick live-price TP check:   every 1 hour  (catches intrabar TP hits)
 *   4-hour report:               independent timer, never tied to trade events
 *
 * Symbols: BTC, ETH, SOL, LINK, DOGE · 0.60% Coinbase taker fees
 */

import "dotenv/config";
import { isPaused, startCommandPolling } from "./telegram.js";
import { updatePortfolio, shouldSendReport, markReportSent, generateReport } from "./report.js";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";

// ─── Config ────────────────────────────────────────────────────────────────────

const CONFIG = {
  symbols: (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT,LINKUSDT,DOGEUSDT")
    .split(",").map(s => s.trim()),
  timeframe: "6H",
  paperTrading: process.env.PAPER_TRADING !== "false",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  // E2 parameters
  legASplit: 0.70,    // 70% to Donchian-GC trend leg
  legBSplit: 0.30,    // 30% to hybrid mean-rev leg
  sizingPct: 0.10,    // 10% of leg equity per trade
  maxConcurPerLeg: 10, // max open positions per leg
  tpAtrMult: 5,       // 5×ATR take-profit for both legs
  telegram: {
    token:  process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  coinbase: {
    apiKey:     process.env.COINBASE_API_KEY,
    privateKey: process.env.COINBASE_PRIVATE_KEY,
  },
};

const SCAN_INTERVAL_MS       = 6 * 60 * 60 * 1000;  // 6 hours — full scan
const QUICK_EXIT_INTERVAL_MS = 1 * 60 * 60 * 1000;  // 1 hour — TP-only quick check
const LOG_FILE = "safety-check-log.json";

// Minimum sellable qty per asset — anything below this is treated as unsellable dust.
// Values chosen so that Math.floor(dust * 1e6) / 1e6 > 0 (i.e. at least 0.000001 units).
const DUST = { BTC: 0.00001, ETH: 0.0001, SOL: 0.001, LINK: 0.01, DOGE: 1 };

// ─── Onboarding ────────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["COINBASE_API_KEY", "COINBASE_PRIVATE_KEY"];
  const missing  = required.filter(k => !process.env[k]);
  const isLocal  = !process.env.RAILWAY_ENVIRONMENT;

  if (isLocal && !existsSync(".env")) {
    writeFileSync(".env", [
      "# Coinbase Advanced Trade credentials",
      "COINBASE_API_KEY=",
      "COINBASE_PRIVATE_KEY=",
      "",
      "# Portfolio",
      "PORTFOLIO_VALUE_USD=1000",
      "PAPER_TRADING=true",
      "SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,LINKUSDT",
    ].join("\n") + "\n");
    console.log("Fill in your Coinbase credentials in .env then re-run.\n");
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials: ${missing.join(", ")}`);
    process.exit(1);
  }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(message) {
  const { token, chatId } = CONFIG.telegram;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
  } catch (err) {
    console.log(`⚠️  Telegram failed: ${err.message}`);
  }
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}
function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

// ─── Market Data ──────────────────────────────────────────────────────────────

const CB_GRANULARITY = {
  "6H": { gran: "SIX_HOUR",  secs: 21600 },
  "1D": { gran: "ONE_DAY",   secs: 86400 },
};
const CB_MAX_PER_PAGE = 350;

function toCoinbaseSymbol(symbol) {
  if (symbol.endsWith("USDT")) return symbol.slice(0, -4) + "-USD";
  if (symbol.endsWith("USD"))  return symbol.slice(0, -3) + "-USD";
  return symbol;
}

async function fetchCandles(symbol, interval, limit = 250) {
  const cbSymbol = toCoinbaseSymbol(symbol);
  const { gran, secs } = CB_GRANULARITY[interval] || CB_GRANULARITY["6H"];
  let allCandles = [], batchEnd = Math.floor(Date.now() / 1000);

  while (allCandles.length < limit) {
    const batchSize  = Math.min(CB_MAX_PER_PAGE, limit - allCandles.length);
    const batchStart = batchEnd - batchSize * secs;
    const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${cbSymbol}/candles`
      + `?start=${batchStart}&end=${batchEnd}&granularity=${gran}&limit=${batchSize}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Coinbase API ${res.status} for ${cbSymbol}`);
    const json = await res.json();
    if (!json.candles?.length) break;

    const batch = json.candles.slice().reverse().map(c => ({
      time:   parseInt(c.start) * 1000,
      open:   parseFloat(c.open),
      high:   parseFloat(c.high),
      low:    parseFloat(c.low),
      close:  parseFloat(c.close),
      volume: parseFloat(c.volume),
    }));
    allCandles = [...batch, ...allCandles];
    batchEnd   = batchStart;
    if (json.candles.length < batchSize) break;
    if (allCandles.length < limit) await new Promise(r => setTimeout(r, 150));
  }
  return allCandles.slice(-limit);
}

async function getCurrentPrice(symbol) {
  try {
    const cb  = toCoinbaseSymbol(symbol);
    const res = await fetch(
      `https://api.coinbase.com/api/v3/brokerage/market/products/${cb}`,
      { signal: AbortSignal.timeout(5000) }
    );
    const d = await res.json();
    return parseFloat(d.price || 0);
  } catch { return 0; }
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema  = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

// Donchian highest high of the `period` bars ending before the LAST bar.
// (Replicates backtest: entry bar's close vs previous period's Donchian high.)
function calcDonchianHigh(candles, period) {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-period - 1, -1);
  return Math.max(...slice.map(c => c.high));
}

// Donchian lowest low of the `period` bars ending before the LAST bar.
function calcDonchianLow(candles, period) {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-period - 1, -1);
  return Math.min(...slice.map(c => c.low));
}

// ─── Portfolio State ───────────────────────────────────────────────────────────
// Reads / writes portfolio.json.
// Structure:
//   legs.A.cash — cash available to Leg A (trend)
//   legs.B.cash — cash available to Leg B (mean-rev)
//   positions[sym] — { leg, quantity, avgCost, totalCost, atrAtEntry, entryTime }

function loadPortfolio() {
  const defaults = {
    startingCapital: CONFIG.portfolioValue,
    legs: {
      A: { cash: CONFIG.portfolioValue * CONFIG.legASplit },
      B: { cash: CONFIG.portfolioValue * CONFIG.legBSplit },
    },
    positions: {},
    lastExits: {},
    lastReportTime: 0,
    paused: false,
  };
  if (!existsSync("portfolio.json")) return defaults;
  try {
    const saved = JSON.parse(readFileSync("portfolio.json", "utf8"));
    // ─── Migration: old format used a flat `cash` key ──────────────────────
    if (saved.cash !== undefined && !saved.legs) {
      const totalCash = saved.cash || CONFIG.portfolioValue;
      saved.legs = {
        A: { cash: totalCash * CONFIG.legASplit },
        B: { cash: totalCash * CONFIG.legBSplit },
      };
      // Tag existing positions to Leg B (they were mean-rev entries)
      for (const sym of Object.keys(saved.positions || {})) {
        if (!saved.positions[sym].leg) saved.positions[sym].leg = "B";
        if (!saved.positions[sym].atrAtEntry) saved.positions[sym].atrAtEntry = 0;
      }
      delete saved.cash;
      writeFileSync("portfolio.json", JSON.stringify(saved, null, 2));
      console.log("  ✅ Migrated portfolio.json to E2 leg structure");
    }
    return { ...defaults, ...saved,
      legs: { A: { cash: 0 }, B: { cash: 0 }, ...saved.legs },
      positions: saved.positions || {},
      lastExits:  saved.lastExits  || {},
    };
  } catch { return defaults; }
}

function savePortfolio(state) {
  writeFileSync("portfolio.json", JSON.stringify(state, null, 2));
}

/** Current equity of a leg = leg cash + mark-to-market of its open positions. */
function getLegEquity(state, leg, livePrices = {}) {
  let equity = state.legs[leg]?.cash || 0;
  for (const [sym, pos] of Object.entries(state.positions)) {
    if (pos.leg !== leg) continue;
    const price = livePrices[sym] || pos.avgCost || 0;
    equity += pos.quantity * price;
  }
  return equity;
}

/** Count open positions for a leg. */
function legPositionCount(state, leg) {
  return Object.values(state.positions).filter(p => p.leg === leg).length;
}

// ─── Coinbase JWT & Order ─────────────────────────────────────────────────────

function buildCoinbaseJWT(method, path) {
  const apiKey     = CONFIG.coinbase.apiKey;
  const privateKey = CONFIG.coinbase.privateKey.replace(/\\n/g, "\n");
  const now   = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  const uri   = `${method} api.coinbase.com${path}`;

  const header  = Buffer.from(JSON.stringify({ alg: "ES256", kid: apiKey, nonce })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: apiKey, iss: "cdp", nbf: now, exp: now + 120, uri })).toString("base64url");
  const sigInput = `${header}.${payload}`;
  const keyObject = crypto.createPrivateKey(privateKey);
  const sig = crypto.sign("SHA256", Buffer.from(sigInput), {
    key: keyObject, dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${sigInput}.${sig}`;
}

async function placeCoinbaseOrder(symbol, side, sizeUSD, price, sellQuantity = null) {
  const productId = toCoinbaseSymbol(symbol);
  const cbSide    = side.toUpperCase();
  const path      = "/api/v3/brokerage/orders";
  const clientId  = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const orderConfig = cbSide === "BUY"
    ? { market_market_ioc: { quote_size: sizeUSD.toFixed(2) } }
    : { market_market_ioc: { base_size:  (sellQuantity ?? (sizeUSD / price)).toFixed(8) } };

  const body = JSON.stringify({
    client_order_id:     clientId,
    product_id:          productId,
    side:                cbSide,
    order_configuration: orderConfig,
  });

  const jwt = buildCoinbaseJWT("POST", path);
  const res = await fetch(`https://api.coinbase.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${jwt}` },
    body,
  });
  const data = await res.json();
  if (!data.success) {
    const reason = data.error_response?.message || data.preview_failure_reason || JSON.stringify(data);
    throw new Error(`Coinbase order failed: ${reason}`);
  }
  return { orderId: data.order_id || clientId };
}

/** Fetch live Coinbase balance for a coin (floors to 6dp for precision safety). */
async function getCBBalance(base) {
  try {
    const path    = "/api/v3/brokerage/accounts";
    const balData = await fetch(`https://api.coinbase.com${path}`, {
      headers: { Authorization: `Bearer ${buildCoinbaseJWT("GET", path)}` },
    }).then(r => r.json());
    const cbQty = (balData.accounts || [])
      .filter(a => a.currency === base)
      .reduce((max, a) => Math.max(max, parseFloat(a.available_balance?.value || 0)), 0);
    return Math.floor(cbQty * 1e6) / 1e6;
  } catch { return null; }
}

// ─── Tax CSV ──────────────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";
const CSV_HEADERS = "Date,Time (UTC),Exchange,Symbol,Leg,Side,Quantity,Price,Total USD,Fee (est.),Net Amount,Order ID,Mode,Notes";

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
    console.log(`📄 Created ${CSV_FILE}`);
  }
}

function writeTradeCsv(entry) {
  const now  = new Date(entry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const qty  = entry.sellQuantity
    ? entry.sellQuantity.toFixed(6)
    : (entry.tradeSize / entry.price).toFixed(6);
  const fee  = (entry.tradeSize * 0.006).toFixed(4);
  const net  = (entry.tradeSize - parseFloat(fee)).toFixed(2);
  const notes = entry.exitReason
    ? `Exit: ${entry.exitReason.replace(/_/g, " ")}${entry.pnlPct != null ? ` | P&L ${entry.pnlPct}%` : ""}`
    : (entry.orderPlaced ? "Entry — E2 strategy" : `Blocked: ${entry.blockedReason || "?"}`);
  const row = [
    date, time, "Coinbase", entry.symbol, entry.leg || "",
    (entry.side || "").toUpperCase(), qty, entry.price.toFixed(2),
    entry.tradeSize.toFixed(2), fee, net,
    entry.orderId || "", entry.paperTrading ? "PAPER" : "LIVE",
    `"${notes}"`,
  ].join(",");
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
}

// ─── Exit Monitor ─────────────────────────────────────────────────────────────
//
// Two exit checks per tick:
//   1. Live-price TP check: fires as soon as price crosses entry + 5×ATR (intrabar).
//   2. Candle-based Donchian check (Leg A only): fires when last completed 6h close
//      drops below the 10-bar Donchian low.
//
// Both checks attempt a full Coinbase execution; if paper-trading, they log only.

async function checkExits(fullScan = false) {
  const state = loadPortfolio();
  const positions = Object.entries(state.positions);
  if (positions.length === 0) return;

  console.log(`\n── Exit Monitor (${fullScan ? "full" : "quick TP"}) ─────────────────────────────\n`);

  for (const [symbol, pos] of positions) {
    const leg = pos.leg || "B";

    // ── Get indicators ─────────────────────────────────────────────────────
    const livePrice = await getCurrentPrice(symbol);
    if (!livePrice) { console.log(`  ⚠️  ${symbol}: price fetch failed`); continue; }

    const atrAtEntry = pos.atrAtEntry || 0;
    const tpPrice    = pos.avgCost + CONFIG.tpAtrMult * atrAtEntry;

    let exitReason = null;

    // 1. TP check (live price — intrabar)
    if (atrAtEntry > 0 && livePrice >= tpPrice) {
      exitReason = "tp_5atr";
    }

    // 2. Donchian-10 exit (Leg A only, requires completed candle)
    if (!exitReason && leg === "A" && fullScan) {
      try {
        const candles = await fetchCandles(symbol, "6H", 25);
        // Use completed candles only (exclude last, which may still be forming)
        const completed = candles.slice(0, -1);
        if (completed.length >= 12) {
          const don10Low  = calcDonchianLow(completed, 10);
          const lastClose = completed[completed.length - 1].close;
          if (don10Low !== null && lastClose < don10Low) {
            exitReason = "don10_low";
          }
        }
      } catch (err) { console.log(`  ⚠️  ${symbol}: candle fetch error — ${err.message}`); }
    }

    if (!exitReason) {
      const tpDist = atrAtEntry > 0 ? ((tpPrice - livePrice) / livePrice * 100).toFixed(1) : "N/A";
      console.log(`  ✅ ${symbol} [Leg ${leg}] holding | price $${livePrice.toFixed(2)} | TP $${tpPrice.toFixed(2)} (${tpDist}% away) | entry $${pos.avgCost.toFixed(2)}`);
      continue;
    }

    // ── Execute exit ───────────────────────────────────────────────────────
    let qty = pos.quantity;
    if (!CONFIG.paperTrading) {
      const base = symbol.replace("USDT","").replace(/USD$/,"");
      const cbQty = await getCBBalance(base);
      if (cbQty !== null && cbQty < qty) {
        console.log(`  ⚠️  Qty adjusted: ${qty.toFixed(6)} → ${cbQty.toFixed(6)} (Coinbase available)`);
        qty = cbQty;
      }
      // If CB balance is dust (unsellable), remove the ghost position and move on
      const dustThreshold = DUST[base] || 0.0001;
      if (qty < dustThreshold) {
        console.log(`  🧹 ${symbol}: balance ${qty} is below dust threshold (${dustThreshold}) — removing ghost position`);
        const state = loadPortfolio();
        delete state.positions[symbol];
        savePortfolio(state);
        continue;
      }
    }
    if (qty <= 0) { console.log(`  ⚠️  ${symbol}: zero balance, skipping exit`); continue; }

    const proceeds = qty * livePrice;
    const pnl      = proceeds - pos.totalCost;
    const pnlPct   = (pnl / pos.totalCost * 100).toFixed(2);
    const pnlStr   = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const exitLabel = exitReason.toUpperCase().replace(/_/g," ");

    console.log(`  🚪 EXIT — ${symbol} [Leg ${leg}] | ${exitLabel} | price $${livePrice.toFixed(2)} | P&L ${pnlStr} (${pnlPct}%)`);

    const exitEntry = {
      timestamp: new Date().toISOString(), symbol, side: "sell", leg,
      exitReason, price: livePrice, entryPrice: pos.avgCost,
      pnl, pnlPct, tradeSize: proceeds, sellQuantity: qty,
      allPass: true, orderPlaced: false, orderId: null,
      paperTrading: CONFIG.paperTrading,
    };

    const tgMsg =
      `🚪 <b>EXIT — ${symbol}</b>${CONFIG.paperTrading ? " <i>(paper)</i>" : ""}\n` +
      `Leg: ${leg === "A" ? "A — Trend" : "B — Mean-Rev"}\n` +
      `Reason: <b>${exitLabel}</b>\n` +
      `Price: $${livePrice.toFixed(2)}  |  Entry: $${pos.avgCost.toFixed(2)}\n` +
      `Qty: ${qty.toFixed(6)}  |  P&L: ${pnlStr} (${pnlPct}%)\n` +
      `🕐 ${new Date().toUTCString()}`;

    if (CONFIG.paperTrading) {
      exitEntry.orderPlaced = true;
      exitEntry.orderId     = `PAPER-EXIT-${Date.now()}`;
      updatePortfolio(symbol, "sell", livePrice, proceeds, qty, leg);
      await sendTelegram(tgMsg + `\nOrder: ${exitEntry.orderId}`);
    } else {
      try {
        const order = await placeCoinbaseOrder(symbol, "sell", proceeds, livePrice, qty);
        exitEntry.orderPlaced = true;
        exitEntry.orderId     = order.orderId;
        updatePortfolio(symbol, "sell", livePrice, proceeds, qty, leg);
        await sendTelegram(tgMsg + `\nOrder: ${order.orderId}`);
        console.log(`  ✅ Exit order placed: ${order.orderId}`);
      } catch (err) {
        console.log(`  ❌ Exit order failed: ${err.message}`);
        exitEntry.error = err.message;
        await sendTelegram(`❌ <b>EXIT FAILED — ${symbol}</b> (${exitLabel})\n${err.message}`);
      }
    }

    const log = loadLog();
    log.trades.push(exitEntry);
    saveLog(log);
    writeTradeCsv(exitEntry);
  }
}

// ─── Entry Scanner ─────────────────────────────────────────────────────────────
//
// Runs once per 6h scan. Evaluates each symbol for Leg A and Leg B entry conditions
// using the LAST COMPLETED 6h candle (candles[-2]) to avoid acting on a forming bar.
//
// COMPOUNDING: trade size = 50% of the leg's current total equity (cash + open positions
// at market value). This means each trade grows proportionally as the portfolio grows.

async function scanEntries() {
  console.log(`\n── Entry Scanner (6h candles · E2 Ensemble) ─────────────────\n`);

  if (isPaused()) {
    console.log("⏸ Bot is paused — skipping entry scan.");
    return;
  }

  const state = loadPortfolio();
  const livePrices = {};

  for (const symbol of CONFIG.symbols) {
    console.log(`\n  ${symbol} ─────────────────────────────────`);

    // ── Fetch candle data ────────────────────────────────────────────────
    let candles;
    try {
      candles = await fetchCandles(symbol, "6H", 250);
    } catch (err) {
      console.log(`  ⚠️  Data fetch failed: ${err.message}`);
      continue;
    }

    // Use only completed candles (exclude last which may still be forming)
    const completed = candles.slice(0, -1);
    if (completed.length < 210) {
      console.log(`  ⚠️  Not enough history (${completed.length} bars — need 210)`);
      continue;
    }

    const closes    = completed.map(c => c.close);
    const price     = closes[closes.length - 1];
    livePrices[symbol] = price;
    console.log(`  Price: $${price.toLocaleString()}`);

    const ema50  = calcEMA(closes, 50);
    const ema200 = calcEMA(closes, 200);
    const rsi14  = calcRSI(closes, 14);
    const atr14  = calcATR(completed, 14);
    const don20H = calcDonchianHigh(completed, 20);
    const don10L = calcDonchianLow(completed, 10);

    if (!ema50 || !ema200 || !atr14) {
      console.log(`  ⚠️  Indicators not ready`);
      continue;
    }

    const inGC = ema50 > ema200;
    // Robust formatter — won't crash if a non-numeric value slips through
    const fmt  = v => (v != null && typeof v === "number" && isFinite(v)) ? v.toFixed(2) : String(v ?? "N/A");
    const regimeLabel = inGC ? "✨ GOLDEN CROSS" : "☠️  DEATH CROSS";

    console.log(`  EMA50: $${fmt(ema50)}  EMA200: $${fmt(ema200)}  → ${regimeLabel}`);
    console.log(`  RSI14: ${rsi14?.toFixed(1) ?? "N/A"}  ATR14: $${fmt(atr14)}`);
    console.log(`  Don20-high: $${fmt(don20H)}  Don10-low: $${fmt(don10L)}`);

    const tpFromHere = (price + CONFIG.tpAtrMult * atr14).toFixed(2);
    console.log(`  TP from here: $${tpFromHere}  (+${((CONFIG.tpAtrMult * atr14) / price * 100).toFixed(1)}%)`);

    // ── Leg A: Donchian-GC Trend ─────────────────────────────────────────
    const alreadyInA = state.positions[symbol]?.leg === "A";
    const legAFull   = legPositionCount(state, "A") >= CONFIG.maxConcurPerLeg;
    const legAEntry  = !alreadyInA && !legAFull
      && inGC
      && don20H !== null && price > don20H + 0.5 * atr14  // ATR buffer: filters fake breakouts
      && price > ema50;

    if (legAEntry) {
      const legEquity  = getLegEquity(state, "A", livePrices);
      const tradeSize  = Math.min(legEquity * CONFIG.sizingPct, state.legs.A.cash);
      console.log(`\n  🟢 LEG A ENTRY — Donchian-20 breakout in GC`);
      console.log(`     Leg A equity: $${legEquity.toFixed(2)} → trade size: $${tradeSize.toFixed(2)} (50%)`);
      await placeEntry(symbol, "A", tradeSize, price, atr14, state, livePrices);
      // Reload state after entry
      Object.assign(state, loadPortfolio());
    } else {
      const atrThreshold = don20H !== null ? don20H + 0.5 * atr14 : null;
      const legABlockReason = alreadyInA ? "already in position" : legAFull ? "leg A full (10/10)" : !inGC ? "not in golden cross" : don20H === null || price <= don20H ? `price ${price.toFixed(0)} ≤ don20H ${don20H?.toFixed(0)}` : atrThreshold !== null && price <= atrThreshold ? `price ${price.toFixed(0)} ≤ don20H+0.5ATR ${atrThreshold?.toFixed(0)}` : "price ≤ EMA50";
      console.log(`  ⏸ Leg A: skip (${legABlockReason})`);
    }

    // ── Leg B: Hybrid Mean-Reversion ─────────────────────────────────────
    const alreadyInB = state.positions[symbol]?.leg === "B";
    const legBFull   = legPositionCount(state, "B") >= CONFIG.maxConcurPerLeg;
    let legBEntry = false;
    let legBReason = "";

    if (!alreadyInB && !legBFull && rsi14 !== null) {
      if (!inGC && rsi14 <= 30) {
        legBEntry  = true;
        legBReason = `death cross + RSI ${rsi14.toFixed(1)} ≤ 30`;
      } else if (inGC && price < ema50 && rsi14 <= 45) {
        legBEntry  = true;
        legBReason = `GC pullback + RSI ${rsi14.toFixed(1)} ≤ 45`;
      }
    }

    if (legBEntry) {
      const legEquity  = getLegEquity(state, "B", livePrices);
      const tradeSize  = Math.min(legEquity * CONFIG.sizingPct, state.legs.B.cash);
      console.log(`\n  🟡 LEG B ENTRY — ${legBReason}`);
      console.log(`     Leg B equity: $${legEquity.toFixed(2)} → trade size: $${tradeSize.toFixed(2)} (50%)`);
      await placeEntry(symbol, "B", tradeSize, price, atr14, state, livePrices);
      Object.assign(state, loadPortfolio());
    } else {
      const legBBlockReason = alreadyInB ? "already in position" : legBFull ? "leg B full (2/2)" : rsi14 === null ? "RSI not ready" : `RSI ${rsi14.toFixed(1)} — no signal`;
      console.log(`  ⏸ Leg B: skip (${legBBlockReason})`);
    }

    await new Promise(r => setTimeout(r, 300)); // polite rate limiting between symbols
  }

  // Portfolio summary after scan
  const totA  = getLegEquity(state, "A", livePrices);
  const totB  = getLegEquity(state, "B", livePrices);
  const total = totA + totB;
  const sc    = state.startingCapital || CONFIG.portfolioValue;
  const net   = total - sc;
  const pct   = (net / sc * 100).toFixed(1);

  console.log(`\n── Portfolio Summary ────────────────────────────────────────`);
  console.log(`  Leg A equity: $${totA.toFixed(2)} (cash $${(state.legs.A?.cash || 0).toFixed(2)})`);
  console.log(`  Leg B equity: $${totB.toFixed(2)} (cash $${(state.legs.B?.cash || 0).toFixed(2)})`);
  console.log(`  Total:        $${total.toFixed(2)}  |  Net: ${net >= 0 ? "+" : ""}$${net.toFixed(2)} (${net >= 0 ? "+" : ""}${pct}%)`);
  console.log(`  Open positions: ${Object.keys(state.positions).length}`);
}

// ─── Place Entry ───────────────────────────────────────────────────────────────

async function placeEntry(symbol, leg, tradeSize, price, atr14, state, livePrices) {
  if (tradeSize < 5) {
    console.log(`     ⚠️  Trade size $${tradeSize.toFixed(2)} too small — skipping`);
    return;
  }

  const tpTarget = (price + CONFIG.tpAtrMult * atr14).toFixed(2);
  const legLabel = leg === "A" ? "Trend (Donchian-GC)" : "Mean-Rev (Hybrid)";

  const logEntry = {
    timestamp: new Date().toISOString(), symbol, side: "buy", leg,
    price, tradeSize, atr14, tpTarget,
    allPass: true, orderPlaced: false, orderId: null,
    paperTrading: CONFIG.paperTrading,
  };

  const tgMsg =
    `🟢 <b>BUY ${symbol}</b>${CONFIG.paperTrading ? " <i>(paper)</i>" : ""}\n` +
    `Leg: ${leg} — ${legLabel}\n` +
    `Size: $${tradeSize.toFixed(2)}  |  Price: $${price.toLocaleString()}\n` +
    `ATR: $${atr14.toFixed(2)}  |  TP target: $${tpTarget}\n` +
    `Leg equity: $${getLegEquity(state, leg, livePrices).toFixed(2)}\n` +
    `🕐 ${new Date().toUTCString()}`;

  if (CONFIG.paperTrading) {
    logEntry.orderPlaced = true;
    logEntry.orderId     = `PAPER-${Date.now()}`;
    updatePortfolio(symbol, "buy", price, tradeSize, null, leg, atr14);
    await sendTelegram(tgMsg + `\nOrder: ${logEntry.orderId}`);
    console.log(`     ✅ PAPER BUY — $${tradeSize.toFixed(2)} @ $${price.toLocaleString()} | TP $${tpTarget}`);
  } else {
    try {
      const order = await placeCoinbaseOrder(symbol, "buy", tradeSize, price, null);
      logEntry.orderPlaced = true;
      logEntry.orderId     = order.orderId;
      updatePortfolio(symbol, "buy", price, tradeSize, null, leg, atr14);
      await sendTelegram(tgMsg + `\nOrder: ${order.orderId}`);
      console.log(`     ✅ LIVE BUY — ${order.orderId} | $${tradeSize.toFixed(2)} @ $${price.toLocaleString()}`);
    } catch (err) {
      console.log(`     ❌ BUY FAILED — ${err.message}`);
      logEntry.error = err.message;
      await sendTelegram(`❌ <b>BUY FAILED — ${symbol}</b> [Leg ${leg}]\n${err.message}`);
    }
  }

  const log = loadLog();
  log.trades.push(logEntry);
  saveLog(log);
  writeTradeCsv(logEntry);
}

// ─── Portfolio Reconciliation ──────────────────────────────────────────────────
// Runs on live startup. Syncs portfolio.json with actual Coinbase balances.

async function reconcilePortfolioWithCoinbase() {
  if (CONFIG.paperTrading) return;
  console.log("\n🔄 Reconciling portfolio.json with Coinbase...");

  try {
    // Use limit=250 — without it the fiat USD account is omitted from the response
    const basePath = "/api/v3/brokerage/accounts";
    const res  = await fetch(`https://api.coinbase.com${basePath}?limit=250`, {
      headers: { Authorization: `Bearer ${buildCoinbaseJWT("GET", basePath)}` },
    });
    if (!res.ok) { console.log("  ⚠️  Coinbase accounts fetch failed"); return; }
    const accounts = (await res.json()).accounts || [];

    // Total USD/USDC balance
    const usdBal = accounts
      .filter(a => a.currency === "USDC" || a.currency === "USD")
      .reduce((sum, a) => sum + parseFloat(a.available_balance?.value || 0), 0);

    // Load and migrate state
    const state = loadPortfolio();

    for (const symbol of CONFIG.symbols) {
      const base    = symbol.replace("USDT","").replace(/USD$/,"");
      const cbQty   = accounts
        .filter(a => a.currency === base)
        .reduce((max, a) => Math.max(max, parseFloat(a.available_balance?.value || 0)), 0);
      const dust    = DUST[base] || 0.0001;
      const heldCB  = cbQty > dust;
      const heldFile = !!state.positions[symbol];

      if (heldCB && !heldFile) {
        let currentPrice = 0;
        try {
          const pd = await (await fetch(
            `https://api.coinbase.com/api/v3/brokerage/market/products/${toCoinbaseSymbol(symbol)}`
          )).json();
          currentPrice = parseFloat(pd.price || 0);
        } catch {}
        const candles = await fetchCandles(symbol, "6H", 20).catch(() => []);
        const atr = candles.length > 15 ? calcATR(candles, 14) || 0 : 0;
        state.positions[symbol] = {
          leg: "B", quantity: cbQty, avgCost: currentPrice,
          totalCost: cbQty * currentPrice, atrAtEntry: atr, entryTime: Date.now(),
        };
        console.log(`  ✅ Restored: ${symbol} ${cbQty.toFixed(6)} @ $${currentPrice.toFixed(2)}`);
      } else if (!heldCB && heldFile) {
        delete state.positions[symbol];
        console.log(`  🗑️  Removed ghost: ${symbol}`);
      } else if (heldCB && heldFile) {
        const tracked = state.positions[symbol].quantity;
        if (Math.abs(tracked - cbQty) / cbQty > 0.01) {
          state.positions[symbol].quantity  = cbQty;
          state.positions[symbol].totalCost = cbQty * state.positions[symbol].avgCost;
          console.log(`  🔧 Drift fixed: ${symbol} ${tracked.toFixed(6)} → ${cbQty.toFixed(6)}`);
        } else {
          console.log(`  ✅ ${symbol}: in sync (${cbQty.toFixed(6)} held)`);
        }
      }
    }

    // Redistribute USD balance across legs proportionally
    const legAPositionValue = Object.values(state.positions)
      .filter(p => p.leg === "A")
      .reduce((s, p) => s + p.totalCost, 0);
    const legBPositionValue = Object.values(state.positions)
      .filter(p => p.leg === "B")
      .reduce((s, p) => s + p.totalCost, 0);

    state.legs.A.cash = Math.max(0, usdBal * CONFIG.legASplit - legAPositionValue);
    state.legs.B.cash = Math.max(0, usdBal * CONFIG.legBSplit - legBPositionValue);
    // Any remainder goes to Leg A
    const remainder = usdBal - state.legs.A.cash - state.legs.B.cash - legAPositionValue - legBPositionValue;
    if (remainder > 0) state.legs.A.cash += remainder;

    console.log(`  💵 USD balance: $${usdBal.toFixed(2)}`);
    console.log(`  📊 Leg A cash: $${state.legs.A.cash.toFixed(2)}  |  Leg B cash: $${state.legs.B.cash.toFixed(2)}`);

    savePortfolio(state);
    console.log("  ✅ Reconcile complete\n");
  } catch (err) {
    console.log(`  ⚠️  Reconcile error: ${err.message}\n`);
  }
}

// ─── Tax Summary ──────────────────────────────────────────────────────────────

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) { console.log("No trades.csv found."); return; }
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows  = lines.slice(1).map(l => l.split(","));
  const live  = rows.filter(r => r[12] === "LIVE");
  const paper = rows.filter(r => r[12] === "PAPER");
  const vol   = live.reduce((s, r) => s + parseFloat(r[8] || 0), 0);
  const fees  = live.reduce((s, r) => s + parseFloat(r[9] || 0), 0);
  console.log(`\n── Tax Summary ──────────────────────\n`);
  console.log(`  Live trades : ${live.length}`);
  console.log(`  Paper trades: ${paper.length}`);
  console.log(`  Volume (USD): $${vol.toFixed(2)}`);
  console.log(`  Fees (est.) : $${fees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}\n`);
}

// ─── Trading Loop ─────────────────────────────────────────────────────────────

async function startTradingLoop() {
  console.log("⏰ E2 Swing Bot started");
  console.log(`   Full scan (exits + entries): every 6h`);
  console.log(`   Quick TP exit check:         every 1h`);

  await reconcilePortfolioWithCoinbase();

  // Quick TP exit check — every 1 hour
  setInterval(async () => {
    try {
      console.log(`\n${"═".repeat(56)}`);
      console.log(`  E2 Bot — Quick Exit Check`);
      console.log(`  ${new Date().toISOString()}`);
      console.log(`${"═".repeat(56)}`);
      await checkExits(false); // live-price TP only
      // Stamp last scan time for /status
      const s = loadPortfolio();
      s.lastScanTime = new Date().toISOString();
      savePortfolio(s);
    } catch (err) { console.error("Quick exit check error:", err.message); }
  }, QUICK_EXIT_INTERVAL_MS);

  // Full scan — every 6 hours
  const tick = async () => {
    try {
      console.log(`\n${"═".repeat(56)}`);
      console.log(`  E2 Swing Bot — Full Scan`);
      console.log(`  ${new Date().toISOString()}`);
      console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"}`);
      console.log(`${"═".repeat(56)}`);

      await checkExits(true);  // full exits including Donchian
      await scanEntries();

      // Stamp last scan time so /status shows a real time even when no trades fire
      const scanState = loadPortfolio();
      scanState.lastScanTime = new Date().toISOString();
      savePortfolio(scanState);
    } catch (err) { console.error("Scan error:", err.message); }
    setTimeout(tick, SCAN_INTERVAL_MS);
  };

  // 4-hour report — independent timer, never tied to trade events
  const reportTick = async () => {
    try {
      if (shouldSendReport()) {
        const log    = loadLog();
        const report = await generateReport(log);
        await sendTelegram(report);
        markReportSent();
        console.log("\n  ✅ Report sent");
      }
    } catch (err) { console.error("Report error:", err.message); }
    setTimeout(reportTick, 60 * 60 * 1000); // check every hour, fires when 4h elapsed
  };

  await tick();
  setTimeout(reportTick, 60 * 60 * 1000); // first report check in 1 hour
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

checkOnboarding();
initCsv();

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  Promise.all([startTradingLoop(), startCommandPolling()]).catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
