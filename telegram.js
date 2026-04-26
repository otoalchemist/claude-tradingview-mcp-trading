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

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT").split(",").map(s => s.trim());
const PAPER   = process.env.PAPER_TRADING !== "false";

const STATE_FILE  = "portfolio.json";
const LOG_FILE    = "safety-check-log.json";
const OFFSET_FILE = "tg-offset.json";

// ─── Commands registered with BotFather ──────────────────────────────────────
// Only commands that actually exist in the code.

const BOT_COMMANDS = [
  { command: "help",      description: "List all commands" },
  { command: "status",    description: "Bot mode, trades today, last run" },
  { command: "prices",    description: "Live prices + 24h change" },
  { command: "portfolio", description: "Cash, open positions, P&L" },
  { command: "trades",    description: "Today's trade activity" },
  { command: "report",    description: "Full intelligence report on demand" },
  { command: "pause",     description: "Stop placing new trades" },
  { command: "resume",    description: "Resume trading" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadPortfolio() {
  if (!existsSync(STATE_FILE)) return { startingCapital: 1000, cash: 1000, positions: {}, paused: false };
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return { startingCapital: 1000, cash: 1000, positions: {}, paused: false }; }
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

async function send(text) {
  if (!TOKEN || !CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
    });
  } catch (err) {
    console.log(`⚠️  Telegram send failed: ${err.message}`);
  }
}

async function registerCommands() {
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
  if (s.endsWith("USDT")) return s.slice(0, -4) + "-USD";
  if (s.endsWith("USD"))  return s.slice(0, -3) + "-USD";
  return s;
}

async function fetchPrices() {
  const results = {};
  await Promise.allSettled(
    SYMBOLS.map(s =>
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
  const mode = PAPER ? "📋 Paper" : "🔴 Live";
  const lines = [
    `🤖 <b>Claude Trading Bot</b>`,
    `Mode: ${mode} | Assets: ${SYMBOLS.map(s => s.replace("USDT", "")).join(", ")}`,
    ``,
    `<b>Commands</b>`,
    ...BOT_COMMANDS.map(c => `/${c.command} — ${c.description}`),
  ];
  await send(lines.join("\n"));
}

async function cmdStatus() {
  const log   = loadLog();
  const state = loadPortfolio();
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = log.trades.filter(t => t.timestamp?.startsWith(today) && t.orderPlaced).length;
  const mode  = PAPER ? "📋 Paper Trading" : "🔴 Live Trading";
  const statusIcon = state.paused ? "⏸" : "▶️";

  const lastTrade = log.trades.filter(t => t.orderPlaced).at(-1);
  const lastScan  = log.trades.at(-1);
  const fmtTime = t => t
    ? new Date(t.timestamp).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })
    : "Never";

  await send(
    `📊 <b>Bot Status</b>\n\n` +
    `${statusIcon} ${state.paused ? "PAUSED" : "Running"}\n` +
    `Mode: ${mode}\n` +
    `Assets: ${SYMBOLS.map(s => s.replace("USDT","")).join(", ")}\n` +
    `Timeframe: ${process.env.TIMEFRAME || "5m"}\n` +
    `Trades today: ${todayCount}/${process.env.MAX_TRADES_PER_DAY || 100}\n` +
    `Last scan: ${fmtTime(lastScan)}\n` +
    `Last trade: ${fmtTime(lastTrade)}`
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
  for (const s of SYMBOLS) {
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

  let posValue = 0, unrealizedPnL = 0;
  const posLines = [];

  for (const [sym, pos] of Object.entries(state.positions || {})) {
    const cp = prices[sym]?.price || pos.avgCost || 0;
    const cv = pos.quantity * cp;
    const pnl = cv - pos.totalCost;
    posValue += cv;
    unrealizedPnL += pnl;
    const arrow = pnl >= 0 ? "▲" : "▼";
    const pct = pos.totalCost > 0 ? ((pnl / pos.totalCost) * 100).toFixed(1) : "0.0";
    posLines.push(`  ${arrow} ${sym.replace("USDT","")}: $${pos.totalCost.toFixed(2)} → $${cv.toFixed(2)} (${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} / ${pnl >= 0 ? "+" : ""}${pct}%)`);
  }

  const total  = (state.cash || 0) + posValue;
  const net    = total - (state.startingCapital || 1000);
  const netPct = ((net / (state.startingCapital || 1000)) * 100).toFixed(1);

  const lines = [
    `💰 <b>Portfolio</b>\n`,
    `Starting capital: $${(state.startingCapital || 1000).toFixed(2)}`,
    `USDC cash: $${(state.cash || 0).toFixed(2)}`,
    `Open positions: $${posValue.toFixed(2)}`,
    `Total value: $${total.toFixed(2)}`,
    `Unrealized P&amp;L: ${unrealizedPnL >= 0 ? "+" : ""}$${unrealizedPnL.toFixed(2)}`,
    `Net change: ${net >= 0 ? "+" : ""}$${net.toFixed(2)} (${net >= 0 ? "+" : ""}${netPct}%)`,
    posLines.length ? `\n<b>Positions:</b>\n${posLines.join("\n")}` : `\nNo open positions`,
  ];
  await send(lines.join("\n"));
}

async function cmdTrades() {
  const log   = loadLog();
  const today = new Date().toISOString().slice(0, 10);
  const todayTrades = log.trades.filter(t => t.timestamp?.startsWith(today));

  if (!todayTrades.length) {
    await send("📋 No activity today yet.");
    return;
  }

  const lines = [`📋 <b>Today's Activity</b> (${todayTrades.length} scans)\n`];
  const recent = todayTrades.slice(-10);
  for (const t of recent) {
    const sym  = t.symbol?.replace("USDT","") || "?";
    const icon = t.orderPlaced ? "✅" : "🚫";
    const time = new Date(t.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/Los_Angeles" });
    const price = t.price ? fmtPrice(t.price) : "";
    const size  = t.orderPlaced && t.tradeSize ? ` $${t.tradeSize.toFixed(2)}` : "";
    lines.push(`${icon} ${sym} ${price}${size} — ${time}`);
  }
  if (todayTrades.length > 10) lines.push(`...and ${todayTrades.length - 10} more`);
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

// ─── Command Router ───────────────────────────────────────────────────────────

async function handleUpdate(update) {
  const text = update.message?.text?.trim() || update.channel_post?.text?.trim() || "";
  if (!text.startsWith("/")) return;

  const cmd = text.split("@")[0].toLowerCase().slice(1); // strip leading / and @botname
  console.log(`📨 Telegram command: /${cmd}`);

  try {
    if      (cmd === "help")      await cmdHelp();
    else if (cmd === "status")    await cmdStatus();
    else if (cmd === "prices")    await cmdPrices();
    else if (cmd === "portfolio") await cmdPortfolio();
    else if (cmd === "trades")    await cmdTrades();
    else if (cmd === "report")    await cmdReport();
    else if (cmd === "pause")     await cmdPause();
    else if (cmd === "resume")    await cmdResume();
    else await send(`❓ Unknown command: /${cmd}\n\nSend /help to see available commands.`);
  } catch (err) {
    console.log(`⚠️  Command /${cmd} failed: ${err.message}`);
    await send(`⚠️ /${cmd} failed: ${err.message}`);
  }
}

// ─── Long-Polling Loop ────────────────────────────────────────────────────────

export async function startCommandPolling() {
  if (!TOKEN || !CHAT_ID) {
    console.log("⚠️  TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — Telegram disabled");
    return;
  }

  // Register commands with BotFather so the menu only shows real commands
  await registerCommands();

  let offset = getOffset();
  console.log(`📡 Telegram long-polling started (offset: ${offset})`);

  while (true) {
    try {
      // timeout=30 — Telegram holds connection up to 30s, delivers instantly on message
      const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message"]`;
      const res = await fetch(url, { signal: AbortSignal.timeout(35000) });
      const data = await res.json();

      if (!data.ok) {
        console.log(`⚠️  Telegram getUpdates error: ${data.description}`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
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
