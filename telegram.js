/**
 * telegram.js — Telegram bot with true long-polling
 *
 * Replaces the old checkTelegramCommands in report.js.
 * Uses getUpdates with timeout=30 so messages are delivered instantly.
 * Each command is wrapped in try/catch — failures send an error message
 * back to the user rather than silently dying.
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import { generateReport } from "./report.js";

// Read lazily to survive any module-init / dotenv ordering edge cases
function getToken()  { return process.env.TELEGRAM_BOT_TOKEN; }
function getChatId() { return process.env.TELEGRAM_CHAT_ID; }

// Read lazily at call time — avoids module-init race with dotenv loading
function getSymbols() {
  return (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT,LINKUSDT,DOGEUSDT")
    .split(",").map(s => s.trim());
}
function isPaperMode() {
  return process.env.PAPER_TRADING !== "false";
}

const STATE_FILE       = "portfolio.json";
const LOG_FILE         = "safety-check-log.json";
const OFFSET_FILE      = "tg-offset.json";
const CRAIG_STATE_FILE = "craig-portfolio.json";

// ─── Commands registered with BotFather ──────────────────────────────────────
// Only commands that actually exist in the code.

const BOT_COMMANDS = [
  { command: "help",          description: "List all commands" },
  { command: "status",        description: "E2 bot: mode, trades today, last run" },
  { command: "prices",        description: "Live prices + 24h change" },
  { command: "portfolio",     description: "E2: cash, open positions, P&L" },
  { command: "trades",        description: "Today's trade activity" },
  { command: "report",        description: "Full intelligence report on demand" },
  { command: "pause",         description: "Pause E2 bot (no new trades)" },
  { command: "resume",        description: "Resume E2 bot" },
  { command: "craig_status",  description: "Craig bot: phase, position, stats" },
  { command: "craig_pause",   description: "Pause Craig bot" },
  { command: "craig_resume",  description: "Resume Craig bot" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadPortfolio() {
  const fallback = {
    startingCapital: 1000,
    legs: { A: { cash: 700 }, B: { cash: 300 } },
    positions: {},
    paused: false,
  };
  if (!existsSync(STATE_FILE)) return fallback;
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    // Migrate old flat-cash format to legs structure
    if (s.cash !== undefined && !s.legs) {
      const total = s.cash;
      s.legs = { A: { cash: total * 0.70 }, B: { cash: total * 0.30 } };
      delete s.cash;
    }
    return s;
  } catch { return fallback; }
}

function savePortfolio(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  try { return JSON.parse(readFileSync(LOG_FILE, "utf8")); }
  catch { return { trades: [] }; }
}

function getOffset() {
  try {
    if (existsSync(OFFSET_FILE)) return JSON.parse(readFileSync(OFFSET_FILE, "utf8")).offset || 0;
    // Fall back to lastUpdateId in portfolio.json
    const s = loadPortfolio();
    return (s.lastUpdateId || 0) + 1;
  } catch { return 0; }
}

function saveOffset(n) {
  writeFileSync(OFFSET_FILE, JSON.stringify({ offset: n }));
}

function fmtPrice(p) {
  if (!p) return "N/A";
  if (p >= 1000) return "$" + p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1)    return "$" + p.toFixed(2);
  return "$" + p.toFixed(6);
}

// ─── Telegram API ─────────────────────────────────────────────────────────────

// Telegram max message length is 4096 chars — split longer messages at newlines
async function send(text) {
  const TOKEN  = getToken();
  const CHAT_ID = getChatId();
  if (!TOKEN || !CHAT_ID) return;
  const MAX = 4000; // leave headroom below 4096
  const chunks = [];
  if (text.length <= MAX) {
    chunks.push(text);
  } else {
    const lines = text.split("\n");
    let current = "";
    for (const line of lines) {
      if ((current + "\n" + line).length > MAX) {
        if (current) chunks.push(current);
        current = line;
      } else {
        current = current ? current + "\n" + line : line;
      }
    }
    if (current) chunks.push(current);
  }
  for (const chunk of chunks) {
    try {
      await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text: chunk, parse_mode: "HTML" }),
      });
    } catch (err) {
      console.log(`⚠️  Telegram send failed: ${err.message}`);
    }
  }
}

async function registerCommands() {
  const TOKEN = getToken();
  if (!TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
    console.log("✅ Telegram commands registered with BotFather");
  } catch (err) {
    console.log(`⚠️  Failed to register commands: ${err.message}`);
  }
}

// ─── Price fetch (Coinbase — no auth) ────────────────────────────────────────

function toCbSymbol(s) {
  if (s.includes("-"))    return s;
  if (s.endsWith("USDT")) return s.slice(0, -4) + "-USD";
  if (s.endsWith("USD"))  return s.slice(0, -3) + "-USD";
  return s;
}

async function fetchPrices() {
  const results = {};
  await Promise.allSettled(
    getSymbols().map(s =>
      fetch(`https://api.coinbase.com/api/v3/brokerage/market/products/${toCbSymbol(s)}`,
        { signal: AbortSignal.timeout(5000) })
        .then(r => r.json())
        .then(d => {
          if (d.price) results[s] = {
            price: parseFloat(d.price),
            change24h: parseFloat(d.price_percentage_change_24h || 0),
          };
        })
        .catch(() => {})
    )
  );
  return results;
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

async function cmdHelp() {
  const mode = isPaperMode() ? "📋 Paper" : "🔴 Live";
  const syms = getSymbols();
  const craigState = loadCraigState();
  const craigRunning = existsSync(CRAIG_STATE_FILE);

  const e2Commands   = BOT_COMMANDS.filter(c => !c.command.startsWith("craig"));
  const craigCommands = BOT_COMMANDS.filter(c => c.command.startsWith("craig"));

  const lines = [
    `🤖 <b>Claude Trading Bots</b>`,
    ``,
    `<b>E2 Bot</b> (6h swing ensemble) — ${mode}`,
    `Assets: ${syms.map(s => s.replace("USDT", "")).join(", ")}`,
    ...e2Commands.map(c => `  /${c.command} — ${c.description}`),
    ``,
    `<b>Craig Bot</b> (1m SMC/ICT) — ${craigRunning ? (craigState.paused ? "⏸ paused" : "▶️ running") : "not started"}`,
    ...craigCommands.map(c => `  /${c.command} — ${c.description}`),
  ];
  await send(lines.join("\n"));
}

async function cmdStatus() {
  const log   = loadLog();
  const state = loadPortfolio();
  const syms  = getSymbols();
  const today = new Date().toISOString().slice(0, 10);
  const todayEntries = log.trades.filter(t => t.timestamp?.startsWith(today) && t.orderPlaced && t.side === "buy").length;
  const todayExits   = log.trades.filter(t => t.timestamp?.startsWith(today) && t.orderPlaced && t.side === "sell").length;
  const mode  = isPaperMode() ? "📋 Paper Trading" : "🔴 Live Trading";
  const statusIcon = state.paused ? "⏸" : "▶️";

  const lastTrade = log.trades.filter(t => t.orderPlaced).at(-1);
  const fmtTime = iso => iso
    ? new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })
    : "Never";

  // Show open position count per leg
  const positions = state.positions || {};
  const legACount = Object.values(positions).filter(p => p.leg === "A").length;
  const legBCount = Object.values(positions).filter(p => p.leg === "B").length;

  await send(
    `📊 <b>Bot Status</b>\n\n` +
    `${statusIcon} ${state.paused ? "PAUSED" : "Running"}\n` +
    `Mode: ${mode}\n` +
    `Strategy: E2 Swing Ensemble — 6H candles\n` +
    `\n<b>Trading pairs (${syms.length}):</b>\n` +
    syms.map(s => `  • ${s.replace("USDT","")}`).join("\n") + "\n" +
    `\nLeg A open: ${legACount}/2  |  Leg B open: ${legBCount}/2\n` +
    `Trades today: ${todayEntries} entries · ${todayExits} exits\n` +
    `Last scan: ${fmtTime(state.lastScanTime)}\n` +
    `Last trade: ${fmtTime(lastTrade?.timestamp)}`
  );
}

async function cmdPrices() {
  await send("⏳ Fetching prices...");
  const prices = await fetchPrices();
  if (!Object.keys(prices).length) {
    await send("⚠️ Could not fetch prices. Try again in a moment.");
    return;
  }
  const lines = [`💹 <b>Live Prices</b>\n`];
  for (const s of getSymbols()) {
    const d = prices[s];
    if (!d) { lines.push(`• ${s.replace("USDT","")}: N/A`); continue; }
    const arrow = d.change24h >= 0 ? "▲" : "▼";
    const pct   = (d.change24h >= 0 ? "+" : "") + d.change24h.toFixed(2) + "%";
    lines.push(`${arrow} <b>${s.replace("USDT","")}</b>: ${fmtPrice(d.price)} (${pct} 24h)`);
  }
  await send(lines.join("\n"));
}

async function cmdPortfolio() {
  const state  = loadPortfolio();
  const prices = await fetchPrices();
  const mode   = isPaperMode() ? " 📋" : " 🔴";
  const TP_ATR_MULT = 5;

  const legACash = state.legs?.A?.cash ?? (state.cash ? state.cash * 0.7 : 0);
  const legBCash = state.legs?.B?.cash ?? (state.cash ? state.cash * 0.3 : 0);
  const startCap = state.startingCapital || (legACash + legBCash) || 1000;

  // Build per-leg position lines and totals
  let legAPosCost = 0, legBPosCost = 0, legAPosVal = 0, legBPosVal = 0;
  const legAPosLines = [], legBPosLines = [];

  for (const [sym, pos] of Object.entries(state.positions || {})) {
    const cp  = prices[sym]?.price || pos.avgCost || 0;
    const cv  = pos.quantity * cp;
    const pnl = cv - pos.totalCost;
    const arrow = pnl >= 0 ? "▲" : "▼";
    const pct   = pos.totalCost > 0 ? ((pnl / pos.totalCost) * 100).toFixed(1) : "0.0";
    let tpStr = "";
    if (pos.atrAtEntry > 0 && pos.avgCost > 0) {
      const tp = pos.avgCost + TP_ATR_MULT * pos.atrAtEntry;
      const pctToTp = cp > 0 ? ((tp - cp) / cp * 100).toFixed(1) : "?";
      const tpFmt = tp >= 1000
        ? "$" + tp.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : "$" + tp.toFixed(2);
      tpStr = `  →TP ${tpFmt} (${pctToTp}% away)`;
    }
    const line = `    ${arrow} <b>${sym.replace("USDT","")}</b>: cost $${pos.totalCost.toFixed(2)} · now $${cv.toFixed(2)} (${pnl >= 0 ? "+" : ""}${pct}%)${tpStr}`;
    if (pos.leg === "A") {
      legAPosCost += pos.totalCost; legAPosVal += cv;
      legAPosLines.push(line);
    } else {
      legBPosCost += pos.totalCost; legBPosVal += cv;
      legBPosLines.push(line);
    }
  }

  const legAEquity = legACash + legAPosVal;
  const legBEquity = legBCash + legBPosVal;
  const total      = legAEquity + legBEquity;
  const unrealizedPnL = (legAPosVal - legAPosCost) + (legBPosVal - legBPosCost);
  const net    = total - startCap;
  const netPct = startCap > 0 ? ((net / startCap) * 100).toFixed(1) : "0.0";

  const L = [];
  L.push(`💰 <b>Portfolio — E2 Ensemble</b>${mode}\n`);

  // Leg A
  L.push(`<b>Leg A — Donchian Trend (70%)</b>`);
  L.push(`  Cash: $${legACash.toFixed(2)}  · Deployed: $${legAPosVal.toFixed(2)}  · <b>Equity: $${legAEquity.toFixed(2)}</b>`);
  legAPosLines.forEach(l => L.push(l));

  L.push(`\n<b>Leg B — Mean-Rev (30%)</b>`);
  L.push(`  Cash: $${legBCash.toFixed(2)}  · Deployed: $${legBPosVal.toFixed(2)}  · <b>Equity: $${legBEquity.toFixed(2)}</b>`);
  legBPosLines.forEach(l => L.push(l));

  if (legAPosLines.length === 0 && legBPosLines.length === 0) {
    L.push(`  No open positions`);
  }

  L.push(``);
  L.push(`<b>Total: $${total.toFixed(2)}</b>  (started $${startCap.toFixed(2)})`);
  L.push(`Unrealized P&amp;L: ${unrealizedPnL >= 0 ? "+" : ""}$${unrealizedPnL.toFixed(2)}`);
  L.push(`Net change: ${net >= 0 ? "+" : ""}$${net.toFixed(2)} (${net >= 0 ? "+" : ""}${netPct}%)`);

  await send(L.join("\n"));
}

async function cmdTrades() {
  const log   = loadLog();
  const today = new Date().toISOString().slice(0, 10);
  const todayTrades = log.trades.filter(t => t.timestamp?.startsWith(today));

  if (!todayTrades.length) {
    await send("📋 No activity today yet.");
    return;
  }

  const entries = todayTrades.filter(t => t.side === "buy"  && t.orderPlaced);
  const exits   = todayTrades.filter(t => t.side === "sell" && t.orderPlaced);
  const failed  = todayTrades.filter(t => !t.orderPlaced && t.error);
  const failTag = failed.length > 0 ? ` · ⚠️ ${failed.length} failed` : "";
  const lines = [`📋 <b>Today's Trades</b>  (${entries.length} entries · ${exits.length} exits${failTag})\n`];
  const recent = todayTrades.slice(-12);
  for (const t of recent) {
    const sym  = t.symbol?.replace("USDT","") || "?";
    const time = new Date(t.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/Los_Angeles" });
    const legTag = t.leg ? ` [${t.leg}]` : "";
    if (t.side === "buy" && t.orderPlaced) {
      const tp = t.tpTarget ? `  TP $${parseFloat(t.tpTarget).toLocaleString("en-US",{maximumFractionDigits:2})}` : "";
      lines.push(`🟢 BUY${legTag} ${sym} ${fmtPrice(t.price)} $${(t.tradeSize||0).toFixed(2)}${tp} — ${time}`);
    } else if (t.side === "sell" && t.orderPlaced) {
      const pnlStr = t.pnl != null ? ` P&L: ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}` : "";
      const reason = t.exitReason ? ` (${t.exitReason.replace(/_/g," ")})` : "";
      lines.push(`🔴 EXIT${legTag} ${sym} ${fmtPrice(t.price)}${pnlStr}${reason} — ${time}`);
    } else if (!t.orderPlaced && t.error) {
      lines.push(`❌ FAILED ${sym} — ${t.error?.slice(0,40)} — ${time}`);
    }
  }
  if (todayTrades.length > 12) lines.push(`...and ${todayTrades.length - 12} more`);
  await send(lines.join("\n"));
}

async function cmdReport() {
  await send("⏳ Generating report...");
  const log = loadLog();
  const report = await generateReport(log);
  await send(report);
}

async function cmdPause() {
  const state = loadPortfolio();
  state.paused = true;
  savePortfolio(state);
  await send("⏸ <b>Bot paused.</b>\nNo new trades until you send /resume.");
}

async function cmdResume() {
  const state = loadPortfolio();
  state.paused = false;
  savePortfolio(state);
  await send("▶️ <b>Bot resumed.</b>\nBack to scanning for signals.");
}

// ─── Craig Bot Commands ───────────────────────────────────────────────────────

function loadCraigState() {
  const defaults = { phase: "idle", bias: "neutral", setup: null, position: null,
    paused: false, stats: { wins: 0, losses: 0, breakevens: 0, totalRealizedPnL: 0 } };
  if (!existsSync(CRAIG_STATE_FILE)) return defaults;
  try { return { ...defaults, ...JSON.parse(readFileSync(CRAIG_STATE_FILE, "utf8")) }; }
  catch { return defaults; }
}

function saveCraigState(s) {
  writeFileSync(CRAIG_STATE_FILE, JSON.stringify(s, null, 2));
}

async function cmdCraigStatus() {
  const state = loadCraigState();
  const pos   = state.position;
  const stats = state.stats;

  // Fetch live BTC price for unrealized P&L
  let livePrice = 0;
  try {
    const r = await fetch("https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD",
      { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    livePrice = parseFloat(d.price || 0);
  } catch {}

  let posLine = "No open position";
  if (pos) {
    const pnl = pos.side === "long"
      ? (livePrice - pos.entry) * pos.qty
      : (pos.entry - livePrice) * pos.qty;
    posLine =
      `${pos.side.toUpperCase()} BTC @ $${pos.entry.toFixed(2)}\n` +
      `SL: $${pos.sl.toFixed(2)}  |  TP: $${pos.tp.toFixed(2)}\n` +
      `Qty: ${pos.qty.toFixed(6)} BTC\n` +
      `Unrealized: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}\n` +
      `BE: ${pos.beTriggered ? "✅ set" : "⏳ watching"}`;
  }

  const total  = stats.wins + stats.losses + stats.breakevens;
  const wr     = total > 0 ? ((stats.wins / total) * 100).toFixed(1) : "—";
  const isRun  = existsSync(CRAIG_STATE_FILE);

  await send(
    `🧠 <b>Craig Bot Status</b> ${state.paused ? "⏸" : "▶️"}\n\n` +
    `Phase: ${state.phase.toUpperCase()}\n` +
    `15m Bias: ${state.bias}\n` +
    `Running: ${isRun ? "yes" : "state file missing"}\n\n` +
    `<b>Position:</b>\n${posLine}\n\n` +
    `<b>Stats:</b>\n` +
    `Trades: ${total}  W: ${stats.wins}  L: ${stats.losses}  BE: ${stats.breakevens}\n` +
    `Win Rate: ${wr}%  |  PnL: $${stats.totalRealizedPnL.toFixed(2)}`
  );
}

async function cmdCraigPause() {
  const state = loadCraigState();
  state.paused = true;
  saveCraigState(state);
  await send("⏸️ <b>Craig Bot paused.</b> No new entries until /craig_resume.");
}

async function cmdCraigResume() {
  const state = loadCraigState();
  state.paused = false;
  saveCraigState(state);
  await send("▶️ <b>Craig Bot resumed.</b> Back to scanning for SMC setups.");
}

// ─── Command Router ───────────────────────────────────────────────────────────

async function handleUpdate(update) {
  const text = update.message?.text?.trim() || update.channel_post?.text?.trim() || "";
  if (!text.startsWith("/")) return;

  const cmd = text.split("@")[0].toLowerCase().slice(1); // strip leading / and @botname
  console.log(`📨 Telegram command: /${cmd}`);

  try {
    if      (cmd === "help")          await cmdHelp();
    else if (cmd === "status")        await cmdStatus();
    else if (cmd === "prices")        await cmdPrices();
    else if (cmd === "portfolio")     await cmdPortfolio();
    else if (cmd === "trades")        await cmdTrades();
    else if (cmd === "report")        await cmdReport();
    else if (cmd === "pause")         await cmdPause();
    else if (cmd === "resume")        await cmdResume();
    else if (cmd === "craig_status" || cmd === "cs") await cmdCraigStatus();
    else if (cmd === "craig_pause")   await cmdCraigPause();
    else if (cmd === "craig_resume")  await cmdCraigResume();
    else await send(`❓ Unknown command: /${cmd}\n\nSend /help to see available commands.`);
  } catch (err) {
    console.log(`⚠️  Command /${cmd} failed: ${err.message}`);
    await send(`⚠️ /${cmd} failed: ${err.message}`);
  }
}

// ─── Long-Polling Loop ────────────────────────────────────────────────────────

export async function startCommandPolling() {
  const TOKEN   = getToken();
  const CHAT_ID = getChatId();
  if (!TOKEN || !CHAT_ID) {
    console.log("⚠️  TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — Telegram disabled");
    return;
  }

  // Register commands with BotFather so the menu only shows real commands
  await registerCommands();

  let offset        = getOffset();
  let conflictCount = 0;
  let backoffMs     = 5000;

  console.log(`📡 Telegram long-polling started (offset: ${offset})`);

  while (true) {
    try {
      // timeout=30 — Telegram holds connection up to 30s, delivers instantly on message
      const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message","channel_post"]`;
      const res = await fetch(url, { signal: AbortSignal.timeout(35000) });
      const data = await res.json();

      if (!data.ok) {
        const isConflict = data.description?.includes("Conflict");

        if (isConflict) {
          conflictCount++;
          // Only log every 10th conflict to avoid console spam
          if (conflictCount === 1) {
            console.log(`⚠️  Telegram conflict: another bot instance is polling. Commands disabled on this instance.`);
            console.log(`    → Stop the other instance (Railway / another terminal) to re-enable commands.`);
          } else if (conflictCount % 10 === 0) {
            console.log(`⚠️  Telegram conflict ongoing (${conflictCount} retries). Commands still disabled.`);
          }
          // Exponential backoff: 5s → 10s → 20s → 40s → 60s max
          backoffMs = Math.min(backoffMs * 2, 60000);
        } else {
          console.log(`⚠️  Telegram getUpdates error: ${data.description}`);
          backoffMs = 5000; // reset on non-conflict errors
        }

        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }

      // Successful poll — reset conflict state
      if (conflictCount > 0) {
        console.log(`✅ Telegram conflict resolved after ${conflictCount} retries. Commands active.`);
        conflictCount = 0;
        backoffMs     = 5000;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;
        saveOffset(offset);
        await handleUpdate(update);
      }
    } catch (err) {
      // Network timeout on long-poll is expected — just loop immediately
      if (!err.message.includes("timeout") && !err.message.includes("abort")) {
        console.log(`⚠️  Telegram polling error: ${err.message}`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
}

// ─── isPaused export (used by bot.js) ────────────────────────────────────────

export function isPaused() {
  return loadPortfolio().paused || false;
}
