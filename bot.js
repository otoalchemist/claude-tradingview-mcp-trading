/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { isPaused, updatePortfolio, shouldSendReport, markReportSent, generateReport, checkTelegramCommands } from "./report.js";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["COINBASE_API_KEY", "COINBASE_PRIVATE_KEY"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# Coinbase Advanced Trade credentials",
        "COINBASE_API_KEY=",
        "COINBASE_PRIVATE_KEY=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your Coinbase Advanced Trade credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbols: process.env.SYMBOLS
    ? process.env.SYMBOLS.split(",").map((s) => s.trim())
    : [process.env.SYMBOL || "BTCUSDT"],
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "5m",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  coinbase: {
    apiKey:     process.env.COINBASE_API_KEY,
    privateKey: process.env.COINBASE_PRIVATE_KEY,
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Telegram Notifications ──────────────────────────────────────────────────

async function sendTelegram(message) {
  const { token, chatId } = CONFIG.telegram;
  if (!token || !chatId) return; // silently skip if not configured
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
  } catch (err) {
    console.log(`⚠️  Telegram notification failed: ${err.message}`);
  }
}

function buildTradeMessage(symbol, side, price, tradeSize, orderId, paperTrading, strength, signalScores) {
  const emoji = side === "buy" ? "🟢" : "🔴";
  const modeTag = paperTrading ? " <i>(paper)</i>" : "";
  const pct = strength !== undefined ? Math.round(strength * 100) : null;
  const bar = pct !== null
    ? "█".repeat(Math.round(strength * 10)) + "░".repeat(10 - Math.round(strength * 10))
    : null;
  const scoreLines = signalScores && signalScores.length
    ? "\n" + signalScores.map(s => `  • ${s.name}: ${Math.round(s.score * 100)}%`).join("\n")
    : "";
  return (
    `${emoji} <b>${side.toUpperCase()} ${symbol}</b>${modeTag}\n` +
    `💰 Size: $${tradeSize.toFixed(2)}\n` +
    `📈 Price: $${price.toLocaleString()}\n` +
    (pct !== null ? `⚡ Signal: ${pct}%  [${bar}]${scoreLines}\n` : "") +
    `🔑 Order: ${orderId}\n` +
    `🕐 ${new Date().toUTCString()}`
  );
}

function buildBlockedMessage(symbol, price, failedConditions) {
  return (
    `⏸ <b>BLOCKED ${symbol}</b>\n` +
    `📈 Price: $${price.toLocaleString()}\n` +
    `❌ Failed:\n${failedConditions.map(c => `  • ${c}`).join("\n")}\n` +
    `🕐 ${new Date().toUTCString()}`
  );
}

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data ─────────────────────────────────────────────────────────────
// All symbols fetched from Coinbase Advanced Trade public API (no auth needed).
// Symbol format: BTCUSDT → BTC-USD  (covers BTC, ETH, SOL, AKT and most others)

const CB_GRANULARITY = {
  "1m":  { gran: "ONE_MINUTE",    secs: 60    },
  "5m":  { gran: "FIVE_MINUTE",   secs: 300   },
  "15m": { gran: "FIFTEEN_MINUTE",secs: 900   },
  "30m": { gran: "THIRTY_MINUTE", secs: 1800  },
  "1H":  { gran: "ONE_HOUR",      secs: 3600  },
  "1h":  { gran: "ONE_HOUR",      secs: 3600  },
  "2H":  { gran: "TWO_HOUR",      secs: 7200  },
  "4H":  { gran: "ONE_HOUR",      secs: 3600  }, // no 4H on Coinbase → use 1H
  "4h":  { gran: "ONE_HOUR",      secs: 3600  },
  "6H":  { gran: "SIX_HOUR",      secs: 21600 },
  "1D":  { gran: "ONE_DAY",       secs: 86400 },
  "1d":  { gran: "ONE_DAY",       secs: 86400 },
};

const CB_MAX_PER_PAGE = 350;

// Convert bot symbol format (BTCUSDT) → Coinbase product id (BTC-USD)
function toCoinbaseSymbol(symbol) {
  if (symbol.endsWith("USDT")) return symbol.slice(0, -4) + "-USD";
  if (symbol.endsWith("USD"))  return symbol.slice(0, -3) + "-USD";
  return symbol;
}

async function fetchCandles(symbol, interval, limit = 350) {
  const cbSymbol = toCoinbaseSymbol(symbol);
  const { gran, secs } = CB_GRANULARITY[interval] || CB_GRANULARITY["1H"];

  let allCandles = [];
  let batchEnd   = Math.floor(Date.now() / 1000);

  while (allCandles.length < limit) {
    const batchSize  = Math.min(CB_MAX_PER_PAGE, limit - allCandles.length);
    const batchStart = batchEnd - batchSize * secs;

    const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${cbSymbol}/candles` +
      `?start=${batchStart}&end=${batchEnd}&granularity=${gran}&limit=${batchSize}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Coinbase API ${res.status} for ${cbSymbol}`);
    const json = await res.json();
    if (!json.candles || json.candles.length === 0) break;

    // Coinbase returns newest-first — reverse to chronological
    const batch = json.candles.slice().reverse().map((c) => ({
      time:   parseInt(c.start) * 1000,
      open:   parseFloat(c.open),
      high:   parseFloat(c.high),
      low:    parseFloat(c.low),
      close:  parseFloat(c.close),
      volume: parseFloat(c.volume),
    }));

    allCandles = [...batch, ...allCandles];
    batchEnd   = batchStart;

    if (json.candles.length < batchSize) break; // exchange ran out of history
    if (allCandles.length < limit) await new Promise(r => setTimeout(r, 150)); // rate limit
  }

  return allCandles.slice(-limit);
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcBollingerBands(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: sma + mult * std, middle: sma, lower: sma - mult * std };
}

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3) {
  const needed = rsiPeriod + stochPeriod + kSmooth + 1;
  if (closes.length < needed) return null;
  // Build RSI series
  const rsiSeries = [];
  for (let i = rsiPeriod; i <= closes.length; i++) {
    const sl = closes.slice(i - rsiPeriod - 1, i);
    let g = 0, l = 0;
    for (let j = 1; j < sl.length; j++) {
      const d = sl[j] - sl[j - 1];
      if (d > 0) g += d; else l -= d;
    }
    const ag = g / rsiPeriod, al = l / rsiPeriod;
    rsiSeries.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  // Stochastic of RSI
  const stochSeries = [];
  for (let i = stochPeriod; i <= rsiSeries.length; i++) {
    const sl = rsiSeries.slice(i - stochPeriod, i);
    const hi = Math.max(...sl), lo = Math.min(...sl);
    stochSeries.push(hi === lo ? 50 : (rsiSeries[i - 1] - lo) / (hi - lo) * 100);
  }
  if (stochSeries.length < kSmooth) return null;
  // K = smoothed stoch
  return stochSeries.slice(-kSmooth).reduce((a, b) => a + b, 0) / kSmooth;
}

function calcVolumeSpikeRatio(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const avgVol = candles.slice(-period - 1, -1).reduce((s, c) => s + c.volume, 0) / period;
  const lastVol = candles[candles.length - 1].volume;
  return avgVol === 0 ? null : lastVol / avgVol;
}

// ATR(14) — Average True Range for dynamic stop sizing
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

// VWAP with ±1 and ±2 standard deviation bands (institutional exhaustion levels)
// Resets at midnight UTC (or last available candle when session is short)
function calcVWAPBands(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  let sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  // Fall back to last 50 candles if session is empty or very short
  if (sessionCandles.length < 5) sessionCandles = candles.slice(-50);
  if (sessionCandles.length === 0) return null;

  const tps  = sessionCandles.map((c) => (c.high + c.low + c.close) / 3);
  const vols = sessionCandles.map((c) => c.volume);
  const cumVol = vols.reduce((a, b) => a + b, 0);
  if (cumVol === 0) return null;

  const vwap = tps.reduce((s, tp, i) => s + tp * vols[i], 0) / cumVol;
  const variance = tps.reduce((s, tp) => s + Math.pow(tp - vwap, 2), 0) / tps.length;
  const std = Math.sqrt(variance);

  return {
    vwap,
    upper1: vwap + std,     upper2: vwap + 2 * std,
    lower1: vwap - std,     lower2: vwap - 2 * std,
  };
}

// Legacy single-value VWAP for backward compatibility
function calcVWAP(candles) {
  const bands = calcVWAPBands(candles);
  return bands ? bands.vwap : null;
}

// ─── Daily Regime ─────────────────────────────────────────────────────────────
// Fetches daily candles to get a clean MA50/MA200 cross free of 5m noise.
// Professional standard: use the daily chart for regime, 5m for entry timing.

async function fetchDailyRegime(symbol) {
  try {
    const candles = await fetchCandles(symbol, "1D", 210);
    const closes  = candles.map((c) => c.close);
    return {
      ma50d:  calcSMA(closes, 50),
      ma200d: calcSMA(closes, 200),
    };
  } catch (err) {
    console.log(`⚠️  Daily regime fetch failed for ${symbol}: ${err.message}`);
    return { ma50d: null, ma200d: null };
  }
}

// ─── Signal Strength Scoring ─────────────────────────────────────────────────
// Scores 0.0 → 1.0 based on how extreme each indicator reading is.
// Trade size scales from 20% → 100% of MAX_TRADE_SIZE_USD.
//
// Professional approach: volume is a BOOSTER not a gate.
// High volume on oversold = stronger signal. Low volume = weaker but still valid.
// Thresholds tuned for 5m crypto: RSI(7) 25/75, StochRSI 10/90.

function calcSignalStrength(price, bias, { rsi7, bb, stochRsi, volumeRatio, ma50d, ma200d, vwapBands }) {
  const scores = [];
  const clamp  = (v) => Math.max(0, Math.min(1, v));

  if (bias === "bullish") {
    // RSI(7): deeper below 25 → stronger (25→0 maps to 0→1)
    if (rsi7 !== null)
      scores.push({ name: "RSI(7)", score: clamp((25 - rsi7) / 25) });

    // BB: how far below lower band (0%→2% below = 0→1)
    if (bb)
      scores.push({ name: "BB", score: clamp((bb.lower - price) / (bb.lower * 0.02)) });

    // StochRSI: below 10 = deeply oversold (10→0 maps to 0→1)
    if (stochRsi !== null)
      scores.push({ name: "StochRSI", score: clamp((10 - stochRsi) / 10) });

    // Volume: high volume on oversold = confirmation (1.5x→4x = 0→1)
    // Low volume still scores 0 — doesn't block, just doesn't boost
    if (volumeRatio !== null && volumeRatio >= 1.0)
      scores.push({ name: "Volume", score: clamp((volumeRatio - 1.0) / 3.0) });

    // Daily regime separation (death cross depth — 0%→2% = 0→1)
    if (ma50d && ma200d && ma50d < ma200d)
      scores.push({ name: "Daily Regime", score: clamp((ma200d - ma50d) / ma200d / 0.02) });

    // VWAP lower band: price at/below lower2 = statistically extended
    if (vwapBands && price <= vwapBands.lower2)
      scores.push({ name: "VWAP Band", score: clamp((vwapBands.lower2 - price) / (vwapBands.lower2 * 0.01)) });

  } else if (bias === "bearish") {
    // RSI(7): above 75, deeper = stronger (75→100 maps to 0→1)
    if (rsi7 !== null)
      scores.push({ name: "RSI(7)", score: clamp((rsi7 - 75) / 25) });

    // BB: how far above upper band
    if (bb)
      scores.push({ name: "BB", score: clamp((price - bb.upper) / (bb.upper * 0.02)) });

    // StochRSI: above 90 = deeply overbought (90→100 maps to 0→1)
    if (stochRsi !== null)
      scores.push({ name: "StochRSI", score: clamp((stochRsi - 90) / 10) });

    // Volume booster
    if (volumeRatio !== null && volumeRatio >= 1.0)
      scores.push({ name: "Volume", score: clamp((volumeRatio - 1.0) / 3.0) });

    // Daily regime separation (golden cross depth)
    if (ma50d && ma200d && ma50d > ma200d)
      scores.push({ name: "Daily Regime", score: clamp((ma50d - ma200d) / ma200d / 0.02) });

    // VWAP upper band: price at/above upper2
    if (vwapBands && price >= vwapBands.upper2)
      scores.push({ name: "VWAP Band", score: clamp((price - vwapBands.upper2) / (vwapBands.upper2 * 0.01)) });
  }

  if (scores.length === 0) return { strength: 0, scores: [] };
  const strength = scores.reduce((s, x) => s + x.score, 0) / scores.length;
  return { strength, scores };
}

function calcTradeSize(strength, maxTradeSizeUSD, portfolioValue) {
  // Minimum size: 20% of max. Maximum: 100% of max. Scales with signal strength.
  const min = maxTradeSizeUSD * 0.20;
  const max = Math.min(maxTradeSizeUSD, portfolioValue * 0.05);
  return Math.round((min + (max - min) * strength) * 100) / 100;
}

// ─── Contrarian Entry Check ──────────────────────────────────────────────────
// 2 hard-gate conditions tuned for 5m crypto (research-backed thresholds):
//   • RSI(7) < 25 / > 75  — faster than RSI(14), catches exhaustion sooner
//   • StochRSI < 10 / > 90 — deeply extreme timing filter
//
// BB(20,2) is NOT a hard gate — it's a signal strength booster only.
// Price AT/BEYOND the band increases position size but never blocks a trade.
// High volume confirms, low volume just reduces position size.
// Regime gating (5m MA50/MA200) happens before this is called.

function runContrarianCheck(price, bias, { rsi7, stochRsi }) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Entry Conditions ─────────────────────────────────────\n");

  if (bias === "bullish") {
    check(
      "RSI(7) oversold",
      "≤ 25",
      rsi7 !== null ? rsi7.toFixed(2) : "N/A",
      rsi7 !== null && rsi7 <= 25,
    );
    check(
      "StochRSI deeply oversold",
      "≤ 10",
      stochRsi !== null ? stochRsi.toFixed(2) : "N/A",
      stochRsi !== null && stochRsi <= 10,
    );
  } else {
    check(
      "RSI(7) overbought",
      "≥ 75",
      rsi7 !== null ? rsi7.toFixed(2) : "N/A",
      rsi7 !== null && rsi7 >= 75,
    );
    check(
      "StochRSI deeply overbought",
      "≥ 90",
      stochRsi !== null ? stochRsi.toFixed(2) : "N/A",
      stochRsi !== null && stochRsi >= 90,
    );
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// Read current open position for a symbol from portfolio.json
function getPosition(symbol) {
  if (!existsSync("portfolio.json")) return null;
  try {
    const state = JSON.parse(readFileSync("portfolio.json", "utf8"));
    return state.positions?.[symbol] || null;
  } catch { return null; }
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── Coinbase Advanced Trade Execution ───────────────────────────────────────
// Auth: JWT signed with EC private key (ES256).
// Docs: https://docs.cdp.coinbase.com/advanced-trade/docs/rest-api-auth

function buildCoinbaseJWT(method, path) {
  const apiKey     = CONFIG.coinbase.apiKey;
  const privateKey = CONFIG.coinbase.privateKey.replace(/\\n/g, "\n");

  const now    = Math.floor(Date.now() / 1000);
  const nonce  = crypto.randomBytes(16).toString("hex");
  const uri    = `${method} api.coinbase.com${path}`;

  const header  = Buffer.from(JSON.stringify({ alg: "ES256", kid: apiKey, nonce })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: apiKey, iss: "cdp", nbf: now, exp: now + 120, uri,
  })).toString("base64url");

  const sigInput = `${header}.${payload}`;

  // ES256: ECDSA P-256 + SHA-256. dsaEncoding:'ieee-p1363' gives raw R||S (JWT format).
  const sig = crypto.sign("SHA256", Buffer.from(sigInput), {
    key: privateKey, format: "pem", type: "sec1", dsaEncoding: "ieee-p1363",
  }).toString("base64url");

  return `${sigInput}.${sig}`;
}

async function placeCoinbaseOrder(symbol, side, sizeUSD, price) {
  const productId = toCoinbaseSymbol(symbol);  // BTCUSDT → BTC-USD
  const cbSide    = side.toUpperCase();          // "buy" → "BUY"
  const path      = "/api/v3/brokerage/orders";
  const clientId  = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // BUY: specify quote_size (USD to spend). SELL: specify base_size (crypto to sell).
  const orderConfig = cbSide === "BUY"
    ? { market_market_ioc: { quote_size: sizeUSD.toFixed(2) } }
    : { market_market_ioc: { base_size:  (sizeUSD / price).toFixed(8) } };

  const body = JSON.stringify({
    client_order_id:     clientId,
    product_id:          productId,
    side:                cbSide,
    order_configuration: orderConfig,
  });

  const jwt = buildCoinbaseJWT("POST", path);

  const res = await fetch(`https://api.coinbase.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${jwt}`,
    },
    body,
  });

  const data = await res.json();

  if (!data.success) {
    const reason = data.error_response?.message || data.preview_failure_reason || JSON.stringify(data);
    throw new Error(`Coinbase order failed: ${reason}`);
  }

  return { orderId: data.order_id || clientId };
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "Coinbase",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();

  // Load log early so command handler + report can use it
  const log = loadLog();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbols: ${CONFIG.symbols.join(", ")} | Timeframe: ${CONFIG.timeframe}`);

  // Check Telegram commands (responds to /status, /portfolio, /prices, etc.)
  await checkTelegramCommands(log);

  // Check if bot is paused via /pause command
  if (isPaused()) {
    console.log('\n⏸ Bot is paused. Send /resume to Telegram to restart.\n');
    return;
  }

  // Check daily limits
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Loop through each symbol
  for (const symbol of CONFIG.symbols) {
    console.log(`\n${"─".repeat(59)}`);
    console.log(`  ${symbol}`);
    console.log(`${"─".repeat(59)}\n`);

    // Fetch candle data
    console.log(`── Fetching market data from Coinbase ───────────────────\n`);
    let candles;
    try {
      candles = await fetchCandles(symbol, CONFIG.timeframe, 500);
    } catch (err) {
      console.log(`⚠️  Failed to fetch data for ${symbol}: ${err.message}`);
      continue;
    }

    const closes = candles.map((c) => c.close);
    const price = closes[closes.length - 1];
    console.log(`  Current price: $${price.toLocaleString()}`);

    // ── All indicators from 5m candles (regime + entry signals on same chart) ──
    const ma50        = calcSMA(closes, 50);           // 50 × 5m = ~4.2 hrs
    const ma200       = calcSMA(closes, 200);          // 200 × 5m = ~16.7 hrs
    const rsi7        = calcRSI(closes, 7);
    const bb          = calcBollingerBands(closes, 20, 2);
    const stochRsi    = calcStochRSI(closes, 14, 14, 3);
    const volumeRatio = calcVolumeSpikeRatio(candles, 20);
    const atr14       = calcATR(candles, 14);
    const vwapBands   = calcVWAPBands(candles);
    const ema8        = calcEMA(closes, 8);            // reference only
    const rsi3        = calcRSI(closes, 3);            // reference only

    // Guard: need 200 candles for MA200
    if (!ma50 || !ma200) {
      console.log(`\n⚠️  Not enough 5m candle history for MA200 on ${symbol}. Skipping.`);
      continue;
    }

    const fmt = (v, digits = 2) => v !== null && v !== undefined ? v.toFixed(digits) : "N/A";
    console.log(`\n  ── 5m Indicators (5-day view) ──────────────────────`);
    console.log(`  MA50:       $${fmt(ma50)}  |  MA200: $${fmt(ma200)}`);
    console.log(`  RSI(7):     ${fmt(rsi7)}   ${rsi7 !== null ? (rsi7 <= 25 ? "🔴 OVERSOLD" : rsi7 >= 75 ? "🟢 OVERBOUGHT" : "") : ""}`);
    console.log(`  StochRSI:   ${fmt(stochRsi)}   ${stochRsi !== null ? (stochRsi <= 10 ? "🔴 DEEPLY OVERSOLD" : stochRsi >= 90 ? "🟢 DEEPLY OVERBOUGHT" : "") : ""}`);
    console.log(`  BB Lower:   ${bb ? "$" + fmt(bb.lower) : "N/A"}  |  BB Upper: ${bb ? "$" + fmt(bb.upper) : "N/A"}`);
    console.log(`  VWAP:       ${vwapBands ? "$" + fmt(vwapBands.vwap) : "N/A"}  |  ±2σ: $${vwapBands ? fmt(vwapBands.lower2) : "N/A"} / $${vwapBands ? fmt(vwapBands.upper2) : "N/A"}`);
    console.log(`  ATR(14):    $${atr14 ? fmt(atr14) : "N/A"}  →  SL ~$${atr14 ? fmt(price - 1.5 * atr14) : "N/A"}`);
    console.log(`  Vol Spike:  ${volumeRatio !== null ? fmt(volumeRatio) + "× avg" : "N/A"}  ${volumeRatio !== null && volumeRatio >= 1.5 ? "⚡ HIGH VOLUME" : ""}`);

    // ── Regime (5m MA50 vs MA200 — the 5-day/5m cross) ───────────────────────
    const deathCross = ma50 < ma200;
    const bias       = deathCross ? "bullish" : "bearish";
    const side       = deathCross ? "buy"     : "sell";

    console.log(`\n── Regime (5-day / 5m) ──────────────────────────────────\n`);
    console.log(`  MA50: $${fmt(ma50)}  |  MA200: $${fmt(ma200)}  |  Gap: ${((Math.abs(ma50 - ma200) / ma200) * 100).toFixed(2)}%`);
    if (deathCross) {
      console.log(`  ☠️  DEATH CROSS — MA50 below MA200 — looking for BUY signals`);
    } else {
      console.log(`  ✨ GOLDEN CROSS — MA50 above MA200 — looking for SELL signals`);
      const pos = getPosition(symbol);
      if (!pos) {
        console.log(`  ℹ️  No open position in ${symbol} — nothing to sell. Skipping.\n`);
        continue;
      }
      console.log(`  📦 Open position: ${pos.qty} ${symbol} @ avg $${pos.avgPrice?.toFixed(2) ?? "?"}`);
    }

    // ── Entry conditions (2 hard gates — regime already gated above) ─────────
    // BB is a signal strength booster only — not a hard gate
    const { results, allPass } = runContrarianCheck(price, bias, { rsi7, stochRsi });

    // ── Signal strength — scales trade size 20%→100% of MAX_TRADE_SIZE_USD ────
    const { strength, scores: signalScores } = calcSignalStrength(price, bias, {
      rsi7, bb, stochRsi, volumeRatio, ma50d: ma50, ma200d: ma200, vwapBands,
    });
    const tradeSize = calcTradeSize(strength, CONFIG.maxTradeSizeUSD, CONFIG.portfolioValue);

    console.log("\n── Signal Strength ──────────────────────────────────────\n");
    const strengthBar = "█".repeat(Math.round(strength * 10)) + "░".repeat(10 - Math.round(strength * 10));
    console.log(`  Strength: ${(strength * 100).toFixed(0)}%  [${strengthBar}]`);
    signalScores.forEach(s => console.log(`  • ${s.name.padEnd(12)} ${(s.score * 100).toFixed(0)}%`));
    console.log(`  Trade size: $${tradeSize.toFixed(2)} (min $${(CONFIG.maxTradeSizeUSD * 0.2).toFixed(2)} → max $${CONFIG.maxTradeSizeUSD})`);

    console.log("\n── Decision ─────────────────────────────────────────────\n");

    const logEntry = {
      timestamp: new Date().toISOString(),
      symbol,
      side,
      regime: deathCross ? "death_cross" : "golden_cross",
      timeframe: CONFIG.timeframe,
      price,
      indicators: {
        rsi7, stochRsi, volumeRatio, atr14,
        bbLower:    bb         ? bb.lower         : null,
        bbUpper:    bb         ? bb.upper         : null,
        vwap:       vwapBands  ? vwapBands.vwap   : null,
        vwapLower2: vwapBands  ? vwapBands.lower2 : null,
        vwapUpper2: vwapBands  ? vwapBands.upper2 : null,
        ma50, ma200,
        // reference only
        ema8, rsi3,
      },
      signalStrength: strength,
      signalScores,
      conditions: results,
      allPass,
      tradeSize,
      orderPlaced: false,
      orderId: null,
      paperTrading: CONFIG.paperTrading,
      limits: {
        maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
        maxTradesPerDay: CONFIG.maxTradesPerDay,
        tradesToday: countTodaysTrades(log),
      },
    };

    if (!allPass) {
      const failed = results.filter((r) => !r.pass).map((r) => r.label);
      console.log(`🚫 TRADE BLOCKED — ${symbol}`);
      console.log(`   Failed conditions:`);
      failed.forEach((f) => console.log(`   - ${f}`));
    } else {
      console.log(`✅ ALL CONDITIONS MET — ${symbol}`);

      if (CONFIG.paperTrading) {
        console.log(`\n📋 PAPER TRADE — would ${side.toUpperCase()} ${symbol} ~$${tradeSize.toFixed(2)} at market`);
        console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
        logEntry.orderPlaced = true;
        logEntry.orderId = `PAPER-${Date.now()}`;
        updatePortfolio(symbol, side, price, tradeSize);
        await sendTelegram(buildTradeMessage(symbol, side, price, tradeSize, logEntry.orderId, true, strength, signalScores));
      } else {
        console.log(`\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} ${side.toUpperCase()} ${symbol}`);
        try {
          const order = await placeCoinbaseOrder(symbol, side, tradeSize, price);
          logEntry.orderPlaced = true;
          logEntry.orderId = order.orderId;
          console.log(`✅ ORDER PLACED — ${order.orderId}`);
          updatePortfolio(symbol, side, price, tradeSize);
          await sendTelegram(buildTradeMessage(symbol, side, price, tradeSize, order.orderId, false, strength, signalScores));
        } catch (err) {
          console.log(`❌ ORDER FAILED — ${err.message}`);
          logEntry.error = err.message;
          await sendTelegram(`❌ <b>ORDER FAILED — ${symbol}</b>\n${err.message}`);
        }
      }
    }

    // Save decision log
    log.trades.push(logEntry);
    saveLog(log);
    console.log(`\nDecision log saved → ${LOG_FILE}`);
    writeTradeCsv(logEntry);
  }

  // Send 4-hour summary report if due
  if (shouldSendReport()) {
    console.log("\n── Sending 4-hour Telegram report ──────────────────────\n");
    const report = await generateReport(log);
    await sendTelegram(report);
    markReportSent();
    console.log("  ✅ Report sent");
  }

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
