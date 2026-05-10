#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// craig-accumulation-bot.mjs  — Live Trading  (v2)
//
// STRATEGY (per-symbol timeframes):
//   BTC-USDC  : 30m EMA50/200 regime  →  15m BOS/CHOCH execution
//   ETH-USDC  : 15m EMA50/200 regime  →   5m BOS/CHOCH execution
//   SOL-USDC  : 30m EMA50/200 regime  →   5m BOS/CHOCH execution
//   LINK-USDC : 30m EMA50/200 regime  →   5m BOS/CHOCH execution
//   PEPE-USDC :  1h EMA50/200 regime  →   5m BOS/CHOCH execution  [TREND-FOLLOWING + BTC gate]
//   AKT-USDC  : 15m EMA50/200 regime  →   5m BOS/CHOCH execution
//
//   Death cross  → BUY  regime: scale-in  on each bearish BOS / bullish CHOCH
//   Golden cross → SELL regime: scale-out on each bullish BOS / bearish CHOCH
//   Buy  ladder  : BTC [33,33,33]%  ETH [15,15,15,15]%  SOL [60,25,10,5]%  LINK [60,25,10,5]%  PEPE [60,25,10,5]%  AKT [60,25,10,5]%
//                  % of regime-start capital per BOS signal — UNLIMITED slots (slot 4+ repeats last)
//   Sell ladder  : BTC [10,15,25,50]%  ETH/SOL [5,10,20,40]%  LINK [33,33,33,33]%  PEPE [5,10,20,40]%  AKT [50,25,15,10]%
//                  % of regime-start crypto qty per BOS signal — UNLIMITED slots
//   CHOCH        : continues scale (same per-slot %; no all-in) — BOS-only for BTC/LINK (no CHOCH trades); ETH/SOL/AKT use BOS+CHOCH
//
// REPORTS  : EOD at 23:55 UTC — performance + daily moves + news headlines
// COMMANDS : /status  /report  /trades  /help  (reply in Telegram chat)
// STATE    : craig-state-{SYMBOL}.json  (saved after every bar for crash safety)
// TRADES   : craig-accum-trades.jsonl   (append-only trade log)
// ═══════════════════════════════════════════════════════════════════════════

import "dotenv/config";
import path from "path";
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync, unlinkSync,
         mkdirSync, copyFileSync } from "fs";
import crypto from "crypto";

// ── Persistent state directory ────────────────────────────────────────────────
// Locally defaults to "." (working directory).
// On Railway set STATE_DIR=/app/data and mount a persistent Volume at /app/data
// so state files survive redeploys.
// SEED_DIR holds the one-time bootstrap copies committed to git; they are copied
// to STATE_DIR on first run if STATE_DIR doesn't already have them.
const STATE_DIR  = (process.env.STATE_DIR ?? ".").replace(/\/+$/, "");
const SEED_DIR   = path.join(path.dirname(new URL(import.meta.url).pathname), "data");
const TRADES_LOG        = path.join(STATE_DIR, "craig-accum-trades.jsonl");

// ── Instance identity + duplicate detection ───────────────────────────────────
// Each process start gets a unique 4-byte hex ID so two running instances
// can be told apart immediately in Telegram messages and /ping output.
const BOT_INSTANCE_ID = crypto.randomBytes(4).toString("hex").toUpperCase();
const LOCK_FILE       = path.join(STATE_DIR, "craig-bot.lock");

function acquireInstanceLock() {
  if (existsSync(LOCK_FILE)) {
    try {
      const lock   = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
      const ageMs  = Date.now() - (lock.startedAt ?? 0);
      const ageMin = (ageMs / 60_000).toFixed(1);
      try {
        process.kill(lock.pid, 0);   // signal 0 = is the PID still alive?
        console.warn(`⚠ DUPLICATE — PID ${lock.pid} (id:${lock.id}) running ${ageMin}m`);
        return { duplicate: true, otherPid: lock.pid, otherId: lock.id, ageMin };
      } catch {
        console.log(`[Lock] Stale lock from PID ${lock.pid} (${lock.id}) — cleared`);
      }
    } catch { /* corrupt lock */ }
  }
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, id: BOT_INSTANCE_ID, startedAt: Date.now() }));
  const cleanup = () => { try { unlinkSync(LOCK_FILE); } catch {} };
  process.once("exit",   cleanup);
  process.once("SIGTERM", () => { cleanup(); process.exit(0); });
  process.once("SIGINT",  () => { cleanup(); process.exit(0); });
  return { duplicate: false };
}

// ── Pacific Time display helpers ──────────────────────────────────────────────
// All user-visible timestamps use America/Los_Angeles (auto PST/PDT).
// Internal scheduling logic (hourUTC, minuteUTC) stays on UTC deliberately.
const PT_ZONE = "America/Los_Angeles";
const ptDate = (d = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: PT_ZONE, dateStyle: "short" }).format(d);
const ptTime = (d = new Date(), secs = false) => {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: PT_ZONE, hour: "2-digit", minute: "2-digit",
    ...(secs && { second: "2-digit" }), hourCycle: "h23",
  }).formatToParts(d);
  const g = t => p.find(x => x.type === t)?.value ?? "00";
  return secs ? `${g("hour")}:${g("minute")}:${g("second")}` : `${g("hour")}:${g("minute")}`;
};
const ptZone = (d = new Date()) =>
  new Intl.DateTimeFormat("en-US", { timeZone: PT_ZONE, timeZoneName: "short" })
    .formatToParts(d).find(x => x.type === "timeZoneName")?.value ?? "PT";
const ptStr  = (d = new Date(), secs = false) => `${ptDate(d)} ${ptTime(d, secs)} ${ptZone(d)}`;

// ── Time constants ────────────────────────────────────────────────────────────
const HOUR_MS        = 3_600_000;
const FOUR_HOUR_MS   = 4 * HOUR_MS;   // 14_400_000 — Coinbase has no 4h granularity; we aggregate from 1h
const THIRTY_MIN_MS  = 1_800_000;
const FIFTEEN_MIN_MS =   900_000;

// ── Config ────────────────────────────────────────────────────────────────────
const SYMBOLS              = ["BTC-USDC", "ETH-USDC", "SOL-USDC", "LINK-USDC", "PEPE-USDC", "AKT-USDC"];
const INITIAL_CAPITAL      = 100;
const EMA_FAST             = 50;
const EMA_SLOW             = 200;
const SWING_LB             = 5;
const BOS_SCALE_PCT_BUY    = [15, 15, 15, 15];  // scale-in:  flat-15  — ETH/SOL default (overridden per-symbol below)
const BOS_SCALE_PCT_SELL   = [ 5, 10, 20, 40];  // scale-out: back-steep — ETH/SOL default (overridden per-symbol below)
const REQUIRE_BOS_BEFORE_CHOCH = true;
const CHOCH_CONTINUE_SCALE     = true;
const SCAN_INTERVAL_MS     = 5 * 60 * 1000;   // scan every 5 min
const CB_MAX               = 350;
const WARMUP               = SWING_LB * 2 + 2;

const MAX_TRADES_IN_STATE  = 500;              // cap trades[] in state file to prevent unbounded growth
const MIN_ORDER_USD        = 1.00;             // Coinbase Advanced Trade minimum order size
const MIN_ORDER_QTY        = 1e-8;             // minimum sell qty (dust threshold)

// ── Live trading flag ─────────────────────────────────────────────────────────
// Set LIVE_TRADING=true in .env to place real orders on Coinbase Advanced Trade.
// When false (default), all trades are simulated at bar-close price — paper mode.
const LIVE_TRADING = process.env.LIVE_TRADING === "true";

// Coinbase order precision per symbol — overwritten at startup from live product info.
// base_size (SELL): how many decimal places the crypto quantity may have.
// quote_size (BUY): how many decimal places the USD amount may have.
// Conservative defaults; fetchProductPrecisions() replaces these with real values.
const BASE_SIZE_DECIMALS = {
  "BTC-USDC":  8,
  "ETH-USDC":  8,
  "SOL-USDC":  3,   // Coinbase SOL base_increment = 0.001
  "LINK-USDC": 2,   // Coinbase LINK base_increment = 0.01
  "PEPE-USDC": 0,   // integer PEPE only (base_increment = 1)
  "AKT-USDC":  2,   // conservative default; overwritten at startup by fetchProductPrecisions
};
const QUOTE_SIZE_DECIMALS = {
  "BTC-USDC":  2,
  "ETH-USDC":  2,
  "SOL-USDC":  2,
  "LINK-USDC": 2,
  "PEPE-USDC": 2,
  "AKT-USDC":  2,
};

// Per-symbol execution / regime config
// sellLadder (optional): overrides global BOS_SCALE_PCT_SELL for this symbol only.
// buyLadder  (optional): overrides global BOS_SCALE_PCT_BUY  for this symbol only.
const SYMBOL_CONFIG = {
  "BTC-USDC": {
    exec:      { gran: "FIFTEEN_MINUTE", secs:  900, bars: 250, label: "15m" },
    regime:    { gran: "THIRTY_MINUTE",  secs: 1800, bars: 600, ms: THIRTY_MIN_MS, label: "30m" },
    buyLadder:  [33, 33, 33],        // flat-33 — fewer bigger entries beat flat-15 DCA across all periods
    sellLadder: [10, 15, 25, 50],    // back-mid — hold most for the full rally, better than back-steep at 90/180d
    bosOnly:    true,                // BOS-only: no CHOCH trades (+3.5-4.2% at 90/180d vs BOS+CHOCH)
  },
  "ETH-USDC": {
    exec:  { gran: "FIVE_MINUTE",    secs:  300, bars: 300, label: "5m"  },
    regime:{ gran: "FIFTEEN_MINUTE", secs:  900, bars: 800, ms: FIFTEEN_MIN_MS, label: "15m" },
    bosOnly: false,                  // BOS+CHOCH: +5.77pt avg alpha vs bosOnly across all periods
    // regime 15m → +22.54% avg alpha vs +10.24% at 30m (backtest-eth-combined.mjs, config D)
  },
  "SOL-USDC": {
    exec:  { gran: "FIVE_MINUTE",    secs:  300, bars: 300, label: "5m"  },
    regime:{ gran: "THIRTY_MINUTE",  secs: 1800, bars: 600, ms: THIRTY_MIN_MS,  label: "30m" },
    buyLadder:  [60, 25, 10,  5],    // front-60 — deploy fast; +4.3% at 60d / +5.4% at 90d vs flat-15
  },
  "LINK-USDC": {
    exec:  { gran: "FIVE_MINUTE",    secs:  300, bars: 300, label: "5m"  },
    regime:{ gran: "THIRTY_MINUTE",  secs: 1800, bars: 600, ms: THIRTY_MIN_MS,  label: "30m" },
    buyLadder:  [60, 25, 10,  5],    // front-60 — deploy fast; LINK moves hard, wins all periods vs flat-15
    sellLadder: [33, 33, 33, 33],    // flat-33 — LINK oscillates; uniform distribution beats backloaded
    bosOnly:    true,                // BOS-only: +1.0% at 90d / +3.0% at 180d vs BOS+CHOCH
  },
  // PEPE: trend-following (not contrarian) — meme coins ride narrative supercycles
  //   golden cross → BUY  (ride the pump),  death cross → SELL (exit the dump)
  //   BTC gate: buy signals suppressed when BTC EMA50 < EMA200 (crypto bear market)
  //   buy=front-60 — fast deployment when narrative ignites; wins 60/90/180d
  //   sell=back-steep — let winners run; +10.86% at 180d vs flat-33, better MaxDD
  "PEPE-USDC": {
    exec:           { gran: "FIVE_MINUTE", secs:  300, bars: 300, label: "5m"  },
    regime:         { gran: "ONE_HOUR",    secs: 3600, bars: 600, ms: HOUR_MS, label: "1h" },
    buyLadder:      [60, 25, 10,  5],  // front-60 — deploy fast when narrative ignites
    sellLadder:     [ 5, 10, 20, 40],  // back-steep — let PEPE run, scale out aggressively at end
    trendFollowing: true,              // golden=BUY, death=SELL (opposite of contrarian)
    btcGate:        true,              // only buy when BTC EMA50 > EMA200 (crypto bull market)
    useChochGate:   true,             // gate-closed: pause BOS until aligned CHOCH fires
  },
  // AKT: buy=front-60 (#1 both periods, +23.79% gain vs flat-33 in 90d)
  //      sell=front-50 (#1 in 90d) / front-40 (#1 in 180d) → using front-50 as it wins 90d by larger margin
  "AKT-USDC": {
    exec:   { gran: "FIVE_MINUTE",    secs:  300, bars: 300, label: "5m"  },
    regime: { gran: "FIFTEEN_MINUTE", secs:  900, bars: 600, ms: FIFTEEN_MIN_MS, label: "15m" },
    buyLadder:  [60, 25, 10,  5],  // front-60 — deploy fast; AKT moves hard when it moves (+23% vs flat-33)
    sellLadder: [50, 25, 15, 10],  // front-50 — take profits early; front-loaded beats back-steep by >20%
  },
};

// ── Telegram ──────────────────────────────────────────────────────────────────
let tgOffset           = 0;       // tracks last processed update_id for getUpdates polling
const BOT_START_MS     = Date.now();
let lastScanTime       = 0;       // epoch ms when last scan completed
let lastScanMs         = 0;       // duration of last scan in ms
let scanInProgress     = false;   // prevents concurrent scan cycles
let lastFetchErrAlertMs = 0;      // throttle fetch-error Telegram alerts (max 1/hour)

// Dedup cache: prevents identical trade alerts from two simultaneous instances
// (Railway + local) both detecting the same signal within a 90-second window.
const _tgRecentHashes = new Map();   // hash → sentAtMs
const _TG_DEDUP_MS    = 90_000;

function _msgHash(msg) {
  let h = 0;
  for (let i = 0; i < msg.length; i++) h = (Math.imul(31, h) + msg.charCodeAt(i)) | 0;
  return h;
}

async function sendTelegram(msg) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  // Drop duplicate trade/regime alerts within 90 seconds (not status/command replies)
  const isTradeAlert = /BUY|SELL|CROSS|REGIME|STARTED|DUPLICATE/.test(msg);
  if (isTradeAlert) {
    const hash = _msgHash(msg);
    const now  = Date.now();
    if (_tgRecentHashes.has(hash) && now - _tgRecentHashes.get(hash) < _TG_DEDUP_MS) {
      console.log(`[Telegram] Duplicate suppressed (same alert sent <90s ago)`);
      return;
    }
    _tgRecentHashes.set(hash, now);
    // Evict old entries
    for (const [k, t] of _tgRecentHashes) if (now - t > _TG_DEDUP_MS) _tgRecentHashes.delete(k);
  }

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
    { command: "pause",   description: "Pause a symbol: /pause btc  or  /pause all" },
    { command: "resume",  description: "Resume a symbol: /resume btc  or  /resume all" },
    { command: "setcash",        description: "Fix cash balance: /setcash link 0" },
    { command: "setregimeqty",   description: "Fix sell baseline: /setregimeqty link 10.93" },
    { command: "setcryptoqty",   description: "Force-set cryptoQty: /setcryptoqty eth 0.031" },
    { command: "setpreexisting", description: "Fix pre-existing balance offset: /setpreexisting link 0" },
    { command: "reconcile",     description: "Full state recovery after bad re-init: /reconcile eth" },
    { command: "btc",    description: "BTC-USDC snapshot" },
    { command: "eth",    description: "ETH-USDC snapshot" },
    { command: "sol",    description: "SOL-USDC snapshot" },
    { command: "link",   description: "LINK-USDC snapshot" },
    { command: "pepe",   description: "PEPE-USDC snapshot" },
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
  if (n == null || isNaN(n)) return "0";
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
  const uri   = `${method} api.coinbase.com${path.split("?")[0]}`; // strip query params — Coinbase JWT uri must be method+host+path only
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
  const text = await res.text();
  if (!res.ok) {
    console.error(`[CB] HTTP ${res.status} ${method} ${path} — body: ${text.slice(0, 400)}`);
    throw new Error(`CB ${res.status} ${method} ${path}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`[CB] Non-JSON OK response ${method} ${path}: ${text.slice(0, 200)}`);
    throw e;
  }
}

// Derive decimal places from a Coinbase increment string e.g. "0.001" → 3, "1" → 0
function incrementDecimals(inc) {
  const n = parseFloat(inc);
  if (!n || n >= 1) return 0;
  return Math.ceil(-Math.log10(n));
}

function formatBaseSize(symbol, qty) {
  const dec = BASE_SIZE_DECIMALS[symbol] ?? 6;
  if (dec === 0) return String(Math.floor(qty));
  return qty.toFixed(dec);
}

function formatQuoteSize(symbol, usd) {
  const dec = QUOTE_SIZE_DECIMALS[symbol] ?? 2;
  return usd.toFixed(dec);
}

// Fetch actual base_increment / quote_increment from Coinbase and update precision maps.
// Runs once at startup when LIVE_TRADING=true to ensure we never send too many decimals.
async function fetchProductPrecisions() {
  if (!LIVE_TRADING) return;
  console.log("[Precision] Fetching product increments from Coinbase...");
  for (const sym of SYMBOLS) {
    try {
      const data = await cbFetch("GET", `/api/v3/brokerage/products/${sym}`);
      if (data.base_increment) {
        const dec = incrementDecimals(data.base_increment);
        BASE_SIZE_DECIMALS[sym] = dec;
      }
      if (data.quote_increment) {
        const dec = incrementDecimals(data.quote_increment);
        QUOTE_SIZE_DECIMALS[sym] = dec;
      }
      console.log(`[Precision] ${sym}  base=${data.base_increment}(${BASE_SIZE_DECIMALS[sym]}dp)  quote=${data.quote_increment}(${QUOTE_SIZE_DECIMALS[sym]}dp)`);
    } catch (e) {
      console.warn(`[Precision] ${sym} fetch failed: ${e.message} — using defaults`);
    }
    await new Promise(r => setTimeout(r, 250));
  }
}

async function placeLiveOrder(symbol, side, size) {
  // BUY:  size = USD amount  → quote_size (market buy)
  // SELL: size = crypto qty  → base_size  (market sell)
  const clientOrderId = `craig-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const orderCfg = side === "BUY"
    ? { market_market_ioc: { quote_size: formatQuoteSize(symbol, size) } }
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
  const currency = symbol.replace("-USDC", "");
  const json     = await cbFetch("GET", "/api/v3/brokerage/accounts?limit=250");
  const accounts = json.accounts ?? [];

  // Quote currency is USDC — only sum USDC accounts (not fiat USD)
  const usdTotal = accounts
    .filter(a => a.currency === "USDC")
    .reduce((s, a) => s + parseFloat(a.available_balance?.value ?? 0), 0);

  // Sum ALL accounts for this currency (Coinbase can have multiple sub-accounts / portfolios).
  // Include both available_balance AND hold (amounts in open orders) to get the true total
  // balance — available_balance alone returns 0 when crypto is in a hold or different portfolio.
  const cryptoQty = accounts
    .filter(a => a.currency === currency)
    .reduce((s, a) => {
      const avail = parseFloat(a.available_balance?.value ?? 0);
      const hold  = parseFloat(a.hold?.value ?? 0);
      return s + avail + hold;
    }, 0);

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

// ── Candle aggregation (e.g. 1h → 4h) ────────────────────────────────────────
// Used when Coinbase has no native granularity for the desired regime TF.
// Each bucket keyed by floor(t / targetMs)*targetMs — same anchor logic as the
// backtest scripts so signals are identical to what the backtests measured.
function aggregateCandles(bars, targetMs) {
  const buckets = new Map();
  for (const b of bars) {
    const bucket = Math.floor(b.t / targetMs) * targetMs;
    if (!buckets.has(bucket)) {
      buckets.set(bucket, { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c });
    } else {
      const agg = buckets.get(bucket);
      agg.h = Math.max(agg.h, b.h);
      agg.l = Math.min(agg.l, b.l);
      agg.c = b.c;   // last bar in bucket = close
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
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
function stateFile(symbol) { return path.join(STATE_DIR, `craig-state-${symbol}.json`); }

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
    preExistingCryptoQty: 0,               // crypto held before bot started managing this symbol
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
    chochGate:            false,        // false=closed (must see aligned CHOCH before BOS fires)
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
    if (!("regimeCount"          in state)) state.regimeCount          = { buy: 0, sell: 0 };
    if (!("chochGate"            in state)) state.chochGate            = false;
    if (!("preExistingCryptoQty" in state)) {
      // Migration: derive bot-accumulated qty from trade log; remainder is pre-existing balance.
      // (e.g. if cryptoQty=300 and bot trades show net 50 bought, pre-existing = 250)
      //
      // Special case: botNetQty < 0 means more sells than buys in the log — this is an
      // inherited sell-regime position (e.g. LINK set up via /setregimeqty with no prior
      // buy trades). Treat as fully bot-managed; do NOT strip cryptoQty.
      const botNetQty = (state.trades ?? []).reduce((sum, t) => {
        if (t.type === "scaled_buy")  return sum + (t.qty ?? 0);
        if (t.type === "scaled_sell") return sum - (t.qty ?? 0);
        return sum;
      }, 0);
      if (botNetQty >= 0) {
        state.preExistingCryptoQty = Math.max(0, state.cryptoQty - botNetQty);
        state.cryptoQty            = Math.max(0, botNetQty);
      } else {
        // Inherited position — no pre-existing offset; reconciliation will sync cryptoQty
        state.preExistingCryptoQty = 0;
      }
    }
    return state;
  } catch (e) {
    // State file exists but failed to parse — alert loudly rather than silently resetting.
    // A corrupted reset in live mode means the bot would re-init and misclassify all
    // existing exchange balance as pre-existing, breaking buy sizing and portfolio value.
    console.error(`[${symbol}] State file corrupt — falling back to fresh state: ${e.message}`);
    if (LIVE_TRADING) {
      sendTelegram(`🚨 <b>${symbol}</b> state file corrupted (${e.message})\nFalling back to fresh state — run <code>/reconcile ${symbol.replace("-USDC","")}</code> after first scan to restore correct balances.`).catch(() => {});
    }
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
      // Bot-managed qty = real balance minus any pre-existing balance at init time
      const botQty = Math.max(0, pos.cryptoQty - (state.preExistingCryptoQty ?? 0));
      if (Math.abs(state.cryptoQty - botQty) > 1e-6) {
        const msg = `⚠️ <b>${symbol}</b> position reconciled on startup\n` +
          `State: ${fQty(state.cryptoQty)} → Actual bot-managed: ${fQty(botQty)}\n` +
          `(preExisting: ${fQty(state.preExistingCryptoQty ?? 0)}  total on exchange: ${fQty(pos.cryptoQty)})\n` +
          `Total USD on exchange: $${pos.usdTotal.toFixed(2)}`;
        console.log(`[${symbol}] Reconcile: botQty ${state.cryptoQty} → ${botQty} (preExisting: ${state.preExistingCryptoQty ?? 0})`);
        state.cryptoQty = botQty;
        saveState(symbol, state);
        await sendTelegram(msg);
      } else {
        console.log(`[${symbol}] Reconcile OK: botQty=${state.cryptoQty}  preExisting=${state.preExistingCryptoQty ?? 0}  total on exchange: ${fQty(pos.cryptoQty)}`);
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

  if (candlesExec.length < 50 || candlesRegime.length < 520) {
    console.log(`[${symbol}] Insufficient candles — skipping (exec:${candlesExec.length} regime:${candlesRegime.length})`);
    return;
  }

  // Aggregate regime candles when aggFrom is set (e.g. 1h bars → synthetic 4h for PEPE)
  const regimeBarsForBuild = cfg.regime.aggFrom
    ? aggregateCandles(candlesRegime, cfg.regime.ms)
    : candlesRegime;

  if (cfg.regime.aggFrom && regimeBarsForBuild.length < 220) {
    console.log(`[${symbol}] Insufficient aggregated regime bars (${regimeBarsForBuild.length} after ${cfg.regime.label} agg, need 220) — skipping`);
    return;
  }

  const { crossMap, stateMap } = buildRegime(regimeBarsForBuild, cfg.regime.ms);

  // ── On first run: detect current regime ──────────────────────────────────
  if (!state.initialized) {
    const lastBar = candlesExec.at(-1);

    // Live: sync actual crypto balance FIRST so regime init uses the correct qty.
    // BUG FIXED: previously cryptoQty was fetched AFTER regimeStartCryptoQty was set,
    // causing regimeStartCryptoQty=0 even when the account held real crypto.
    // That silently zeroed every sell order: sellQty = 0 * sellPct% = 0 → skipped.
    if (LIVE_TRADING) {
      try {
        const pos = await fetchCoinbasePosition(symbol);
        // ── Accidental re-init guard ──────────────────────────────────────────
        // If meaningful crypto is on the exchange, this may be an accidental re-init
        // (e.g. state file wiped after a Railway volume issue). Warn loudly and treat
        // the balance as pre-existing so the user can correct with /setpreexisting + /reconcile.
        // For a true first start the user should have 0 or known pre-existing balance.
        if (pos.cryptoQty * lastBar.c > INITIAL_CAPITAL * 0.05) {
          const symShort = symbol.replace("-USDC", "");
          await sendTelegram(
            `⚠️ <b>${symbol}</b> initializing with ${fQty(pos.cryptoQty)} on exchange ($${(pos.cryptoQty * lastBar.c).toFixed(2)}).\n` +
            `If this was <b>bot-managed</b> crypto (not pre-existing), run:\n` +
            `<code>/setpreexisting ${symShort} 0</code>\n` +
            `<code>/reconcile ${symShort}</code>\n\n` +
            `If it was pre-existing, no action needed.`
          );
        }
        // Record pre-existing balance so the bot only tracks its own $INITIAL_CAPITAL
        // allocation. P&L, sell sizing, and reconciliation all exclude preExistingCryptoQty.
        state.preExistingCryptoQty = pos.cryptoQty;
        state.cryptoQty            = 0;   // bot starts fresh — only counts what IT buys/sells
        console.log(`[${symbol}] Live init: preExisting=${pos.cryptoQty}  botQty=0  totalUSD=$${pos.usdTotal.toFixed(2)}`);
      } catch (e) {
        console.error(`[${symbol}] Live init balance fetch failed: ${e.message}`);
      }
    }
    reconciledThisSession.add(symbol);   // mark as reconciled — skip the startup check

    // Now determine regime with accurate cryptoQty.
    // trendFollowing symbols (PEPE): golden=BUY, death=SELL — opposite of normal.
    const periodMs    = cfg.regime.ms;
    const recentClose = Math.floor(lastBar.t / periodMs) * periodMs;
    const initS       = stateMap.get(recentClose);
    const buyInitCross  = cfg.trendFollowing ? "golden" : "death";
    const sellInitCross = cfg.trendFollowing ? "death"  : "golden";

    if (initS === buyInitCross) {
      state.regime             = "buy";
      state.regimeStartCapital = state.cash;
      state.regimeStartPrice   = lastBar.c;
      state.regimeCount.buy++;
    } else if (initS === sellInitCross) {
      state.regime                = "sell";
      state.regimeStartCryptoQty  = state.cryptoQty;   // now correct — real balance already loaded above
      state.regimeStartCapital    = state.cash + state.cryptoQty * lastBar.c;  // full portfolio value at sell start
      state.regimeStartPrice      = lastBar.c;
      state.regimeCount.sell++;
    } else {
      state.regime = "neutral";
    }

    state.lastPrice         = lastBar.c;
    state.lastProcessedBarT = lastBar.t;
    state.initialized       = true;
    saveState(symbol, state);

    const now = ptStr();
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
    console.log(`[${symbol}] No new ${cfg.exec.label} bars since ${ptTime(new Date(state.lastProcessedBarT))} ${ptZone()}`);
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
    // Checked at each regime-candle boundary (every 15m for BTC/ETH/AKT; every 30m for SOL/LINK; every 1h for PEPE)
    //
    // trendFollowing symbols (PEPE): golden cross → BUY (ride the pump), death cross → SELL (exit the dump)
    // contrarian symbols (all others): death cross → BUY (accumulate dip), golden cross → SELL (distribute rally)
    if (bar.t % cfg.regime.ms === 0) {
      const cross = crossMap.get(bar.t);
      const buyOnCross  = cfg.trendFollowing ? "golden" : "death";
      const sellOnCross = cfg.trendFollowing ? "death"  : "golden";

      if (cross === buyOnCross && state.regime !== "buy") {
        state.regime             = "buy";
        state.bosCount           = 0;
        state.regimeStartCapital = state.cash + state.cryptoQty * bar.c;
        state.regimeStartPrice   = bar.c;
        state.regimeCount.buy++;
        // Reset structure tracking so stale pivots from the old regime don't fire false signals
        state.structure = 0; state.lastSH = null; state.lastSL = null;
        // CHOCH gate: reset to closed on regime start (aligned CHOCH required before first BOS)
        if (cfg.useChochGate) state.chochGate = false;
        const crossLabel = cfg.trendFollowing ? "GOLDEN CROSS → TREND BUY" : "DEATH CROSS → BUY";
        const crossEmoji = cfg.trendFollowing ? "🚀" : "☠️";
        const msg = `${crossEmoji} <b>${symbol}</b> ${crossLabel} REGIME\n@ ${fP(bar.c)} | Capital: $${f2(state.regimeStartCapital)}`;
        console.log(`[${symbol}] ${crossLabel} REGIME @ ${fP(bar.c)} | capital $${f2(state.regimeStartCapital)}`);
        alerts.push(msg);
        appendTrade({ symbol, t: bar.t, type: "regime", to: "buy",  price: bar.c, ts: new Date(bar.t).toISOString() });
      } else if (cross === sellOnCross && state.regime !== "sell") {
        state.regime                = "sell";
        state.bosCount              = 0;
        state.regimeStartCryptoQty  = state.cryptoQty;
        state.regimeStartCapital    = state.cash + state.cryptoQty * bar.c;  // full portfolio value at sell start
        state.regimeStartPrice      = bar.c;
        state.regimeCount.sell++;
        // Reset structure tracking so stale pivots from the old regime don't fire false signals
        state.structure = 0; state.lastSH = null; state.lastSL = null;
        // CHOCH gate: reset to closed on regime start
        if (cfg.useChochGate) state.chochGate = false;
        const crossLabel = cfg.trendFollowing ? "DEATH CROSS → TREND SELL" : "GOLDEN CROSS → SELL";
        const crossEmoji = cfg.trendFollowing ? "☠️📉" : "⭐";
        const msg = `${crossEmoji} <b>${symbol}</b> ${crossLabel} REGIME\n@ ${fP(bar.c)} | Crypto: ${fQ(state.regimeStartCryptoQty)}`;
        console.log(`[${symbol}] ${crossLabel} REGIME @ ${fP(bar.c)} | qty ${fQ(state.regimeStartCryptoQty)}`);
        alerts.push(msg);
        appendTrade({ symbol, t: bar.t, type: "regime", to: "sell", price: bar.c, ts: new Date(bar.t).toISOString() });
      }
    }

    // ── 4. Trade execution ───────────────────────────────────────────────────
    const dateStr = ptStr(new Date(bar.t));

    // Allocation % — use per-symbol override if present, else fall back to global ladder
    const symBuyLadder  = cfg.buyLadder  ?? BOS_SCALE_PCT_BUY;
    const symSellLadder = cfg.sellLadder ?? BOS_SCALE_PCT_SELL;
    const buySlot  = idx => symBuyLadder [Math.min(idx, symBuyLadder.length  - 1)];
    const sellSlot = idx => symSellLadder[Math.min(idx, symSellLadder.length - 1)];

    // ── CHOCH gate update ─────────────────────────────────────────────────────
    // Only applies to symbols with cfg.useChochGate (currently PEPE).
    // Gate update runs BEFORE BOS execution so that on a bar where both CHOCH and BOS
    // fire simultaneously the gate state is correct when BOS is evaluated.
    //
    // Trend-following BUY:  bullCHOCH=aligned (opens gate), bearCHOCH=reverse (closes gate)
    // Trend-following SELL: bearCHOCH=aligned (opens gate), bullCHOCH=reverse (closes gate)
    if (cfg.useChochGate) {
      const wasGated = state.chochGate;
      if (state.regime === "buy") {
        if (bullCHOCH) { state.chochGate = true; }   // trend: bull structure confirmed → open
        if (bearCHOCH) { state.chochGate = false; }  // trend: structure broke down   → close
      } else if (state.regime === "sell") {
        if (bearCHOCH) { state.chochGate = true; }   // trend: bear structure confirmed → open
        if (bullCHOCH) { state.chochGate = false; }  // trend: structure reversed up   → close
      }
      if (wasGated !== state.chochGate) {
        const gateLabel = state.chochGate ? "🔓 CHOCH gate OPEN" : "🔒 CHOCH gate CLOSED";
        const chochType = state.chochGate
          ? (state.regime === "buy" ? "bullish CHOCH" : "bearish CHOCH")
          : (state.regime === "buy" ? "bearish CHOCH" : "bullish CHOCH");
        console.log(`[${symbol}] ${gateLabel} (${chochType})`);
        alerts.push(`${state.chochGate ? "🔓" : "🔒"} <b>${symbol}</b> ${gateLabel}\n(${chochType}) @ ${fP(bar.c)}`);
      }
    }

    // ── BUY regime ────────────────────────────────────────────────────────────
    if (state.regime === "buy") {
      // trendFollowing: buy bullBOS (breakout above resistance = momentum)
      // contrarian:     buy bearBOS (break below support  = buy the dip)
      const bosBuySignal = cfg.trendFollowing ? bullBOS : bearBOS;
      const bosLabel     = cfg.trendFollowing ? "bullish BOS" : "bearish BOS";

      // BTC gate: only allow buys when BTC EMA50 > EMA200 (crypto bull market).
      // BTC processes first in SYMBOLS[], so its state is always fresh by the time PEPE runs.
      // btcState.regime === "sell" → BTC golden cross → EMA50 > EMA200 → gate open.
      let btcGateOpen = true;
      if (cfg.btcGate) {
        const btcState = loadState("BTC-USDC");
        btcGateOpen = btcState.regime === "sell";
      }

      // CHOCH gate: BOS only fires when gate is open (cfg.useChochGate must see aligned CHOCH first)
      const chochGateOpen = !cfg.useChochGate || state.chochGate;

      // Scaled BOS buy — UNLIMITED: no slot cap; slots 5+ repeat the last ladder value
      if (bosBuySignal && btcGateOpen && chochGateOpen && state.cash >= MIN_ORDER_USD) {
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
            const msg = `🟢 <b>${symbol}</b> BUY #${state.bosCount} (${bosLabel})\n@ ${fP(fill.price)} | $${f2(fill.usd)} | ${fQ(fill.qty)}\nCash: $${f2(state.cash)} | ${dateStr}`;
            console.log(`[${symbol}] BUY #${state.bosCount} (BOS) @ ${fP(fill.price)} | $${f2(fill.usd)} | cash $${f2(state.cash)}`);
            alerts.push(msg);
          } catch (e) {
            console.error(`[${symbol}] BUY (BOS) order error: ${e.message}`);
            await sendTelegram(`❌ <b>${symbol}</b> BUY (BOS) FAILED: ${e.message}`);
          }
        }
      }

      // CHOCH buy — continues scale; slots 5+ repeat the last ladder value
      // bullCHOCH = structure reverting to uptrend — valid buy for both trend and contrarian
      const chochBuyArmed = !REQUIRE_BOS_BEFORE_CHOCH || state.bosCount >= 1;
      if (CHOCH_CONTINUE_SCALE && !cfg.bosOnly && bullCHOCH && chochBuyArmed && btcGateOpen && state.cash >= MIN_ORDER_USD) {
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
      // trendFollowing: sell bearBOS (breakdown below support = momentum sell)
      // contrarian:     sell bullBOS (break above resistance = sell into rally)
      const bosSellSignal = cfg.trendFollowing ? bearBOS : bullBOS;
      const bosSellLabel  = cfg.trendFollowing ? "bearish BOS" : "bullish BOS";

      // CHOCH gate: BOS only fires when gate is open
      const chochGateOpenSell = !cfg.useChochGate || state.chochGate;

      // Scaled BOS sell — UNLIMITED: no slot cap; slots 5+ repeat the last ladder value
      if (bosSellSignal && chochGateOpenSell && state.cryptoQty >= MIN_ORDER_QTY) {
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
            const msg = `🔴 <b>${symbol}</b> SELL #${state.bosCount} (${bosSellLabel})\n@ ${fP(fill.price)} | $${f2(fill.usd)} | ${fQ(fill.qty)}\nCash: $${f2(state.cash)} | ${dateStr}`;
            console.log(`[${symbol}] SELL #${state.bosCount} (BOS) @ ${fP(fill.price)} | $${f2(fill.usd)} | cash $${f2(state.cash)}`);
            alerts.push(msg);
          } catch (e) {
            console.error(`[${symbol}] SELL (BOS) order error: ${e.message}`);
            await sendTelegram(`❌ <b>${symbol}</b> SELL (BOS) FAILED: ${e.message}`);
          }
        }
      }

      // CHOCH sell — continues scale; slots 5+ repeat the last ladder value
      // bearCHOCH = structure reverting to downtrend — valid sell for both trend and contrarian
      const chochSellArmed = !REQUIRE_BOS_BEFORE_CHOCH || state.bosCount >= 1;
      if (CHOCH_CONTINUE_SCALE && !cfg.bosOnly && bearCHOCH && chochSellArmed && state.cryptoQty >= MIN_ORDER_QTY) {
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
// EOD report at 23:55 UTC — sent once per calendar day.
// State persisted to disk so a restart near midnight never fires a duplicate.
const REPORT_STATE_FILE = path.join(STATE_DIR, "craig-accum-report-state.json");

function loadReportState() {
  try {
    if (existsSync(REPORT_STATE_FILE)) {
      const s = JSON.parse(readFileSync(REPORT_STATE_FILE, "utf8"));
      return { lastEodSentDate: s.lastEodSentDate ?? "" };
    }
  } catch {}
  return { lastEodSentDate: "" };
}

function saveReportState() {
  try {
    writeFileSync(REPORT_STATE_FILE,
      JSON.stringify({ lastEodSentDate }, null, 2));
  } catch (e) { console.error("[Report] Failed to save report state:", e.message); }
}

const _rs = loadReportState();
let lastEodSentDate = _rs.lastEodSentDate;

// ── Fetch 24h price change for all symbols ────────────────────────────────────
async function fetchDailyChanges() {
  const changes = {};
  for (const sym of SYMBOLS) {
    try {
      const now   = Math.floor(Date.now() / 1000);
      const url   = `https://api.coinbase.com/api/v3/brokerage/market/products/${sym}/candles` +
                    `?granularity=ONE_DAY&start=${now - 2 * 86400}&end=${now}`;
      const res   = await fetch(url, { headers: { "User-Agent": "craig-bot/2.0" }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const j       = await res.json();
      const candles = (j.candles ?? j).sort((a, b) => +b.start - +a.start);
      if (candles.length >= 2) {
        const todayClose = +candles[0].close;
        const prevClose  = +candles[1].close;
        changes[sym] = { pct: (todayClose - prevClose) / prevClose * 100, price: todayClose };
      }
    } catch { /* skip on error */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return changes;
}

// ── Fetch top crypto news headlines from RSS ──────────────────────────────────
async function fetchCryptoNews() {
  const sources = [
    { name: "CoinDesk",      url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
    { name: "CoinTelegraph", url: "https://cointelegraph.com/rss" },
  ];
  for (const src of sources) {
    try {
      const res = await fetch(src.url, {
        headers: { "User-Agent": "craig-bot/2.0", "Accept": "application/rss+xml, text/xml" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const xml   = await res.text();
      const items = [];
      const re    = /<item[^>]*>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = re.exec(xml)) !== null && items.length < 5) {
        let title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(m[1])?.[1] ?? "").trim();
        title = title.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "").trim();
        if (title.length > 8) items.push(title);
      }
      if (items.length >= 2) return { source: src.name, items };
    } catch { /* try next source */ }
  }
  return null;
}

function buildSymbolReport(symbol) {
  let s;
  try { s = loadState(symbol); } catch { return `<b>${symbol}</b> — state unavailable`; }
  if (!s.initialized) return `<b>${symbol}</b> — not yet initialized`;

  const cfg       = SYMBOL_CONFIG[symbol];
  const price     = s.lastPrice || 0;
  const portVal   = s.cash + s.cryptoQty * price;
  // P&L baseline: for inherited positions (preExistingCryptoQty > 0, e.g. LINK set via
  // /setregimeqty), the bot's capital allocation is simply INITIAL_CAPITAL — the crypto was
  // already on the exchange and was never purchased out of the bot's $100 cash.
  // For all other symbols, use regimeStartCapital (portfolio value recorded at regime start).
  // Fall back to INITIAL_CAPITAL for old states that never set regimeStartCapital.
  const pnlBaseline = (s.preExistingCryptoQty > 0)
    ? INITIAL_CAPITAL
    : (s.regimeStartCapital || INITIAL_CAPITAL);
  const pnlPct    = ((portVal - pnlBaseline) / pnlBaseline * 100);
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
    // regimeStartCryptoQty > 0 means we had a real position at regime start
    //   cryptoQty ≈ 0 → 100% distributed
    //   cryptoQty > 0 → partial — compute from baseline
    // regimeStartCryptoQty = 0 means no position was ever bought (never entered buy regime)
    //   → show "no position" rather than a misleading %
    let soldPct, noPos = false;
    if (s.regimeStartCryptoQty > 0) {
      soldPct = s.cryptoQty <= MIN_ORDER_QTY
        ? 100
        : (1 - s.cryptoQty / s.regimeStartCryptoQty) * 100;
    } else {
      soldPct = 0; noPos = true;
    }
    deployLine = noPos
      ? `\nNo crypto position  │  Signals: ${s.bosCount}`
      : `\nDistributed: ${soldPct.toFixed(0)}% of crypto  │  Signals: ${s.bosCount}`;
  }

  // Today's trades
  const todayDate = ptDate();
  const todayTrades = s.trades.filter(t => t.ts && ptDate(new Date(t.ts)) === todayDate);

  // Last 2 trades
  const recentLines = s.trades.slice(-2).map(t => {
    const dt   = `${ptDate(new Date(t.t)).slice(5)} ${ptTime(new Date(t.t))}`;
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

async function sendPortfolioReport() {
  const now     = new Date();
  const timeStr = ptStr(now);
  const dateStr = ptDate(now);

  // ── Part 1: portfolio performance ───────────────────────────────────────────
  let totalPortVal = 0;
  const symbolBlocks = [];
  const stateCache   = {};  // reuse for analysis section

  for (const symbol of SYMBOLS) {
    try {
      const s = loadState(symbol);
      stateCache[symbol] = s;
      const p = s.lastPrice || 0;
      totalPortVal += s.initialized ? s.cash + s.cryptoQty * p : INITIAL_CAPITAL;
      symbolBlocks.push(buildSymbolReport(symbol));
    } catch {
      totalPortVal += INITIAL_CAPITAL;
      symbolBlocks.push(`<b>${symbol}</b> — error reading state`);
    }
  }

  const totalStart  = SYMBOLS.length * INITIAL_CAPITAL;
  const totalPnlPct = (totalPortVal - totalStart) / totalStart * 100;
  const totalSign   = totalPnlPct >= 0 ? "+" : "";

  const header = `📊 <b>END OF DAY  ─  ${dateStr}</b>\n${timeStr}`;
  const footer =
    `\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>TOTAL: $${totalPortVal.toFixed(2)} / $${totalStart}  (${totalSign}${totalPnlPct.toFixed(2)}%)</b>`;

  await sendTelegram(header + "\n\n" + symbolBlocks.join("\n\n") + footer);

  // ── Part 2: daily analysis ──────────────────────────────────────────────────
  // Fetch 24h changes and news in parallel
  const [dailyChanges, news] = await Promise.allSettled([
    fetchDailyChanges(),
    fetchCryptoNews(),
  ]).then(r => r.map(x => x.status === "fulfilled" ? x.value : null));

  const lines = [`🔍 <b>EOD ANALYSIS  ─  ${dateStr}</b>\n`];

  // ── Daily moves per coin ───────────────────────────────────────────────────
  if (dailyChanges && Object.keys(dailyChanges).length) {
    lines.push(`<b>📈 24H Price Change</b>`);
    const blackSwans = [];
    for (const sym of SYMBOLS) {
      const d = dailyChanges[sym];
      if (!d) { lines.push(`  ${sym.replace("-USDC","").padEnd(5)}  —`); continue; }
      const sign  = d.pct >= 0 ? "+" : "";
      const emoji = d.pct >= 15 ? "🚀" : d.pct >= 8 ? "📈" : d.pct >= 0 ? "🟢" :
                    d.pct <= -15 ? "💥" : d.pct <= -8 ? "📉" : "🔴";
      const flag  = Math.abs(d.pct) >= 8 ? "  ⚠️ notable" : "";
      lines.push(`  ${emoji} ${sym.replace("-USDC","").padEnd(5)}  ${sign}${d.pct.toFixed(2)}%${flag}`);
      if (Math.abs(d.pct) >= 12)
        blackSwans.push({ sym: sym.replace("-USDC",""), pct: d.pct });
    }
    // Black swans
    if (blackSwans.length) {
      lines.push(`\n🚨 <b>Black Swan Alert</b>`);
      for (const bs of blackSwans) {
        const dir  = bs.pct > 0 ? "surge" : "crash";
        const sign = bs.pct > 0 ? "+" : "";
        lines.push(`  ${bs.sym}: ${sign}${bs.pct.toFixed(1)}% — extreme ${dir}. Check positions + news.`);
      }
    }
  }

  // ── What went right ─────────────────────────────────────────────────────────
  const rightsLines = [], wrongsLines = [];
  const todayDate = dateStr;

  for (const symbol of SYMBOLS) {
    const s = stateCache[symbol];
    if (!s?.initialized) continue;

    const price    = s.lastPrice || 0;
    const portVal  = s.cash + s.cryptoQty * price;
    const baseline = s.preExistingCryptoQty > 0 ? INITIAL_CAPITAL : (s.regimeStartCapital || INITIAL_CAPITAL);
    const pnlPct   = (portVal - baseline) / baseline * 100;

    let hodlPct = null;
    if (s.regimeStartPrice > 0 && price > 0)
      hodlPct = (price / s.regimeStartPrice - 1) * 100;
    const edge = hodlPct !== null ? pnlPct - hodlPct : null;

    const todayTrades = s.trades.filter(t => t.ts && ptDate(new Date(t.ts)) === todayDate);
    const coin = symbol.replace("-USDC", "");
    const d24  = dailyChanges?.[symbol];

    // Went right: positive edge, or active trading in a coin up today
    if (edge !== null && edge > 5)
      rightsLines.push(`  ✅ ${coin}: +${edge.toFixed(1)}% alpha over HODL in current regime`);
    else if (todayTrades.length > 0 && d24 && d24.pct > 3)
      rightsLines.push(`  ✅ ${coin}: ${todayTrades.length} trade${todayTrades.length>1?"s":""} executed, coin up ${d24.pct.toFixed(1)}% today`);
    else if (s.regime === "sell" && s.cryptoQty <= 1e-8 && pnlPct > 0)
      rightsLines.push(`  ✅ ${coin}: fully distributed in SELL regime with +${pnlPct.toFixed(1)}% gain secured`);

    // Went wrong: negative edge, stale state, or no activity while coin moved hard
    const barAgeMin = s.lastProcessedBarT ? (Date.now() - s.lastProcessedBarT) / 60_000 : 0;
    if (s.tradingPaused)
      wrongsLines.push(`  ⚠️ ${coin}: trading PAUSED — remember to /resume when ready`);
    else if (barAgeMin > 30)
      wrongsLines.push(`  ⚠️ ${coin}: last bar ${Math.round(barAgeMin)}m ago — possible data stall`);
    else if (edge !== null && edge < -8)
      wrongsLines.push(`  ❌ ${coin}: underperforming HODL by ${edge.toFixed(1)}% this regime`);
    else if (d24 && d24.pct < -8 && s.regime === "buy" && s.cash < 5)
      wrongsLines.push(`  ❌ ${coin}: down ${d24.pct.toFixed(1)}% today while fully deployed in BUY regime`);
  }

  if (rightsLines.length) {
    lines.push(`\n<b>✅ What Went Right</b>`);
    lines.push(...rightsLines);
  }
  if (wrongsLines.length) {
    lines.push(`\n<b>⚠️ Watch List</b>`);
    lines.push(...wrongsLines);
  }
  if (!rightsLines.length && !wrongsLines.length)
    lines.push(`\n<i>No notable events — steady state.</i>`);

  // ── News headlines ──────────────────────────────────────────────────────────
  if (news?.items?.length) {
    lines.push(`\n<b>📰 Crypto News  (${news.source})</b>`);
    for (const headline of news.items.slice(0, 5))
      lines.push(`  • ${headline}`);
  } else {
    lines.push(`\n<i>News unavailable.</i>`);
  }

  await sendTelegram(lines.join("\n"));
  console.log(`[Report] Sent EOD report @ ${timeStr}`);
}

async function checkAndSendReports() {
  const now       = new Date();
  const hourUTC   = now.getUTCHours();
  const minuteUTC = now.getUTCMinutes();
  const dateStr   = now.toISOString().slice(0, 10);

  // EOD report at 23:55 UTC — once per calendar day, safe across restarts
  if (hourUTC === 23 && minuteUTC >= 55 && lastEodSentDate !== dateStr) {
    await sendPortfolioReport();
    lastEodSentDate = dateStr;
    saveReportState();
  }
}

// ── Telegram command: today's trades list ────────────────────────────────────
async function sendTodaysTrades() {
  const todayDate = ptDate();
  const lines     = [];
  let   totalCount = 0;

  for (const symbol of SYMBOLS) {
    try {
      const s      = loadState(symbol);
      const today  = s.trades.filter(t => t.ts?.startsWith(todayDate));
      totalCount  += today.length;
      if (!today.length) { lines.push(`<b>${symbol}</b> — no trades today`); continue; }
      const rows = today.map(t => {
        const dt   = ptTime(new Date(t.t));
        const icon = t.type.includes("buy") ? "🟢" : "🔴";
        const side = t.type === "scaled_buy"  ? `BUY  #${t.bosNum} BOS`
                   : t.type === "choch_buy"   ? `BUY  #${t.bosNum} CHOCH`
                   : t.type === "scaled_sell" ? `SELL #${t.bosNum} BOS`
                   : t.type === "choch_sell"  ? `SELL #${t.bosNum} CHOCH`
                   : t.type;
        return `  ${icon} ${side.padEnd(16)} ${fPrice(t.price).padStart(14)}  ${dt} ${ptZone(new Date(t.t))}`;
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
    ? `${ptTime(new Date(lastScanTime), true)} ${ptZone(new Date(lastScanTime))}  (${(lastScanMs / 1000).toFixed(1)}s)`
    : "not yet";
  const nextMs  = lastScanTime
    ? Math.ceil(lastScanTime / SCAN_INTERVAL_MS) * SCAN_INTERVAL_MS : null;
  const nextStr = nextMs ? `${ptTime(new Date(nextMs))} ${ptZone(new Date(nextMs))}` : "soon";

  await sendTelegram(
    `🏓 <b>Pong — Bot is alive</b>\n\n` +
    `Uptime    : ${uptime}\n` +
    `Last scan : ${lastStr}\n` +
    `Next scan : ~${nextStr}\n` +
    `Symbols   : ${SYMBOLS.length}  [${SYMBOLS.map(s => s.replace("-USDC","")).join(" · ")}]\n` +
    `Capital   : $${INITIAL_CAPITAL}/sym  ($${SYMBOLS.length * INITIAL_CAPITAL} total)\n` +
    `Regimes   : BTC=30m  ETH=15m  SOL/LINK=30m  PEPE=1h  AKT=15m\n` +
    `Buy scale : BTC=[${(SYMBOL_CONFIG["BTC-USDC"].buyLadder ?? BOS_SCALE_PCT_BUY).join(",")}]%  ETH=[${BOS_SCALE_PCT_BUY.join(",")}]%  SOL=[${(SYMBOL_CONFIG["SOL-USDC"].buyLadder ?? BOS_SCALE_PCT_BUY).join(",")}]%  LINK=[${(SYMBOL_CONFIG["LINK-USDC"].buyLadder ?? BOS_SCALE_PCT_BUY).join(",")}]%  PEPE=[${(SYMBOL_CONFIG["PEPE-USDC"].buyLadder ?? BOS_SCALE_PCT_BUY).join(",")}]%  AKT=[${(SYMBOL_CONFIG["AKT-USDC"].buyLadder ?? BOS_SCALE_PCT_BUY).join(",")}]%\n` +
    `Sell scale: BTC=[${(SYMBOL_CONFIG["BTC-USDC"].sellLadder ?? BOS_SCALE_PCT_SELL).join(",")}]%  ETH/SOL=[${BOS_SCALE_PCT_SELL.join(",")}]%  LINK=[${(SYMBOL_CONFIG["LINK-USDC"].sellLadder ?? BOS_SCALE_PCT_SELL).join(",")}]%  PEPE=[${(SYMBOL_CONFIG["PEPE-USDC"].sellLadder ?? BOS_SCALE_PCT_SELL).join(",")}]%  AKT=[${(SYMBOL_CONFIG["AKT-USDC"].sellLadder ?? BOS_SCALE_PCT_SELL).join(",")}]%\n` +
    (() => { try { const ps = loadState("PEPE-USDC"); return `PEPE gate : ${ps.chochGate ? "🔓 OPEN" : "🔒 CLOSED"}  (regime: ${ps.regime})\n`; } catch { return ""; } })() +
    `Report    : EOD at 23:55 UTC  (portfolio + analysis + news)\n` +
    `Instance  : <code>${BOT_INSTANCE_ID}</code>  ← if you see two IDs, a duplicate is running`
  );
}

async function sendPrices() {
  const lines = SYMBOLS.map(sym => {
    try {
      const s   = loadState(sym);
      const cfg = SYMBOL_CONFIG[sym];
      const icon  = s.regime === "buy" ? "☠️" : s.regime === "sell" ? "⭐" : "⏸ ";
      const name  = sym.replace("-USDC","").padEnd(5);
      const price = fPrice(s.lastPrice || 0).padStart(15);
      const reg   = s.regime.toUpperCase().padEnd(7);
      return `${icon} ${name} ${price}  [${reg}]  ${cfg.exec.label}/${cfg.regime.label}`;
    } catch { return `❌ ${sym}  error`; }
  });
  const t = `${ptTime(new Date(), true)} ${ptZone()}`;
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
      const name  = sym.replace("-USDC","").padEnd(5);
      const reg   = s.regime.toUpperCase().padEnd(7);
      const ovBaseline = (s.preExistingCryptoQty > 0)
        ? INITIAL_CAPITAL
        : (s.regimeStartCapital || INITIAL_CAPITAL);
      const pnl   = ((val - ovBaseline) / ovBaseline * 100);
      const pnlS  = (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + "%";
      let detail  = "";
      if (s.regime === "buy") {
        const dep = s.cryptoQty * price;
        const pct = val > 0 ? (dep / val * 100).toFixed(0) : 0;
        detail = `dep:${pct}% sig:${s.bosCount}`;
      } else if (s.regime === "sell") {
        const sp = s.regimeStartCryptoQty > 0
          ? (s.cryptoQty <= MIN_ORDER_QTY
              ? "100"
              : ((1 - s.cryptoQty / s.regimeStartCryptoQty) * 100).toFixed(0))
          : "—";   // no position ever held in this sell regime
        detail = `sold:${sp}% sig:${s.bosCount}`;
      }
      const pauseTag = s.tradingPaused ? " ⏸" : "";
      lines.push(`${icon} ${name} [${reg}] $${val.toFixed(2)} (${pnlS})  ${detail}${pauseTag}`);
    } catch { lines.push(`❌ ${sym}  error`); }
  }
  const totalStart = SYMBOLS.length * INITIAL_CAPITAL;
  const totalPnl   = ((totalVal - totalStart) / totalStart * 100);
  const t = `${ptTime(new Date(), true)} ${ptZone()}`;
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
    const dt   = `${ptDate(new Date(t.t)).slice(5)} ${ptTime(new Date(t.t))}`;
    const sym  = t.symbol.replace("-USDC","").padEnd(5);
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
  // exact match first (e.g. "AKT-USDC")
  if (SYMBOLS.includes(a)) return [a];
  // short name match: "BTC" → "BTC-USDC"
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
    await sendTelegram(`ℹ️ ${targets.map(s => s.replace("-USDC","")).join(", ")} already paused.`);
  } else {
    const names = changed.map(s => s.replace("-USDC","")).join(", ");
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
    await sendTelegram(`ℹ️ ${targets.map(s => s.replace("-USDC","")).join(", ")} already active.`);
  } else {
    const names = changed.map(s => s.replace("-USDC","")).join(", ");
    await sendTelegram(`▶️ <b>${names}</b> trading RESUMED.\nSignals active again.`);
    console.log(`[Telegram] RESUMED: ${changed.join(", ")}`);
  }
}

async function sendBackup() {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  let summary = `💾 <b>State Backup</b> — ${ts}\n<code>Instance: ${BOT_INSTANCE_ID}</code>\n\n`;
  let restoreBlock = `<b>Restore commands (paste if state wiped):</b>\n<code>`;

  for (const sym of SYMBOLS) {
    try {
      const s     = loadState(sym);
      const short = sym.replace("-USDC", "").toLowerCase();
      const portVal = s.cash + s.cryptoQty * (s.lastPrice || 0);
      const pxStr   = s.lastPrice ? ` @ ${fPrice(s.lastPrice)}` : "";

      summary +=
        `<b>${sym}</b>  ${s.regime.toUpperCase()}  ≈$${portVal.toFixed(2)}\n` +
        `  cash: $${s.cash.toFixed(2)}  crypto: ${fQty(s.cryptoQty)}${pxStr}\n` +
        `  regimeStartCap: $${s.regimeStartCapital.toFixed(2)}` +
        (s.regimeStartCryptoQty > 0 ? `  regimeStartQty: ${fQty(s.regimeStartCryptoQty)}` : "") +
        (( s.preExistingCryptoQty ?? 0) > 0 ? `  preExisting: ${fQty(s.preExistingCryptoQty)}` : "") +
        `  bosCount: ${s.bosCount}  trades: ${s.trades.length}\n\n`;

      restoreBlock += `/setcash ${short} ${s.cash.toFixed(2)}\n`;
      restoreBlock += `/setcryptoqty ${short} ${fQty(s.cryptoQty)}\n`;
      if (s.regimeStartCryptoQty > 0)
        restoreBlock += `/setregimeqty ${short} ${fQty(s.regimeStartCryptoQty)}\n`;
      if ((s.preExistingCryptoQty ?? 0) > 0)
        restoreBlock += `/setpreexisting ${short} ${fQty(s.preExistingCryptoQty)}\n`;
      restoreBlock += `\n`;
    } catch (e) {
      summary += `<b>${sym}</b>  ⚠️ read error: ${e.message}\n\n`;
    }
  }

  restoreBlock += `</code>`;
  await sendTelegram(summary + restoreBlock);
  console.log("[Telegram] /backup sent");
}

async function sendHelpMessage() {
  await sendTelegram(
    `🤖 <b>Craig Accum Bot v2 — Commands</b>\n\n` +
    `<b>Status &amp; Prices</b>\n` +
    `/ping          — Health: uptime, last scan, next scan\n` +
    `/price  — Live prices + regime for all symbols\n` +
    `/status — Regime overview + P&amp;L per symbol\n` +
    `/report — Full portfolio report (all symbols)\n\n` +
    `<b>Trades</b>\n` +
    `/trades — Today's trades by symbol\n` +
    `/hist   — Last 20 trades across all symbols\n\n` +
    `<b>Per Symbol</b>\n` +
    `/btc /eth /sol /link /pepe /akt — Symbol snapshot\n\n` +
    `<b>Control</b>\n` +
    `/scan          — Trigger immediate scan now\n` +
    `/backup        — Snapshot all state to Telegram (cash, crypto, regimeStartCap per symbol + restore commands)\n` +
    `/pause &lt;sym&gt;        — Pause trading for a symbol (btc, eth, sol…)\n` +
    `/resume &lt;sym&gt;       — Resume trading for a symbol\n` +
    `/pause all           — Pause ALL symbols\n` +
    `/resume all          — Resume ALL symbols\n` +
    `/setcash &lt;sym&gt; &lt;$&gt;      — Manually correct cash balance\n` +
    `/setregimeqty &lt;sym&gt; &lt;qty&gt; — Fix sell baseline qty (e.g. /setregimeqty link 10.93)\n` +
    `/setcryptoqty &lt;sym&gt; &lt;qty&gt; — Force-set cryptoQty directly (e.g. /setcryptoqty eth 0.031)\n` +
    `/setpreexisting &lt;sym&gt; &lt;qty&gt; — Fix pre-existing balance offset (e.g. /setpreexisting link 0)\n` +
    `/reconcile &lt;sym&gt;       — Full state recovery after bad re-init (fixes cryptoQty + regimeStartCapital)\n` +
    `/help                — This message\n\n` +
    `<b>Strategy</b>\n` +
    `BTC: 30m regime / 15m exec\n` +
    `ETH: 15m regime / 5m exec  [BOS+CHOCH]\n` +
    `SOL · LINK: 30m regime / 5m exec\n` +
    `PEPE: 1h regime / 5m exec  [TREND + BTC gate]\n` +
    `AKT: 15m regime / 5m exec\n` +
    `Buy:  BTC=[${(SYMBOL_CONFIG["BTC-USDC"].buyLadder ?? BOS_SCALE_PCT_BUY).join(",")}]%  ETH=[${BOS_SCALE_PCT_BUY.join(",")}]%  SOL=[${(SYMBOL_CONFIG["SOL-USDC"].buyLadder ?? BOS_SCALE_PCT_BUY).join(",")}]%  LINK=[${(SYMBOL_CONFIG["LINK-USDC"].buyLadder ?? BOS_SCALE_PCT_BUY).join(",")}]%  PEPE=[${(SYMBOL_CONFIG["PEPE-USDC"].buyLadder ?? BOS_SCALE_PCT_BUY).join(",")}]%  AKT=[${(SYMBOL_CONFIG["AKT-USDC"].buyLadder ?? BOS_SCALE_PCT_BUY).join(",")}]%\n` +
    `Sell: BTC=[${(SYMBOL_CONFIG["BTC-USDC"].sellLadder ?? BOS_SCALE_PCT_SELL).join(",")}]%  ETH/SOL=[${BOS_SCALE_PCT_SELL.join(",")}]%  LINK=[${(SYMBOL_CONFIG["LINK-USDC"].sellLadder ?? BOS_SCALE_PCT_SELL).join(",")}]%  PEPE=[${(SYMBOL_CONFIG["PEPE-USDC"].sellLadder ?? BOS_SCALE_PCT_SELL).join(",")}]%  AKT=[${(SYMBOL_CONFIG["AKT-USDC"].sellLadder ?? BOS_SCALE_PCT_SELL).join(",")}]%\n\n` +
    `⏰ Auto-report: EOD at 23:55 UTC  (portfolio + analysis + news)`
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
        const SHORTCUTS = { "/btc":"BTC-USDC", "/eth":"ETH-USDC", "/sol":"SOL-USDC", "/link":"LINK-USDC", "/pepe":"PEPE-USDC", "/akt":"AKT-USDC" };

        // Parse optional argument for /pause and /resume: "/pause btc" → arg="btc"
        const [cmd, cmdArg] = text.split(/\s+/, 2);

        if      (cmd === "/ping"    || cmd === "/p")  { await sendPing(); }
        else if (cmd === "/price"   || cmd === "/px") { await sendPrices(); }
        else if (cmd === "/status"  || cmd === "/s")  { await sendRegimeOverview(); }
        else if (cmd === "/report"  || cmd === "/r")  { await sendPortfolioReport(); }
        else if (cmd === "/trades"  || cmd === "/t")  { await sendTodaysTrades(); }
        else if (cmd === "/hist"    || cmd === "/history") { await sendTradeHistory(); }
        else if (cmd === "/backup"  || cmd === "/bk") { await sendBackup(); }
        else if (cmd === "/scan"    || cmd === "/sc") {
          if (scanInProgress) {
            await sendTelegram("⏳ Scan already in progress — please wait.");
          } else {
            await sendTelegram("🔄 Manual scan triggered...");
            runCycle(true).catch(e => sendTelegram(`❌ Scan error: ${e.message}`));
          }
        } else if (cmd === "/setcash") {
          // /setcash <symbol> <amount>  e.g. /setcash link 0
          const parts = rawText.trim().split(/\s+/);
          const symRaw = (parts[1] || "").toUpperCase();
          const sym = symRaw.includes("-") ? symRaw : `${symRaw}-USDC`;
          const amount = parseFloat(parts[2]);
          if (!SYMBOL_CONFIG[sym] || isNaN(amount) || amount < 0) {
            await sendTelegram(`❌ Usage: /setcash &lt;symbol&gt; &lt;amount&gt;\nExample: <code>/setcash LINK 0</code>`);
          } else {
            const st = loadState(sym);
            const old = st.cash.toFixed(2);
            st.cash = amount;
            saveState(sym, st);
            await sendTelegram(`✅ <b>${sym}</b> cash updated: $${old} → $${amount.toFixed(2)}`);
          }
        } else if (cmd === "/setregimeqty") {
          // /setregimeqty <symbol> <qty>  e.g. /setregimeqty link 10.93
          // Fixes regimeStartCryptoQty when it was zeroed out at init (sell-regime init bug).
          const parts  = rawText.trim().split(/\s+/);
          const symRaw = (parts[1] || "").toUpperCase();
          const sym    = symRaw.includes("-") ? symRaw : `${symRaw}-USDC`;
          const qty    = parseFloat(parts[2]);
          if (!SYMBOL_CONFIG[sym] || isNaN(qty) || qty < 0) {
            await sendTelegram(`❌ Usage: /setregimeqty &lt;symbol&gt; &lt;qty&gt;\nExample: <code>/setregimeqty LINK 10.93</code>\n\nSets regimeStartCryptoQty — the baseline used to calculate sell ladder sizes.`);
          } else {
            const st  = loadState(sym);
            const old = st.regimeStartCryptoQty;
            st.regimeStartCryptoQty = qty;
            saveState(sym, st);
            const pct = ((qty * st.lastPrice)).toFixed(2);
            await sendTelegram(
              `✅ <b>${sym}</b> regimeStartCryptoQty updated: ${fQty(old)} → ${fQty(qty)}\n` +
              `≈ $${pct} @ current price\n` +
              `Sell ladder will now use this as the 100% baseline.`
            );
          }
        } else if (cmd === "/setcryptoqty") {
          // /setcryptoqty <symbol> <qty>  e.g. /setcryptoqty eth 0.031
          // Directly overrides cryptoQty in state — nuclear option when /reconcile can't
          // read the correct balance from Coinbase (e.g. available_balance shows 0 due to
          // holds, staking, or API quirks).  Use the actual bot-managed ETH qty from
          // Coinbase's portfolio view.
          const parts  = rawText.trim().split(/\s+/);
          const symRaw = (parts[1] || "").toUpperCase();
          const sym    = symRaw.includes("-") ? symRaw : `${symRaw}-USDC`;
          const qty    = parseFloat(parts[2]);
          if (!SYMBOL_CONFIG[sym] || isNaN(qty) || qty < 0) {
            await sendTelegram(`❌ Usage: /setcryptoqty &lt;symbol&gt; &lt;qty&gt;\nExample: <code>/setcryptoqty ETH 0.031</code>\n\nDirectly sets cryptoQty — use when /reconcile shows wrong balance from Coinbase.`);
          } else {
            const st  = loadState(sym);
            const old = st.cryptoQty;
            st.cryptoQty = qty;
            // Also fix regimeStartCapital if it looks like a bad re-init
            if (st.regimeStartCapital < INITIAL_CAPITAL) st.regimeStartCapital = INITIAL_CAPITAL;
            saveState(sym, st);
            const portVal = st.cash + qty * (st.lastPrice || 1);
            await sendTelegram(
              `✅ <b>${sym}</b> cryptoQty: ${fQty(old)} → ${fQty(qty)}\n` +
              `<b>cash:</b>     $${st.cash.toFixed(2)}\n` +
              `<b>portVal:</b>  $${portVal.toFixed(2)}  (@ $${fPrice(st.lastPrice || 1)})\n` +
              `<b>regime:</b>   ${st.regime}  (regimeStartCap: $${st.regimeStartCapital.toFixed(2)})\n\n` +
              `Run /scan to resume.`
            );
          }
        } else if (cmd === "/setpreexisting") {
          // /setpreexisting <symbol> <qty>  e.g. /setpreexisting link 0
          // Fixes preExistingCryptoQty and immediately re-derives botQty from the exchange.
          // Use when migration wrongly classified bot-managed crypto as pre-existing.
          const parts  = rawText.trim().split(/\s+/);
          const symRaw = (parts[1] || "").toUpperCase();
          const sym    = symRaw.includes("-") ? symRaw : `${symRaw}-USDC`;
          const qty    = parseFloat(parts[2]);
          if (!SYMBOL_CONFIG[sym] || isNaN(qty) || qty < 0) {
            await sendTelegram(`❌ Usage: /setpreexisting &lt;symbol&gt; &lt;qty&gt;\nExample: <code>/setpreexisting LINK 0</code>\n\nSets preExistingCryptoQty (crypto held before bot started managing this symbol).`);
          } else {
            const st    = loadState(sym);
            const oldPx = st.preExistingCryptoQty ?? 0;
            st.preExistingCryptoQty = qty;
            // Immediately re-derive bot-managed qty from exchange (don't wait for next startup reconcile)
            if (LIVE_TRADING) {
              try {
                const pos = await fetchCoinbasePosition(sym);
                st.cryptoQty = Math.max(0, pos.cryptoQty - qty);
                saveState(sym, st);
                const portVal = st.cash + st.cryptoQty * st.lastPrice;
                await sendTelegram(
                  `✅ <b>${sym}</b> preExistingCryptoQty: ${fQty(oldPx)} → ${fQty(qty)}\n` +
                  `Bot-managed qty: ${fQty(st.cryptoQty)}  (real on exchange: ${fQty(pos.cryptoQty)})\n` +
                  `Portfolio: $${portVal.toFixed(2)}`
                );
              } catch (e) {
                saveState(sym, st);
                await sendTelegram(`⚠️ <b>${sym}</b> preExistingCryptoQty set to ${fQty(qty)} but balance fetch failed: ${e.message}`);
              }
            } else {
              saveState(sym, st);
              await sendTelegram(`✅ <b>${sym}</b> preExistingCryptoQty: ${fQty(oldPx)} → ${fQty(qty)} (paper mode — no balance sync)`);
            }
          }
        } else if (cmd === "/reconcile") {
          // /reconcile <symbol>  e.g. /reconcile eth
          // Full state recovery after accidental re-init or state corruption.
          // Fetches real balance from Coinbase, corrects cryptoQty and regimeStartCapital.
          const parts  = rawText.trim().split(/\s+/);
          const symRaw = (parts[1] || "").toUpperCase();
          const sym    = symRaw.includes("-") ? symRaw : `${symRaw}-USDC`;
          if (!SYMBOL_CONFIG[sym]) {
            await sendTelegram(`❌ Usage: /reconcile &lt;symbol&gt;\nExample: <code>/reconcile ETH</code>`);
          } else if (!LIVE_TRADING) {
            await sendTelegram(`❌ /reconcile only works in live trading mode.`);
          } else {
            try {
              const st  = loadState(sym);
              const pos = await fetchCoinbasePosition(sym);
              const oldCrypto = st.cryptoQty;
              const oldRSC    = st.regimeStartCapital;
              const oldRSCQ   = st.regimeStartCryptoQty;

              // Fix 1: cryptoQty = actual exchange balance minus any pre-existing
              st.cryptoQty = Math.max(0, pos.cryptoQty - (st.preExistingCryptoQty ?? 0));

              // Fix 2: regimeStartCapital — only reset to INITIAL_CAPITAL when the current
              // value is clearly wrong (below INITIAL_CAPITAL, as happens after an accidental
              // re-init where it gets set to just the remaining cash ~$26).  If it's at or
              // above INITIAL_CAPITAL the bot is running normally and we must not overwrite it
              // (e.g. legitimate growth to $180 in a long-running regime would be destroyed).
              if (st.regimeStartCapital < INITIAL_CAPITAL) {
                st.regimeStartCapital = INITIAL_CAPITAL;
              }

              // Fix 3: if sell regime, regimeStartCryptoQty must be >= cryptoQty (we can
              // only have sold some fraction of what we started with).  Fix both the
              // zero case (bad re-init) AND the nonzero-but-wrong case (e.g. manual
              // setregimeqty error, or value from a different regime cycle).
              if (st.regime === "sell" && st.regimeStartCryptoQty < st.cryptoQty) {
                st.regimeStartCryptoQty = st.cryptoQty;
              }

              saveState(sym, st);

              const portVal = st.cash + st.cryptoQty * (st.lastPrice || 1);
              await sendTelegram(
                `✅ <b>${sym}</b> reconciled\n\n` +
                `<b>cryptoQty:</b>       ${fQty(oldCrypto)} → ${fQty(st.cryptoQty)}\n` +
                `<b>preExisting:</b>     ${fQty(st.preExistingCryptoQty ?? 0)}\n` +
                `<b>on exchange:</b>     ${fQty(pos.cryptoQty)}\n` +
                `<b>regimeStartCap:</b>  $${oldRSC.toFixed(2)} → $${st.regimeStartCapital.toFixed(2)}\n` +
                `<b>regimeStartQty:</b>  ${fQty(oldRSCQ)} → ${fQty(st.regimeStartCryptoQty)}\n` +
                `<b>cash:</b>           $${st.cash.toFixed(2)}\n` +
                `<b>portVal:</b>        $${portVal.toFixed(2)}\n` +
                `<b>regime:</b>         ${st.regime}\n\n` +
                `Run /scan to resume normal operation.`
              );
            } catch (e) {
              await sendTelegram(`❌ <b>${sym}</b> reconcile failed: ${e.message}`);
            }
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
  console.log(`  ${ptStr(new Date(), true)}  │  Craig Accum Bot v2  │  ${LIVE_TRADING ? "LIVE TRADING" : "Paper Trading"}`);
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
  console.log(`\n⏱  Scanning ${SYMBOLS.length} symbols @ ${ptStr(new Date(), true)}  [${label}]`);

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

    // Send EOD report only on scheduled scans — not manual /scan triggers
    if (!manual) await checkAndSendReports();
  } finally {
    scanInProgress = false;
  }
}

async function main() {
  // ── State directory + seed bootstrap ───────────────────────────────────────
  // Must run before any file reads so STATE_DIR exists and is populated.
  seedStateDir();

  // ── One-time state wipe (e.g. paper → live migration) ──────────────────────
  // Set RESET_STATE=true in Railway env vars, deploy once, then remove it.
  // Deletes all symbol state files so the bot re-initialises fresh with live balances.
  if (process.env.RESET_STATE === "true") {
    console.log("[Reset] RESET_STATE=true — wiping all symbol state files");
    for (const sym of SYMBOLS) {
      const f = stateFile(sym);
      if (existsSync(f)) { unlinkSync(f); console.log(`[Reset] Deleted ${f}`); }
    }
    if (existsSync(TRADES_LOG)) { unlinkSync(TRADES_LOG); console.log("[Reset] Deleted trades log"); }
    const reportState = path.join(STATE_DIR, "craig-accum-report-state.json");
    if (existsSync(reportState)) { unlinkSync(reportState); }
    console.log("[Reset] Done — bot will initialise fresh. Remove RESET_STATE from env after this deploy.");
  }

  // ── Duplicate-instance detection ────────────────────────────────────────────
  // Writes a lock file with this process's PID + BOT_INSTANCE_ID.
  // On startup, if another PID is still alive we warn via Telegram immediately.
  // NOTE: only catches same-machine duplicates (e.g. PM2 + direct node).
  // Cross-machine duplicates (e.g. Railway + local) are identified by instance ID
  // shown in /ping and the startup message — if you see two different IDs respond
  // to a command, two bots are running and you need to stop one.
  const lockResult = acquireInstanceLock();
  if (lockResult.duplicate) {
    console.warn(`[Lock] Duplicate detected — other instance ID: ${lockResult.otherId}`);
    // Still send the warning even if Telegram creds aren't loaded yet (dotenv ran above)
    await sendTelegram(
      `⚠️ <b>DUPLICATE BOT INSTANCE DETECTED</b>\n\n` +
      `New instance  : <code>${BOT_INSTANCE_ID}</code>\n` +
      `Already running: PID ${lockResult.otherPid} (<code>${lockResult.otherId}</code>)` +
      ` — running for ${lockResult.ageMin} min\n\n` +
      `Two bots share the same Telegram token → commands get double responses.\n` +
      `Run <code>pm2 list</code> or check Railway dashboards and stop the duplicate.`
    );
  }

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
    // ── Private key diagnostic ──────────────────────────────────────────────────
    try {
      const rawKey = (process.env.COINBASE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
      const lines  = rawKey.split("\n");
      console.log(`[CB Key diag] raw length=${rawKey.length} lines=${lines.length}`);
      console.log(`[CB Key diag] first line: "${lines[0]}"`);
      console.log(`[CB Key diag] last line:  "${lines[lines.length - 1]}"`);
      const keyObj = crypto.createPrivateKey(rawKey);
      const { asymmetricKeyType, asymmetricKeyDetails } = keyObj;
      console.log(`[CB Key diag] parsed OK — type=${asymmetricKeyType} namedCurve=${asymmetricKeyDetails?.namedCurve}`);
    } catch (e) {
      console.error(`[CB Key diag] key parse FAILED: ${e.message}`);
    }
    // ── Quick auth check — logs key ID, JWT claims, HTTP status + headers ────────
    (async () => {
      try {
        const apiKeyId = process.env.COINBASE_API_KEY ?? "";
        console.log(`[CB Auth check] key ID prefix: "${apiKeyId.slice(0, 60)}"`);
        const jwt = buildJWT("GET", "/api/v3/brokerage/accounts");
        const payloadB64 = jwt.split(".")[1];
        const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
        console.log(`[CB Auth check] JWT claims: sub=${claims.sub?.slice(-36)} iss=${claims.iss} uri="${claims.uri}"`);
        const testRes = await fetch("https://api.coinbase.com/api/v3/brokerage/accounts", {
          headers: { "Authorization": `Bearer ${jwt}`, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        const testBody = await testRes.text();
        const wwwAuth  = testRes.headers.get("www-authenticate") ?? "(none)";
        console.log(`[CB Auth check] HTTP ${testRes.status} www-auth: ${wwwAuth} — body[:300]: ${testBody.slice(0, 300)}`);
      } catch (e) {
        console.error(`[CB Auth check] request failed: ${e.message}`);
      }
    })();
  }

  const modeLabel    = LIVE_TRADING ? "🔴 LIVE TRADING"  : "📝 PAPER TRADING";
  const modeLabelTg  = LIVE_TRADING ? "🔴 <b>LIVE TRADING</b>" : "📝 PAPER TRADING";

  // Fetch live product precision from Coinbase (fixes "too many decimals" order rejections)
  await fetchProductPrecisions();

  // Overwrite stale BotFather command menu (old E2 bot registered E2-specific commands)
  await registerBotCommands();

  console.log("\n" + "═".repeat(66));
  console.log(`  Craig Accumulation Bot  v2  —  ${modeLabel}`);
  console.log(`  Instance ID: ${BOT_INSTANCE_ID}`);
  console.log("═".repeat(66));
  for (const sym of SYMBOLS) {
    const c    = SYMBOL_CONFIG[sym];
    const buy  = (c.buyLadder  ?? BOS_SCALE_PCT_BUY).join(",");
    const sell = (c.sellLadder ?? BOS_SCALE_PCT_SELL).join(",");
    console.log(`  ${sym.padEnd(9)}  exec: ${c.exec.label.padEnd(4)}  regime: ${c.regime.label.padEnd(4)}  EMA${EMA_FAST}/${EMA_SLOW}  buy:[${buy}]%  sell:[${sell}]%`);
  }
  console.log(`  Buy (default) : [${BOS_SCALE_PCT_BUY.join(", ")}]%  │  Sell (default): [${BOS_SCALE_PCT_SELL.join(", ")}]%  │  UNLIMITED slots`);
  console.log(`  Reports : EOD at 23:55 UTC  (portfolio + analysis + news)`);
  console.log(`  Commands: /ping /price /status /report /trades /hist /scan /btc /eth /sol /link /pepe /akt /help`);
  console.log(`  Capital : $${INITIAL_CAPITAL}/symbol  │  Scan: every 5 min`);
  console.log("═".repeat(66) + "\n");

  await sendTelegram(
    `🤖 <b>Craig Accumulation Bot v2 — STARTED</b>\n` +
    `Instance: <code>${BOT_INSTANCE_ID}</code>\n\n` +
    `BTC: 30m regime / 15m exec\n` +
    `ETH: 15m regime / 5m exec  [BOS+CHOCH]\n` +
    `SOL · LINK: 30m regime / 5m exec\n` +
    `PEPE: 1h regime / 5m exec  [TREND + BTC gate]\n` +
    `AKT: 15m regime / 5m exec\n` +
    `Buy:  BTC=[${(SYMBOL_CONFIG["BTC-USDC"].buyLadder ?? BOS_SCALE_PCT_BUY).join(",")}]%  ETH=[${BOS_SCALE_PCT_BUY.join(",")}]%  SOL=[${(SYMBOL_CONFIG["SOL-USDC"].buyLadder ?? BOS_SCALE_PCT_BUY).join(",")}]%  LINK=[${(SYMBOL_CONFIG["LINK-USDC"].buyLadder ?? BOS_SCALE_PCT_BUY).join(",")}]%  PEPE=[${(SYMBOL_CONFIG["PEPE-USDC"].buyLadder ?? BOS_SCALE_PCT_BUY).join(",")}]%  AKT=[${(SYMBOL_CONFIG["AKT-USDC"].buyLadder ?? BOS_SCALE_PCT_BUY).join(",")}]%\n` +
    `Sell: BTC=[${(SYMBOL_CONFIG["BTC-USDC"].sellLadder ?? BOS_SCALE_PCT_SELL).join(",")}]%  ETH/SOL=[${BOS_SCALE_PCT_SELL.join(",")}]%  LINK=[${(SYMBOL_CONFIG["LINK-USDC"].sellLadder ?? BOS_SCALE_PCT_SELL).join(",")}]%  PEPE=[${(SYMBOL_CONFIG["PEPE-USDC"].sellLadder ?? BOS_SCALE_PCT_SELL).join(",")}]%  AKT=[${(SYMBOL_CONFIG["AKT-USDC"].sellLadder ?? BOS_SCALE_PCT_SELL).join(",")}]%\n` +
    `Reports: EOD at 23:55 UTC  (portfolio + analysis + news)\n` +
    `Commands: /ping /price /status /report /trades /hist /scan\n` +
    `Per symbol: /btc /eth /sol /link /pepe /akt  |  /help for full list\n` +
    `Capital: $${INITIAL_CAPITAL}/symbol  │  ${modeLabelTg}\n\n` +
    `⚠️ If you see TWO of these start messages, a duplicate bot is running.\n` +
    `Use /ping to compare instance IDs — stop the older one.`
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

// ── State directory bootstrap ─────────────────────────────────────────────────
// Ensures STATE_DIR exists, then copies any seed files from ./data/ that don't
// yet exist in STATE_DIR. Seed files are committed to git once so Railway's
// volume starts with the correct state rather than reinitialising from scratch.
// On subsequent deploys the volume files already exist — seed is a no-op.
function seedStateDir() {
  // Ensure the directory exists (important when STATE_DIR=/app/data and volume just mounted)
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch {}

  if (!existsSync(SEED_DIR)) {
    console.log(`[Seed] No seed directory found at ${SEED_DIR} — skipping`);
    return;
  }

  const candidates = [
    ...SYMBOLS.map(s => `craig-state-${s}.json`),
    "craig-accum-trades.jsonl",
    "craig-accum-report-state.json",
  ];

  let copied = 0;
  for (const fname of candidates) {
    const src = path.join(SEED_DIR, fname);
    const dst = path.join(STATE_DIR, fname);
    if (existsSync(src) && !existsSync(dst)) {
      try {
        copyFileSync(src, dst);
        console.log(`[Seed] ✓ ${fname} → ${STATE_DIR}`);
        copied++;
      } catch (e) {
        console.error(`[Seed] Failed to copy ${fname}: ${e.message}`);
      }
    }
  }
  if (copied === 0) {
    console.log(`[Seed] STATE_DIR already populated — no files copied`);
  } else {
    console.log(`[Seed] Copied ${copied} seed file(s) into ${STATE_DIR}`);
  }
}

main().catch(async err => {
  console.error("Fatal:", err);
  await sendTelegram(`❌ Craig Accum Bot crashed: ${err.message}`);
  process.exit(1);
});
