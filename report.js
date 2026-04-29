// report.js — Portfolio tracking + 4-hour intelligence report
import { readFileSync, writeFileSync, existsSync } from 'fs';

const SYMBOLS          = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,LINKUSDT,DOGEUSDT').split(',').map(s => s.trim());
const STARTING_CAPITAL = parseFloat(process.env.PORTFOLIO_VALUE_USD || '1000');
const REPORT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const STATE_FILE = 'portfolio.json';

// ─── State (portfolio.json) ───────────────────────────────────────────────────

function loadState() {
  const defaults = {
    startingCapital: STARTING_CAPITAL,
    legs: { A: { cash: STARTING_CAPITAL * 0.70 }, B: { cash: STARTING_CAPITAL * 0.30 } },
    positions: {},
    lastExits: {},
    lastReportTime: 0,
    paused: false,
  };
  if (!existsSync(STATE_FILE)) return defaults;
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    // Migrate old flat cash structure
    if (saved.cash !== undefined && !saved.legs) {
      saved.legs = {
        A: { cash: (saved.cash || 0) * 0.70 },
        B: { cash: (saved.cash || 0) * 0.30 },
      };
      delete saved.cash;
    }
    return {
      ...defaults, ...saved,
      legs: { A: { cash: 0 }, B: { cash: 0 }, ...(saved.legs || {}) },
      positions: saved.positions || {},
      lastExits:  saved.lastExits  || {},
    };
  } catch { return defaults; }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// updatePortfolio — records a BUY or SELL against the correct leg cash pool.
// leg      : "A" (trend) or "B" (mean-rev) — required for leg-based cash tracking.
// atrAtEntry: ATR value stored at buy time, used for live TP calculation.
// sellQuantity: specific qty to sell (null = full position close).
export function updatePortfolio(symbol, side, price, tradeSize, sellQuantity = null, leg = 'B', atrAtEntry = 0) {
  const state = loadState();
  if (!state.legs) state.legs = { A: { cash: 0 }, B: { cash: 0 } };

  if (side === 'buy') {
    // Deduct from the leg's cash pool
    state.legs[leg].cash = Math.max(0, (state.legs[leg].cash || 0) - tradeSize);
    if (!state.positions[symbol]) {
      state.positions[symbol] = { leg, quantity: 0, avgCost: 0, totalCost: 0, atrAtEntry: atrAtEntry || 0, entryTime: Date.now() };
    }
    const pos = state.positions[symbol];
    pos.leg        = leg;
    pos.atrAtEntry = atrAtEntry || pos.atrAtEntry || 0;
    if (!pos.entryTime) pos.entryTime = Date.now();
    pos.quantity  += tradeSize / price;
    pos.totalCost += tradeSize;
    pos.avgCost    = pos.totalCost / pos.quantity;
  } else if (side === 'sell') {
    const pos = state.positions[symbol];
    if (pos) {
      const posLeg = pos.leg || leg;
      const qty    = sellQuantity ?? pos.quantity;
      // Return proceeds to the leg's cash pool
      state.legs[posLeg].cash = (state.legs[posLeg].cash || 0) + qty * price;
      pos.quantity  -= qty;
      pos.totalCost  = pos.quantity * pos.avgCost;
      if (pos.quantity <= 1e-8) {
        delete state.positions[symbol];
        state.lastExits = state.lastExits || {};
        state.lastExits[symbol] = Date.now();
      }
    }
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

function toCbSymbol(s) {
  if (s.includes('-'))    return s;
  if (s.endsWith('USDT')) return s.slice(0, -4) + '-USD';
  if (s.endsWith('USD'))  return s.slice(0, -3) + '-USD';
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
            price:     parseFloat(d.price),
            change24h: parseFloat(d.price_percentage_change_24h || 0),
          };
        })
        .catch(() => {})
    )
  );
  return results;
}

// ─── External Market Intelligence ─────────────────────────────────────────────

async function fetchFearGreed() {
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    const v = parseInt(d?.data?.[0]?.value || 0);
    const label = d?.data?.[0]?.value_classification || '';
    return { value: v, label };
  } catch { return null; }
}

async function fetchGlobalMarket() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/global', { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    const g = d?.data;
    return {
      btcDominance:   parseFloat(g?.market_cap_percentage?.btc || 0).toFixed(1),
      totalMarketCap: g?.total_market_cap?.usd || 0,
      marketCapChange24h: parseFloat(g?.market_cap_change_percentage_24h_usd || 0).toFixed(2),
    };
  } catch { return null; }
}

// Feed-level title patterns to skip (these are channel/source names, not articles)
const FEED_TITLE_RE = /^(RSS|Feed|Cointelegraph|CoinDesk|Reuters|Yahoo|Bloomberg|CoinGecko|Decrypt|TheBlock|Bitcoin Magazine)/i;
const FILLER_RE     = /^(here.?s what happened|today in crypto|daily (brief|roundup)|morning (brief|markets)|what happened in crypto|crypto today)/i;

async function fetchRSS(url, max = 4) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradingBot/1.0)' },
      signal: AbortSignal.timeout(6000),
    });
    const xml = await r.text();
    const titles = [];
    // Match <item> titles only (skip the top-level <channel><title>)
    const itemsOnly = xml.split(/<item[\s>]/i).slice(1).join('<item>');
    const re = /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gs;
    const src = itemsOnly || xml; // fallback to full xml if no <item> found
    let m;
    while ((m = re.exec(src)) !== null && titles.length < max + 4) {
      const t = m[1].trim()
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').trim();
      if (
        t.length > 20 &&
        t.length < 200 &&
        !FEED_TITLE_RE.test(t) &&
        !FILLER_RE.test(t)
      ) titles.push(t);
    }
    return titles.slice(0, max);
  } catch { return []; }
}

// ─── Portfolio Snapshot (identical logic to telegram.js /portfolio) ───────────

function buildPortfolioSnap(state, prices) {
  let posValue = 0, unrealizedPnL = 0;
  const posLines = [];

  for (const [sym, pos] of Object.entries(state.positions || {})) {
    // Use live price if available, fall back to avgCost (matches telegram.js behaviour)
    const cp = prices[sym]?.price || pos.avgCost || 0;
    const cv = pos.quantity * cp;
    const pnl = cv - pos.totalCost;
    posValue     += cv;
    unrealizedPnL += pnl;
    const arrow  = pnl >= 0 ? '▲' : '▼';
    const pct    = pos.totalCost > 0 ? ((pnl / pos.totalCost) * 100).toFixed(1) : '0.0';
    const liveTag = prices[sym] ? '' : ' (est.)';
    posLines.push(
      `  ${arrow} ${sym.replace('USDT','')}: $${pos.totalCost.toFixed(2)} → $${cv.toFixed(2)}${liveTag}` +
      ` (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} / ${pnl >= 0 ? '+' : ''}${pct}%)`
    );
  }

  const legACash = state.legs?.A?.cash || 0;
  const legBCash = state.legs?.B?.cash || 0;
  const totalCash = legACash + legBCash;
  const total  = totalCash + posValue;
  const net    = total - (state.startingCapital || STARTING_CAPITAL);
  const netPct = ((net / (state.startingCapital || STARTING_CAPITAL)) * 100).toFixed(1);

  return { posValue, unrealizedPnL, total, net, netPct, posLines, legACash, legBCash };
}

// ─── Session Stats (E2) ────────────────────────────────────────────────────────

function getSessionStats(log, hoursBack = 4) {
  const cutoff   = Date.now() - hoursBack * 60 * 60 * 1000;
  const recent   = log.trades.filter(t => new Date(t.timestamp).getTime() > cutoff);
  const executed = recent.filter(t => t.orderPlaced);
  const failed   = recent.filter(t => !t.orderPlaced && t.error);
  const entries  = executed.filter(t => t.side === 'buy');
  const exits    = executed.filter(t => t.side === 'sell');
  // Realized P&L from exits this window
  const realizedPnL = exits.reduce((s, t) => s + (t.pnl || 0), 0);
  return { recent, executed, failed, entries, exits, realizedPnL };
}

// ─── Trade Performance Analysis ───────────────────────────────────────────────
// For E2: BUY entries show unrealized move vs current price.
//         SELL exits show realized P&L from the log.

function analysePerformance(executed, prices) {
  const results = [];
  for (const t of executed) {
    if (t.side === 'buy') {
      const currentPrice = prices[t.symbol]?.price;
      if (!currentPrice || !t.price) continue;
      const pctMove = ((currentPrice - t.price) / t.price) * 100;
      const tpTarget = t.tpTarget ? parseFloat(t.tpTarget) : null;
      const pctToTp  = (tpTarget && currentPrice)
        ? ((tpTarget - currentPrice) / currentPrice * 100).toFixed(1)
        : null;
      results.push({
        symbol:    t.symbol.replace('USDT', ''),
        side:      'buy',
        leg:       t.leg || '?',
        entry:     t.price,
        current:   currentPrice,
        pctMove,
        tpTarget,
        pctToTp,
        size:      t.tradeSize || 0,
        timestamp: t.timestamp,
      });
    } else if (t.side === 'sell') {
      // Realized exit — use logged pnlPct
      results.push({
        symbol:    t.symbol.replace('USDT', ''),
        side:      'sell',
        leg:       t.leg || '?',
        entry:     t.entryPrice || t.price,
        current:   t.price,
        pctMove:   parseFloat(t.pnlPct || 0),
        exitReason: t.exitReason || '',
        pnl:       t.pnl || 0,
        size:      t.tradeSize || 0,
        timestamp: t.timestamp,
      });
    }
  }
  return results;
}

// ─── Suggestions Engine (E2 Swing Ensemble) ───────────────────────────────────

function generateSuggestions({ perf, openPositions, fearGreed, global, prices }) {
  const suggestions = [];

  const openEntries  = perf.filter(t => t.side === 'buy');
  const closedExits  = perf.filter(t => t.side === 'sell');

  // ── Open position health ───────────────────────────────────────────────────
  if (openEntries.length === 0 && Object.keys(openPositions).length === 0) {
    suggestions.push('No open positions — bot is hunting for the next 6H Donchian breakout or mean-rev dip. Patience is the correct stance.');
  }

  // Any positions well on their way to TP?
  const nearTp = openEntries.filter(t => t.pctToTp !== null && parseFloat(t.pctToTp) < 15);
  if (nearTp.length > 0) {
    nearTp.forEach(t => {
      suggestions.push(`${t.symbol} [Leg ${t.leg}] is within ${t.pctToTp}% of its 5×ATR TP target — watch for exit trigger on next 6H close.`);
    });
  }

  // Positions moving against us
  const underwater = openEntries.filter(t => t.pctMove < -3);
  if (underwater.length > 0) {
    underwater.forEach(t => {
      suggestions.push(`${t.symbol} [Leg ${t.leg}] is ${t.pctMove.toFixed(1)}% below entry. E2 has no stop-loss — hold until 10-bar Donchian low exit (Leg A) or TP hit.`);
    });
  }

  // ── Recent exits ──────────────────────────────────────────────────────────
  if (closedExits.length > 0) {
    const wins   = closedExits.filter(t => t.pnl >= 0);
    const losses = closedExits.filter(t => t.pnl < 0);
    if (wins.length > 0) {
      suggestions.push(`${wins.length} exit(s) closed profitably this window — compounding is working. Check leg cash balances have updated correctly.`);
    }
    if (losses.length > 0) {
      suggestions.push(`${losses.length} exit(s) closed at a loss. For Leg A (Donchian exit), this is expected in choppy markets — wait for the next clear breakout.`);
    }
  }

  // ── Leg A trend context ────────────────────────────────────────────────────
  // Check if BTC is in GC or DC to give context for Leg A opportunity
  const btcPrice = prices['BTCUSDT']?.price;
  if (btcPrice) {
    if (fearGreed && fearGreed.value >= 70) {
      suggestions.push(`Fear & Greed at ${fearGreed.value} (${fearGreed.label}) — elevated greed. Leg A (Donchian trend) entries may be chasing extended moves. Leg B mean-rev entries more likely to trigger on pullbacks.`);
    } else if (fearGreed && fearGreed.value <= 30) {
      suggestions.push(`Fear & Greed at ${fearGreed.value} (${fearGreed.label}) — fear environment. Leg B mean-rev (RSI ≤30 in death cross) has strongest historical edge in this regime.`);
    }
  }

  // ── Fear & Greed context ──────────────────────────────────────────────────
  if (fearGreed && !btcPrice) {
    if (fearGreed.value <= 20) {
      suggestions.push(`Extreme fear (${fearGreed.value}/100) — Leg B death-cross dip-buy entries carry highest conviction here. Monitor for RSI ≤30 setups.`);
    } else if (fearGreed.value >= 80) {
      suggestions.push(`Extreme greed (${fearGreed.value}/100) — momentum is strong, favours Leg A Donchian breakouts. Leg B mean-rev entries may see reduced accuracy.`);
    }
  }

  // ── Macro market cap context ───────────────────────────────────────────────
  if (global) {
    const capChange = parseFloat(global.marketCapChange24h);
    if (capChange <= -5) {
      suggestions.push(`Broad crypto market down ${Math.abs(capChange)}% in 24h. Strong downtrend — Leg A trend entries unlikely; Leg B DC dip-buy (RSI ≤30) is the primary signal to watch.`);
    } else if (capChange >= 5) {
      suggestions.push(`Broad crypto market up ${capChange}% in 24h — bullish momentum. Leg A Donchian breakouts most likely to fire. Watch for confirmed 6H closes above 20-bar highs.`);
    }
  }

  // ── E2 scan cadence reminder ───────────────────────────────────────────────
  if (openEntries.length === 0 && closedExits.length === 0) {
    suggestions.push('E2 scans every 6H. Signals are infrequent by design (~40-48/yr) — quality over quantity. The next potential entry fires at the next 6H candle close.');
  }

  return suggestions.length > 0 ? suggestions : ['Strategy running normally. No specific actions needed this window.'];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtPrice(p) {
  if (!p) return 'N/A';
  if (p >= 1000) return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1)    return '$' + p.toFixed(2);
  return '$' + p.toFixed(6);
}

function fmtPct(n) {
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtTb(bytes) {
  const t = bytes / 1e12;
  return '$' + t.toFixed(2) + 'T';
}

// ─── Main Report ──────────────────────────────────────────────────────────────

export async function generateReport(log) {
  const state = loadState();
  const now   = new Date();

  const timeStr = now.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true, timeZoneName: 'short',
  });

  const mode = process.env.PAPER_TRADING !== 'false' ? '📋 PAPER' : '🔴 LIVE';

  // Fetch everything in parallel
  const [prices, fearGreed, global, ctHeadlines, cdHeadlines, macroHeadlines] = await Promise.all([
    fetchPrices(),
    fetchFearGreed(),
    fetchGlobalMarket(),
    fetchRSS('https://cointelegraph.com/rss', 3),
    fetchRSS('https://www.coindesk.com/arc/outboundfeeds/rss/', 2),
    fetchRSS('https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EVIX,SPY,AAPL&region=US&lang=en-US', 2),
  ]);

  // Portfolio (same calculation as telegram.js /portfolio)
  const snap = buildPortfolioSnap(state, prices);

  // Session stats
  const stats = getSessionStats(log, 4);

  // Trade performance vs current price
  const perf    = analysePerformance(stats.executed, prices);
  const winners = perf.filter(t => t.pctMove > 0);
  const losers  = perf.filter(t => t.pctMove <= 0);

  // Today's totals
  const today = now.toISOString().slice(0, 10);
  const todayTrades = log.trades.filter(t => t.timestamp.startsWith(today) && t.orderPlaced);

  // Suggestions (E2-aware)
  const suggestions = generateSuggestions({
    perf,
    openPositions: state.positions || {},
    fearGreed,
    global,
    prices,
  });

  // ── News dedup + combine ───────────────────────────────────────────────────
  const cryptoHeadlines = [...ctHeadlines, ...cdHeadlines]
    .filter((h, i, arr) => arr.indexOf(h) === i)
    .slice(0, 4);

  const nextStr = new Date(Date.now() + REPORT_INTERVAL_MS).toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });

  // ── Assemble report ────────────────────────────────────────────────────────
  const L = [];

  const push = (...lines) => lines.forEach(l => L.push(l));

  push(
    `📊 <b>4-HOUR REPORT</b>  ${mode}`,
    `🕐 ${timeStr}`,
    ``,
  );

  // ── Market snapshot ────────────────────────────────────────────────────────
  push(`<b>📈 MARKET SNAPSHOT</b>`);
  for (const s of SYMBOLS) {
    const d = prices[s];
    if (!d) { push(`  • ${s.replace('USDT','')} — price unavailable`); continue; }
    const arrow = d.change24h >= 0 ? '▲' : '▼';
    push(`  ${arrow} <b>${s.replace('USDT','')}</b>: ${fmtPrice(d.price)}  (${fmtPct(d.change24h)} 24h)`);
  }
  if (fearGreed) {
    const fgEmoji = fearGreed.value <= 25 ? '😱' : fearGreed.value <= 45 ? '😰' : fearGreed.value <= 55 ? '😐' : fearGreed.value <= 75 ? '😏' : '🤑';
    push(`  ${fgEmoji} Fear &amp; Greed: <b>${fearGreed.value}/100</b> — ${fearGreed.label}`);
  }
  if (global) {
    const capArrow = parseFloat(global.marketCapChange24h) >= 0 ? '▲' : '▼';
    push(`  ${capArrow} Total Market Cap: ${fmtTb(global.totalMarketCap)}  (${fmtPct(parseFloat(global.marketCapChange24h))} 24h)  |  BTC Dom: ${global.btcDominance}%`);
  }
  push('');

  // ── Portfolio ──────────────────────────────────────────────────────────────
  push(`<b>💰 PORTFOLIO  (E2 Ensemble)</b>`);
  push(
    `  Starting capital: $${(state.startingCapital || STARTING_CAPITAL).toFixed(2)}`,
    `  Leg A cash (70%): $${snap.legACash.toFixed(2)}  ← Donchian-GC trend`,
    `  Leg B cash (30%): $${snap.legBCash.toFixed(2)}  ← Mean-rev contrarian`,
    `  Open positions:   $${snap.posValue.toFixed(2)}`,
    `  Total value:      $${snap.total.toFixed(2)}`,
    `  Unrealized P&amp;L: ${snap.unrealizedPnL >= 0 ? '+' : ''}$${snap.unrealizedPnL.toFixed(2)}`,
    `  Net change:       ${snap.net >= 0 ? '+' : ''}$${snap.net.toFixed(2)} (${snap.net >= 0 ? '+' : ''}${snap.netPct}%)`,
  );
  if (snap.posLines.length) {
    push('');
    snap.posLines.forEach(l => push(l));
  }
  push('');

  // ── Session recap ──────────────────────────────────────────────────────────
  push(`<b>📋 SESSION — last 4h</b>`);
  const pnlStr = stats.realizedPnL !== 0
    ? `  |  Realized: ${stats.realizedPnL >= 0 ? '+' : ''}$${stats.realizedPnL.toFixed(2)}`
    : '';
  push(
    `  Entries: ${stats.entries.length}  |  Exits: ${stats.exits.length}${pnlStr}` +
    (stats.failed.length > 0 ? `  |  ⚠️ Failed: ${stats.failed.length}` : ''),
    `  Today total: ${todayTrades.length} trade(s)`,
  );
  push('');

  // ── What went right ────────────────────────────────────────────────────────
  push(`<b>✅ WHAT WENT RIGHT</b>`);
  const openWinners = winners.filter(t => t.side === 'buy');
  const closedWins  = winners.filter(t => t.side === 'sell');
  if (closedWins.length > 0) {
    closedWins.forEach(t => {
      push(`  • ${t.symbol} [Leg ${t.leg}] EXIT: ${fmtPct(t.pctMove)} realized  (${t.exitReason?.replace(/_/g,' ') || 'exit'})`);
    });
  }
  if (openWinners.length > 0) {
    openWinners.forEach(t => {
      const tpNote = t.pctToTp ? `  ${t.pctToTp}% to TP` : '';
      push(`  • ${t.symbol} [Leg ${t.leg}] open: entry ${fmtPrice(t.entry)} → ${fmtPrice(t.current)}  (${fmtPct(t.pctMove)}${tpNote})`);
    });
  }
  if (stats.entries.length === 0 && stats.exits.length === 0) {
    push('  • No signals this window — E2 correctly quiet in the absence of 6H Donchian breakouts or RSI extremes.');
    const anyBigMoves = Object.values(prices).some(p => Math.abs(p.change24h) > 3);
    if (anyBigMoves) push('  • Market volatile (+/-3%+) but no qualifying setups — avoiding noise is a win.');
  }
  if (winners.length === 0 && stats.executed.length > 0) {
    push('  • Entries placed but not yet at profit — hold until TP or Donchian exit triggers.');
  }
  push('');

  // ── What went wrong ────────────────────────────────────────────────────────
  push(`<b>❌ WHAT WENT WRONG</b>`);
  const openLosers   = losers.filter(t => t.side === 'buy');
  const closedLosses = losers.filter(t => t.side === 'sell');
  if (closedLosses.length > 0) {
    closedLosses.forEach(t => {
      push(`  • ${t.symbol} [Leg ${t.leg}] EXIT at loss: ${fmtPct(t.pctMove)}  (${t.exitReason?.replace(/_/g,' ') || 'exit'})`);
    });
  }
  if (openLosers.length > 0) {
    openLosers.forEach(t => {
      push(`  • ${t.symbol} [Leg ${t.leg}] currently ${fmtPct(t.pctMove)}: entry ${fmtPrice(t.entry)} → ${fmtPrice(t.current)}  — awaiting TP or exit signal`);
    });
  }
  if (stats.failed.length > 0) {
    push(`  ⚠️ ${stats.failed.length} order(s) failed to place — check Coinbase API logs.`);
  }
  if (losers.length === 0 && stats.failed.length === 0) {
    push('  • No errors or losing positions this window.');
  }
  push('');

  // ── Suggestions ───────────────────────────────────────────────────────────
  push(`<b>💡 SUGGESTIONS</b>`);
  suggestions.forEach(s => push(`  • ${s}`));
  push('');

  // ── Market intelligence ───────────────────────────────────────────────────
  const allNews = [...cryptoHeadlines, ...macroHeadlines].filter(Boolean);
  if (allNews.length > 0) {
    push(`<b>📰 MARKET INTELLIGENCE</b>`);
    allNews.slice(0, 5).forEach(h => push(`  • ${h.slice(0, 110)}`));
    push('');
  }

  push(`─────────────────────────────`);
  push(`⏰ Next report: ~${nextStr}  |  Assets: ${SYMBOLS.map(s => s.replace('USDT','')).join(', ')}`);

  return L.join('\n');
}
