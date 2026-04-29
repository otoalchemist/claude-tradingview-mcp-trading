import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock fs BEFORE importing report.js ───────────────────────────────────────
vi.mock('fs', () => ({
  readFileSync:  vi.fn(),
  writeFileSync: vi.fn(),
  existsSync:    vi.fn(),
  appendFileSync: vi.fn(),
}));

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { updatePortfolio, shouldSendReport, markReportSent } from '../report.js';
import { getLegEquity, legPositionCount, toCoinbaseSymbol } from '../portfolioUtils.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE_STATE = () => ({
  startingCapital: 1000,
  legs: { A: { cash: 700 }, B: { cash: 300 } },
  positions: {},
  lastExits: {},
  lastReportTime: 0,
  paused: false,
});

function mockState(state) {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(state));
}

function getSavedState() {
  const calls = vi.mocked(writeFileSync).mock.calls;
  if (!calls.length) return null;
  return JSON.parse(calls.at(-1)[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no portfolio file on disk → loadState returns defaults
  vi.mocked(existsSync).mockReturnValue(false);
});

// ─── updatePortfolio — buy ────────────────────────────────────────────────────

describe('updatePortfolio — buy', () => {
  it('deducts trade size from the correct leg cash', () => {
    mockState(BASE_STATE());
    updatePortfolio('BTCUSDT', 'buy', 50000, 100, null, 'A', 1500);
    const saved = getSavedState();
    expect(saved.legs.A.cash).toBeCloseTo(600); // 700 - 100
    expect(saved.legs.B.cash).toBe(300);        // untouched
  });

  it('creates a new position with correct quantity and avgCost', () => {
    mockState(BASE_STATE());
    updatePortfolio('BTCUSDT', 'buy', 50000, 100, null, 'A', 1500);
    const pos = getSavedState().positions.BTCUSDT;
    expect(pos).toBeDefined();
    expect(pos.leg).toBe('A');
    expect(pos.quantity).toBeCloseTo(100 / 50000);
    expect(pos.totalCost).toBeCloseTo(100);
    expect(pos.avgCost).toBeCloseTo(50000);
    expect(pos.atrAtEntry).toBe(1500);
  });

  it('averages down when adding to an existing position', () => {
    const state = BASE_STATE();
    state.positions.BTCUSDT = {
      leg: 'A', quantity: 0.002, avgCost: 50000,
      totalCost: 100, atrAtEntry: 1500, entryTime: 0,
    };
    state.legs.A.cash = 600;
    mockState(state);

    // Buy more at a lower price
    updatePortfolio('BTCUSDT', 'buy', 40000, 80, null, 'A', 1200);
    const pos = getSavedState().positions.BTCUSDT;
    expect(pos.totalCost).toBeCloseTo(180);
    expect(pos.quantity).toBeCloseTo(0.002 + 80 / 40000);
    expect(pos.avgCost).toBeCloseTo(180 / pos.quantity);
  });

  it('floors leg cash at zero (cannot go negative)', () => {
    const state = BASE_STATE();
    state.legs.B.cash = 50;
    mockState(state);
    updatePortfolio('SOLUSDT', 'buy', 100, 200, null, 'B'); // spend $200 with only $50
    expect(getSavedState().legs.B.cash).toBe(0);
  });

  it('stores atrAtEntry of 0 when not provided', () => {
    mockState(BASE_STATE());
    updatePortfolio('ETHUSDT', 'buy', 3000, 60, null, 'B');
    expect(getSavedState().positions.ETHUSDT.atrAtEntry).toBe(0);
  });
});

// ─── updatePortfolio — sell ───────────────────────────────────────────────────

describe('updatePortfolio — sell', () => {
  function stateWithPosition(leg = 'A', qty = 0.002, avgCost = 50000) {
    const s = BASE_STATE();
    s.legs.A.cash = 600;
    s.positions.BTCUSDT = {
      leg, quantity: qty, avgCost,
      totalCost: qty * avgCost, atrAtEntry: 1500, entryTime: 0,
    };
    return s;
  }

  it('removes position and returns proceeds to correct leg cash', () => {
    mockState(stateWithPosition('A', 0.002, 50000));
    updatePortfolio('BTCUSDT', 'sell', 52000, 104, 0.002, 'A');
    const saved = getSavedState();
    expect(saved.positions.BTCUSDT).toBeUndefined(); // closed
    expect(saved.legs.A.cash).toBeCloseTo(600 + 0.002 * 52000); // 600 + 104 = 704
    expect(saved.lastExits.BTCUSDT).toBeDefined();
  });

  it('does a partial sell and leaves the remaining quantity', () => {
    mockState(stateWithPosition('A', 0.002, 50000));
    updatePortfolio('BTCUSDT', 'sell', 52000, 52, 0.001, 'A'); // sell half
    const pos = getSavedState().positions.BTCUSDT;
    expect(pos).toBeDefined(); // still open
    expect(pos.quantity).toBeCloseTo(0.001);
    expect(pos.totalCost).toBeCloseTo(0.001 * 50000);
  });

  it('returns proceeds to the leg recorded on the position, not the argument', () => {
    // Position is Leg A, but we pass 'B' as leg arg — proceeds should still go to A
    mockState(stateWithPosition('A', 0.002, 50000));
    updatePortfolio('BTCUSDT', 'sell', 52000, 104, 0.002, 'B'); // wrong leg arg
    const saved = getSavedState();
    expect(saved.legs.A.cash).toBeCloseTo(600 + 104); // A gets the proceeds
    expect(saved.legs.B.cash).toBe(300);              // B untouched
  });

  it('does nothing when selling a symbol not in positions', () => {
    mockState(BASE_STATE()); // no positions
    updatePortfolio('BTCUSDT', 'sell', 50000, 100, 0.002, 'A');
    const saved = getSavedState();
    expect(saved.legs.A.cash).toBe(700); // unchanged
  });

  it('deletes position when remaining quantity is effectively zero', () => {
    mockState(stateWithPosition('B', 0.001, 50000));
    updatePortfolio('BTCUSDT', 'sell', 50000, 50, 0.001, 'B'); // sell everything
    expect(getSavedState().positions.BTCUSDT).toBeUndefined();
  });
});

// ─── shouldSendReport / markReportSent ────────────────────────────────────────

describe('shouldSendReport', () => {
  it('returns true when lastReportTime is 0 (never sent)', () => {
    mockState({ ...BASE_STATE(), lastReportTime: 0 });
    expect(shouldSendReport()).toBe(true);
  });

  it('returns false when report was sent less than 4 hours ago', () => {
    mockState({ ...BASE_STATE(), lastReportTime: Date.now() - 1000 }); // 1 second ago
    expect(shouldSendReport()).toBe(false);
  });

  it('returns true when 4+ hours have elapsed', () => {
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000 - 1;
    mockState({ ...BASE_STATE(), lastReportTime: fourHoursAgo });
    expect(shouldSendReport()).toBe(true);
  });
});

describe('markReportSent', () => {
  it('updates lastReportTime to approximately now', () => {
    mockState(BASE_STATE());
    const before = Date.now();
    markReportSent();
    const after = Date.now();
    const saved = getSavedState();
    expect(saved.lastReportTime).toBeGreaterThanOrEqual(before);
    expect(saved.lastReportTime).toBeLessThanOrEqual(after);
  });
});

// ─── getLegEquity (pure — no mocking needed) ──────────────────────────────────

describe('getLegEquity', () => {
  it('returns leg cash when there are no positions', () => {
    const state = {
      legs: { A: { cash: 700 }, B: { cash: 300 } },
      positions: {},
    };
    expect(getLegEquity(state, 'A')).toBe(700);
    expect(getLegEquity(state, 'B')).toBe(300);
  });

  it('adds position value using live price when available', () => {
    const state = {
      legs: { A: { cash: 600 } },
      positions: {
        BTCUSDT: { leg: 'A', quantity: 0.002, avgCost: 50000, totalCost: 100 },
      },
    };
    const equity = getLegEquity(state, 'A', { BTCUSDT: 55000 });
    expect(equity).toBeCloseTo(600 + 0.002 * 55000); // 600 + 110 = 710
  });

  it('falls back to avgCost when live price is missing', () => {
    const state = {
      legs: { A: { cash: 600 } },
      positions: {
        BTCUSDT: { leg: 'A', quantity: 0.002, avgCost: 50000, totalCost: 100 },
      },
    };
    const equity = getLegEquity(state, 'A', {}); // no live prices
    expect(equity).toBeCloseTo(600 + 0.002 * 50000); // 600 + 100 = 700
  });

  it('only counts positions belonging to the requested leg', () => {
    const state = {
      legs: { A: { cash: 600 }, B: { cash: 250 } },
      positions: {
        BTCUSDT: { leg: 'A', quantity: 0.002, avgCost: 50000, totalCost: 100 },
        ETHUSDT: { leg: 'B', quantity: 0.05, avgCost: 3000, totalCost: 150 },
      },
    };
    expect(getLegEquity(state, 'A', {})).toBeCloseTo(600 + 100); // BTC only
    expect(getLegEquity(state, 'B', {})).toBeCloseTo(250 + 150); // ETH only
  });
});

// ─── legPositionCount (pure) ──────────────────────────────────────────────────

describe('legPositionCount', () => {
  it('returns 0 when no positions', () => {
    const state = { positions: {} };
    expect(legPositionCount(state, 'A')).toBe(0);
    expect(legPositionCount(state, 'B')).toBe(0);
  });

  it('counts only positions belonging to the requested leg', () => {
    const state = {
      positions: {
        BTCUSDT: { leg: 'A' },
        ETHUSDT: { leg: 'B' },
        SOLUSDT: { leg: 'A' },
      },
    };
    expect(legPositionCount(state, 'A')).toBe(2);
    expect(legPositionCount(state, 'B')).toBe(1);
  });

  it('returns 0 for a leg with no positions', () => {
    const state = { positions: { BTCUSDT: { leg: 'A' } } };
    expect(legPositionCount(state, 'B')).toBe(0);
  });
});

// ─── toCoinbaseSymbol (pure) ──────────────────────────────────────────────────

describe('toCoinbaseSymbol', () => {
  it('converts USDT suffix to -USD', () => {
    expect(toCoinbaseSymbol('BTCUSDT')).toBe('BTC-USD');
    expect(toCoinbaseSymbol('ETHUSDT')).toBe('ETH-USD');
    expect(toCoinbaseSymbol('DOGEUSDT')).toBe('DOGE-USD');
  });

  it('converts USD suffix to -USD', () => {
    expect(toCoinbaseSymbol('BTCUSD')).toBe('BTC-USD');
    expect(toCoinbaseSymbol('ETHUSD')).toBe('ETH-USD');
  });

  it('passes through already-formatted symbols unchanged', () => {
    expect(toCoinbaseSymbol('BTC-USD')).toBe('BTC-USD');
    expect(toCoinbaseSymbol('ETH-USD')).toBe('ETH-USD');
  });

  it('USDT takes priority over the shorter USD suffix', () => {
    // DOGEUSDT should become DOGE-USD, not DOGEUST-USD
    expect(toCoinbaseSymbol('DOGEUSDT')).toBe('DOGE-USD');
    expect(toCoinbaseSymbol('LINKUSDT')).toBe('LINK-USD');
  });
});
