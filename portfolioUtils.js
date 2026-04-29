// Pure portfolio helper functions — no I/O, no side effects.

/** Current equity of a leg = leg cash + mark-to-market of its open positions. */
export function getLegEquity(state, leg, livePrices = {}) {
  let equity = state.legs[leg]?.cash || 0;
  for (const [sym, pos] of Object.entries(state.positions)) {
    if (pos.leg !== leg) continue;
    const price = livePrices[sym] || pos.avgCost || 0;
    equity += pos.quantity * price;
  }
  return equity;
}

/** Count open positions for a leg. */
export function legPositionCount(state, leg) {
  return Object.values(state.positions).filter(p => p.leg === leg).length;
}

/** Convert BTCUSDT / BTCUSD → BTC-USD for Coinbase API. */
export function toCoinbaseSymbol(symbol) {
  if (symbol.includes("-")) return symbol;              // already Coinbase format
  if (symbol.endsWith("USDT")) return symbol.slice(0, -4) + "-USD";
  if (symbol.endsWith("USD"))  return symbol.slice(0, -3) + "-USD";
  return symbol;
}
