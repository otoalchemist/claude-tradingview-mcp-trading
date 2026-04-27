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
import { isPaused, startCommandPolling } from "./telegram.js";
import { updatePortfolio, shouldSendReport, markReportSent, generateReport } from "./report.js";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["COINBASE_API_KEY", "COINBASE_PRIVATE_KEY"];
  const missing = required.filter((k) => !process.env[k]);

  // On Railway env vars are injected directly — no .env file needed.
  // Only run the local onboarding flow when running on a developer machine.
  const isLocal = !process.env.RAILWAY_ENVIRONMENT;

  if (isLocal && !existsSync(".env")) {
    console.log("\n⚠️  No .env file found — creating one for you...\n");
    writeFileSync(
      ".env",
      [
        "# Coinbase Advanced Trade credentials",
        "COINBASE_API_KEY=",
        "COINBASE_PRIVATE_KEY=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=40",
        "MAX_TRADES_PER_DAY=100",
        "PAPER_TRADING=true",
        "SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT",
        "TIMEFRAME=5m",
      ].join("\n") + "\n",
    );
    console.log("Fill in your Coinbase credentials in .env then re-run: node bot.js\n");
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials: ${missing.join(", ")}`);
    if (isLocal) console.log("Add them to your .env file then re-run: node bot.js\n");
    else console.log("Add them as environment variables in Railway → Variables.\n");
    process.exit(1);
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
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

function buildTradeMessage(symbol, side, price, tradeSize, orderId, paperTrading, strength, signalScores, portfolioSnap) {
  const emoji = side === "buy" ? "🟢" : "🔴";
  const modeTag = paperTrading ? " <i>(paper)</i>" : "";
  const pct = strength !== undefined ? Math.round(strength * 100) : null;
  const bar = pct !== null
    ? "█".repeat(Math.round(strength * 10)) + "░".repeat(10 - Math.round(strength * 10))
    : null;
  const scoreLines = signalScores && signalScores.length
    ? "\n" + signalScores.map(s => `  • ${s.name}: ${Math.round(s.score * 100)}%`).join("\n")
    : "";

  let portfolioLines = "";
  if (portfolioSnap) {
    const { usdcBalance, unrealizedPnL, portfolioValue } = portfolioSnap;
    const pnlSign = unrealizedPnL >= 0 ? "+" : "";
    portfolioLines =
      `\n💵 USDC: $${usdcBalance.toFixed(2)}\n` +
      `📊 Unrealized P&L: ${pnlSign}$${unrealizedPnL.toFixed(2)}\n` +
      `🏦 Portfolio: $${portfolioValue.toFixed(2)}`;
  }

  return (
    `${emoji} <b>${side.toUpperCase()} ${symbol}</b>${modeTag}\n` +
    `💰 Size: $${tradeSize.toFixed(2)}\n` +
    `📈 Price: $${price.toLocaleString()}\n` +
    (pct !== null ? `⚡ Signal: ${pct}%  [${bar}]${scoreLines}\n` : "") +
    `🔑 Order: ${orderId}` +
    portfolioLines + "\n" +
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

// ─── MACD (12,26,9) & CCI(20) — MCC v2 additions ─────────────────────────────

// Running EMA returning full-length aligned array (null until n bars available)
function runEMAArray(arr, n) {
  const k = 2 / (n + 1);
  const out = new Array(arr.length).fill(null);
  if (arr.length < n) return out;
  let ema = arr.slice(0, n).reduce((s, v) => s + v, 0) / n;
  out[n - 1] = ema;
  for (let i = n; i < arr.length; i++) { ema = arr[i] * k + ema * (1 - k); out[i] = ema; }
  return out;
}

// EMA over an array that may have leading nulls (used for MACD signal line)
function runEMANullableArray(arr, n) {
  const k = 2 / (n + 1);
  const out = new Array(arr.length).fill(null);
  let buf = [], ema = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) continue;
    if (ema == null) {
      buf.push(arr[i]);
      if (buf.length === n) { ema = buf.reduce((s, v) => s + v, 0) / n; out[i] = ema; }
    } else { ema = arr[i] * k + ema * (1 - k); out[i] = ema; }
  }
  return out;
}

// MACD(12,26,9) — returns current and previous histogram for improvement detection
function calcMACDValues(closes) {
  if (closes.length < 35) return null;
  const ema12 = runEMAArray(closes, 12);
  const ema26 = runEMAArray(closes, 26);
  const line  = ema12.map((v, i) => v != null && ema26[i] != null ? v - ema26[i] : null);
  const sig   = runEMANullableArray(line, 9);
  const hist  = line.map((v, i) => v != null && sig[i] != null ? v - sig[i] : null);
  const last  = closes.length - 1;
  return {
    line:          line[last],
    signal:        sig[last],
    histogram:     hist[last],
    prevHistogram: last > 0 ? (hist[last - 1] ?? null) : null,
  };
}

// CCI(20) — Commodity Channel Index
function calcCCIValue(candles, period = 20) {
  if (candles.length < period) return null;
  const sl  = candles.slice(-period);
  const tps = sl.map(c => (c.high + c.low + c.close) / 3);
  const sma = tps.reduce((s, v) => s + v, 0) / period;
  const md  = tps.reduce((s, v) => s + Math.abs(v - sma), 0) / period;
  return md === 0 ? 0 : (tps[period - 1] - sma) / (0.015 * md);
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

// ─── Portfolio Snapshot ───────────────────────────────────────────────────────
// Returns USDC balance, unrealized PnL, and total portfolio value.
// In paper mode: uses portfolio.json (the bot's internal ledger).
// In live mode: fetches real USD balance from Coinbase, combines with tracked positions.

async function getPortfolioSnapshot(livePrices = {}) {
  try {
    let usdcBalance;

    if (CONFIG.paperTrading) {
      // Paper mode — read from portfolio.json ledger
      if (existsSync("portfolio.json")) {
        const state = JSON.parse(readFileSync("portfolio.json", "utf8"));
        usdcBalance = state.cash ?? CONFIG.portfolioValue;
      } else {
        usdcBalance = CONFIG.portfolioValue;
      }
    } else {
      // Live mode — fetch real balance from Coinbase
      try {
        const path = "/api/v3/brokerage/accounts";
        const jwt  = buildCoinbaseJWT("GET", path);
        const res  = await fetch(`https://api.coinbase.com${path}`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        if (res.ok) {
          const data = await res.json();
          const usd  = data.accounts?.find(a => a.currency === "USD" || a.currency === "USDC");
          usdcBalance = usd ? parseFloat(usd.available_balance?.value ?? 0) : CONFIG.portfolioValue;
        } else {
          usdcBalance = CONFIG.portfolioValue;
        }
      } catch {
        usdcBalance = CONFIG.portfolioValue;
      }
    }

    // Unrealized PnL from open positions in portfolio.json
    let unrealizedPnL = 0;
    let positionsValue = 0;
    if (existsSync("portfolio.json")) {
      const state = JSON.parse(readFileSync("portfolio.json", "utf8"));
      for (const [sym, pos] of Object.entries(state.positions || {})) {
        const currentPrice = livePrices[sym];
        if (currentPrice && pos.quantity) {
          const currentValue = pos.quantity * currentPrice;
          positionsValue += currentValue;
          unrealizedPnL  += currentValue - pos.totalCost;
        } else if (pos.quantity && pos.avgCost) {
          // Fall back to avgCost if live price not available
          positionsValue += pos.quantity * pos.avgCost;
        }
      }
    }

    return {
      usdcBalance,
      unrealizedPnL,
      portfolioValue: usdcBalance + positionsValue,
    };
  } catch {
    return null;
  }
}

// ─── Entry Scoring — MCC v2 (9-indicator composite) ──────────────────────────
//
// No hard gates — every indicator is a soft score (0–1).
// Composite = average of all scores. Enter when composite ≥ MIN_SCORE (0.30).
// Backtested winner: score≥0.30 · TP=3×ATR · exits=BB midline+RSI50
// 90-day results: 822 trades · 68.2% WR · PF 1.24 · +$6.31 · 0.17% MaxDD
//
// Indicators:
//   1. RSI(14) oversold/overbought
//   2. StochRSI(14,14,3) oversold/overbought
//   3. BB(20,2) lower/upper band breach
//   4. VWAP lower/upper 2σ band
//   5. MACD histogram improving/declining
//   6. Volume spike vs 20-bar average
//   7. CCI(20) oversold/overbought
//   8. EMA9/EMA21 microtrend direction
//   9. MA50/MA200 regime depth

function calcEntryScore(price, bias, { rsi14, bb, stochRsi, volumeRatio, ma50, ma200, vwapBands, ema9, ema21, macd, cci }) {
  const scores = [];
  const cl = v => Math.max(0, Math.min(1, v));

  if (bias === "bullish") {
    // 1. RSI oversold — RSI < 40 starts scoring; RSI = 0 → 1.0
    if (rsi14 != null)
      scores.push({ name: "RSI(14)",   score: cl((40 - rsi14) / 40) });

    // 2. StochRSI oversold — < 25 strong signal
    if (stochRsi != null)
      scores.push({ name: "StochRSI",  score: cl((25 - stochRsi) / 25) });

    // 3. BB lower band breach (1.5% below = 1.0)
    if (bb)
      scores.push({ name: "BB Lower",  score: cl((bb.lower - price) / (bb.lower * 0.015)) });

    // 4. VWAP lower 2σ band breach
    if (vwapBands?.lower2)
      scores.push({ name: "VWAP Band", score: cl((vwapBands.lower2 - price) / (vwapBands.lower2 * 0.01)) });

    // 5. MACD histogram improving (turning less negative = momentum shifting up)
    if (macd?.histogram != null && macd?.prevHistogram != null)
      scores.push({ name: "MACD Hist", score: macd.histogram > macd.prevHistogram ? 1.0 : 0.0 });
    else if (macd?.histogram != null)
      scores.push({ name: "MACD Hist", score: cl(-macd.histogram / (Math.abs(macd.histogram) + 0.01)) });

    // 6. Volume spike — > 1.0× starts scoring; 2.5× = 1.0
    if (volumeRatio != null)
      scores.push({ name: "Volume",    score: cl((volumeRatio - 1.0) / 1.5) });

    // 7. CCI oversold — < −80 starts scoring; −200 = 1.0
    if (cci != null)
      scores.push({ name: "CCI",       score: cl((-80 - cci) / 120) });

    // 8. EMA microtrend — EMA9 below EMA21 = buying dip in micro downtrend
    if (ema9 != null && ema21 != null)
      scores.push({ name: "EMA9/21",   score: cl((ema21 - ema9) / ema21 / 0.003) });

    // 9. Regime depth — wider death cross gap = stronger regime
    if (ma50 && ma200 && ma50 < ma200)
      scores.push({ name: "Regime",    score: cl((ma200 - ma50) / ma200 / 0.02) });

  } else if (bias === "bearish") {
    // 1. RSI overbought — > 60 starts scoring
    if (rsi14 != null)
      scores.push({ name: "RSI(14)",   score: cl((rsi14 - 60) / 40) });

    // 2. StochRSI overbought — > 75
    if (stochRsi != null)
      scores.push({ name: "StochRSI",  score: cl((stochRsi - 75) / 25) });

    // 3. BB upper band breach
    if (bb)
      scores.push({ name: "BB Upper",  score: cl((price - bb.upper) / (bb.upper * 0.015)) });

    // 4. VWAP upper 2σ band breach
    if (vwapBands?.upper2)
      scores.push({ name: "VWAP Band", score: cl((price - vwapBands.upper2) / (vwapBands.upper2 * 0.01)) });

    // 5. MACD histogram declining
    if (macd?.histogram != null && macd?.prevHistogram != null)
      scores.push({ name: "MACD Hist", score: macd.histogram < macd.prevHistogram ? 1.0 : 0.0 });
    else if (macd?.histogram != null)
      scores.push({ name: "MACD Hist", score: cl(macd.histogram / (Math.abs(macd.histogram) + 0.01)) });

    // 6. Volume spike
    if (volumeRatio != null)
      scores.push({ name: "Volume",    score: cl((volumeRatio - 1.0) / 1.5) });

    // 7. CCI overbought — > 80 starts scoring
    if (cci != null)
      scores.push({ name: "CCI",       score: cl((cci - 80) / 120) });

    // 8. EMA microtrend — EMA9 above EMA21 = selling top in micro uptrend
    if (ema9 != null && ema21 != null)
      scores.push({ name: "EMA9/21",   score: cl((ema9 - ema21) / ema21 / 0.003) });

    // 9. Regime depth — wider golden cross gap = stronger regime
    if (ma50 && ma200 && ma50 > ma200)
      scores.push({ name: "Regime",    score: cl((ma50 - ma200) / ma200 / 0.02) });
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

// Scale how much of a position to sell based on signal strength.
// Weak signal (0%) → sell 30% of position; strong signal (100%) → sell 100%.
// This lets the bot partially exit on marginal signals and fully exit on strong ones.
function calcSellSize(strength, posQuantity) {
  const minPct = 0.30;
  const maxPct = 1.00;
  const pct = minPct + (maxPct - minPct) * Math.max(0, Math.min(1, strength));
  return posQuantity * pct;
}

// ─── Entry Conditions Display (MCC v2 — no hard gates) ──────────────────────
// Entry is now purely score-based: composite ≥ MIN_SCORE (0.30) to enter.
// This function just logs the score breakdown for visibility.

function logEntryConditions(bias, strength, scores) {
  console.log("\n── Entry Conditions (MCC v2) ────────────────────────────\n");
  const bar = "█".repeat(Math.round(strength * 10)) + "░".repeat(10 - Math.round(strength * 10));
  console.log(`  Composite score: ${(strength * 100).toFixed(0)}%  [${bar}]`);
  scores.forEach(s => console.log(`  • ${s.name.padEnd(12)} ${(s.score * 100).toFixed(0)}%`));
  console.log(`  Regime bias: ${bias.toUpperCase()}`);
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

async function placeCoinbaseOrder(symbol, side, sizeUSD, price, sellQuantity = null) {
  const productId = toCoinbaseSymbol(symbol);  // BTCUSDT → BTC-USD
  const cbSide    = side.toUpperCase();          // "buy" → "BUY"
  const path      = "/api/v3/brokerage/orders";
  const clientId  = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // BUY:  specify quote_size (USD to spend).
  // SELL: specify base_size = sellQuantity (signal-strength-scaled portion of position).
  //       Exit-rule sells always pass the full position qty; signal sells pass scaled qty.
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
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Score ${logEntry.signalStrength != null ? Math.round(logEntry.signalStrength * 100) + "%" : "?"} below threshold`;
  } else if (logEntry.paperTrading) {
    side = (logEntry.side || "buy").toUpperCase();
    quantity = logEntry.sellQuantity
      ? logEntry.sellQuantity.toFixed(6)
      : (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = logEntry.exitReason
      ? `Exit: ${logEntry.exitReason.replace(/_/g, " ")} | P&L ${logEntry.pnlPct ?? "?"}%`
      : `All conditions met${logEntry.sellPct ? ` | Sold ${logEntry.sellPct}%` : ""}`;
  } else {
    side = (logEntry.side || "buy").toUpperCase();
    quantity = logEntry.sellQuantity
      ? logEntry.sellQuantity.toFixed(6)
      : (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error
      ? `Error: ${logEntry.error}`
      : logEntry.exitReason
        ? `Exit: ${logEntry.exitReason.replace(/_/g, " ")} | P&L ${logEntry.pnlPct ?? "?"}%`
        : `All conditions met${logEntry.sellPct ? ` | Sold ${logEntry.sellPct}%` : ""}`;
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

// ─── Exit Monitor ─────────────────────────────────────────────────────────────
// Runs every tick (every 10 min) BEFORE entry scanning.
// Checks every open position against 4 exit conditions from rules.json:
//   1. Stop loss:   price fell 1.5× ATR below entry        → full close
//   2. Take profit: price rose 2.5× ATR above entry        → full close
//   3. BB midline:  price reverted to 20-SMA (mean target) → full close
//   4. Time stop:   15 candles elapsed without target hit   → full close
// These protective exits always close the FULL position regardless of signal strength.

async function checkExits() {
  if (!existsSync("portfolio.json")) return;
  let state;
  try { state = JSON.parse(readFileSync("portfolio.json", "utf8")); }
  catch { return; }

  const positions = Object.entries(state.positions || {});
  if (positions.length === 0) return;

  console.log("\n── Exit Monitor ─────────────────────────────────────────\n");

  for (const [symbol, pos] of positions) {
    let candles;
    try { candles = await fetchCandles(symbol, CONFIG.timeframe, 220); }
    catch (err) { console.log(`  ⚠️  ${symbol}: candle fetch failed — ${err.message}`); continue; }

    if (!candles || candles.length < 20) continue;

    const closes     = candles.map(c => c.close);
    const price      = closes[closes.length - 1];
    const bb         = calcBollingerBands(closes, 20, 2);
    const atr        = calcATR(candles, 14);
    const rsi14exit  = calcRSI(closes, 14);
    const entryPrice = pos.avgCost;
    const entryTime  = pos.entryTime || 0;
    const candlesSinceEntry = Math.floor((Date.now() - entryTime) / (5 * 60 * 1000));

    if (!bb || !atr) {
      console.log(`  ⚠️  ${symbol}: not enough data for exit checks — holding`);
      continue;
    }

    const takeProfitPrice = entryPrice + 3.0 * atr;  // 3× ATR — backtested optimal
    const fmt = (v) => v.toFixed(2);

    // Exit conditions — MCC v2 backtested optimal: TP + BB midline + RSI50
    // (No stop loss, no time stop — backtested as harmful to overall P&L)
    let exitReason = null;
    if      (price >= takeProfitPrice)                exitReason = "take_profit";
    else if (price >= bb.middle)                      exitReason = "bb_midline";
    else if (rsi14exit != null && rsi14exit >= 50)    exitReason = "rsi_50";

    if (!exitReason) {
      console.log(
        `  ✅ ${symbol}: holding | price $${fmt(price)} | ` +
        `TP $${fmt(takeProfitPrice)} (3×ATR) | BB-mid $${fmt(bb.middle)} | RSI ${rsi14exit?.toFixed(1) ?? "N/A"}`
      );
      continue;
    }

    const exitLabel = exitReason.replace(/_/g, " ").toUpperCase();
    const qty       = pos.quantity;
    const pnl       = (price - entryPrice) * qty;
    const pnlPct    = ((price - entryPrice) / entryPrice * 100).toFixed(2);
    const pnlStr    = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;

    console.log(`  🚪 EXIT — ${symbol} | ${exitLabel} | price $${fmt(price)} | P&L ${pnlStr} (${pnlPct}%)`);

    const exitLogEntry = {
      timestamp:          new Date().toISOString(),
      symbol,
      side:               "sell",
      exitReason,
      regime:             "exit",
      timeframe:          CONFIG.timeframe,
      price,
      entryPrice,
      pnl,
      pnlPct,
      tradeSize:          qty * price,
      sellQuantity:       qty,
      candlesSinceEntry,
      allPass:            true, // so writeTradeCsv logs it as an executed trade
      orderPlaced:        false,
      orderId:            null,
      paperTrading:       CONFIG.paperTrading,
    };

    const telegramMsg =
      `🚪 <b>EXIT — ${symbol}</b>${CONFIG.paperTrading ? " <i>(paper)</i>" : ""}\n` +
      `Reason: <b>${exitLabel}</b>\n` +
      `Price: $${fmt(price)}  |  Entry: $${fmt(entryPrice)}\n` +
      `Qty: ${qty.toFixed(6)}  |  P&L: ${pnlStr} (${pnlPct}%)\n` +
      `Candles held: ${candlesSinceEntry}\n` +
      `🕐 ${new Date().toUTCString()}`;

    if (CONFIG.paperTrading) {
      exitLogEntry.orderPlaced = true;
      exitLogEntry.orderId     = `PAPER-EXIT-${Date.now()}`;
      updatePortfolio(symbol, "sell", price, qty * price, qty);
      await sendTelegram(telegramMsg + `\nOrder: ${exitLogEntry.orderId}`);
    } else {
      try {
        const order = await placeCoinbaseOrder(symbol, "sell", qty * price, price, qty);
        exitLogEntry.orderPlaced = true;
        exitLogEntry.orderId     = order.orderId;
        updatePortfolio(symbol, "sell", price, qty * price, qty);
        await sendTelegram(telegramMsg + `\nOrder: ${order.orderId}`);
      } catch (err) {
        console.log(`  ❌ Exit order failed — ${err.message}`);
        exitLogEntry.error = err.message;
        await sendTelegram(`❌ <b>EXIT FAILED — ${symbol}</b> (${exitLabel})\n${err.message}`);
      }
    }

    const log = loadLog();
    log.trades.push(exitLogEntry);
    saveLog(log);
    writeTradeCsv(exitLogEntry);
  }
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

  // Check exit conditions on all open positions before scanning for new entries
  await checkExits();

  // Tracks live prices as each symbol is scanned — used for portfolio snapshot
  const livePrices = {};

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
    livePrices[symbol] = price;
    console.log(`  Current price: $${price.toLocaleString()}`);

    // ── All indicators from 5m candles (regime + entry signals on same chart) ──
    const ma50        = calcSMA(closes, 50);           // 50 × 5m = ~4.2 hrs
    const ma200       = calcSMA(closes, 200);          // 200 × 5m = ~16.7 hrs
    const rsi14       = calcRSI(closes, 14);
    const bb          = calcBollingerBands(closes, 20, 2);
    const stochRsi    = calcStochRSI(closes, 14, 14, 3);
    const volumeRatio = calcVolumeSpikeRatio(candles, 20);
    const atr14       = calcATR(candles, 14);
    const vwapBands   = calcVWAPBands(candles);
    // MCC v2 additions
    const ema9        = calcEMA(closes, 9);
    const ema21       = calcEMA(closes, 21);
    const macd        = calcMACDValues(closes);        // { line, signal, histogram, prevHistogram }
    const cci         = calcCCIValue(candles, 20);
    const rsi3        = calcRSI(closes, 3);            // reference only

    // Guard: need 200 candles for MA200
    if (!ma50 || !ma200) {
      console.log(`\n⚠️  Not enough 5m candle history for MA200 on ${symbol}. Skipping.`);
      continue;
    }

    const fmt = (v, digits = 2) => v !== null && v !== undefined ? v.toFixed(digits) : "N/A";
    console.log(`\n  ── 5m Indicators (MCC v2) ──────────────────────────`);
    console.log(`  MA50:       $${fmt(ma50)}  |  MA200: $${fmt(ma200)}`);
    console.log(`  EMA9:       $${fmt(ema9)}  |  EMA21: $${fmt(ema21)}  ${ema9 != null && ema21 != null ? (ema9 < ema21 ? "📉 micro-down" : "📈 micro-up") : ""}`);
    console.log(`  RSI(14):    ${fmt(rsi14)}   ${rsi14 !== null ? (rsi14 <= 40 ? "🔴 OVERSOLD" : rsi14 >= 60 ? "🟢 OVERBOUGHT" : "") : ""}`);
    console.log(`  StochRSI:   ${fmt(stochRsi)}   ${stochRsi !== null ? (stochRsi <= 25 ? "🔴 DEEPLY OVERSOLD" : stochRsi >= 75 ? "🟢 DEEPLY OVERBOUGHT" : "") : ""}`);
    console.log(`  MACD Hist:  ${macd ? fmt(macd.histogram, 4) + (macd.prevHistogram != null ? (macd.histogram > macd.prevHistogram ? "  📈 improving" : "  📉 declining") : "") : "N/A"}`);
    console.log(`  CCI(20):    ${fmt(cci, 1)}${cci != null ? (cci < -80 ? "  🔴 OVERSOLD" : cci > 80 ? "  🟢 OVERBOUGHT" : "") : ""}`);
    console.log(`  BB Lower:   ${bb ? "$" + fmt(bb.lower) : "N/A"}  |  BB Upper: ${bb ? "$" + fmt(bb.upper) : "N/A"}`);
    console.log(`  VWAP:       ${vwapBands ? "$" + fmt(vwapBands.vwap) : "N/A"}  |  ±2σ: $${vwapBands ? fmt(vwapBands.lower2) : "N/A"} / $${vwapBands ? fmt(vwapBands.upper2) : "N/A"}`);
    console.log(`  ATR(14):    $${atr14 ? fmt(atr14) : "N/A"}  →  TP ~$${atr14 ? fmt(price + 3.0 * atr14) : "N/A"} (3×ATR)`);
    console.log(`  Vol Spike:  ${volumeRatio !== null ? fmt(volumeRatio) + "× avg" : "N/A"}  ${volumeRatio !== null && volumeRatio >= 1.5 ? "⚡ HIGH VOLUME" : ""}`);

    // ── Regime (5m MA50 vs MA200 — the 5-day/5m cross) ───────────────────────
    const deathCross = ma50 < ma200;
    const bias       = deathCross ? "bullish" : "bearish";
    const side       = deathCross ? "buy"     : "sell";

    console.log(`\n── Regime (5-day / 5m) ──────────────────────────────────\n`);
    console.log(`  MA50: $${fmt(ma50)}  |  MA200: $${fmt(ma200)}  |  Gap: ${((Math.abs(ma50 - ma200) / ma200) * 100).toFixed(2)}%`);
    let openPos = null;
    if (deathCross) {
      console.log(`  ☠️  DEATH CROSS — MA50 below MA200 — looking for BUY signals`);
    } else {
      console.log(`  ✨ GOLDEN CROSS — MA50 above MA200 — looking for SELL signals`);
      openPos = getPosition(symbol);
      if (!openPos) {
        console.log(`  ℹ️  No open position in ${symbol} — nothing to sell. Skipping.\n`);
        continue;
      }
      console.log(`  📦 Open position: ${openPos.quantity} ${symbol} @ avg $${openPos.avgCost?.toFixed(2) ?? "?"}`);
    }

    // ── MCC v2 composite entry score (9 indicators, no hard gates) ───────────
    const { strength, scores: signalScores } = calcEntryScore(price, bias, {
      rsi14, bb, stochRsi, volumeRatio, ma50, ma200, vwapBands, ema9, ema21, macd, cci,
    });
    const tradeSize = calcTradeSize(strength, CONFIG.maxTradeSizeUSD, CONFIG.portfolioValue);

    logEntryConditions(bias, strength, signalScores);
    console.log(`  Trade size: $${tradeSize.toFixed(2)} (min $${(CONFIG.maxTradeSizeUSD * 0.2).toFixed(2)} → max $${CONFIG.maxTradeSizeUSD})`);

    console.log("\n── Decision ─────────────────────────────────────────────\n");

    // For sells: scale quantity by signal strength (30% min → 100% max of position).
    // For buys: sellQty is null (not applicable).
    const sellQty = (side === "sell" && openPos?.quantity)
      ? calcSellSize(strength, openPos.quantity)
      : null;

    const logEntry = {
      timestamp: new Date().toISOString(),
      symbol,
      side,
      regime: deathCross ? "death_cross" : "golden_cross",
      timeframe: CONFIG.timeframe,
      price,
      indicators: {
        rsi14, stochRsi, volumeRatio, atr14,
        bbLower:    bb         ? bb.lower         : null,
        bbUpper:    bb         ? bb.upper         : null,
        bbMiddle:   bb         ? bb.middle        : null,
        vwap:       vwapBands  ? vwapBands.vwap   : null,
        vwapLower2: vwapBands  ? vwapBands.lower2 : null,
        vwapUpper2: vwapBands  ? vwapBands.upper2 : null,
        ma50, ma200, ema9, ema21,
        macdHistogram:     macd?.histogram     ?? null,
        macdPrevHistogram: macd?.prevHistogram ?? null,
        cci,
        rsi3,
      },
      signalStrength: strength,
      signalScores,
      allPass: strength >= 0.30, // MCC v2: composite score is the sole gate
      tradeSize,
      sellQuantity: sellQty,          // strength-scaled qty (null for buys)
      sellPct: sellQty && openPos?.quantity
        ? parseFloat((sellQty / openPos.quantity * 100).toFixed(1))
        : null,
      orderPlaced: false,
      orderId: null,
      paperTrading: CONFIG.paperTrading,
      limits: {
        maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
        maxTradesPerDay: CONFIG.maxTradesPerDay,
        tradesToday: countTodaysTrades(log),
      },
    };

    // MCC v2: single gate — composite score ≥ 0.30 (no hard RSI gate)
    // Backtested: 68.2% WR · PF 1.24 · +$6.31 combined 90-day P&L
    const MIN_SCORE = 0.30;
    if (strength < MIN_SCORE) {
      console.log(`🚫 TRADE BLOCKED — ${symbol}`);
      console.log(`   Composite score ${(strength * 100).toFixed(0)}% below minimum ${MIN_SCORE * 100}% — low-conviction setup, skipping.`);
    } else {
      console.log(`✅ ALL CONDITIONS MET — ${symbol}`);

      if (CONFIG.paperTrading) {
        const sellNote = sellQty ? ` (${logEntry.sellPct}% of position = ${sellQty.toFixed(6)} ${symbol.replace("USDT","")})` : "";
        console.log(`\n📋 PAPER TRADE — would ${side.toUpperCase()} ${symbol} ~$${tradeSize.toFixed(2)} at market${sellNote}`);
        console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
        logEntry.orderPlaced = true;
        logEntry.orderId = `PAPER-${Date.now()}`;
        updatePortfolio(symbol, side, price, tradeSize, sellQty);
        const snap = await getPortfolioSnapshot(livePrices);
        await sendTelegram(buildTradeMessage(symbol, side, price, tradeSize, logEntry.orderId, true, strength, signalScores, snap));
      } else {
        console.log(`\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} ${side.toUpperCase()} ${symbol}`);
        try {
          const order = await placeCoinbaseOrder(symbol, side, tradeSize, price, sellQty);
          logEntry.orderPlaced = true;
          logEntry.orderId = order.orderId;
          console.log(`✅ ORDER PLACED — ${order.orderId}`);
          updatePortfolio(symbol, side, price, tradeSize, sellQty);
          const snap = await getPortfolioSnapshot(livePrices);
          await sendTelegram(buildTradeMessage(symbol, side, price, tradeSize, order.orderId, false, strength, signalScores, snap));
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


// ─── Trading Loop ─────────────────────────────────────────────────────────────
// Runs the full trading scan every TRADE_INTERVAL_MS, independent of polling.

const TRADE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

async function startTradingLoop() {
  console.log(`⏰ Trading loop started — scanning every 10 minutes`);

  // Run immediately on startup, then every 10 minutes
  const tick = () =>
    run().catch((err) => console.error("Trade run error:", err.message));

  await tick();
  setInterval(tick, TRADE_INTERVAL_MS);
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  // Run trading loop and Telegram polling concurrently
  Promise.all([startTradingLoop(), startCommandPolling()]).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
