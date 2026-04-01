---
name: zest-liquidation-watch
description: "Monitors Zest Protocol lending positions for liquidation risk — tracks health factors, collateral ratios, and price thresholds so agents can protect capital or spot liquidation opportunities."
metadata:
  author: "azagh72-creator"
  author-agent: "Flying Whale"
  user-invocable: "false"
  arguments: "doctor | check | scan | alert"
  entry: "zest-liquidation-watch/zest-liquidation-watch.ts"
  requires: "wallet"
  tags: "defi, read-only, mainnet-only, l2, safety"
---

# Zest Liquidation Watch

Liquidation risk monitor for Zest Protocol lending positions on Stacks.

## What it does

Tracks the health factor of Zest lending positions by reading on-chain collateral values, borrow balances, and liquidation thresholds. Computes how far each position is from liquidation and what price movement would trigger it.

Three modes:

1. **Single position** (`check`) — instant health check for one wallet's Zest position. Returns health factor, distance to liquidation, and the exact price drop that triggers it.
2. **Network scan** (`scan`) — scans recent Zest borrowers to find positions approaching liquidation. Useful for liquidation bots or agents monitoring systemic risk.
3. **Alert mode** (`alert`) — checks a wallet and outputs a structured alert if health factor drops below a configurable threshold.

## Why agents need it

Zest is the largest lending protocol on Stacks. Agents managing DeFi portfolios need to know:
- **Am I about to get liquidated?** — `check` answers this instantly
- **What price move kills my position?** — the liquidation price field tells agents exactly when to exit
- **Are there liquidation opportunities?** — `scan` finds underwater positions for liquidator agents
- **Wake me up if danger is near** — `alert` mode for cron-based monitoring

No existing skill monitors Zest liquidation risk. `zest-yield-manager` handles supply/borrow operations but does not track health factors or liquidation distance.

## Safety notes

- **Read-only** — never submits transactions or moves funds
- **Wallet required** — only to derive the default address for `check`; no signing occurs
- **Mainnet-only** — Zest Protocol contracts are mainnet-only
- **No state files** — every call is a fresh on-chain read, no local persistence
- All Stacks API calls go through the public Hiro API endpoint

## Commands

### doctor

Checks Hiro API connectivity and Zest contract readability.

```bash
bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts doctor
```

### check

Reads a single wallet's Zest position and computes health factor.

```bash
bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts check --address SP322ZK...
```

Options:
- `--address <stx-address>` — wallet to check (defaults to active wallet)

Output includes: supplied assets, borrowed assets, health factor, liquidation threshold, liquidation price, distance to liquidation percentage.

### scan

Scans recent Zest borrowers for positions near liquidation.

```bash
bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts scan
bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts scan --min-risk 0.7
```

Options:
- `--min-risk <0-1>` — only show positions with risk score above this threshold (default: 0.5). Risk score = 1 - (health_factor - 1) / liquidation_buffer.

### alert

Same as `check` but outputs a structured alert payload when health factor is below threshold. Designed for cron + notification pipelines.

```bash
bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts alert --address SP322ZK... --threshold 1.3
```

Options:
- `--address <stx-address>` — wallet to check
- `--threshold <number>` — health factor threshold for alert (default: 1.5)

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{
  "status": "success",
  "network": "mainnet",
  "timestamp": "2026-04-01T12:00:00Z",
  "command": "check",
  "data": {
    "address": "SP322ZK...",
    "healthFactor": 1.82,
    "supplied": { "sBTC": { "amount": 0.5, "valueUsd": 42500 } },
    "borrowed": { "STX": { "amount": 15000, "valueUsd": 23400 } },
    "liquidationThreshold": 0.8,
    "liquidationPrice": { "asset": "sBTC", "triggerPrice": 46800, "currentPrice": 85000, "dropRequired": "-44.9%" },
    "riskLevel": "low"
  }
}
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Data sources

| Source | Data | Endpoint |
|---|---|---|
| Hiro Stacks API | Contract reads, account state | `api.hiro.so/v2/contracts/call-read` |
| Zest Protocol contracts | Pool state, borrow balances, collateral factors | `SP2VCQJHN7SP2CZCE8BBRUMHVDMSVJYMZWGT5TTA.pool-0-reserve` |
| Zest Oracle | Asset prices for health factor computation | `SP2VCQJHN7SP2CZCE8BBRUMHVDMSVJYMZWGT5TTA.oracle` |

## Known constraints

- Health factor computation depends on Zest's on-chain oracle prices, which may lag market prices by minutes
- `scan` is limited by Hiro API rate limits; scans recent contract callers, not all borrowers
- Liquidation price is an estimate based on current collateral/debt ratio; actual liquidation depends on oracle update timing
- Zest v1 pools only; future versions may require contract address updates
