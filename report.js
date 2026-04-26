// report.js — Portfolio tracking + 4-hour intelligence report
import { readFileSync, writeFileSync, existsSync } from 'fs';

const SYMBOLS          = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map(s => s.trim());
const STARTING_CAPITAL = parseFloat(process.env.PORTFOLIO_VALUE_USD || '1000');
const REPORT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const STATE_FILE = 'portfolio.json';

// ─── State (portfolio.json) ───────────────────────────────────────────────────

function loadState() {
  const defaults = {
    startingCapital: STARTING_CAPITAL,
    cash: STARTING_CAPITAL,
    positions: {},
    lastReportTime: 0,
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

export function updatePortfolio(symbol, side, price, tradeSize) {
  const state = loadState();
  if (side === 'buy') {
    state.cash = Math.max(0, state.cash - tradeSize);
    if (!state.positions[symbol]) state.positions[symbol] = { quantity: 0, avgCost: 0, totalCost: 0 };
    const pos = state.positions[symbol];
    pos.quantity  += tradeSize / price;
    pos.totalCost += tradeSize;
    pos.avgCost    = pos.totalCost / pos.quantity;
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

function toCbSymbol(s) {
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

  const total  = (state.cash || 0) + posValue;
  const net    = total - (state.startingCapital || STARTING_CAPITAL);
  const netPct = ((net / (state.startingCapital || STARTING_CAPITAL)) * 100).toFixed(1);

  return { posValue, unrealizedPnL, total, net, netPct, posLines };
}

// ─── Session Stats ─────────────────────────────────────────────────────────────

function getSessionStats(log, hoursBack = 4) {
  const cutoff  = Date.now() - hoursBack * 60 * 60 * 1000;
  const recent  = log.trades.filter(t => new Date(t.timestamp).getTime() > cutoff);
  const executed = recent.filter(t => t.orderPlaced);
  const blocked  = recent.filter(t => !t.orderPlaced);

  const blockerCounts = {};
  blocked.forEach(t => {
    (t.conditions || []).filter(c => !c.pass).forEach(c => {
      blockerCounts[c.label] = (blockerCounts[c.label] || 0) + 1;
    });
  });
  const topBlocker = Object.entries(blockerCounts).sort((a, b) => b[1] - a[1])[0] || null;

  return { recent, executed, blocked, topBlocker, blockerCounts };
}

// ─── Trade Performance Analysis ───────────────────────────────────────────────
// Compare entry prices from recent trades to current prices.

function analysePerformance(executed, prices) {
  const results = [];
  for (const t of executed) {
    const currentPrice = prices[t.symbol]?.price;
    if (!currentPrice || !t.price) continue;
    const pctMove = t.side === 'buy'
      ? ((currentPrice - t.price) / t.price) * 100
      : ((t.price - currentPrice) / t.price) * 100;
    results.push({
      symbol:    t.symbol.replace('USDT', ''),
      side:      t.side,
      entry:     t.price,
      current:   currentPrice,
      pctMove,
      strength:  t.signalStrength || 0,
      size:      t.tradeSize || 0,
      regime:    t.regime,
      timestamp: t.timestamp,
    });
  }
  return results;
}

// ─── Suggestions Engine ───────────────────────────────────────────────────────

function generateSuggestions({ perf, stats, fearGreed, global, blockCount, recentAll }) {
  const suggestions = [];
  const winCount  = perf.filter(t => t.pctMove > 0).length;
  const lossCount = perf.filter(t => t.pctMove <= 0).length;
  const winRate   = perf.length > 0 ? (winCount / perf.length) * 100 : null;

  // ── Performance-based ──────────────────────────────────────────────────────
  if (perf.length === 0 && stats.blocked.length === 0) {
    suggestions.push('No activity this window. Market is in consolidation — patience is the strategy.');
  }

  if (winRate !== null) {
    if (winRate >= 65) {
      suggestions.push(`Win rate ${winRate.toFixed(0)}% this window — strategy is dialled in. Hold current settings.`);
    } else if (winRate >= 45) {
      suggestions.push(`Win rate ${winRate.toFixed(0)}% — slightly below target. Review whether entries were at RSI extremes or near the 38/62 boundary.`);
    } else if (winRate < 45) {
      suggestions.push(`Win rate only ${winRate.toFixed(0)}% — consider waiting for deeper RSI readings (≤34 buys / ≥66 sells) before entering. Thresholds may need tightening in current volatility.`);
    }
  }

  // ── High-strength trades underperforming ──────────────────────────────────
  const highStr = perf.filter(t => t.strength >= 0.6);
  const highStrLosers = highStr.filter(t => t.pctMove <= 0);
  if (highStr.length >= 2 && highStrLosers.length / highStr.length > 0.5) {
    suggestions.push('High-confidence signals are underperforming. Could indicate a trending market overriding mean-reversion — consider temporarily reducing position size by 30%.');
  }

  // ── Regime context ─────────────────────────────────────────────────────────
  const deathCrossTrades = recentAll.filter(t => t.regime === 'death_cross');
  const goldenCrossTrades = recentAll.filter(t => t.regime === 'golden_cross');
  if (deathCrossTrades.length > goldenCrossTrades.length * 2) {
    suggestions.push('Most scans are in death cross regime. Be cautious on buy signals if BTC is in a strong downtrend — death crosses on 5m can persist for hours.');
  } else if (goldenCrossTrades.length > deathCrossTrades.length * 2) {
    suggestions.push('Consistent golden cross regime. Sell signals have macro tailwind — be more aggressive on high-strength sell setups.');
  }

  // ── Blocker patterns ──────────────────────────────────────────────────────
  if (stats.topBlocker) {
    const [cond, count] = stats.topBlocker;
    if (count >= 4) {
      suggestions.push(`"${cond}" has blocked ${count} entries. If this is RSI not reaching threshold, price may be in a slow mean-reversion — patience over chasing.`);
    }
  }

  // ── Fear & Greed context ──────────────────────────────────────────────────
  if (fearGreed) {
    if (fearGreed.value <= 20) {
      suggestions.push(`Fear & Greed at ${fearGreed.value} (${fearGreed.label}). Extreme fear can mean capitulation — buy signals carry higher conviction. Watch for volume spike confirmation.`);
    } else if (fearGreed.value >= 80) {
      suggestions.push(`Fear & Greed at ${fearGreed.value} (${fearGreed.label}). Extreme greed = elevated reversal risk. Tighten stops or reduce sell signal sizes — euphoria can extend further than expected.`);
    } else if (fearGreed.value >= 65) {
      suggestions.push(`Market sentiment is greedy (${fearGreed.value}). Contrarian sell setups have better macro backing right now.`);
    } else if (fearGreed.value <= 35) {
      suggestions.push(`Market sentiment is fearful (${fearGreed.value}). Contrarian buy setups in death cross have higher mean-reversion potential.`);
    }
  }

  // ── Macro market cap context ───────────────────────────────────────────────
  if (global) {
    const capChange = parseFloat(global.marketCapChange24h);
    if (capChange <= -5) {
      suggestions.push(`Total crypto market cap down ${Math.abs(capChange)}% in 24h. Consider pausing sell signals until market finds support — sharp drops can continue.`);
    } else if (capChange >= 5) {
      suggestions.push(`Total crypto market cap up ${capChange}% in 24h. Strong rally — buy signals may face resistance near highs, be selective.`);
    }
  }

  return suggestions.length > 0 ? suggestions : ['Strategy appears balanced. Continue monitoring.'];
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
  const perf = analysePerformance(stats.executed, prices);
  const winners = perf.filter(t => t.pctMove > 0);
  const losers  = perf.filter(t => t.pctMove <= 0);

  // Today's totals
  const today = now.toISOString().slice(0, 10);
  const todayTrades = log.trades.filter(t => t.timestamp.startsWith(today) && t.orderPlaced);

  // Suggestions
  const suggestions = generateSuggestions({
    perf, stats, fearGreed, global,
    blockCount: stats.blocked.length,
    recentAll:  stats.recent,
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
  push(`<b>💰 PORTFOLIO</b>`);
  push(
    `  Starting capital: $${(state.startingCapital || STARTING_CAPITAL).toFixed(2)}`,
    `  USDC cash:        $${(state.cash || 0).toFixed(2)}`,
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
  push(
    `  Scans: ${stats.recent.length}  |  Trades: ${stats.executed.length}  |  Blocked: ${stats.blocked.length}`,
    `  Today total: ${todayTrades.length} trade(s)`,
  );
  push('');

  // ── What went right ────────────────────────────────────────────────────────
  push(`<b>✅ WHAT WENT RIGHT</b>`);
  if (winners.length > 0) {
    winners.forEach(t => {
      push(`  • ${t.symbol} ${t.side.toUpperCase()}: entry ${fmtPrice(t.entry)} → ${fmtPrice(t.current)}  (${fmtPct(t.pctMove)})  signal ${Math.round(t.strength * 100)}%`);
    });
  } else if (stats.executed.length === 0) {
    push('  • No trades fired this window — filters avoided low-quality setups.');
    // Check if market went against us (good that we didn't trade)
    const anyBigMoves = Object.values(prices).some(p => Math.abs(p.change24h) > 3);
    if (anyBigMoves) push('  • Market had large moves (+/-3%+) — staying disciplined during volatility is a win.');
  } else {
    push('  • No open positions from this window are currently profitable.');
  }
  if (stats.blocked.length === 0 && stats.executed.length === 0) {
    push('  • Strategy correctly silent in low-signal environment.');
  }
  push('');

  // ── What went wrong ────────────────────────────────────────────────────────
  push(`<b>❌ WHAT WENT WRONG</b>`);
  if (losers.length > 0) {
    losers.forEach(t => {
      push(`  • ${t.symbol} ${t.side.toUpperCase()}: entry ${fmtPrice(t.entry)} → ${fmtPrice(t.current)}  (${fmtPct(t.pctMove)})  signal ${Math.round(t.strength * 100)}%`);
    });
  }
  // Missed moves (blocked trades where price went our way)
  const missedMoves = [];
  for (const t of stats.blocked) {
    const cp = prices[t.symbol]?.price;
    if (!cp || !t.price) continue;
    const wouldHaveBeen = t.side === 'buy'
      ? ((cp - t.price) / t.price) * 100
      : ((t.price - cp) / t.price) * 100;
    if (wouldHaveBeen > 0.5) {
      missedMoves.push({ symbol: t.symbol.replace('USDT',''), side: t.side, pct: wouldHaveBeen, cond: (t.conditions || []).find(c => !c.pass)?.label || '?' });
    }
  }
  if (missedMoves.length > 0) {
    push(`  ⚠️ Missed moves (blocked but would have profited):`);
    missedMoves.slice(0, 3).forEach(m => {
      push(`    • ${m.symbol} ${m.side.toUpperCase()}: blocked by "${m.cond}" — would be ${fmtPct(m.pct)}`);
    });
  }
  if (losers.length === 0 && missedMoves.length === 0) {
    push('  • No significant errors this window.');
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
