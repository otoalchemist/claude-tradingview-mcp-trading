# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

A live 24/7 crypto accumulation bot deployed on Railway, trading BTC/ETH/SOL/LINK/PEPE/AKT on Coinbase Advanced Trade. The **primary production file** is `craig-accumulation-bot.mjs`. Everything else in the root (`bot.js`, `backtest-*.mjs`, `tv-*.mjs`, `craig-backtest.mjs`) is either legacy, experimental, or tooling.

## Running Things

```bash
# Run the live bot locally (paper mode unless LIVE_TRADING=true)
node craig-accumulation-bot.mjs

# Full 5-symbol portfolio backtest (single period)
node craig-backtest-full.mjs [days]        # e.g. node craig-backtest-full.mjs 90

# Multi-period backtest (30/60/90/180/365d comparison table)
node craig-backtest-multi.mjs [d1 d2 ...]  # e.g. node craig-backtest-multi.mjs 30 60 90

# Buy/sell ladder sweep (14×12=168 combos per symbol × 5 symbols)
node craig-backtest-ladders.mjs [days]

# Tests
npm test           # vitest run (one-shot)
npm run test:watch # vitest watch mode
```

No build step. ESM modules (`"type": "module"` in package.json). Node 18+ required.

## Deploy

Railway runs `node craig-accumulation-bot.mjs` (see `railway.json`). Push to `main` → auto-deploy. The bot uses a persistent Railway Volume mounted at `/app/data` (env var `STATE_DIR=/app/data`). State files in `./data/` are seed files copied to the volume on first boot only.

**Key env vars for Railway:**
- `LIVE_TRADING=true` — enables real order placement (default: paper mode)
- `COINBASE_API_KEY` / `COINBASE_PRIVATE_KEY` — EC private key (full PEM including headers), newlines as `\n`
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
- `STATE_DIR=/app/data`
- `RESET_STATE=true` — one-time wipe of all state files on next deploy (remove after use)

## Strategy Architecture

**Craig Accumulation Strategy** — contrarian, not trend-following:
- **Death cross** (EMA50 crosses below EMA200) → **BUY regime**: scale in on each bearish BOS / bullish CHOCH
- **Golden cross** (EMA50 crosses above EMA200) → **SELL regime**: scale out on each bullish BOS / bearish CHOCH

Execution uses two timeframes per symbol: a **regime TF** (EMA50/200 regime detection) and a lower **exec TF** (BOS/CHOCH signal detection):

| Symbol | Exec | Regime | Regime source |
|---|---|---|---|
| BTC-USD | 15m | 1h | fetched separately |
| ETH/SOL/LINK | 5m | 30m | aggregated from 5m exec bars |
| PEPE-USD | 5m | 1h | fetched directly (ONE_HOUR) |
| AKT-USD | 5m | 15m | fetched directly (FIFTEEN_MINUTE) |

Coinbase has no native 4h granularity — `aggregateCandles(bars, FOUR_HOUR_MS)` synthesises it. (PEPE no longer uses 4h; it was switched to native 1h for better signal frequency.)

**Per-symbol ladder config** (in `SYMBOL_CONFIG`):
| Symbol | buyLadder | sellLadder |
|---|---|---|
| BTC/ETH/SOL | [15,15,15,15] flat | [5,10,20,40] back-steep |
| LINK | [15,15,15,15] flat (global) | [33,33,33,33] flat |
| PEPE | [60,25,10,5] front-60 | [33,33,33,33] flat | **TREND-FOLLOWING** (golden=BUY, death=SELL) + BTC gate |
| AKT | [60,25,10,5] front-60 | [50,25,15,10] front-50 |

- **Buy ladder**: % of `regimeStartCapital` per BOS signal (slot 4+ repeats the last value — unlimited signals)
- **Sell ladder**: % of `regimeStartCryptoQty` per BOS signal (same repeat mechanic)
- Per-symbol `buyLadder`/`sellLadder` in `SYMBOL_CONFIG` override the global `BOS_SCALE_PCT_BUY`/`BOS_SCALE_PCT_SELL`

## State Files

Each symbol has a `craig-state-{SYMBOL}.json` with fields:
- `regime` — `"buy"` / `"sell"` / `"neutral"`
- `regimeStartCapital` — USD baseline for buy sizing (full portfolio value at regime start)
- `regimeStartCryptoQty` — crypto qty baseline for sell sizing (**critical**: must match actual balance at regime start or sells calculate to 0)
- `regimeStartPrice` — price at regime start (used for HODL comparison)
- `bosCount` — signals fired in current regime (indexes into the ladder)
- `preExistingCryptoQty` — crypto held on exchange before the bot started managing the symbol; excluded from portVal and reconciliation
- `initialized` — false means the bot will run the init block on next scan

**Atomic writes**: state is written to `.tmp` then renamed to prevent corrupt state on crash.

## P&L Baseline Logic

`buildSymbolReport` and `sendRegimeOverview` compute P&L as `(portVal - pnlBaseline) / pnlBaseline`:

```js
const pnlBaseline = (s.preExistingCryptoQty > 0)
  ? INITIAL_CAPITAL                          // inherited position (e.g. LINK via /setregimeqty)
  : (s.regimeStartCapital || INITIAL_CAPITAL); // normal: portfolio value at regime start
```

**Inherited positions** (e.g. LINK set up via `/setregimeqty` with crypto already on exchange): `preExistingCryptoQty > 0` → baseline is `INITIAL_CAPITAL` ($100). This avoids double-counting the crypto value against the bot's cash allocation.

**Normal positions**: baseline is `regimeStartCapital` (the actual portfolio value recorded at the golden/death cross).

## Critical Known Bugs (Fixed)

**`regimeStartCryptoQty = 0` init order bug**: In live mode, `fetchCoinbasePosition()` must run *before* the regime init block assigns `regimeStartCryptoQty = state.cryptoQty`. The fixed code fetches balance first, then determines regime. If a live deployment starts with the wrong `regimeStartCryptoQty`, fix it via Telegram: `/setregimeqty LINK 10.93`.

## Order Precision

Coinbase rejects orders with too many decimal places. At startup (`LIVE_TRADING=true`), `fetchProductPrecisions()` queries `/api/v3/brokerage/products/{sym}` for each symbol's real `base_increment` and `quote_increment`, then overwrites `BASE_SIZE_DECIMALS` and `QUOTE_SIZE_DECIMALS`. Conservative hardcoded defaults are used if the fetch fails.

- **SELL**: `formatBaseSize(symbol, qty)` — rounds to `BASE_SIZE_DECIMALS[sym]` decimal places
- **BUY**: `formatQuoteSize(symbol, usd)` — rounds to `QUOTE_SIZE_DECIMALS[sym]` decimal places

## Regime Map Key Convention

`buildRegime()` keys maps by **close time** of each regime candle: `candle.t + periodMs`. The bot checks `bar.t % cfg.regime.ms === 0` to detect regime boundaries on exec bars, then looks up `crossMap.get(bar.t)`. Backtest scripts must use the same key convention — mismatching this causes crosses to never fire.

## Backtest Scripts

All backtest scripts fetch from the **Coinbase Exchange public API** (no auth): `api.exchange.coinbase.com/products/{sym}/candles?granularity={secs}`. Supported granularities: 60, 300, 900, 3600, 21600, 86400 seconds only.

The live bot uses the **Coinbase Advanced Trade authenticated API** (`api.coinbase.com/api/v3/brokerage/...`).

**Cross mapping**: death cross → BUY, golden cross → SELL. This is the opposite of trend-following. Getting this backwards (golden→buy) causes the simulation to lose money — all three backtest scripts must use `cross === "death"` for buy regime.

`craig-backtest-ladders.mjs` saves results to `backtest-ladder-results.json`. Re-run to refresh after strategy changes.

## Telegram Commands

`/setregimeqty <sym> <qty>` — fixes `regimeStartCryptoQty` without a restart  
`/setcash <sym> <amount>` — fixes `cash` balance  
`/setpreexisting <sym> <qty>` — fixes `preExistingCryptoQty` and re-syncs `cryptoQty` from exchange  
`/reconcile <sym>` — full state recovery after accidental re-init: re-syncs `cryptoQty` from exchange, resets `regimeStartCapital` to `INITIAL_CAPITAL`, fixes `regimeStartCryptoQty` if sell regime and zero  
`/pause <sym|all>` / `/resume <sym|all>` — halts signal processing for a symbol  
`/scan` — triggers an immediate scan cycle  
`/ping` — shows uptime, instance ID, and ladder config

Two bot instances show two different instance IDs in `/ping` responses — a sign of duplicate deployment.
