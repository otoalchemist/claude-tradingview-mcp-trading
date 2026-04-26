// report.js — Report generation, portfolio tracking, Telegram commands
import { readFileSync, writeFileSync, existsSync } from 'fs';

const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,AKTUSDT').split(',').map(s => s.trim());
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STARTING_CAPITAL = parseFloat(process.env.PORTFOLIO_VALUE_USD || '1000');
const TIMEFRAME = process.env.TIMEFRAME || '5m';
const MAX_TRADES = process.env.MAX_TRADES_PER_DAY || '100';
const KUCOIN_SYMBOLS = ['AKTUSDT'];
const STATE_FILE = 'portfolio.json';
const REPORT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

// ─── State (portfolio + bot flags) ───────────────────────────────────────────

function loadState() {
  const defaults = {
    startingCapital: STARTING_CAPITAL,
    cash: STARTING_CAPITAL,
    positions: {},
    lastReportTime: 0,
    lastUpdateId: 0,
    paused: false,
  };
  if (!existsSync(STATE_FILE)) return defaults;
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return { ...defaults, ...saved, positions: saved.positions || {} };
  } catch { return defaults; }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function isPaused() {
  return loadState().paused || false;
}

export function updatePortfolio(symbol, side, price, tradeSize) {
  const state = loadState();
  if (side === 'buy') {
    state.cash = Math.max(0, state.cash - tradeSize);
    if (!state.positions[symbol]) state.positions[symbol] = { quantity: 0, avgCost: 0, totalCost: 0 };
    const pos = state.positions[symbol];
    pos.quantity += tradeSize / price;
    pos.totalCost += tradeSize;
    pos.avgCost = pos.totalCost / pos.quantity;
  } else if (side === 'sell') {
    const pos = state.positions[symbol];
    if (pos) { state.cash += pos.quantity * price; delete state.positions[symbol]; }
  }
  saveState(state);
}

export function shouldSendReport() {
  return Date.now() - (loadState().lastReportTime || 0) >= REPORT_INTERVAL_MS;
}

export function markReportSent() {
  const state = loadState();
  state.lastReportTime = Date.now();
  saveState(state);
}

// ─── Market Data ──────────────────────────────────────────────────────────────

async function fetch24hData() {
  const results = {};
  const binanceSymbols = SYMBOLS.filter(s => !KUCOIN_SYMBOLS.includes(s));

  await Promise.allSettled([
    // Binance US (BTC, ETH, SOL)
    ...binanceSymbols.map(s =>
      fetch(`https://api.binance.us/api/v3/ticker/24hr?symbol=${s}`, { signal: AbortSignal.timeout(5000) })
        .then(r => r.json())
        .then(d => { results[s] = { price: parseFloat(d.lastPrice), change24h: parseFloat(d.priceChangePercent) }; })
        .catch(() => {})
    ),
    // KuCoin (AKT)
    ...KUCOIN_SYMBOLS.filter(s => SYMBOLS.includes(s)).map(s =>
      fetch(`https://api.kucoin.com/api/v1/market/stats?symbol=${s.replace('USDT', '-USDT')}`, { signal: AbortSignal.timeout(5000) })
        .then(r => r.json())
        .then(d => {
          if (d.data) {
            const last = parseFloat(d.data.last);
            const open = parseFloat(d.data.open);
            results[s] = { price: last, change24h: ((last - open) / open) * 100 };
          }
        })
        .catch(() => {})
    ),
  ]);

  return results;
}

// ─── News ─────────────────────────────────────────────────────────────────────

async function fetchRSS(url, max = 5) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
    const xml = await r.text();
    const titles = [];
    const re = /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gs;
    let m;
    while ((m = re.exec(xml)) !== null && titles.length < max + 2) {
      const t = m[1].trim()
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '');
      if (t.length > 15 && !/^(RSS|Feed|Cointelegraph|CoinDesk)$/i.test(t)) titles.push(t);
    }
    return titles.slice(0, max);
  } catch { return []; }
}

// ─── Session Stats ────────────────────────────────────────────────────────────

function getSessionStats(log, hoursBack = 4) {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const recent = log.trades.filter(t => new Date(t.timestamp).getTime() > cutoff);

  const scans = recent.length;
  const executed = recent.filter(t => t.orderPlaced).length;
  const blocked = recent.filter(t => !t.orderPlaced).length;

  const nearMisses = recent
    .filter(t => !t.orderPlaced && Array.isArray(t.conditions))
    .filter(t => t.conditions.filter(c => !c.pass).length === 1)
    .map(t => ({ symbol: t.symbol, cond: t.conditions.find(c => !c.pass)?.label || '?' }));

  const blockerCounts = {};
  recent.filter(t => !t.orderPlaced && Array.isArray(t.conditions)).forEach(t => {
    t.conditions.filter(c => !c.pass).forEach(c => {
      blockerCounts[c.label] = (blockerCounts[c.label] || 0) + 1;
    });
  });
  const topBlocker = Object.entries(blockerCounts).sort((a, b) => b[1] - a[1])[0];

  const bySymbol = {};
  SYMBOLS.forEach(s => {
    const sym = recent.filter(t => t.symbol === s);
    bySymbol[s] = {
      executed: sym.filter(t => t.orderPlaced).length,
      nearMisses: nearMisses.filter(n => n.symbol === s).length,
    };
  });

  return { scans, executed, blocked, nearMisses, topBlocker, bySymbol, recent };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtPrice(price) {
  if (!price) return 'N/A';
  if (price >= 1000) return '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1)    return '$' + price.toFixed(2);
  return '$' + price.toFixed(6);
}

function fmtMarketLine(symbol, price, change24h) {
  const arrow = change24h >= 0 ? '▲' : '▼';
  const pct = (change24h >= 0 ? '+' : '') + change24h.toFixed(2) + '% 24h';
  return `${arrow} ${symbol.replace('USDT', '')}: ${fmtPrice(price)} (${pct})`;
}

// ─── Generate Full Report ─────────────────────────────────────────────────────

export async function generateReport(log) {
  const state = loadState();
  const now = new Date();

  const timeStr = now.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short',
  });

  const prices = await fetch24hData();
  const stats = getSessionStats(log, 4);

  // Portfolio calculations
  let totalPosValue = 0, unrealizedPnL = 0;
  const posLines = [];
  for (const [sym, pos] of Object.entries(state.positions || {})) {
    const cp = prices[sym]?.price || 0;
    const cv = pos.quantity * cp;
    const pnl = cv - pos.totalCost;
    totalPosValue += cv;
    unrealizedPnL += pnl;
    const pnlPct = pos.totalCost > 0 ? ((pnl / pos.totalCost) * 100).toFixed(1) : '0.0';
    const arrow = pnl >= 0 ? '▲' : '▼';
    posLines.push(`  ${arrow} ${sym.replace('USDT','')}: cost $${pos.totalCost.toFixed(2)} → $${cv.toFixed(2)}  (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} / ${pnl >= 0 ? '+' : ''}${pnlPct}%)`);
  }
  const totalPortfolio = state.cash + totalPosValue;
  const netChange = totalPortfolio - state.startingCapital;
  const netPct = ((netChange / state.startingCapital) * 100).toFixed(1);

  // All-time
  const allExecuted = log.trades.filter(t => t.orderPlaced).length;
  const allDeployed = log.trades.filter(t => t.orderPlaced).reduce((s, t) => s + (t.tradeSize || 0), 0);
  const today = now.toISOString().slice(0, 10);
  const todayTrades = log.trades.filter(t => t.timestamp.startsWith(today) && t.orderPlaced);
  const todayDeployed = todayTrades.reduce((s, t) => s + (t.tradeSize || 0), 0);

  // News
  const [cointelegraph, coindesk] = await Promise.all([
    fetchRSS('https://cointelegraph.com/rss', 4),
    fetchRSS('https://www.coindesk.com/arc/outboundfeeds/rss/', 4),
  ]);
  const headlines = [...cointelegraph, ...coindesk].slice(0, 5);

  const nextReport = new Date(Date.now() + REPORT_INTERVAL_MS);
  const nextStr = nextReport.toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });

  const mode = process.env.PAPER_TRADING !== 'false' ? '📋 PAPER' : '🔴 LIVE';

  const L = [
    `📊 REPORT — Claude Trading Bot`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🕐 ${timeStr}`,
    ``,
    `📈 MARKET OVERVIEW`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ...SYMBOLS.map(s => prices[s] ? fmtMarketLine(s, prices[s].price, prices[s].change24h) : `• ${s.replace('USDT','')}: N/A`),
    ``,
    `💰 PORTFOLIO (${mode})`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Starting capital: $${state.startingCapital.toFixed(2)}`,
    `Cash:             $${state.cash.toFixed(2)}`,
    `Open positions:   $${totalPosValue.toFixed(2)}`,
    `Total portfolio:  $${totalPortfolio.toFixed(2)}`,
    `Unrealized P&L:   ${unrealizedPnL >= 0 ? '+' : ''}$${unrealizedPnL.toFixed(2)}`,
    `Net change:       ${netChange >= 0 ? '+' : ''}$${netChange.toFixed(2)} (${netChange >= 0 ? '+' : ''}${netPct}%)`,
    ...(posLines.length > 0 ? [``, `Positions:`, ...posLines] : []),
    ``,
    `Today: ${todayTrades.length} trade(s) | $${todayDeployed.toFixed(2)} deployed`,
    `All-time: ${allExecuted} trade(s) | $${allDeployed.toFixed(2)} deployed`,
    ``,
    `📋 SESSION (last 4h)`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Scans:       ${stats.scans}`,
    `Executed:    ${stats.executed}`,
    `Blocked:     ${stats.blocked}`,
    `Near-misses: ${stats.nearMisses.length}`,
    ...(stats.nearMisses.length > 0 ? [
      ``,
      `⚡️ Near-misses (1 condition away):`,
      ...stats.nearMisses.slice(0, 3).map(n => `  • ${n.symbol.replace('USDT','')} — blocked by: ${n.cond}`),
      ...(stats.nearMisses.length > 3 ? [`  ...and ${stats.nearMisses.length - 3} more`] : []),
    ] : []),
    ``,
    `✅ WHAT WENT RIGHT`,
    `━━━━━━━━━━━━━━━━━━━━`,
    stats.executed > 0 ? `• ${stats.executed} trade(s) executed on qualifying signals.` : `• No trades this window — filters held firm.`,
    stats.nearMisses.length > 0 ? `• ${stats.nearMisses.length} near-miss(es) — indicators converging, watch for entries.` : `• Signals quiet — patience pays.`,
    `• All-condition filter working as designed.`,
    ``,
    `⚠️ WHAT TO WATCH`,
    `━━━━━━━━━━━━━━━━━━━━`,
    stats.topBlocker ? `• Most common blocker: "${stats.topBlocker[0]}" (${stats.topBlocker[1]}x)` : `• No dominant blocker this window.`,
    ``,
    `🔄 ASSET ROTATION`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ...SYMBOLS.map(s => {
      const d = prices[s];
      const st = stats.bySymbol[s];
      const trend = (d?.change24h || 0) >= 0 ? '📈' : '📉';
      return `${trend} ${s.replace('USDT','')}: ${d ? fmtPrice(d.price) : 'N/A'} | ${st.executed} executed | ${st.nearMisses} near-miss(es)`;
    }),
    ...(headlines.length > 0 ? [
      ``,
      `📰 CRYPTO HEADLINES`,
      `━━━━━━━━━━━━━━━━━━━━`,
      ...headlines.map(h => `• ${h.slice(0, 100)}`),
    ] : []),
    ``,
    `─────────────────────────────`,
    `Next report: ~${nextStr} | Assets: ${SYMBOLS.map(s => s.replace('USDT','')).join(', ')}`,
  ];

  return L.join('\n');
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function tg(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch {}
}

// ─── Telegram Command Handler ─────────────────────────────────────────────────

export async function checkTelegramCommands(log) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const state = loadState();
  const offset = (state.lastUpdateId || 0) + 1;

  let data;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=1`, { signal: AbortSignal.timeout(5000) });
    data = await r.json();
  } catch { return; }

  if (!data.ok || !data.result.length) return;

  for (const update of data.result) {
    state.lastUpdateId = update.update_id;
    const raw = update.message?.text?.trim() || '';
    const cmd = raw.split('@')[0].toLowerCase(); // strip @botname suffix

    if (cmd === '/help') {
      await tg(
        `🤖 <b>Commands</b>\n\n` +
        `/status — Mode, trade count, last run\n` +
        `/portfolio — Cash, positions, P&amp;L\n` +
        `/prices — Live prices for all assets\n` +
        `/trades — Today's activity\n` +
        `/report — Full report right now\n` +
        `/pause — Pause trading\n` +
        `/resume — Resume trading\n` +
        `/help — This message`
      );

    } else if (cmd === '/status') {
      const today = new Date().toISOString().slice(0, 10);
      const todayCount = log.trades.filter(t => t.timestamp.startsWith(today) && t.orderPlaced).length;
      const mode = process.env.PAPER_TRADING !== 'false' ? '📋 Paper Trading' : '🔴 Live Trading';
      const statusIcon = state.paused ? '⏸' : '▶️';
      const lastRun = log.trades.length > 0
        ? new Date(log.trades[log.trades.length - 1].timestamp).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
        : 'Never';
      await tg(
        `📊 <b>Bot Status</b>\n\n` +
        `${statusIcon} ${state.paused ? 'PAUSED' : 'Running'}\n` +
        `Mode: ${mode}\n` +
        `Assets: ${SYMBOLS.map(s => s.replace('USDT','')).join(', ')}\n` +
        `Timeframe: ${TIMEFRAME}\n` +
        `Trades today: ${todayCount}/${MAX_TRADES}\n` +
        `Last run: ${lastRun}`
      );

    } else if (cmd === '/portfolio') {
      const prices = await fetch24hData();
      let totalPos = 0, pnl = 0;
      const posLines = [];
      for (const [sym, pos] of Object.entries(state.positions || {})) {
        const cp = prices[sym]?.price || 0;
        const cv = pos.quantity * cp;
        const p = cv - pos.totalCost;
        totalPos += cv; pnl += p;
        posLines.push(`  ${p >= 0 ? '▲' : '▼'} ${sym.replace('USDT','')}: $${pos.totalCost.toFixed(2)} → $${cv.toFixed(2)} (${p >= 0 ? '+' : ''}$${p.toFixed(2)})`);
      }
      const total = state.cash + totalPos;
      const net = total - state.startingCapital;
      await tg(
        `💰 <b>Portfolio</b>\n\n` +
        `Starting: $${state.startingCapital.toFixed(2)}\n` +
        `Cash: $${state.cash.toFixed(2)}\n` +
        `Positions: $${totalPos.toFixed(2)}\n` +
        `Total: $${total.toFixed(2)}\n` +
        `Net P&amp;L: ${net >= 0 ? '+' : ''}$${net.toFixed(2)}\n` +
        (posLines.length ? `\nPositions:\n${posLines.join('\n')}` : `\nNo open positions`)
      );

    } else if (cmd === '/prices') {
      const prices = await fetch24hData();
      const lines = ['💹 <b>Current Prices</b>\n'];
      SYMBOLS.forEach(s => {
        const d = prices[s];
        if (d) lines.push(fmtMarketLine(s, d.price, d.change24h));
      });
      await tg(lines.join('\n'));

    } else if (cmd === '/trades') {
      const today = new Date().toISOString().slice(0, 10);
      const todayTrades = log.trades.filter(t => t.timestamp.startsWith(today));
      if (!todayTrades.length) {
        await tg('📋 No activity today yet.');
      } else {
        const lines = [`📋 <b>Today's Activity</b> (${todayTrades.length} scans)\n`];
        todayTrades.slice(-10).forEach(t => {
          const sym = t.symbol.replace('USDT','');
          const icon = t.orderPlaced ? '✅' : '🚫';
          const time = new Date(t.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });
          lines.push(`${icon} ${sym} @ ${fmtPrice(t.price)} — ${time}`);
        });
        if (todayTrades.length > 10) lines.push(`...and ${todayTrades.length - 10} more`);
        await tg(lines.join('\n'));
      }

    } else if (cmd === '/pause') {
      state.paused = true;
      await tg('⏸ <b>Bot paused.</b>\nNo new trades until you send /resume.');

    } else if (cmd === '/resume') {
      state.paused = false;
      await tg('▶️ <b>Bot resumed.</b>\nBack to scanning for signals.');

    } else if (cmd === '/report') {
      await tg('⏳ Generating report...');
      const report = await generateReport(log);
      await tg(report);
    }
  }

  saveState(state);
}
