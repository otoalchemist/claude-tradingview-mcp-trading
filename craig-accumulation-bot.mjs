#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// craig-accumulation-bot.mjs  — Live Paper Trading  (v2)
//
// STRATEGY (per-symbol timeframes):
//   BTC-USD  : 1h  EMA50/200 regime  →  15m BOS/CHOCH execution
//   ETH-USD  : 30m EMA50/200 regime  →   5m BOS/CHOCH execution
//   SOL-USD  : 30m EMA50/200 regime  →   5m BOS/CHOCH execution
//   LINK-USD : 30m EMA50/200 regime  →   5m BOS/CHOCH execution
//   AKT-USD  : 30m EMA50/200 regime  →   5m BOS/CHOCH execution
//   PEPE-USD : 15m EMA50/200 regime  →   1m BOS/CHOCH execution
//
//   Death cross  → BUY  regime: scale-in  on each bearish BOS / bullish CHOCH
//   Golden cross → SELL regime: scale-out on each bullish BOS / bearish CHOCH
//   Buy  ladder  : [8, 12, 18, 27]% of regime-start capital — UNLIMITED slots
//   Sell ladder  : [15, 18, 27, 27]% of regime-start crypto  — UNLIMITED slots
//   CHOCH        : continues scale (same per-slot %; no all-in)
//
// REPORTS  : 6-hour check-in (00, 06, 12, 18 UTC) + EOD at 23:55 UTC via Telegram
// COMMANDS : /status  /report  /trades  /help  (reply in Telegram chat)
// STATE    : craig-state-{SYMBOL}.json  (saved after every bar for crash safety)
// TRADES   : craig-accum-trades.jsonl   (append-only trade log)
// ═══════════════════════════════════════════════════════════════════════════

import "dotenv/config";
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";

// ── Time constants ────────────────────────────────────────────────────────────
const HOUR_MS        = 3_600_000;
const THIRTY_MIN_MS  = 1_800_000;
const FIFTEEN_MIN_MS =   900_000;

// ── Config ────────────────────────────────────────────────────────────────────
const SYMBOLS              = ["BTC-USD", "ETH-USD", "SOL-USD", "LINK-USD", "AKT-USD", "PEPE-USD"];
const INITIAL_CAPITAL      = 500;
const EMA_FAST             = 50;
const EMA_SLOW             = 200;
const SWING_LB             = 5;
const BOS_SCALE_PCT_BUY    = [8, 12, 18, 27];   // scale-in: conservative entry
const BOS_SCALE_PCT_SELL   = [15, 18, 27, 27];  // scale-out: larger first exit
const REQUIRE_BOS_BEFORE_CHOCH = true;
const CHOCH_CONTINUE_SCALE     = true;
const SCAN_INTERVAL_MS     = 5 * 60 * 1000;   // scan every 5 min
const CB_MAX               = 350;
const TRADES_LOG           = "craig-accum-trades.jsonl";
const WARMUP               = SWING_LB * 2 + 2;
const MAX_TRADES_IN_STATE  = 500;              // cap trades[] in state file to prevent unbounded growth
const MIN_ORDER_USD        = 1.00;             // minimum buy size (raise to exchange minimum before live)
const MIN_ORDER_QTY        = 1e-8;             // minimum sell qty (dust threshold)

// ── Live trading flag ─────────────────────────────────────────────────────────
// Set LIVE_TRADING=true in .env to place real orders on Coinbase Advanced Trade.
// When false (default), all trades are simulated at bar-close price — paper mode.
const LIVE_TRADING = process.env.LIVE_TRADING === "true";

// Coinbase base-size decimal precision per symbol (for sell orders)
// Coinbase rejects orders with more decimal places than the product allows
const BASE_SIZE_DECIMALS = {
  "BTC-USD":  8,
  "ETH-USD":  8,
  "SOL-USD":  6,
  "LINK-USD": 4,
  "AKT-USD":  4,
  "PEPE-USD": 0,   // integer PEPE only
};

// Per-symbol execution / regime config
const SYMBOL_CONFIG = {
  "BTC-USD": {
    exec:  { gran: "FIFTEEN_MINUTE", secs:  900, bars: 250, label: "15m" },
    regime:{ gran: "ONE_HOUR",       secs: 3600, bars: 400, ms: HOUR_MS,       label: "1h"  },
  },
  "ETH-USD": {
    exec:  { gran: "FIVE_MINUTE",    secs:  300, bars: 300, label: "5m"  },
    regime:{ gran: "THIRTY_MINUTE",  secs: 1800, bars: 250, ms: THIRTY_MIN_MS, label: "30m" },
  },
  "SOL-USD": {
    exec:  { gran: "FIVE_MINUTE",    secs:  300, bars: 300, label: "5m"  },
    regime:{ gran: "THIRTY_MINUTE",  secs: 1800, bars: 250, ms: THIRTY_MIN_MS,  label: "30m" },
  },
  "LINK-USD": {
    exec:  { gran: "FIVE_MINUTE",    secs:  300, bars: 300, label: "5m"  },
    regime:{ gran: "THIRTY_MINUTE",  secs: 1800, bars: 250, ms: THIRTY_MIN_MS,  label: "30m" },
  },
  "AKT-USD": {
    exec:  { gran: "FIVE_MINUTE",    secs:  300, bars: 300, label: "5m"  },
    regime:{ gran: "THIRTY_MINUTE",  secs: 1800, bars: 250, ms: THIRTY_MIN_MS,  label: "30m" },
  },
  "PEPE-USD": {
    exec:  { gran: "ONE_MINUTE",     secs:   60, bars: 300, label: "1m"  },
    regime:{ gran: "FIFTEEN_MINUTE", secs:  900, bars: 250, ms: FIFTEEN_MIN_MS, label: "15m" },
  },
};

// ── Telegram ──────────────────────────────────────────────────────────────────
let tgOffset           = 0;       // tracks last processed update_id for getUpdates polling
const BOT_START_MS     = Date.now();
let lastScanTime       = 0;       // epoch ms when last scan completed
let lastScanMs         = 0;       // duration of last scan in ms
let scanInProgress     = false;   // prevents concurrent scan cycles
let lastFetchErrAlertMs = 0;      // throttle fetch-error Telegram alerts (max 1/hour)

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
  } catch (e) { console.error("Telegram error:", e.message); }
}

// ── Register commands with BotFather so the / menu shows Craig bot commands only.
// Overwrites any stale E2 Swing Ensemble commands from the old bot.js deployment.
async function registerBotCommands() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const commands = [
    { command: "ping",   description: "Health check — uptime, last scan, next scan" },
    { command: "price",  description: "Live prices + regime for all symbols" },
    { command: "status", description: "Regime overview + P&L per symbol" },
    { command: "report", description: "Full portfolio report (all symbols)" },
    { command: "trades", description: "Today's trades by symbol" },
    { command: "hist",   description: "Last 20 trades across all symbols" },
    { command: "scan",   description: "Trigger an immediate scan now" },
    { command: "pause",  description: "Pause a symbol: /pause btc  or  /pause all" },
    { command: "resume", description: "Resume a symbol: /resume btc  or  /resume all" },
    { command: "btc",    description: "BTC-USD snapshot" },
    { command: "eth",    description: "ETH-USD snapshot" },
    { command: "sol",    description: "SOL-USD snapshot" },
    { command: "link",   description: "LINK-USD snapshot" },
    { command: "akt",    description: "AKT-USD snapshot" },
    { command: "pepe",   description: "PEPE-USD snapshot" },
    { command: "help",   description: "Full command list + strategy info" },
  ];
  try {
    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands }),
    });
    console.log("[Telegram] Bot commands registered with BotFather");
  } catch (e) {
    console.error("[Telegram] Failed to register commands:", e.message);
  }
}

// ── Adaptive price / qty formatters (handles PEPE micro-prices) ───────────────
function fPrice(n) {
  if (!n || n === 0)        return "$0";
  if (Math.abs(n) >= 1)     return "$" + n.toFixed(2);
  if (Math.abs(n) >= 0.01)  return "$" + n.toFixed(4);
  if (Math.abs(n) >= 0.001) return "$" + n.toFixed(5);
  return "$" + n.toFixed(8);
}
function fQty(n) {
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1)    return n.toFixed(4);
  return n.toFixed(8);
}

// ── Coinbase Advanced Trade — authenticated requests ─────────────────────────
// Used only when LIVE_TRADING=true. Paper mode never calls these functions.

function buildJWT(method, path) {
  const apiKey     = process.env.COINBASE_API_KEY ?? "";
  const privateKey = (process.env.COINBASE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  const now   = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  const uri   = `${method} api.coinbase.com${path}`;
  const header  = Buffer.from(JSON.stringify({ alg: "ES256", kid: apiKey, nonce })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: apiKey, iss: "cdp", nbf: now, exp: now + 120, uri })).toString("base64url");
  const sigInput  = `${header}.${payload}`;
  const keyObject = crypto.createPrivateKey(privateKey);
  const sig = crypto.sign("SHA256", Buffer.from(sigInput), { key: keyObject, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${sigInput}.${sig}`;
}

async function cbFetch(method, path, body = null) {
  const opts = {
    method,
    headers: { "Authorization": `Bearer ${buildJWT(method, path)}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(`https://api.coinbase.com${path}`, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(`CB ${res.status} ${method} ${path}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

function formatBaseSize(symbol, qty) {
  const dec = BASE_SIZE_DECIMALS[symbol] ?? 6;
  if (dec === 0) return String(Math.floor(qty));
  return qty.toFixed(dec);
}

async function placeLiveOrder(symbol, side, size) {
  // BUY:  size = USD amount  → quote_size (market buy)
  // SELL: size = crypto qty  → base_size  (market sell)
  const clientOrderId = `craig-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const orderCfg = side === "BUY"
    ? { market_market_ioc: { quote_size: size.toFixed(2) } }
    : { market_market_ioc: { base_size:  formatBaseSize(symbol, size) } };

  const result = await cbFetch("POST", "/api/v3/brokerage/orders", {
    client_order_id:     clientOrderId,
    product_id:          symbol,
    side,
    order_configuration: orderCfg,
  });

  if (!result.success) {
    const errMsg = result.error_response?.message ?? result.failure_reason ?? JSON.stringify(result);
    throw new Error(`Order rejected: ${errMsg}`);
  }
  return result.success_response?.order_id ?? result.order_id;
}

async function waitForFill(orderId, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const json = await cbFetch("GET", `/api/v3/brokerage/orders/historical/${orderId}`);
    const o = json.order;
    if (o?.status === "FILLED") return o;
    if (o?.status === "CANCELLED" || o?.status === "FAILED") {
      throw new Error(`Order ${orderId} ${o.status}: ${o.cancel_message ?? ""}`);
    }
    await new Promise(r => setTimeout(r, 750));
  }
  throw new Error(`Order ${orderId} fill timeout (${timeoutMs}ms)`);
}

async function fetchCoinbasePosition(symbol) {
  const currency = symbol.replace("-USD", "");
  const json     = await cbFetch("GET", "/api/v3/brokerage/accounts?limit=250");
  const accounts = json.accounts ?? [];
  const usdTotal  = accounts
    .filter(a => a.currency === "USD" || a.currency === "USDC")
    .reduce((s, a) => s + parseFloat(a.available_balance?.value ?? 0), 0);
  const cryptoQty = parseFloat(
    accounts.find(a => a.currency === currency)?.available_balance?.value ?? "0"
  );
  return { usdTotal, cryptoQty };
}

// executeBuy / executeSell — unified fill executor
// Returns { price, qty, usd } — paper fills at bar.c, live fills at actual market price
async function executeBuy(symbol, usdAmount, bar) {
  if (!LIVE_TRADING) {
    return { price: bar.c, qty: usdAmount / bar.c, usd: usdAmount };
  }
  const orderId = await placeLiveOrder(symbol, "BUY", usdAmount);
  const order   = await waitForFill(orderId);
  return {
    price: parseFloat(order.average_filled_price),
    qty:   parseFloat(order.filled_size),
    usd:   parseFloat(order.filled_value),
  };
}

async function executeSell(symbol, cryptoQty, bar) {
  if (!LIVE_TRADING) {
    return { price: bar.c, qty: cryptoQty, usd: cryptoQty * bar.c };
  }
  const orderId = await placeLiveOrder(symbol, "SELL", cryptoQty);
  const order   = await waitForFill(orderId);
  return {
    price: parseFloat(order.average_filled_price),
    qty:   parseFloat(order.filled_size),
    usd:   parseFloat(order.filled_value),
  };
}

// reconciledThisSession — tracks which symbols have had startup reconciliation
// Reconciliation only runs once per process launch, not on every scan cycle
const reconciledThisSession = new Set();

// ── Candle fetch ──────────────────────────────────────────────────────────────
async function fetchCandles(symbol, gran, secs, numBars) {
  let allCandles = [];
  let batchEnd   = Math.floor(Date.now() / 1000);
  let emptyCount = 0;
  const need     = numBars + 20;

  while (allCandles.length < need) {
    const batchSize  = Math.min(CB_MAX, need - allCandles.length);
    const batchStart = batchEnd - batchSize * secs;
    const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${symbol}/candles`
      + `?start=${batchStart}&end=${batchEnd}&granularity=${gran}&limit=${batchSize}`;

    const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Coinbase ${res.status} for ${symbol} ${gran}`);
    const json = await res.json();

    if (!json.candles?.length) {
      if (++emptyCount >= 2) break;
      batchEnd = batchStart;
      continue;
    }
    emptyCount = 0;

    const batch = json.candles.slice().reverse().map(c => ({
      t: parseInt(c.start) * 1000,
      o: parseFloat(c.open),
      h: parseFloat(c.high),
      l: parseFloat(c.low),
      c: parseFloat(c.close),
    }));
    allCandles = [...batch, ...allCandles];
    batchEnd   = batchStart;
  }

  const seen = new Set();
  return allCandles
    .filter(c => { if (seen.has(c.t)) return false; seen.add(c.t); return true; })
    .sort((a, b) => a.t - b.t)
    .slice(-numBars);
}

// ── EMA ───────────────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  const out = new Array(closes.length).fill(null);
  const k   = 2 / (period + 1);
  let ema   = null;
  for (let i = 0; i < closes.length; i++) {
    if (ema === null) {
      if (i < period - 1) continue;
      ema = closes.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0) / period;
    } else {
      ema = closes[i] * k + ema * (1 - k);
    }
    out[i] = ema;
  }
  return out;
}

// ── Regime map builder (generic — works for any candle period) ────────────────
// Keys are the CLOSE time of each regime candle = candle.t + periodMs
function buildRegime(candles, periodMs) {
  const closes   = candles.map(c => c.c);
  const emaF     = calcEMA(closes, EMA_FAST);
  const emaS     = calcEMA(closes, EMA_SLOW);
  const crossMap = new Map();
  const stateMap = new Map();

  for (let i = 1; i < candles.length; i++) {
    const ef = emaF[i], es = emaS[i], efP = emaF[i - 1], esP = emaS[i - 1];
    if (!ef || !es || !efP || !esP) continue;
    const closeTime = candles[i].t + periodMs;
    stateMap.set(closeTime, ef > es ? "golden" : "death");
    if      (efP <= esP && ef > es) crossMap.set(closeTime, "golden");
    else if (efP >= esP && ef < es) crossMap.set(closeTime, "death");
  }
  return { crossMap, stateMap };
}

// ── State persistence ─────────────────────────────────────────────────────────
function stateFile(symbol) { return `craig-state-${symbol}.json`; }

function makeFreshState(symbol) {
  const cfg = SYMBOL_CONFIG[symbol];
  return {
    symbol,
    execGran:             cfg.exec.gran,   // detect timeframe migrations on restart
    initialized:          false,
    tradingPaused:        false,           // per-symbol pause via /pause command
    regime:               "neutral",
    bosCount:             0,
    cash:                 INITIAL_CAPITAL,
    cryptoQty:            0,
    regimeStartCapital:   INITIAL_CAPITAL,
    regimeStartCryptoQty: 0,
    regimeStartPrice:     0,               // price when current regime started (for HODL comparison)
    lastPrice:            0,               // most recent bar close (for portfolio valuation)
    structure:            0,
    lastSH:               null,
    lastSL:               null,
    lastProcessedBarT:    0,
    trades:               [],
    regimeCount:          { buy: 0, sell: 0 },
  };
}

function loadState(symbol) {
  const f = stateFile(symbol);
  if (!existsSync(f)) return makeFreshState(symbol);
  try {
    const state = JSON.parse(readFileSync(f, "utf8"));
    const cfg   = SYMBOL_CONFIG[symbol];
    if (state.execGran !== cfg.exec.gran) {
      // Back up the old state before wiping so it can be recovered if needed
      const backupPath = stateFile(symbol) + `.backup-${Date.now()}`;
      try { writeFileSync(backupPath, readFileSync(stateFile(symbol))); } catch {}
      console.log(`[${symbol}] Exec TF changed (${state.execGran ?? "unknown"} → ${cfg.exec.gran}) — state reset (backup: ${backupPath})`);
      return makeFreshState(symbol);
    }
    // Back-fill new fields for states saved before they were added
    if (!("lastPrice"            in state)) state.lastPrice            = 0;
    if (!("regimeStartPrice"     in state)) state.regimeStartPrice     = 0;
    if (!("regimeStartCryptoQty" in state)) state.regimeStartCryptoQty = 0;
    if (!("tradingPaused"        in state)) state.tradingPaused        = false;
    return state;
  } catch {
    return makeFreshState(symbol);
  }
}

function saveState(symbol, state) {
  // Trim trades array before saving to prevent unbounded file/memory growth
  if (state.trades.length > MAX_TRADES_IN_STATE) {
    state.trades = state.trades.slice(-MAX_TRADES_IN_STATE);
  }
  // Atomic write: write to .tmp then rename so a mid-write crash never corrupts the state file
  const target = stateFile(symbol);
  const tmp    = target + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, target);
}

function appendTrade(entry) {
  appendFileSync(TRADES_LOG, JSON.stringify(entry) + "\n");
}

// ── Process one symbol ────────────────────────────────────────────────────────
async function processSymbol(symbol) {
  const cfg = SYMBOL_CONFIG[symbol];
  let state;
  try {
    state = loadState(symbol);
  } catch (e) {
    console.error(`[${symbol}] State load error: ${e.message}`);
    return;
  }

  // ── Per-symbol pause check ────────────────────────────────────────────────────
  // Still fetch candles so lastPrice stays current for reports, but skip all
  // trade-signal logic.
  if (state.tradingPaused) {
    console.log(`[${symbol}] ⏸ PAUSED — skipping signals`);
    // Best-effort price update so /status and /report still show live price
    try {
      const bars = await fetchCandles(symbol, cfg.exec.gran, cfg.exec.secs, 2);
      if (bars.length) { state.lastPrice = bars.at(-1).c; saveState(symbol, state); }
    } catch {}
    return;
  }

  // ── Live: reconcile crypto position on first scan after startup ──────────────
  if (LIVE_TRADING && state.initialized && !reconciledThisSession.has(symbol)) {
    reconciledThisSession.add(symbol);
    try {
      const pos = await fetchCoinbasePosition(symbol);
      if (Math.abs(state.cryptoQty - pos.cryptoQty) > 1e-6) {
        const msg = `⚠️ <b>${symbol}</b> position reconciled on startup\n` +
          `State: ${fQty(state.cryptoQty)} → Actual: ${fQty(pos.cryptoQty)}\n` +
          `Total USD on exchange: $${pos.usdTotal.toFixed(2)}`;
        console.log(`[${symbol}] Reconcile: cryptoQty ${state.cryptoQty} → ${pos.cryptoQty}`);
        state.cryptoQty = pos.cryptoQty;
        saveState(symbol, state);
        await sendTelegram(msg);
      } else {
        console.log(`[${symbol}] Reconcile OK: cryptoQty=${state.cryptoQty}  USD on exchange: $${pos.usdTotal.toFixed(2)}`);
      }
    } catch (e) {
      console.error(`[${symbol}] Reconcile failed: ${e.message}`);
      await sendTelegram(`⚠️ <b>${symbol}</b> startup reconcile failed: ${e.message}`);
    }
  }

  let candlesExec, candlesRegime;
  try {
    [candlesExec, candlesRegime] = await Promise.all([
      fetchCandles(symbol, cfg.exec.gran,   cfg.exec.secs,   cfg.exec.bars),
      fetchCandles(symbol, cfg.regime.gran, cfg.regime.secs, cfg.regime.bars),
    ]);
  } catch (e) {
    console.error(`[${symbol}] Fetch error: ${e.message}`);
    // Alert once per hour so a sustained outage doesn't spam Telegram
    if (Date.now() - lastFetchErrAlertMs > 3_600_000) {
      lastFetchErrAlertMs = Date.now();
      await sendTelegram(`⚠️ <b>${symbol}</b> API fetch error: ${e.message}\nScans continuing — check Coinbase status.`);
    }
    return;
  }

  if (candlesExec.length < 50 || candlesRegime.length < 220) {
    console.log(`[${symbol}] Insufficient candles — skipping (exec:${candlesExec.length} regime:${candlesRegime.length})`);
    return;
  }

  const { crossMap, stateMap } = buildRegime(candlesRegime, cfg.regime.ms);

  // ── On first run: detect current regime ──────────────────────────────────
  if (!state.initialized) {
    const lastBar     = candlesExec.at(-1);
    const periodMs    = cfg.regime.ms;
    const recentClose = Math.floor(lastBar.t / periodMs) * periodMs;
    const initS       = stateMap.get(recentClose);

    if (initS === "death") {
      state.regime             = "buy";
      state.regimeStartCapital = state.cash;
      state.regimeStartPrice   = lastBar.c;
      state.regimeCount.buy++;
    } else if (initS === "golden") {
      state.regime                = "sell";
      state.regimeStartCryptoQty  = state.cryptoQty;
      state.regimeStartPrice      = lastBar.c;
      state.regimeCount.sell++;
    } else {
      state.regime = "neutral";
    }

    // Live: sync actual crypto balance at init time
    if (LIVE_TRADING) {
      try {
        const pos = await fetchCoinbasePosition(symbol);
        state.cryptoQty = pos.cryptoQty;
        console.log(`[${symbol}] Live init: cryptoQty=${pos.cryptoQty}  totalUSD=$${pos.usdTotal.toFixed(2)}`);
      } catch (e) {
        console.error(`[${symbol}] Live init balance fetch failed: ${e.message}`);
      }
    }
    reconciledThisSession.add(symbol);   // mark as reconciled — skip the startup check

    state.lastPrice         = lastBar.c;
    state.lastProcessedBarT = lastBar.t;
    state.initialized       = true;
    saveState(symbol, state);

    const now = new Date().toISOString().slice(0, 16);
    console.log(`[${symbol}] ✓ Init | regime=${state.regime} | $${state.cash.toFixed(2)} | exec:${cfg.exec.label} regime:${cfg.regime.label} | ${now}`);
    await sendTelegram(
      `🤖 <b>Craig Accum Bot — ${symbol}</b>\n` +
      `Initialized | Regime: ${state.regime.toUpperCase()}\n` +
      `Cash: $${state.cash.toFixed(2)} | Crypto: ${fQty(state.cryptoQty)}\n` +
      `Exec: ${cfg.exec.label} | Regime TF: ${cfg.regime.label} EMA${EMA_FAST}/${EMA_SLOW}\n` +
      (LIVE_TRADING ? `🔴 LIVE TRADING` : `📝 PAPER TRADING`)
    );
    return;
  }

  // ── Process bars newer than last processed ────────────────────────────────
  const newBars = candlesExec.filter(b => b.t > state.lastProcessedBarT);
  if (!newBars.length) {
    console.log(`[${symbol}] No new ${cfg.exec.label} bars since ${new Date(state.lastProcessedBarT).toISOString().slice(11, 16)} UTC`);
    return;
  }

  const alerts = [];
  const f2     = n => n.toFixed(2);   // USD amounts only
  const fP     = n => fPrice(n);      // prices (adaptive for micro-prices)
  const fQ     = n => fQty(n);        // quantities (adaptive for large PEPE qty)
  const tToIdx = new Map(candlesExec.map((b, i) => [b.t, i]));

  for (const bar of newBars) {
    const i = tToIdx.get(bar.t);

    // Always update lastPrice and advance pointer, even for warmup bars
    state.lastPrice         = bar.c;
    state.lastProcessedBarT = bar.t;

    if (i === undefined || i < WARMUP) { saveState(symbol, state); continue; }

    // ── 1. Confirm pivot at i−SWING_LB ──────────────────────────────────────
    const pIdx = i - SWING_LB;
    if (pIdx >= SWING_LB) {
      const pb = candlesExec[pIdx];
      let isPH = true, isPL = true;
      for (let j = 1; j <= SWING_LB; j++) {
        const prev = candlesExec[pIdx - j];
        const next = candlesExec[pIdx + j];
        if (!prev || !next) { isPH = isPL = false; break; }
        if (prev.h >= pb.h || next.h >= pb.h) isPH = false;
        if (prev.l <= pb.l || next.l <= pb.l) isPL = false;
      }
      if (isPH && (!state.lastSH || pb.t >= state.lastSH.t)) state.lastSH = { price: pb.h, t: pb.t };
      if (isPL && (!state.lastSL || pb.t >= state.lastSL.t)) state.lastSL = { price: pb.l, t: pb.t };
    }

    // ── 2. BOS / CHOCH detection ─────────────────────────────────────────────
    // BUY  regime signals: bearBOS (buy the dip) | bullCHOCH (buy the reversal)
    // SELL regime signals: bullBOS (sell the rally) | bearCHOCH (sell the reversal)
    let bullBOS = false, bearBOS = false, bullCHOCH = false, bearCHOCH = false;
    if (state.lastSH && state.lastSL && i > 0) {
      const pc = candlesExec[i - 1].c;
      if (bar.c > state.lastSH.price && pc <= state.lastSH.price) {
        if (state.structure === -1) bullCHOCH = true; else bullBOS = true;
        state.structure = 1;
      }
      if (bar.c < state.lastSL.price && pc >= state.lastSL.price) {
        if (state.structure === 1) bearCHOCH = true; else bearBOS = true;
        state.structure = -1;
      }
    }

    // ── 3. Regime change check ────────────────────────────────────────────────
    // Checked at each regime-candle boundary (every 1h for BTC, every 30m for ETH/SOL)
    if (bar.t % cfg.regime.ms === 0) {
      const cross = crossMap.get(bar.t);
      if (cross === "death" && state.regime !== "buy") {
        state.regime             = "buy";
        state.bosCount           = 0;
        state.regimeStartCapital = state.cash + state.cryptoQty * bar.c;
        state.regimeStartPrice   = bar.c;
        state.regimeCount.buy++;
        const msg = `☠️ <b>${symbol}</b> DEATH CROSS → BUY REGIME\n@ ${fP(bar.c)} | Capital: $${f2(state.regimeStartCapital)}`;
        console.log(`[${symbol}] DEATH CROSS → BUY @ ${fP(bar.c)} | capital $${f2(state.regimeStartCapital)}`);
        alerts.push(msg);
        appendTrade({ symbol, t: bar.t, type: "regime", to: "buy",  price: bar.c, ts: new Date(bar.t).toISOString() });
      } else if (cross === "golden" && state.regime !== "sell") {
        state.regime                = "sell";
        state.bosCount              = 0;
        state.regimeStartCryptoQty  = state.cryptoQty;
        state.regimeStartPrice      = bar.c;
        state.regimeCount.sell++;
        const msg = `⭐ <b>${symbol}</b> GOLDEN CROSS → SELL REGIME\n@ ${fP(bar.c)} | Crypto: ${fQ(state.regimeStartCryptoQty)}`;
        console.log(`[${symbol}] GOLDEN CROSS → SELL @ ${fP(bar.c)} | qty ${fQ(state.regimeStartCryptoQty)}`);
        alerts.push(msg);
        appendTrade({ symbol, t: bar.t, type: "regime", to: "sell", price: bar.c, ts: new Date(bar.t).toISOString() });
      }
    }

    // ── 4. Trade execution ───────────────────────────────────────────────────
    const dateStr = new Date(bar.t).toISOString().slice(0, 16).replace("T", " ");

    // Allocation % — buy uses conservative ladder; sell uses aggressive first-slot ladder
    const buySlot  = idx => BOS_SCALE_PCT_BUY [Math.min(idx, BOS_SCALE_PCT_BUY.length  - 1)];
    const sellSlot = idx => BOS_SCALE_PCT_SELL[Math.min(idx, BOS_SCALE_PCT_SELL.length - 1)];

    // ── BUY regime ────────────────────────────────────────────────────────────
    if (state.regime === "buy") {

      // Scaled BOS buy — UNLIMITED: no slot cap; slots 5+ repeat at 27%
      if (bearBOS && state.cash >= MIN_ORDER_USD) {
        const buyUSD = Math.min((state.regimeStartCapital * buySlot(state.bosCount)) / 100, state.cash);
        if (buyUSD >= MIN_ORDER_USD) {
          try {
            const fill = await executeBuy(symbol, buyUSD, bar);
            state.cash      -= fill.usd;
            state.cryptoQty += fill.qty;
            state.bosCount++;
            const trade = { symbol, t: bar.t, type: "scaled_buy", bosNum: state.bosCount,
                            price: fill.price, usd: fill.usd, qty: fill.qty, ts: new Date(bar.t).toISOString() };
            state.trades.push(trade);
            appendTrade(trade);
            const msg = `🟢 <b>${symbol}</b> BUY #${state.bosCount} (bearish BOS)\n@ ${fP(fill.price)} | $${f2(fill.usd)} | ${fQ(fill.qty)}\nCash: $${f2(state.cash)} | ${dateStr}`;
            console.log(`[${symbol}] BUY #${state.bosCount} (BOS) @ ${fP(fill.price)} | $${f2(fill.usd)} | cash $${f2(state.cash)}`);
            alerts.push(msg);
          } catch (e) {
            console.error(`[${symbol}] BUY (BOS) order error: ${e.message}`);
            await sendTelegram(`❌ <b>${symbol}</b> BUY (BOS) FAILED: ${e.message}`);
          }
        }
      }

      // CHOCH buy — continues scale; slots 5+ repeat at 27%
      const chochBuyArmed = !REQUIRE_BOS_BEFORE_CHOCH || state.bosCount >= 1;
      if (CHOCH_CONTINUE_SCALE && bullCHOCH && chochBuyArmed && state.cash >= MIN_ORDER_USD) {
        const buyUSD = Math.min((state.regimeStartCapital * buySlot(state.bosCount)) / 100, state.cash);
        if (buyUSD >= MIN_ORDER_USD) {
          try {
            const fill = await executeBuy(symbol, buyUSD, bar);
            state.cash      -= fill.usd;
            state.cryptoQty += fill.qty;
            state.bosCount++;
            const trade = { symbol, t: bar.t, type: "choch_buy", bosNum: state.bosCount,
                            price: fill.price, usd: fill.usd, qty: fill.qty, ts: new Date(bar.t).toISOString() };
            state.trades.push(trade);
            appendTrade(trade);
            const msg = `🟢✦ <b>${symbol}</b> BUY #${state.bosCount} (bullish CHOCH)\n@ ${fP(fill.price)} | $${f2(fill.usd)} | ${fQ(fill.qty)}\nCash: $${f2(state.cash)} | ${dateStr}`;
            console.log(`[${symbol}] BUY #${state.bosCount} (CHOCH) @ ${fP(fill.price)} | $${f2(fill.usd)}`);
            alerts.push(msg);
          } catch (e) {
            console.error(`[${symbol}] BUY (CHOCH) order error: ${e.message}`);
            await sendTelegram(`❌ <b>${symbol}</b> BUY (CHOCH) FAILED: ${e.message}`);
          }
        }
      }
    }

    // ── SELL regime ───────────────────────────────────────────────────────────
    if (state.regime === "sell") {

      // Scaled BOS sell — UNLIMITED: no slot cap; slots 5+ repeat at 27%
      if (bullBOS && state.cryptoQty >= MIN_ORDER_QTY) {
        const sellQty = Math.min((state.regimeStartCryptoQty * sellSlot(state.bosCount)) / 100, state.cryptoQty);
        if (sellQty >= MIN_ORDER_QTY) {
          try {
            const fill = await executeSell(symbol, sellQty, bar);
            state.cash      += fill.usd;
            state.cryptoQty -= fill.qty;
            state.bosCount++;
            const trade = { symbol, t: bar.t, type: "scaled_sell", bosNum: state.bosCount,
                            price: fill.price, usd: fill.usd, qty: fill.qty, ts: new Date(bar.t).toISOString() };
            state.trades.push(trade);
            appendTrade(trade);
            const msg = `🔴 <b>${symbol}</b> SELL #${state.bosCount} (bullish BOS)\n@ ${fP(fill.price)} | $${f2(fill.usd)} | ${fQ(fill.qty)}\nCash: $${f2(state.cash)} | ${dateStr}`;
            console.log(`[${symbol}] SELL #${state.bosCount} (BOS) @ ${fP(fill.price)} | $${f2(fill.usd)} | cash $${f2(state.cash)}`);
            alerts.push(msg);
          } catch (e) {
            console.error(`[${symbol}] SELL (BOS) order error: ${e.message}`);
            await sendTelegram(`❌ <b>${symbol}</b> SELL (BOS) FAILED: ${e.message}`);
          }
        }
      }

      // CHOCH sell — continues scale; slots 5+ repeat at 27%
      const chochSellArmed = !REQUIRE_BOS_BEFORE_CHOCH || state.bosCount >= 1;
      if (CHOCH_CONTINUE_SCALE && bearCHOCH && chochSellArmed && state.cryptoQty >= MIN_ORDER_QTY) {
        const sellQty = Math.min((state.regimeStartCryptoQty * sellSlot(state.bosCount)) / 100, state.cryptoQty);
        if (sellQty >= MIN_ORDER_QTY) {
          try {
            const fill = await executeSell(symbol, sellQty, bar);
            state.cash      += fill.usd;
            state.cryptoQty -= fill.qty;
            state.bosCount++;
            const trade = { symbol, t: bar.t, type: "choch_sell", bosNum: state.bosCount,
                            price: fill.price, usd: fill.usd, qty: fill.qty, ts: new Date(bar.t).toISOString() };
            state.trades.push(trade);
            appendTrade(trade);
            const msg = `🔴✦ <b>${symbol}</b> SELL #${state.bosCount} (bearish CHOCH)\n@ ${fP(fill.price)} | $${f2(fill.usd)} | ${fQ(fill.qty)}\nCash: $${f2(state.cash)} | ${dateStr}`;
            console.log(`[${symbol}] SELL #${state.bosCount} (CHOCH) @ ${fP(fill.price)} | $${f2(fill.usd)} | cash $${f2(state.cash)}`);
            alerts.push(msg);
          } catch (e) {
            console.error(`[${symbol}] SELL (CHOCH) order error: ${e.message}`);
            await sendTelegram(`❌ <b>${symbol}</b> SELL (CHOCH) FAILED: ${e.message}`);
          }
        }
      }
    }

    // Save state after every bar — prevents duplicate trades on crash/restart
    saveState(symbol, state);
  }

  // Send batched Telegram alerts
  if (alerts.length) {
    await sendTelegram(alerts.join("\n\n"));
  }
}

// ── Periodic reporting ────────────────────────────────────────────────────────
// Report state persisted to disk so a bot restart within a 6h window
// does not fire a duplicate report on the very next scan.
const REPORT_STATE_FILE = "craig-accum-report-state.json";

function loadReportState() {
  try {
    if (existsSync(REPORT_STATE_FILE)) {
      const s = JSON.parse(readFileSync(REPORT_STATE_FILE, "utf8"));
      return { lastSixHourSummaryHour: s.lastSixHourSummaryHour ?? -1,
               lastEodSentDate:        s.lastEodSentDate        ?? "" };
    }
  } catch {}
  return { lastSixHourSummaryHour: -1, lastEodSentDate: "" };
}

function saveReportState() {
  try {
    writeFileSync(REPORT_STATE_FILE,
      JSON.stringify({ lastSixHourSummaryHour, lastEodSentDate }, null, 2));
  } catch (e) { console.error("[Report] Failed to save report state:", e.message); }
}

const _rs = loadReportState();
let lastSixHourSummaryHour = _rs.lastSixHourSummaryHour;
let lastEodSentDate        = _rs.lastEodSentDate;

function buildSymbolReport(symbol) {
  let s;
  try { s = loadState(symbol); } catch { return `<b>${symbol}</b> — state unavailable`; }
  if (!s.initialized) return `<b>${symbol}</b> — not yet initialized`;

  const cfg       = SYMBOL_CONFIG[symbol];
  const price     = s.lastPrice || 0;
  const portVal   = s.cash + s.cryptoQty * price;
  const pnlPct    = ((portVal - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100);
  const pnlSign   = pnlPct >= 0 ? "+" : "";

  // HODL comparison from regime start
  let hodlLine = "";
  if (s.regimeStartPrice > 0 && price > 0) {
    const hodlPct      = ((price / s.regimeStartPrice) - 1) * 100;
    const edgePct      = pnlPct - hodlPct;
    const hodlSign     = hodlPct >= 0 ? "+" : "";
    const edgeSign     = edgePct >= 0 ? "+" : "";
    hodlLine = `\nHODL (regime): ${hodlSign}${hodlPct.toFixed(1)}%  │  Edge: ${edgeSign}${edgePct.toFixed(1)}%`;
  }

  // Deployment progress
  let deployLine = "";
  if (s.regime === "buy") {
    const deployedPct = (s.cryptoQty * price) / (portVal || 1) * 100;
    deployLine = `\nDeployed: ${deployedPct.toFixed(0)}% in crypto  │  Signals: ${s.bosCount}`;
  } else if (s.regime === "sell") {
    const soldPct = s.regimeStartCryptoQty > 0
      ? (1 - s.cryptoQty / s.regimeStartCryptoQty) * 100 : 0;
    deployLine = `\nDistributed: ${soldPct.toFixed(0)}% of crypto  │  Signals: ${s.bosCount}`;
  }

  // Today's trades
  const todayDate = new Date().toISOString().slice(0, 10);
  const todayTrades = s.trades.filter(t => t.ts?.startsWith(todayDate));

  // Last 2 trades
  const recentLines = s.trades.slice(-2).map(t => {
    const dt   = new Date(t.t).toISOString().slice(5, 16).replace("T", " ");
    const icon = t.type.includes("buy") ? "🟢" : "🔴";
    const tag  = t.type === "scaled_buy"   ? `BUY  #${t.bosNum}  (BOS)`
               : t.type === "choch_buy"    ? `BUY  #${t.bosNum}  (CHOCH)`
               : t.type === "scaled_sell"  ? `SELL #${t.bosNum}  (BOS)`
               : t.type === "choch_sell"   ? `SELL #${t.bosNum}  (CHOCH)`
               : t.type;
    return `  ${icon} ${tag} @ ${fPrice(t.price)} | ${dt}`;
  }).join("\n");

  // Contextual analysis
  const notes = [];
  if (s.regime !== "neutral" && s.bosCount === 0 && s.trades.length === 0)
    notes.push("⏳ No trades yet — awaiting first BOS signal");
  if (s.regime === "buy" && s.cash < 10)
    notes.push("💰 Near fully deployed — capital working");
  if (s.regime === "sell" && s.cryptoQty < 1e-8)
    notes.push("💰 Fully distributed — cash secured");
  if (s.regime === "neutral")
    notes.push("⏸️ No regime established — EMA still warming up");

  // Data freshness
  const barAgeMin = s.lastProcessedBarT
    ? Math.floor((Date.now() - s.lastProcessedBarT) / 60_000) : null;
  const freshStr = barAgeMin !== null
    ? (barAgeMin < 10 ? `  🟢 ${barAgeMin}m ago` : `  🟡 ${barAgeMin}m ago`) : "";

  const pausedBadge = s.tradingPaused ? "  ⏸ <b>PAUSED</b>" : "";

  return (
    `<b>${symbol}</b>  [${s.regime.toUpperCase()}]  ${cfg.exec.label}/${cfg.regime.label}${freshStr}${pausedBadge}\n` +
    `Value: $${portVal.toFixed(2)}  (${pnlSign}${pnlPct.toFixed(2)}%)  @ ${fPrice(price)}` +
    hodlLine +
    deployLine +
    `\nToday: ${todayTrades.length} trade${todayTrades.length !== 1 ? "s" : ""}  │  Total: ${s.trades.length}  │  Cycles: ${s.regimeCount.buy}B/${s.regimeCount.sell}S` +
    (recentLines ? `\nRecent:\n${recentLines}` : "") +
    (notes.length ? `\n${notes.join("\n")}` : "")
  );
}

async function sendPortfolioReport(isEod = false) {
  const now     = new Date();
  const timeStr = now.toISOString().slice(0, 16).replace("T", " ") + " UTC";

  let totalPortVal = 0;
  const symbolBlocks = [];

  for (const symbol of SYMBOLS) {
    try {
      const s = loadState(symbol);
      const p = s.lastPrice || 0;
      totalPortVal += s.initialized ? s.cash + s.cryptoQty * p : INITIAL_CAPITAL;
      symbolBlocks.push(buildSymbolReport(symbol));
    } catch {
      totalPortVal += INITIAL_CAPITAL;
      symbolBlocks.push(`<b>${symbol}</b> — error reading state`);
    }
  }

  const totalStart  = SYMBOLS.length * INITIAL_CAPITAL;
  const totalPnlPct = ((totalPortVal - totalStart) / totalStart * 100);
  const totalSign   = totalPnlPct >= 0 ? "+" : "";

  const header = isEod
    ? `📊 <b>END OF DAY  ─  ${now.toISOString().slice(0, 10)}</b>\n${timeStr}`
    : `📈 <b>6H CHECK-IN  ─  ${timeStr}</b>`;

  const footer =
    `\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>TOTAL: $${totalPortVal.toFixed(2)} / $${totalStart}  (${totalSign}${totalPnlPct.toFixed(2)}%)</b>`;

  await sendTelegram(header + "\n\n" + symbolBlocks.join("\n\n") + footer);
  console.log(`[Report] Sent ${isEod ? "EOD" : "6h"} report @ ${timeStr}`);
}

async function checkAndSendReports() {
  const now       = new Date();
  const hourUTC   = now.getUTCHours();
  const minuteUTC = now.getUTCMinutes();
  const dateStr   = now.toISOString().slice(0, 10);

  // 6-hour check-ins at 00:00, 06:00, 12:00, 18:00 UTC
  // Fire on the first scheduled scan within 10 minutes of each boundary.
  // lastSixHourSummaryHour persists to disk — safe across restarts.
  if (hourUTC % 6 === 0 && minuteUTC < 10 && lastSixHourSummaryHour !== hourUTC) {
    await sendPortfolioReport(false);
    lastSixHourSummaryHour = hourUTC;
    saveReportState();
  }

  // End-of-day report at 23:55 UTC
  if (hourUTC === 23 && minuteUTC >= 55 && lastEodSentDate !== dateStr) {
    await sendPortfolioReport(true);
    lastEodSentDate = dateStr;
    saveReportState();
  }
}

// ── Telegram command: today's trades list ────────────────────────────────────
async function sendTodaysTrades() {
  const todayDate = new Date().toISOString().slice(0, 10);
  const lines     = [];
  let   totalCount = 0;

  for (const symbol of SYMBOLS) {
    try {
      const s      = loadState(symbol);
      const today  = s.trades.filter(t => t.ts?.startsWith(todayDate));
      totalCount  += today.length;
      if (!today.length) { lines.push(`<b>${symbol}</b> — no trades today`); continue; }
      const rows = today.map(t => {
        const dt   = new Date(t.t).toISOString().slice(11, 16);
        const icon = t.type.includes("buy") ? "🟢" : "🔴";
        const side = t.type === "scaled_buy"  ? `BUY  #${t.bosNum} BOS`
                   : t.type === "choch_buy"   ? `BUY  #${t.bosNum} CHOCH`
                   : t.type === "scaled_sell" ? `SELL #${t.bosNum} BOS`
                   : t.type === "choch_sell"  ? `SELL #${t.bosNum} CHOCH`
                   : t.type;
        return `  ${icon} ${side.padEnd(16)} ${fPrice(t.price).padStart(14)}  ${dt} UTC`;
      });
      lines.push(`<b>${symbol}</b>  (${today.length} trade${today.length !== 1 ? "s" : ""})\n<code>${rows.join("\n")}</code>`);
    } catch {
      lines.push(`<b>${symbol}</b> — error reading state`);
    }
  }

  const header = `📋 <b>TODAY'S TRADES  ─  ${todayDate}</b>`;
  const footer = `\n<b>${totalCount} total trade${totalCount !== 1 ? "s" : ""} today</b>`;
  await sendTelegram(header + "\n\n" + lines.join("\n\n") + footer);
}

// ── Telegram commands: new handlers ──────────────────────────────────────────

async function sendPing() {
  const ms  = Date.now() - BOT_START_MS;
  const h   = Math.floor(ms / 3_600_000);
  const m   = Math.floor((ms % 3_600_000) / 60_000);
  const s   = Math.floor((ms % 60_000) / 1000);
  const uptime = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;

  const lastStr = lastScanTime
    ? `${new Date(lastScanTime).toISOString().slice(11, 19)} UTC  (${(lastScanMs / 1000).toFixed(1)}s)`
    : "not yet";
  const nextMs  = lastScanTime
    ? Math.ceil(lastScanTime / SCAN_INTERVAL_MS) * SCAN_INTERVAL_MS : null;
  const nextStr = nextMs ? new Date(nextMs).toISOString().slice(11, 16) + " UTC" : "soon";

  await sendTelegram(
    `🏓 <b>Pong — Bot is alive</b>\n\n` +
    `Uptime    : ${uptime}\n` +
    `Last scan : ${lastStr}\n` +
    `Next scan : ~${nextStr}\n` +
    `Symbols   : ${SYMBOLS.length}  [${SYMBOLS.map(s => s.replace("-USD","")).join(" · ")}]\n` +
    `Capital   : $${INITIAL_CAPITAL}/sym  ($${SYMBOLS.length * INITIAL_CAPITAL} total)\n` +
    `Buy scale : [${BOS_SCALE_PCT_BUY.join(", ")}]%  UNLIMITED\n` +
    `Sell scale: [${BOS_SCALE_PCT_SELL.join(", ")}]%  UNLIMITED`
  );
}

async function sendPrices() {
  const lines = SYMBOLS.map(sym => {
    try {
      const s   = loadState(sym);
      const cfg = SYMBOL_CONFIG[sym];
      const icon  = s.regime === "buy" ? "☠️" : s.regime === "sell" ? "⭐" : "⏸ ";
      const name  = sym.replace("-USD","").padEnd(5);
      const price = fPrice(s.lastPrice || 0).padStart(15);
      const reg   = s.regime.toUpperCase().padEnd(7);
      return `${icon} ${name} ${price}  [${reg}]  ${cfg.exec.label}/${cfg.regime.label}`;
    } catch { return `❌ ${sym}  error`; }
  });
  const t = new Date().toISOString().slice(11, 19) + " UTC";
  await sendTelegram(`💰 <b>PRICES  ─  ${t}</b>\n\n<code>${lines.join("\n")}</code>`);
}

async function sendRegimeOverview() {
  const lines = [];
  let totalVal = 0;
  for (const sym of SYMBOLS) {
    try {
      const s     = loadState(sym);
      const price = s.lastPrice || 0;
      const val   = s.cash + s.cryptoQty * price;
      totalVal   += val;
      const icon  = s.regime === "buy" ? "☠️" : s.regime === "sell" ? "⭐" : "⏸ ";
      const name  = sym.replace("-USD","").padEnd(5);
      const reg   = s.regime.toUpperCase().padEnd(7);
      const pnl   = ((val - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100);
      const pnlS  = (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + "%";
      let detail  = "";
      if (s.regime === "buy") {
        const dep = s.cryptoQty * price;
        const pct = val > 0 ? (dep / val * 100).toFixed(0) : 0;
        detail = `dep:${pct}% sig:${s.bosCount}`;
      } else if (s.regime === "sell") {
        const sp = s.regimeStartCryptoQty > 0
          ? ((1 - s.cryptoQty / s.regimeStartCryptoQty) * 100).toFixed(0) : "—";
        detail = `sold:${sp}% sig:${s.bosCount}`;
      }
      const pauseTag = s.tradingPaused ? " ⏸" : "";
      lines.push(`${icon} ${name} [${reg}] $${val.toFixed(2)} (${pnlS})  ${detail}${pauseTag}`);
    } catch { lines.push(`❌ ${sym}  error`); }
  }
  const totalStart = SYMBOLS.length * INITIAL_CAPITAL;
  const totalPnl   = ((totalVal - totalStart) / totalStart * 100);
  const t = new Date().toISOString().slice(11, 19) + " UTC";
  await sendTelegram(
    `📡 <b>REGIME OVERVIEW  ─  ${t}</b>\n\n` +
    `<code>${lines.join("\n")}</code>\n\n` +
    `<b>Portfolio: $${totalVal.toFixed(2)} / $${totalStart}  (${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}%)</b>`
  );
}

async function sendTradeHistory() {
  const all = [];
  for (const sym of SYMBOLS) {
    try {
      const s = loadState(sym);
      for (const t of s.trades) all.push({ ...t, symbol: sym });
    } catch {}
  }
  all.sort((a, b) => b.t - a.t);
  const recent = all.slice(0, 20);

  if (!recent.length) {
    await sendTelegram(`📜 <b>Trade History</b>\n\nNo trades yet across all symbols.`);
    return;
  }
  const rows = recent.map(t => {
    const dt   = new Date(t.t).toISOString().slice(5, 16).replace("T", " ");
    const sym  = t.symbol.replace("-USD","").padEnd(5);
    const icon = t.type.includes("buy") ? "🟢" : "🔴";
    const side = t.type === "scaled_buy"  ? `B#${t.bosNum} BOS  `
               : t.type === "choch_buy"   ? `B#${t.bosNum} CHOCH`
               : t.type === "scaled_sell" ? `S#${t.bosNum} BOS  `
               : t.type === "choch_sell"  ? `S#${t.bosNum} CHOCH`
               : t.type.padEnd(12);
    return `${icon} ${sym} ${side}  ${fPrice(t.price).padStart(12)}  ${dt}`;
  });
  await sendTelegram(
    `📜 <b>TRADE HISTORY  ─  last ${recent.length} of ${all.length}</b>\n\n` +
    `<code>${rows.join("\n")}</code>`
  );
}

// ── Per-symbol pause / resume ─────────────────────────────────────────────────
// Resolves a short name ("btc", "eth", "akt"…) or "all" to symbol(s).
function resolveSymbol(arg) {
  if (!arg) return [];
  const a = arg.toUpperCase();
  if (a === "ALL") return [...SYMBOLS];
  // exact match first (e.g. "AKT-USD")
  if (SYMBOLS.includes(a)) return [a];
  // short name match: "BTC" → "BTC-USD"
  const hit = SYMBOLS.find(s => s.startsWith(a + "-") || s === a);
  return hit ? [hit] : [];
}

async function cmdPauseSymbol(arg) {
  const targets = resolveSymbol(arg);
  if (!targets.length) {
    await sendTelegram(`❓ Unknown symbol: <code>${arg}</code>\nUse: /pause btc  or  /pause all`);
    return;
  }
  const changed = [];
  for (const sym of targets) {
    const state = loadState(sym);
    if (!state.tradingPaused) {
      state.tradingPaused = true;
      saveState(sym, state);
      changed.push(sym);
    }
  }
  if (!changed.length) {
    await sendTelegram(`ℹ️ ${targets.map(s => s.replace("-USD","")).join(", ")} already paused.`);
  } else {
    const names = changed.map(s => s.replace("-USD","")).join(", ");
    await sendTelegram(`⏸ <b>${names}</b> trading PAUSED.\nSignals will be skipped until you send /resume ${arg.toLowerCase()}`);
    console.log(`[Telegram] PAUSED: ${changed.join(", ")}`);
  }
}

async function cmdResumeSymbol(arg) {
  const targets = resolveSymbol(arg);
  if (!targets.length) {
    await sendTelegram(`❓ Unknown symbol: <code>${arg}</code>\nUse: /resume btc  or  /resume all`);
    return;
  }
  const changed = [];
  for (const sym of targets) {
    const state = loadState(sym);
    if (state.tradingPaused) {
      state.tradingPaused = false;
      saveState(sym, state);
      changed.push(sym);
    }
  }
  if (!changed.length) {
    await sendTelegram(`ℹ️ ${targets.map(s => s.replace("-USD","")).join(", ")} already active.`);
  } else {
    const names = changed.map(s => s.replace("-USD","")).join(", ");
    await sendTelegram(`▶️ <b>${names}</b> trading RESUMED.\nSignals active again.`);
    console.log(`[Telegram] RESUMED: ${changed.join(", ")}`);
  }
}

async function sendHelpMessage() {
  await sendTelegram(
    `🤖 <b>Craig Accum Bot v2 — Commands</b>\n\n` +
    `<b>Status &amp; Prices</b>\n` +
    `/ping   — Health: uptime, last scan, next scan\n` +
    `/price  — Live prices + regime for all symbols\n` +
    `/status — Regime overview + P&amp;L per symbol\n` +
    `/report — Full portfolio report (all symbols)\n\n` +
    `<b>Trades</b>\n` +
    `/trades — Today's trades by symbol\n` +
    `/hist   — Last 20 trades across all symbols\n\n` +
    `<b>Per Symbol</b>\n` +
    `/btc /eth /sol /link /akt /pepe — Symbol snapshot\n\n` +
    `<b>Control</b>\n` +
    `/scan          — Trigger immediate scan now\n` +
    `/pause &lt;sym&gt;  — Pause trading for a symbol (btc, eth, sol…)\n` +
    `/resume &lt;sym&gt; — Resume trading for a symbol\n` +
    `/pause all     — Pause ALL symbols\n` +
    `/resume all    — Resume ALL symbols\n` +
    `/help          — This message\n\n` +
    `<b>Strategy</b>\n` +
    `BTC: 1h regime / 15m exec\n` +
    `ETH · SOL · LINK · AKT: 30m regime / 5m exec\n` +
    `PEPE: 15m regime / 1m exec\n` +
    `Buy: [${BOS_SCALE_PCT_BUY.join(", ")}]%  |  Sell: [${BOS_SCALE_PCT_SELL.join(", ")}]%  UNLIMITED\n\n` +
    `⏰ Auto-reports: 00/06/12/18 UTC  +  EOD 23:55 UTC`
  );
}

// ── Telegram command poller (long-poll getUpdates) ────────────────────────────
// Listens for incoming messages in the authorized chat and dispatches commands.
// Runs as an independent async loop — never blocks the scan cycle.
async function startTelegramPoller() {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("[Telegram] No credentials — command polling disabled");
    return;
  }

  console.log("[Telegram] Command polling started (long-poll, 25s timeout)");

  // Drain any queued updates from before this session so stale commands aren't re-run
  try {
    const drain = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?offset=-1&limit=1`,
      { signal: AbortSignal.timeout(8_000) }
    );
    const dj = await drain.json();
    if (dj.result?.length) tgOffset = dj.result[dj.result.length - 1].update_id + 1;
  } catch {}

  while (true) {
    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates`
        + `?offset=${tgOffset}&timeout=25&allowed_updates=%5B%22message%22%5D`;
      const res  = await fetch(url, { signal: AbortSignal.timeout(32_000) });
      if (!res.ok) { await new Promise(r => setTimeout(r, 5_000)); continue; }
      const json = await res.json();

      for (const update of json.result ?? []) {
        tgOffset = update.update_id + 1;

        const msg  = update.message;
        if (!msg) continue;
        // Only respond to the authorized chat
        if (String(msg.chat.id) !== String(chatId)) continue;

        // Preserve original case for pause/resume argument (symbol name)
        const rawText = (msg.text || "").trim().split("@")[0];
        const text    = rawText.toLowerCase();
        console.log(`[Telegram] Command received: "${text}"`);

        // Per-symbol shortcuts
        const SHORTCUTS = { "/btc":"BTC-USD", "/eth":"ETH-USD", "/sol":"SOL-USD", "/link":"LINK-USD", "/akt":"AKT-USD", "/pepe":"PEPE-USD" };

        // Parse optional argument for /pause and /resume: "/pause btc" → arg="btc"
        const [cmd, cmdArg] = text.split(/\s+/, 2);

        if      (cmd === "/ping"    || cmd === "/p")  { await sendPing(); }
        else if (cmd === "/price"   || cmd === "/px") { await sendPrices(); }
        else if (cmd === "/status"  || cmd === "/s")  { await sendRegimeOverview(); }
        else if (cmd === "/report"  || cmd === "/r")  { await sendPortfolioReport(false); }
        else if (cmd === "/trades"  || cmd === "/t")  { await sendTodaysTrades(); }
        else if (cmd === "/hist"    || cmd === "/history") { await sendTradeHistory(); }
        else if (cmd === "/scan"    || cmd === "/sc") {
          if (scanInProgress) {
            await sendTelegram("⏳ Scan already in progress — please wait.");
          } else {
            await sendTelegram("🔄 Manual scan triggered...");
            runCycle(true).catch(e => sendTelegram(`❌ Scan error: ${e.message}`));
          }
        } else if (cmd === "/pause") {
          await cmdPauseSymbol(cmdArg || "");
        } else if (cmd === "/resume") {
          await cmdResumeSymbol(cmdArg || "");
        } else if (SHORTCUTS[cmd]) {
          await sendTelegram(buildSymbolReport(SHORTCUTS[cmd]));
        } else if (cmd === "/help"  || cmd === "/h")  { await sendHelpMessage(); }
        else if (cmd.startsWith("/")) {
          await sendTelegram(`❓ Unknown: <code>${cmd}</code>\nSend /help for all commands.`);
        }
      }
    } catch (e) {
      // Suppress expected timeout noise from AbortSignal; log real errors
      if (!e.message?.includes("abort") && !e.message?.includes("Abort")) {
        console.error("[Telegram] Poll error:", e.message);
      }
      await new Promise(r => setTimeout(r, 5_000));
    }
  }
}

// ── Console status table ──────────────────────────────────────────────────────
function printStatus() {
  const sep = "─".repeat(76);
  console.log(`\n${sep}`);
  console.log(`  ${new Date().toISOString().slice(0, 19)} UTC  │  Craig Accum Bot v2  │  ${LIVE_TRADING ? "LIVE TRADING" : "Paper Trading"}`);
  console.log(sep);
  console.log(`  ${"Symbol".padEnd(10)} ${"Regime".padEnd(8)} ${"Cash".padStart(10)} ${"Crypto".padStart(14)} ${"Sigs".padStart(6)} ${"Trades".padStart(8)}  Regimes`);
  console.log(`  ${"-".repeat(70)}`);
  for (const symbol of SYMBOLS) {
    try {
      const s = loadState(symbol);
      if (!s.initialized) { console.log(`  ${symbol.padEnd(10)} not yet initialized`); continue; }
      const cfg = SYMBOL_CONFIG[symbol];
      const price    = s.lastPrice || 0;
      const portVal  = s.cash + s.cryptoQty * price;
      const pnlPct   = ((portVal - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100).toFixed(1);
      const pnlStr   = (pnlPct >= 0 ? "+" : "") + pnlPct + "%";
      console.log(
        `  ${symbol.padEnd(10)}` +
        ` ${s.regime.padEnd(8)}` +
        ` $${s.cash.toFixed(2).padStart(9)}` +
        ` ${s.cryptoQty.toFixed(6).padStart(14)}` +
        ` ${String(s.bosCount).padStart(6)}` +
        ` ${String(s.trades.length).padStart(8)}` +
        `  (${s.regimeCount.buy}B/${s.regimeCount.sell}S)  ${pnlStr}`
      );
    } catch {}
  }
  console.log("");
}

// ── Main loop ─────────────────────────────────────────────────────────────────
// manual=true: triggered by /scan command — skips auto-report check so a
// manual scan near a 6h boundary never fires the scheduled 6h report.
async function runCycle(manual = false) {
  if (scanInProgress) {
    console.log("⚠  Scan already in progress — skipping duplicate cycle");
    return;
  }
  scanInProgress = true;
  const start = Date.now();
  const label = manual ? "manual" : "scheduled";
  console.log(`\n⏱  Scanning ${SYMBOLS.length} symbols @ ${new Date().toISOString().slice(0, 19)} UTC  [${label}]`);

  try {
    for (const symbol of SYMBOLS) {
      try {
        await processSymbol(symbol);
      } catch (e) {
        console.error(`[${symbol}] Unhandled error: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 1200));   // brief pause between symbols
    }

    lastScanMs   = Date.now() - start;
    lastScanTime = Date.now();

    printStatus();
    console.log(`  Cycle done in ${(lastScanMs / 1000).toFixed(1)}s — next scan in 5 min`);

    // Send 6h / EOD reports only on scheduled scans — not manual /scan triggers
    if (!manual) await checkAndSendReports();
  } finally {
    scanInProgress = false;
  }
}

async function main() {
  // ── Env validation ──────────────────────────────────────────────────────────
  const missingEnv = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"].filter(k => !process.env[k]);
  if (missingEnv.length) {
    console.warn(`⚠  Missing env vars: ${missingEnv.join(", ")} — Telegram alerts DISABLED`);
  }
  if (LIVE_TRADING) {
    const missingCB = ["COINBASE_API_KEY", "COINBASE_PRIVATE_KEY"].filter(k => !process.env[k]);
    if (missingCB.length) {
      console.error(`❌ LIVE_TRADING=true but missing: ${missingCB.join(", ")} — cannot start`);
      process.exit(1);
    }
    console.log("🔴 LIVE_TRADING=true — real orders will be placed on Coinbase");
  }

  const modeLabel    = LIVE_TRADING ? "🔴 LIVE TRADING"  : "📝 PAPER TRADING";
  const modeLabelTg  = LIVE_TRADING ? "🔴 <b>LIVE TRADING</b>" : "📝 PAPER TRADING";

  // Overwrite stale BotFather command menu (old E2 bot registered E2-specific commands)
  await registerBotCommands();

  console.log("\n" + "═".repeat(66));
  console.log(`  Craig Accumulation Bot  v2  —  ${modeLabel}`);
  console.log("═".repeat(66));
  for (const sym of SYMBOLS) {
    const c = SYMBOL_CONFIG[sym];
    console.log(`  ${sym.padEnd(9)}  exec: ${c.exec.label.padEnd(4)}  regime: ${c.regime.label.padEnd(4)}  EMA${EMA_FAST}/${EMA_SLOW}`);
  }
  console.log(`  Buy     : [${BOS_SCALE_PCT_BUY.join(", ")}]%  │  Sell: [${BOS_SCALE_PCT_SELL.join(", ")}]%  │  UNLIMITED slots`);
  console.log(`  Reports : 6h check-in (00/06/12/18 UTC)  +  EOD at 23:55 UTC`);
  console.log(`  Commands: /ping /price /status /report /trades /hist /scan /btc /eth /sol /link /akt /pepe /help`);
  console.log(`  Capital : $${INITIAL_CAPITAL}/symbol  │  Scan: every 5 min`);
  console.log("═".repeat(66) + "\n");

  await sendTelegram(
    `🤖 <b>Craig Accumulation Bot v2 — STARTED</b>\n` +
    `BTC:  1h  regime / 15m exec\n` +
    `ETH · SOL · LINK · AKT:  30m regime / 5m exec\n` +
    `PEPE: 15m regime / 1m exec\n` +
    `Buy:  [${BOS_SCALE_PCT_BUY.join(", ")}]%  UNLIMITED\n` +
    `Sell: [${BOS_SCALE_PCT_SELL.join(", ")}]%  UNLIMITED\n` +
    `Reports: every 6h + EOD at 23:55 UTC\n` +
    `Commands: /ping /price /status /report /trades /hist /scan\n` +
    `Per symbol: /btc /eth /sol /link /akt /pepe  |  /help for full list\n` +
    `Capital: $${INITIAL_CAPITAL}/symbol  │  ${modeLabelTg}`
  );

  // Start Telegram command listener — auto-restarts on crash with a 30s delay
  ;(async function telegramPollerLoop() {
    while (true) {
      try {
        await startTelegramPoller();
      } catch (e) {
        console.error("[Telegram] Poller crashed:", e.message);
        await sendTelegram(`⚠️ Telegram poller crashed: ${e.message}\nRestarting in 30s — /ping will resume shortly.`);
        await new Promise(r => setTimeout(r, 30_000));
      }
    }
  })();

  // Initial scan
  await runCycle();

  // Align subsequent scans to 5-min clock boundaries (:00, :05, :10 …)
  const nowMs  = Date.now();
  const nextMs = Math.ceil(nowMs / SCAN_INTERVAL_MS) * SCAN_INTERVAL_MS;
  const waitMs = nextMs - nowMs;
  console.log(`  Next aligned scan in ${Math.round(waitMs / 1000)}s`);

  setTimeout(async function loop() {
    await runCycle();
    // Re-align to next 5-min boundary after each cycle to prevent drift from slow scans
    const drift = Date.now() % SCAN_INTERVAL_MS;
    setTimeout(loop, drift > 0 ? SCAN_INTERVAL_MS - drift : SCAN_INTERVAL_MS);
  }, waitMs);
}

main().catch(async err => {
  console.error("Fatal:", err);
  await sendTelegram(`❌ Craig Accum Bot crashed: ${err.message}`);
  process.exit(1);
});
