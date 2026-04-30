/**
 * Craig Bot — SMC/ICT 3-Step Strategy (BTC-USD)
 * Based on Craig Percoco's "Range → Change → Execution" framework
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STEP 1 — RANGE (15-minute timeframe)
 *   Determine market structure and bias:
 *   • Break of Structure (BOS): HH+HL = bullish trend | LL+LH = bearish trend
 *   • Change of Character (CHOCH): price breaks opposite structure swing point
 *   • Fair Value Gaps (FVG): 3-candle imbalance → candle[i-1].high < candle[i+1].low
 *   • Liquidity Inflection Levels (LIL): key swing highs/lows acting as S/R
 *
 * STEP 2 — CHANGE (1-minute timeframe)
 *   Confirm entry direction:
 *   • Wait for 1m CHOCH aligned with 15m bias
 *   • Identify FVG formed at or around the 1m CHOCH
 *   • Find LIL (swing high/low) associated with the CHOCH
 *   • Require high-impact candle (large body ≥ 40% of range) closing through structure
 *
 * STEP 3 — EXECUTION
 *   Enter the trade:
 *   • Entry: price pulls back INTO the FVG zone (≤ FVG midpoint for longs)
 *   • Stop Loss: just outside the LIL (swing low − 0.15% for longs)
 *   • Take Profit: entry + 4 × (entry − SL) = 1:4 initial R:R
 *   • Break-Even: move SL to entry when new swing low forms above entry (long)
 *   • Can ride to 6-9R when 15m draw-in liquidity aligns
 *
 * FILTERS:
 *   • Skip if 15m trend is neutral (no clear BOS structure)
 *   • Skip if CHOCH candle has small body (< 40% of range) — choppy/weak signal
 *   • Skip FVGs that have already been filled (price closed through bottom for long)
 *   • Mark NY Open (9:30 AM ET) — best setups often form here
 *   • One position at a time; wait for full resolution before re-entry
 *
 * SYMBOL: BTC-USD (Coinbase Advanced Trade)
 * TIMEFRAMES: 15-minute (bias) + 1-minute (execution)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import crypto from "crypto";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol:       process.env.CRAIG_SYMBOL    || "BTC-USD",
  paperTrading: process.env.CRAIG_PAPER     !== "false",   // default paper mode
  riskUSD:      parseFloat(process.env.CRAIG_RISK_USD || "15"),  // $ risked per trade
  maxPositionUSD: parseFloat(process.env.CRAIG_MAX_POS_USD || "200"), // hard cap on position size

  // Strategy parameters
  swingLookback:   5,     // bars on each side to confirm a swing high/low
  fvgMinGapPct:    0.05,  // FVG minimum gap size as % of price (filters micro-gaps)
  chochBodyPct:    0.40,  // CHOCH candle body must be ≥ 40% of its range (high-impact)
  fvgMaxAgeMs:     30 * 60 * 1000, // discard FVGs older than 30 minutes
  setupExpiryMs:   30 * 60 * 1000, // reset idle if setup not triggered within 30 min
  slBufferPct:     0.15,  // SL placed 0.15% beyond LIL
  initialRR:       4,     // initial risk:reward (1:4)

  telegram: {
    token:  process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  coinbase: {
    apiKey:     process.env.COINBASE_API_KEY,
    privateKey: process.env.COINBASE_PRIVATE_KEY,
  },
};

const PORTFOLIO_FILE  = "craig-portfolio.json";
const LOG_FILE        = "craig-log.json";
const SCAN_INTERVAL   = 60 * 1000;  // scan every 1 minute

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(msg) {
  const { token, chatId } = CONFIG.telegram;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "HTML" }),
    });
  } catch (e) { console.error("Telegram error:", e.message); }
}

// ─── Market Data ──────────────────────────────────────────────────────────────

const CB_GRAN = {
  "1m":  { gran: "ONE_MINUTE",     secs: 60     },
  "15m": { gran: "FIFTEEN_MINUTE", secs: 900    },
};

async function fetchCandles(symbol, tf, limit = 200) {
  const { gran, secs } = CB_GRAN[tf];
  const batchEnd   = Math.floor(Date.now() / 1000);
  const batchStart = batchEnd - limit * secs;
  const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${symbol}/candles`
    + `?start=${batchStart}&end=${batchEnd}&granularity=${gran}&limit=${limit}`;

  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Coinbase candles ${res.status} for ${symbol} ${tf}`);
  const json = await res.json();
  if (!json.candles?.length) throw new Error(`No candles returned for ${symbol} ${tf}`);

  return json.candles.slice().reverse().map(c => ({
    time:   parseInt(c.start) * 1000,
    open:   parseFloat(c.open),
    high:   parseFloat(c.high),
    low:    parseFloat(c.low),
    close:  parseFloat(c.close),
    volume: parseFloat(c.volume),
  }));
}

async function getCurrentPrice(symbol) {
  try {
    const res  = await fetch(
      `https://api.coinbase.com/api/v3/brokerage/market/products/${symbol}`,
      { signal: AbortSignal.timeout(5000) }
    );
    const d = await res.json();
    return parseFloat(d.price || 0);
  } catch { return 0; }
}

// ─── Technical: Swing Point Detection ─────────────────────────────────────────
// A confirmed swing high at index i requires: all bars within `lb` bars on each
// side have a LOWER high. We exclude the last `lb` bars (still potentially forming).

function detectSwings(candles, lb = 5) {
  const highs = [], lows = [];
  const end = candles.length - lb;  // leave lb bars unconfirmed

  for (let i = lb; i < end; i++) {
    const slice = candles.slice(i - lb, i + lb + 1);
    const isHigh = slice.every((c, j) => j === lb || c.high <= candles[i].high);
    const isLow  = slice.every((c, j) => j === lb || c.low  >= candles[i].low);
    if (isHigh) highs.push({ idx: i, price: candles[i].high, time: candles[i].time });
    if (isLow)  lows.push({ idx: i, price: candles[i].low,  time: candles[i].time });
  }
  return { highs, lows };
}

// ─── Technical: Market Structure (BOS) ────────────────────────────────────────
// Bullish BOS  = latest swing high > previous swing high  AND latest swing low > previous swing low (HH + HL)
// Bearish BOS  = latest swing low  < previous swing low   AND latest swing high < previous swing high (LL + LH)
// Returns: "bullish" | "bearish" | "neutral"

function detectStructure(highs, lows) {
  if (highs.length < 2 || lows.length < 2) return "neutral";

  const recentH = highs.slice(-2);
  const recentL = lows.slice(-2);

  const isHH = recentH[1].price > recentH[0].price;
  const isHL  = recentL[1].price > recentL[0].price;
  const isLL  = recentL[1].price < recentL[0].price;
  const isLH  = recentH[1].price < recentH[0].price;

  if (isHH && isHL) return "bullish";
  if (isLL && isLH) return "bearish";
  return "neutral";
}

// ─── Technical: CHOCH Detection ───────────────────────────────────────────────
// Bullish CHOCH on 1m: bearish sequence (LL+LH) then a candle CLOSES ABOVE the
//   last confirmed swing high in that bearish run.
// Returns: null | { type, breakLevel, chochIdx, chochCandle }

function detectCHOCH(candles, highs, lows, direction) {
  if (direction === "bullish") {
    // Looking for a BEARISH sequence on 1m followed by a break UPWARD (CHOCH to bullish)
    // Find the most recent swing low (will become our LIL candidate)
    // Then find the last LH (lower high) that was broken to the upside
    if (highs.length < 2) return null;

    // The most recent LH (lower high) is the structure point to break
    const lastHigh = highs[highs.length - 1];
    const prevHigh = highs[highs.length - 2];

    // Only look for a CHOCH break if there was a lower high (bearish sequence)
    if (lastHigh.price >= prevHigh.price) return null; // no bearish LH to break

    // Scan candles after the lastHigh for a close above it
    for (let i = lastHigh.idx + 1; i < candles.length; i++) {
      if (candles[i].close > lastHigh.price) {
        return {
          type:       "bullish",
          breakLevel: lastHigh.price,
          chochIdx:   i,
          chochCandle: candles[i],
        };
      }
    }
    return null;
  }

  if (direction === "bearish") {
    // Looking for a BULLISH sequence on 1m followed by a break DOWNWARD (CHOCH to bearish)
    if (lows.length < 2) return null;
    const lastLow  = lows[lows.length - 1];
    const prevLow  = lows[lows.length - 2];
    if (lastLow.price <= prevLow.price) return null; // no bullish HL to break

    for (let i = lastLow.idx + 1; i < candles.length; i++) {
      if (candles[i].close < lastLow.price) {
        return {
          type:       "bearish",
          breakLevel: lastLow.price,
          chochIdx:   i,
          chochCandle: candles[i],
        };
      }
    }
    return null;
  }

  return null;
}

// ─── Technical: Fair Value Gap Detection ──────────────────────────────────────
// Bullish FVG: candles[i-1].high < candles[i+1].low  (upward imbalance)
// Bearish FVG: candles[i-1].low  > candles[i+1].high (downward imbalance)
// Returns array of FVG objects sorted newest-first, excluding filled ones.

function detectFVGs(candles, direction, minGapPct = 0.0005) {
  const fvgs = [];
  const closes = candles.map(c => c.close);
  const avgPrice = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const minGap = avgPrice * minGapPct;

  for (let i = 1; i < candles.length - 1; i++) {
    const c0 = candles[i - 1], c1 = candles[i], c2 = candles[i + 1];

    if (direction === "bullish") {
      // Gap between c0.high (bottom of gap) and c2.low (top of gap)
      const gap = c2.low - c0.high;
      if (gap >= minGap) {
        const fvg = {
          bottom:   c0.high,
          top:      c2.low,
          midpoint: (c0.high + c2.low) / 2,
          idx:      i,
          time:     c1.time,
          direction: "bullish",
          filled:   false,
        };
        // Check if FVG has already been filled (price closed below bottom after formation)
        for (let j = i + 2; j < candles.length; j++) {
          if (candles[j].close < fvg.bottom) { fvg.filled = true; break; }
        }
        if (!fvg.filled) fvgs.push(fvg);
      }
    } else if (direction === "bearish") {
      // Gap between c2.high (bottom of gap) and c0.low (top of gap)
      const gap = c0.low - c2.high;
      if (gap >= minGap) {
        const fvg = {
          bottom:    c2.high,
          top:       c0.low,
          midpoint:  (c2.high + c0.low) / 2,
          idx:       i,
          time:      c1.time,
          direction: "bearish",
          filled:    false,
        };
        for (let j = i + 2; j < candles.length; j++) {
          if (candles[j].close > fvg.top) { fvg.filled = true; break; }
        }
        if (!fvg.filled) fvgs.push(fvg);
      }
    }
  }
  // Return newest first, limited to last 10
  return fvgs.reverse().slice(0, 10);
}

// ─── Technical: High-Impact Candle Check ──────────────────────────────────────
// Returns true if the candle's body is ≥ `minBodyPct` fraction of its total range.

function isHighImpact(candle, minBodyPct = 0.40) {
  const range = candle.high - candle.low;
  if (range === 0) return false;
  const body = Math.abs(candle.close - candle.open);
  return body / range >= minBodyPct;
}

// ─── Technical: NY Open Check ─────────────────────────────────────────────────
// Returns true if current UTC time corresponds to 9:30 AM Eastern Time.
// Best setups form in the first 1–2 hours of the NY session.

function isNYSession(tsMs = Date.now()) {
  const d = new Date(tsMs);
  // Eastern = UTC-5 (EST) or UTC-4 (EDT). Approximate: use UTC-4 for summer.
  const etHour = (d.getUTCHours() + 20) % 24; // crude ET offset (UTC-4)
  return etHour >= 9 && etHour < 16;
}

function isNYOpen(tsMs = Date.now()) {
  const d = new Date(tsMs);
  const etHour = (d.getUTCHours() + 20) % 24;
  const etMin  = d.getUTCMinutes();
  // 9:30–11:00 AM ET is prime time
  return (etHour === 9 && etMin >= 30) || etHour === 10 || (etHour === 11 && etMin === 0);
}

// ─── State Management ─────────────────────────────────────────────────────────

function loadState() {
  const defaults = {
    phase:         "idle",   // idle | setup_detected | in_position
    bias:          "neutral",
    setup: null,             // { fvg, lil, chochCandle, detectedAt (bar idx) }
    position: null,          // { side, entry, sl, tp, beLevel, qty, entryTime }
    stats: { wins: 0, losses: 0, breakevens: 0, totalRealizedPnL: 0 },
  };
  if (!existsSync(PORTFOLIO_FILE)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(PORTFOLIO_FILE, "utf8")) };
  } catch { return defaults; }
}

function saveState(s) {
  writeFileSync(PORTFOLIO_FILE, JSON.stringify(s, null, 2));
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function logTrade(entry) {
  let log = [];
  if (existsSync(LOG_FILE)) {
    try { log = JSON.parse(readFileSync(LOG_FILE, "utf8")); } catch {}
  }
  log.push({ ...entry, timestamp: new Date().toISOString() });
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

// ─── Coinbase JWT & Orders ─────────────────────────────────────────────────────

function buildJWT(method, path) {
  const apiKey     = CONFIG.coinbase.apiKey;
  const privateKey = CONFIG.coinbase.privateKey.replace(/\\n/g, "\n");
  const now   = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  const uri   = `${method} api.coinbase.com${path}`;
  const header  = Buffer.from(JSON.stringify({ alg: "ES256", kid: apiKey, nonce })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: apiKey, iss: "cdp", nbf: now, exp: now + 120, uri })).toString("base64url");
  const sigInput = `${header}.${payload}`;
  const sig = crypto.sign("SHA256", Buffer.from(sigInput), {
    key: crypto.createPrivateKey(privateKey), dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${sigInput}.${sig}`;
}

async function placeMarketOrder(symbol, side, sizeUSD, sellQty = null) {
  if (CONFIG.paperTrading) {
    console.log(`📝 PAPER ${side} ${symbol} $${sizeUSD.toFixed(2)}`);
    return { orderId: `paper-${Date.now()}` };
  }

  const path     = "/api/v3/brokerage/orders";
  const clientId = `craig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const orderConfig = side === "BUY"
    ? { market_market_ioc: { quote_size: sizeUSD.toFixed(2) } }
    : { market_market_ioc: { base_size:  (sellQty).toFixed(8) } };

  const body = JSON.stringify({
    client_order_id:     clientId,
    product_id:          symbol,
    side:                side,
    order_configuration: orderConfig,
  });

  const res  = await fetch(`https://api.coinbase.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${buildJWT("POST", path)}` },
    body,
  });
  const data = await res.json();
  if (!data.success) {
    const reason = data.error_response?.message || JSON.stringify(data);
    throw new Error(`Coinbase order failed: ${reason}`);
  }
  return { orderId: data.order_id || clientId };
}

// ─── Setup Analysis ────────────────────────────────────────────────────────────
// Full 3-step analysis: returns setup object or null.

function analyzeSetup(candles1m, candles15m) {
  // ── Step 1: 15m bias ─────────────────────────────────────────────────────────
  const { highs: h15, lows: l15 } = detectSwings(candles15m, CONFIG.swingLookback);
  const bias = detectStructure(h15, l15);
  if (bias === "neutral") return { bias: "neutral", setup: null };

  // ── Step 2: 1m CHOCH + FVG ───────────────────────────────────────────────────
  const { highs: h1, lows: l1 } = detectSwings(candles1m, CONFIG.swingLookback);
  const choch = detectCHOCH(candles1m, h1, l1, bias);
  if (!choch) return { bias, setup: null };

  // CHOCH candle must be high-impact (large body)
  if (!isHighImpact(choch.chochCandle, CONFIG.chochBodyPct)) {
    return { bias, setup: null };
  }

  // Find FVGs on 1m that formed AROUND or AFTER the CHOCH (within 5 bars of it)
  const direction = bias === "bullish" ? "bullish" : "bearish";
  const allFVGs = detectFVGs(candles1m, direction, CONFIG.fvgMinGapPct / 100);

  // Filter to FVGs near the CHOCH (within 5 bars idx AND less than 30 min old by timestamp)
  const now = Date.now();
  const nearFVGs = allFVGs.filter(fvg =>
    Math.abs(fvg.idx - choch.chochIdx) <= 5 &&
    (now - fvg.time) <= CONFIG.fvgMaxAgeMs
  );
  if (!nearFVGs.length) return { bias, setup: null };

  const bestFVG = nearFVGs[0]; // newest valid FVG near CHOCH

  // Find the LIL: the swing low (for long) or swing high (for short) associated with the CHOCH
  let lil = null;
  if (bias === "bullish") {
    // LIL = the swing low closest to and before the CHOCH candle
    const relevantLows = l1.filter(l => l.idx < choch.chochIdx);
    if (!relevantLows.length) return { bias, setup: null };
    lil = relevantLows[relevantLows.length - 1]; // most recent low before CHOCH
  } else {
    const relevantHighs = h1.filter(h => h.idx < choch.chochIdx);
    if (!relevantHighs.length) return { bias, setup: null };
    lil = relevantHighs[relevantHighs.length - 1];
  }

  return {
    bias,
    setup: {
      direction,
      fvg: bestFVG,
      lil,
      choch,
      detectedAt: Date.now(),  // timestamp for setup expiry
    },
  };
}

// ─── Position Sizing ──────────────────────────────────────────────────────────

function calcPositionSize(entry, slPrice, riskUSD, maxPositionUSD) {
  const riskPerUnit = Math.abs(entry - slPrice);
  if (riskPerUnit <= 0) return { qty: 0, sizeUSD: 0 };
  let qty     = riskUSD / riskPerUnit;       // BTC qty to risk exactly riskUSD
  let sizeUSD = qty * entry;
  // Hard cap: never exceed maxPositionUSD
  if (sizeUSD > maxPositionUSD) {
    sizeUSD = maxPositionUSD;
    qty     = sizeUSD / entry;
  }
  return { qty, sizeUSD };
}

// ─── Main Scan ────────────────────────────────────────────────────────────────

async function tick() {
  const state = loadState();
  let dirty = false;

  try {
    const [candles1m, candles15m] = await Promise.all([
      fetchCandles(CONFIG.symbol, "1m",  200),
      fetchCandles(CONFIG.symbol, "15m", 200),
    ]);

    // Last COMPLETED candle is candles[-2]; candles[-1] is still forming
    const lastCompleted1m  = candles1m[candles1m.length - 2];
    const currentPrice     = candles1m[candles1m.length - 1].close; // forming candle

    // Also try live price for faster exit detection
    const livePrice = await getCurrentPrice(CONFIG.symbol) || currentPrice;

    // ── PHASE: IN_POSITION ─────────────────────────────────────────────────────
    if (state.phase === "in_position" && state.position) {
      const pos   = state.position;
      const price = livePrice;

      // Check TP
      if ((pos.side === "long"  && price >= pos.tp) ||
          (pos.side === "short" && price <= pos.tp)) {
        console.log(`✅ TAKE PROFIT hit @ ${price.toFixed(2)}`);
        const pnl = pos.side === "long"
          ? (price - pos.entry) * pos.qty
          : (pos.entry - price) * pos.qty;

        if (!CONFIG.paperTrading) {
          await placeMarketOrder(CONFIG.symbol, "SELL", 0, pos.qty);
        }

        state.stats.wins++;
        state.stats.totalRealizedPnL += pnl;
        state.phase    = "idle";
        state.setup    = null;
        state.position = null;
        dirty = true;

        logTrade({ type: "exit", reason: "take_profit", price, pnl, qty: pos.qty });
        await sendTelegram(
          `✅ <b>CRAIG BOT — TAKE PROFIT</b>\n` +
          `${CONFIG.symbol} ${pos.side.toUpperCase()}\n` +
          `Entry: $${pos.entry.toFixed(2)} → TP: $${price.toFixed(2)}\n` +
          `PnL: <b>+$${pnl.toFixed(2)}</b> | Wins: ${state.stats.wins}`
        );
      }

      // Check SL
      else if ((pos.side === "long"  && price <= pos.sl) ||
               (pos.side === "short" && price >= pos.sl)) {
        const isBreakeven = Math.abs(pos.sl - pos.entry) < pos.entry * 0.0005;
        const pnl = pos.side === "long"
          ? (price - pos.entry) * pos.qty
          : (pos.entry - price) * pos.qty;

        console.log(`🛑 STOP LOSS hit @ ${price.toFixed(2)} (${isBreakeven ? "break-even" : "loss"})`);

        if (!CONFIG.paperTrading) {
          await placeMarketOrder(CONFIG.symbol, "SELL", 0, pos.qty);
        }

        if (isBreakeven) state.stats.breakevens++;
        else state.stats.losses++;
        state.stats.totalRealizedPnL += pnl;
        state.phase    = "idle";
        state.setup    = null;
        state.position = null;
        dirty = true;

        logTrade({ type: "exit", reason: isBreakeven ? "break_even" : "stop_loss", price, pnl, qty: pos.qty });
        await sendTelegram(
          `🛑 <b>CRAIG BOT — ${isBreakeven ? "BREAK EVEN" : "STOP LOSS"}</b>\n` +
          `${CONFIG.symbol} ${pos.side.toUpperCase()}\n` +
          `Entry: $${pos.entry.toFixed(2)} → SL: $${price.toFixed(2)}\n` +
          `PnL: $${pnl.toFixed(2)}`
        );
      }

      // Check BE: Move SL to entry when new swing forms beyond entry
      else if (!pos.beTriggered) {
        const { highs: h1, lows: l1 } = detectSwings(candles1m, CONFIG.swingLookback);
        if (pos.side === "long") {
          // New swing low above entry → structure confirmed upward → move SL to entry
          const newSwingLows = l1.filter(l => l.price > pos.entry && l.time > pos.entryTime);
          if (newSwingLows.length > 0) {
            console.log(`📈 BE triggered — new swing low above entry`);
            state.position.sl = pos.entry;
            state.position.beTriggered = true;
            dirty = true;
            await sendTelegram(
              `📈 <b>CRAIG BOT — BREAK EVEN SET</b>\n` +
              `${CONFIG.symbol} — SL moved to entry $${pos.entry.toFixed(2)}`
            );
          }
        } else {
          // Short: new swing high below entry
          const newSwingHighs = h1.filter(h => h.price < pos.entry && h.time > pos.entryTime);
          if (newSwingHighs.length > 0) {
            state.position.sl = pos.entry;
            state.position.beTriggered = true;
            dirty = true;
            await sendTelegram(
              `📉 <b>CRAIG BOT — BREAK EVEN SET</b>\n` +
              `${CONFIG.symbol} — SL moved to entry $${pos.entry.toFixed(2)}`
            );
          }
        }
      }
    }

    // ── PHASE: SETUP_DETECTED ──────────────────────────────────────────────────
    else if (state.phase === "setup_detected" && state.setup) {
      const setup = state.setup;
      const price = livePrice;

      // Expire old setups by time (30 min) or if FVG is no longer valid
      const setupAgeMs = Date.now() - (setup.detectedAt || 0);
      if (setupAgeMs > CONFIG.setupExpiryMs) {
        console.log(`⏩ Setup timed out after ${Math.round(setupAgeMs / 60000)}m`);
        state.phase = "idle";
        state.setup = null;
        dirty = true;
      }

      // Also reset if price has moved far past the FVG without triggering
      const fvgMissed = setup.direction === "bullish"
        ? price > setup.fvg.top * 1.005   // price blew through FVG without filling
        : price < setup.fvg.bottom * 0.995;
      const fvgFilled = setup.direction === "bullish"
        ? price < setup.fvg.bottom * 0.998  // price closed well below FVG
        : price > setup.fvg.top * 1.002;

      if (fvgMissed || fvgFilled) {
        console.log(`⏩ Setup expired — FVG ${fvgMissed ? "missed" : "filled"}`);
        state.phase = "idle";
        state.setup = null;
        dirty = true;
      }

      // Entry trigger: price has pulled back INTO the FVG zone
      else if (setup.direction === "bullish" && price <= setup.fvg.midpoint) {
        const entry = price;
        const sl    = setup.lil.price * (1 - CONFIG.slBufferPct / 100);
        const { qty, sizeUSD } = calcPositionSize(entry, sl, CONFIG.riskUSD, CONFIG.maxPositionUSD);
        const tp = entry + CONFIG.initialRR * (entry - sl);

        console.log(`🟢 ENTRY: LONG ${CONFIG.symbol} @ ${entry.toFixed(2)}`);
        console.log(`   SL: ${sl.toFixed(2)} | TP: ${tp.toFixed(2)} | Qty: ${qty.toFixed(6)}`);

        try {
          if (!CONFIG.paperTrading) {
            await placeMarketOrder(CONFIG.symbol, "BUY", sizeUSD);
          }

          state.position = {
            side:       "long",
            entry,
            sl,
            tp,
            qty,
            beTriggered: false,
            entryTime:  Date.now(),
          };
          state.phase = "in_position";
          state.setup = null;
          dirty = true;

          logTrade({ type: "entry", side: "long", entry, sl, tp, qty, sizeUSD });
          await sendTelegram(
            `🟢 <b>CRAIG BOT — LONG ENTRY</b>\n` +
            `${CONFIG.symbol} @ $${entry.toFixed(2)}\n` +
            `SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)}\n` +
            `Risk: $${CONFIG.riskUSD} | Size: ${qty.toFixed(6)} BTC\n` +
            `FVG zone: $${setup.fvg.bottom.toFixed(2)} – $${setup.fvg.top.toFixed(2)}\n` +
            `${isNYOpen() ? "🗽 NY Open session" : ""}`
          );
        } catch (err) {
          console.error("Entry order failed:", err.message);
          await sendTelegram(`⚠️ Craig Bot entry failed: ${err.message}`);
        }
      }

      else if (setup.direction === "bearish" && price >= setup.fvg.midpoint) {
        const entry = price;
        const sl    = setup.lil.price * (1 + CONFIG.slBufferPct / 100);
        const { qty, sizeUSD } = calcPositionSize(entry, sl, CONFIG.riskUSD, CONFIG.maxPositionUSD);
        const tp = entry - CONFIG.initialRR * (sl - entry);

        console.log(`🔴 ENTRY: SHORT ${CONFIG.symbol} @ ${entry.toFixed(2)}`);

        try {
          if (!CONFIG.paperTrading) {
            await placeMarketOrder(CONFIG.symbol, "SELL", 0, qty);
          }

          state.position = {
            side:       "short",
            entry,
            sl,
            tp,
            qty,
            beTriggered: false,
            entryTime:  Date.now(),
          };
          state.phase = "in_position";
          state.setup = null;
          dirty = true;

          logTrade({ type: "entry", side: "short", entry, sl, tp, qty, sizeUSD });
          await sendTelegram(
            `🔴 <b>CRAIG BOT — SHORT ENTRY</b>\n` +
            `${CONFIG.symbol} @ $${entry.toFixed(2)}\n` +
            `SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)}\n` +
            `Risk: $${CONFIG.riskUSD} | Size: ${qty.toFixed(6)} BTC\n` +
            `FVG zone: $${setup.fvg.bottom.toFixed(2)} – $${setup.fvg.top.toFixed(2)}`
          );
        } catch (err) {
          console.error("Entry order failed:", err.message);
          await sendTelegram(`⚠️ Craig Bot entry failed: ${err.message}`);
        }
      }
    }

    // ── PHASE: IDLE ────────────────────────────────────────────────────────────
    else if (state.phase === "idle") {
      const { bias, setup } = analyzeSetup(candles1m, candles15m);
      state.bias = bias;

      if (setup) {
        const fvg = setup.fvg;
        const price = livePrice;

        // Don't enter a setup where price has already moved past the FVG
        const alreadyPastFVG = setup.direction === "bullish"
          ? price > fvg.top
          : price < fvg.bottom;

        if (!alreadyPastFVG) {
          console.log(`🔍 SETUP DETECTED — ${setup.direction.toUpperCase()} bias`);
          console.log(`   FVG: $${fvg.bottom.toFixed(2)} – $${fvg.top.toFixed(2)} (mid: $${fvg.midpoint.toFixed(2)})`);
          console.log(`   LIL: $${setup.lil.price.toFixed(2)} | CHOCH break: $${setup.choch.breakLevel.toFixed(2)}`);
          console.log(`   NY Open: ${isNYOpen() ? "YES 🗽" : "no"}`);

          state.setup = setup;
          state.phase = "setup_detected";
          dirty = true;

          await sendTelegram(
            `🔍 <b>CRAIG BOT — SETUP DETECTED</b>\n` +
            `${CONFIG.symbol} — ${setup.direction.toUpperCase()}\n` +
            `15m Bias: ${bias}\n` +
            `FVG zone: $${fvg.bottom.toFixed(2)} – $${fvg.top.toFixed(2)}\n` +
            `Entry target: $${fvg.midpoint.toFixed(2)}\n` +
            `LIL (SL ref): $${setup.lil.price.toFixed(2)}\n` +
            `${isNYOpen() ? "🗽 NY Open session — prime time!" : ""}`
          );
        }
      } else {
        // Log bias update occasionally (not every tick)
        const now = new Date();
        if (now.getMinutes() % 15 === 0 && now.getSeconds() < 60) {
          console.log(`[${now.toISOString().slice(11,19)}] Idle — 15m bias: ${bias} — no valid setup`);
        }
      }
    }

  } catch (err) {
    console.error(`[CRAIG BOT ERROR] ${err.message}`);
  }

  if (dirty) saveState(state);
}

// ─── Status Report ────────────────────────────────────────────────────────────

async function sendStatusReport() {
  const state = loadState();
  const pos   = state.position;
  const stats = state.stats;
  const livePrice = await getCurrentPrice(CONFIG.symbol);

  let posLine = "No open position";
  if (pos) {
    const pnl = pos.side === "long"
      ? (livePrice - pos.entry) * pos.qty
      : (pos.entry - livePrice) * pos.qty;
    posLine = `${pos.side.toUpperCase()} @ $${pos.entry.toFixed(2)} | ` +
              `SL: $${pos.sl.toFixed(2)} | TP: $${pos.tp.toFixed(2)}\n` +
              `Qty: ${pos.qty.toFixed(6)} BTC | Unrealized: $${pnl.toFixed(2)}\n` +
              `BE: ${pos.beTriggered ? "✅ Set" : "⏳ Watching"}`;
  }

  const totalTrades = stats.wins + stats.losses + stats.breakevens;
  const wr = totalTrades > 0 ? ((stats.wins / totalTrades) * 100).toFixed(1) : "—";

  await sendTelegram(
    `📊 <b>CRAIG BOT STATUS</b>\n` +
    `${CONFIG.symbol} | ${CONFIG.paperTrading ? "📝 PAPER" : "🔴 LIVE"}\n\n` +
    `Phase: ${state.phase.toUpperCase()}\n` +
    `15m Bias: ${state.bias}\n\n` +
    `<b>Position:</b>\n${posLine}\n\n` +
    `<b>Stats (all-time):</b>\n` +
    `Trades: ${totalTrades} | W: ${stats.wins} L: ${stats.losses} BE: ${stats.breakevens}\n` +
    `Win Rate: ${wr}% | PnL: $${stats.totalRealizedPnL.toFixed(2)}`
  );
}

// ─── Telegram Commands ────────────────────────────────────────────────────────

let lastUpdateId = 0;

async function pollTelegramCommands() {
  const { token, chatId } = CONFIG.telegram;
  if (!token || !chatId) return;
  try {
    const res  = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`
    );
    const data = await res.json();
    for (const update of (data.result || [])) {
      lastUpdateId = update.update_id;
      const text = update.message?.text?.trim() || "";
      if (text === "/craig_status" || text === "/cs") {
        await sendStatusReport();
      } else if (text === "/craig_pause") {
        const state = loadState();
        state.paused = true;
        saveState(state);
        await sendTelegram("⏸️ Craig Bot paused — no new entries.");
      } else if (text === "/craig_resume") {
        const state = loadState();
        state.paused = false;
        saveState(state);
        await sendTelegram("▶️ Craig Bot resumed.");
      } else if (text === "/craig_close") {
        const state = loadState();
        if (state.position) {
          await sendTelegram("⚠️ Manual close requested — execute on Coinbase directly for safety.");
        } else {
          await sendTelegram("Craig Bot: no open position to close.");
        }
      }
    }
  } catch {}
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  const isLocal = !process.env.RAILWAY_ENVIRONMENT;

  if (isLocal && !existsSync(".env")) {
    console.log("Create a .env file with COINBASE_API_KEY, COINBASE_PRIVATE_KEY, etc.");
    process.exit(1);
  }

  if (!CONFIG.coinbase.apiKey || !CONFIG.coinbase.privateKey) {
    if (!CONFIG.paperTrading) {
      console.error("❌ Missing COINBASE_API_KEY / COINBASE_PRIVATE_KEY in environment");
      process.exit(1);
    }
    console.warn("⚠️  No Coinbase credentials — running in paper mode only");
  }

  console.log("═".repeat(60));
  console.log("  CRAIG BOT — SMC/ICT 3-Step Strategy");
  console.log(`  Symbol: ${CONFIG.symbol}`);
  console.log(`  Mode:   ${CONFIG.paperTrading ? "PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log(`  Risk:   $${CONFIG.riskUSD} per trade`);
  console.log(`  R:R:    1:${CONFIG.initialRR} initial target`);
  console.log("═".repeat(60));

  await sendTelegram(
    `🤖 <b>Craig Bot STARTED</b>\n` +
    `${CONFIG.symbol} | ${CONFIG.paperTrading ? "📝 Paper" : "🔴 LIVE"}\n` +
    `Risk per trade: $${CONFIG.riskUSD} | R:R: 1:${CONFIG.initialRR}\n` +
    `Scanning every 1 minute for SMC setups.\n\n` +
    `Commands: /craig_status /craig_pause /craig_resume`
  );

  // Initial tick
  await tick();

  // Main scan loop
  const scanLoop = async () => {
    const state = loadState();
    if (!state.paused) await tick();
    await pollTelegramCommands();
    setTimeout(scanLoop, SCAN_INTERVAL);
  };
  setTimeout(scanLoop, SCAN_INTERVAL);
}

start().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
