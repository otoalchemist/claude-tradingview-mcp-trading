import { describe, it, expect } from 'vitest';
import {
  calcEMA,
  calcRSI,
  calcATR,
  calcDonchianHigh,
  calcDonchianLow,
} from '../indicators.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function candle(high, low, close, open = close) {
  return { open, high, low, close, volume: 1 };
}

function flatCandles(n, price = 100) {
  return Array.from({ length: n }, () => candle(price + 1, price - 1, price));
}

// ─── calcEMA ──────────────────────────────────────────────────────────────────

describe('calcEMA', () => {
  it('returns null when fewer data points than period', () => {
    expect(calcEMA([1, 2, 3], 5)).toBeNull();
  });

  it('returns SMA when length equals period (no smoothing steps)', () => {
    // SMA([1,2,3,4,5]) = 3
    expect(calcEMA([1, 2, 3, 4, 5], 5)).toBeCloseTo(3);
  });

  it('computes EMA(3) correctly for a known sequence', () => {
    // Seed SMA([1,2,3]) = 2; k = 0.5
    // i=3: 4*0.5 + 2*0.5 = 3
    // i=4: 5*0.5 + 3*0.5 = 4
    expect(calcEMA([1, 2, 3, 4, 5], 3)).toBeCloseTo(4);
  });

  it('tracks rising prices upward', () => {
    const closes = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    const ema = calcEMA(closes, 5);
    expect(ema).toBeGreaterThan(15); // should trail near recent prices
  });

  it('single data point equal to period returns that value', () => {
    expect(calcEMA([42], 1)).toBeCloseTo(42);
  });

  it('returns null for empty array', () => {
    expect(calcEMA([], 3)).toBeNull();
  });
});

// ─── calcRSI ──────────────────────────────────────────────────────────────────

describe('calcRSI', () => {
  it('returns null when fewer than period+1 data points', () => {
    expect(calcRSI([1, 2, 3], 14)).toBeNull();
    expect(calcRSI(Array(14).fill(100), 14)).toBeNull(); // exactly period — needs period+1
  });

  it('returns 100 when all moves are gains (no losses)', () => {
    const closes = Array.from({ length: 15 }, (_, i) => i + 1); // 1..15
    expect(calcRSI(closes, 14)).toBe(100);
  });

  it('returns 0 when all moves are losses (no gains)', () => {
    const closes = Array.from({ length: 15 }, (_, i) => 15 - i); // 15..1
    expect(calcRSI(closes, 14)).toBe(0);
  });

  it('returns ~50 for perfectly alternating up/down moves', () => {
    // [1,2,1,2,...] — 7 gains of 1, 7 losses of 1 → RSI = 50
    const closes = Array.from({ length: 15 }, (_, i) => (i % 2 === 0 ? 1 : 2));
    expect(calcRSI(closes, 14)).toBeCloseTo(50);
  });

  it('value is between 0 and 100', () => {
    const closes = [10, 11, 9, 12, 8, 13, 7, 14, 6, 15, 5, 16, 4, 17, 3];
    const rsi = calcRSI(closes, 14);
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });

  it('uses only the last period+1 closes for calculation', () => {
    // Prepend many irrelevant values; RSI should be same as without them
    const base = [10, 12, 11, 13, 12, 14, 13, 15, 14, 16, 15, 17, 16, 18, 17];
    const withPadding = [...Array(50).fill(100), ...base];
    // Both should return the same RSI since we only look at last period changes
    const rsiBase    = calcRSI(base, 14);
    const rsiPadded  = calcRSI(withPadding, 14);
    expect(rsiPadded).toBeCloseTo(rsiBase);
  });
});

// ─── calcATR ──────────────────────────────────────────────────────────────────

describe('calcATR', () => {
  it('returns null when fewer than period+1 candles', () => {
    expect(calcATR(flatCandles(14), 14)).toBeNull();
  });

  it('returns correct ATR for uniform candles', () => {
    // Each candle: high=101, low=99, close=100 → TR = max(2, 1, 1) = 2
    const cs = flatCandles(16, 100); // 16 candles, period=14 → 15 needed, 16 available
    expect(calcATR(cs, 14)).toBeCloseTo(2);
  });

  it('uses only the last period candles (plus prev close)', () => {
    // Build 20 candles with wild early ranges and calm recent ranges
    const early  = Array.from({ length: 5 }, () => candle(200, 100, 150));
    const recent = Array.from({ length: 15 }, () => candle(101, 99, 100));
    const cs = [...early, ...recent];
    // ATR(14) looks at last 14 true ranges — all within the calm region
    const atr = calcATR(cs, 14);
    expect(atr).toBeCloseTo(2, 0); // close to 2, not hundreds
  });

  it('handles spike true range (gap up)', () => {
    // prev close=100, current high=120, low=115
    // TR = max(120-115=5, |120-100|=20, |115-100|=15) = 20
    const base = flatCandles(14, 100);
    const spike = candle(120, 115, 117);
    const cs = [...base, spike];
    const atr = calcATR(cs, 14);
    // Last 14 TRs: 13 from flat candles (TR=2 each) + 1 spike (TR=20)
    // ATR = (13*2 + 20) / 14 ≈ 3.29
    expect(atr).toBeGreaterThan(2);
    expect(atr).toBeLessThan(20);
  });
});

// ─── calcDonchianHigh ─────────────────────────────────────────────────────────

describe('calcDonchianHigh', () => {
  it('returns null when fewer than period+1 candles', () => {
    expect(calcDonchianHigh(flatCandles(3), 3)).toBeNull();
  });

  it('returns highest high of the period bars before the last bar', () => {
    const cs = [
      candle(10, 8, 9),
      candle(12, 9, 10),
      candle(11, 7, 9),
      candle(15, 10, 12), // last bar — should be EXCLUDED
    ];
    // period=3 → look at bars 0,1,2 (the 3 before last) → max high = 12
    expect(calcDonchianHigh(cs, 3)).toBe(12);
  });

  it('excludes the most recent (possibly forming) bar', () => {
    const cs = [
      candle(50, 40, 45),
      candle(55, 45, 50),
      candle(60, 50, 55),
      candle(1000, 900, 950), // last bar with extreme high
    ];
    // period=3 → exclude last bar → max = 60
    expect(calcDonchianHigh(cs, 3)).toBe(60);
  });

  it('slides correctly as candles array grows', () => {
    const cs = [
      candle(10, 5, 7),
      candle(20, 10, 15),
      candle(15, 8, 12),
      candle(18, 9, 14),
      candle(99, 50, 70), // last — excluded
    ];
    // period=3 → bars at indices 1,2,3 → max high = max(20,15,18) = 20
    expect(calcDonchianHigh(cs, 3)).toBe(20);
  });
});

// ─── calcDonchianLow ──────────────────────────────────────────────────────────

describe('calcDonchianLow', () => {
  it('returns null when fewer than period+1 candles', () => {
    expect(calcDonchianLow(flatCandles(3), 3)).toBeNull();
  });

  it('returns lowest low of the period bars before the last bar', () => {
    const cs = [
      candle(10, 8, 9),
      candle(12, 9, 10),
      candle(11, 7, 9),
      candle(15, 1, 12), // last bar — should be EXCLUDED (low=1 is extreme)
    ];
    // period=3 → look at bars 0,1,2 → min low = 7
    expect(calcDonchianLow(cs, 3)).toBe(7);
  });

  it('excludes the most recent bar', () => {
    const cs = [
      candle(50, 40, 45),
      candle(55, 38, 47),
      candle(60, 42, 51),
      candle(65, 1, 30), // last bar — extreme low, excluded
    ];
    // period=3 → bars 0,1,2 → min low = 38
    expect(calcDonchianLow(cs, 3)).toBe(38);
  });

  it('correctly tracks the rolling window', () => {
    const cs = [
      candle(10, 5, 7),
      candle(20, 10, 15),
      candle(15, 8, 12),
      candle(18, 9, 14),
      candle(99, 50, 70), // last — excluded
    ];
    // period=3 → bars at indices 1,2,3 → min low = min(10,8,9) = 8
    expect(calcDonchianLow(cs, 3)).toBe(8);
  });
});
