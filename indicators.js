// Pure indicator calculations — extracted for testability.
// No I/O, no side effects, no dependencies.

export function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema  = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

export function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

// Donchian highest high of the `period` bars ending before the LAST bar.
export function calcDonchianHigh(candles, period) {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-period - 1, -1);
  return Math.max(...slice.map(c => c.high));
}

// Donchian lowest low of the `period` bars ending before the LAST bar.
export function calcDonchianLow(candles, period) {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-period - 1, -1);
  return Math.min(...slice.map(c => c.low));
}
