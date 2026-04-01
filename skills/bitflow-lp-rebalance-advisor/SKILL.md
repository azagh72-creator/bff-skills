---
name: bitflow-lp-rebalance-advisor
description: "Analyzes Bitflow HODLMM concentrated LP positions for bin drift and recommends optimal rebalance ranges based on recent volume distribution and fee capture patterns."
metadata:
  author: "azagh72-creator"
  author-agent: "Flying Whale"
  user-invocable: "false"
  arguments: "doctor | analyze | scan | recommend"
  entry: "bitflow-lp-rebalance-advisor/bitflow-lp-rebalance-advisor.ts"
  requires: "wallet"
  tags: "defi, read-only, mainnet-only, l2, hodlmm"
---

# Bitflow LP Rebalance Advisor

Bin drift detector and rebalance planner for Bitflow HODLMM concentrated liquidity positions.

## What it does

Detects when a HODLMM LP position has drifted away from the active trading range and computes the optimal new bin range based on where volume and fees are actually concentrating. Unlike `hodlmm-bin-guardian` (which checks if you're in-range), this skill answers **"where should I move to?"** by analyzing the fee distribution across bins.

Three core functions:

1. **Drift detection** (`analyze`) — measures how far your position's center has moved from the pool's active price bin, and quantifies lost fee capture as a percentage.
2. **Network scan** (`scan`) — finds all pools where active price has moved significantly from recent LP deployments, surfacing rebalance opportunities across the ecosystem.
3. **Rebalance planning** (`recommend`) — outputs a concrete rebalance plan: which bins to withdraw from, which to deploy into, expected fee improvement, and estimated gas cost vs. benefit.

## Why agents need it

Concentrated liquidity in HODLMM pools earns zero fees when price moves outside your bin range. Every minute out-of-range is lost revenue. Agents need to know:

- **Am I earning or idle?** — `analyze` quantifies exactly how much fee capture you're missing
- **Where is the money moving?** — volume distribution shows where fees concentrate, not just where price is
- **Is rebalancing worth the gas?** — `recommend` compares rebalance cost against projected fee improvement, preventing unnecessary churn
- **Which pools need attention first?** — `scan` prioritizes by drift severity and lost fee potential

The decision loop: `hodlmm-pulse` tells you *when* to enter → `hodlmm-advisor` tells you *where* to enter → **this skill tells you *when and where to move* once you're already in**.

## Safety notes

- **Read-only** — never submits transactions or moves funds
- **Wallet required** — only to derive the default address for position lookup; no signing occurs
- **Mainnet-only** — Bitflow HODLMM pools are mainnet-only
- **No state files** — every call is a fresh API read
- Rebalance recommendations are advisory — execution requires explicit human confirmation
- Gas cost estimates are approximations based on current STX fee rates

## Commands

### doctor

Checks connectivity to Bitflow APIs and fee data availability.

```bash
bun run skills/bitflow-lp-rebalance-advisor/bitflow-lp-rebalance-advisor.ts doctor
```

### analyze

Checks a specific position or pool for bin drift and fee capture loss.

```bash
bun run skills/bitflow-lp-rebalance-advisor/bitflow-lp-rebalance-advisor.ts analyze --pool-id dlmm_1
bun run skills/bitflow-lp-rebalance-advisor/bitflow-lp-rebalance-advisor.ts analyze --pool-id dlmm_1 --address SP322ZK...
```

Options:
- `--pool-id` (required) — HODLMM pool identifier
- `--address` (optional) — wallet to check position for (defaults to active wallet)

Output includes: current active bin, position bin range, drift distance, fee capture rate, volume distribution heatmap across bins.

### scan

Scans all HODLMM pools for significant bin drift and rebalance opportunities.

```bash
bun run skills/bitflow-lp-rebalance-advisor/bitflow-lp-rebalance-advisor.ts scan
bun run skills/bitflow-lp-rebalance-advisor/bitflow-lp-rebalance-advisor.ts scan --min-drift 5
```

Options:
- `--min-drift <bins>` — minimum bin drift to flag (default: 3 bins)
- `--min-tvl <usd>` — minimum pool TVL to include (default: 1000)

### recommend

Generates a concrete rebalance plan with new bin range, expected improvement, and cost analysis.

```bash
bun run skills/bitflow-lp-rebalance-advisor/bitflow-lp-rebalance-advisor.ts recommend --pool-id dlmm_1
```

Options:
- `--pool-id` (required) — pool to generate plan for
- `--address` (optional) — wallet address for position-specific plan
- `--slippage <pct>` — maximum slippage tolerance for rebalance (default: 1.0)

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{
  "status": "success",
  "network": "mainnet",
  "timestamp": "2026-04-01T12:00:00Z",
  "command": "analyze",
  "data": {
    "poolId": "dlmm_1",
    "pair": "STX/sBTC",
    "activeBin": 142,
    "positionRange": { "lower": 128, "upper": 138 },
    "driftBins": 4,
    "driftDirection": "above",
    "feeCaptureRate": 0.12,
    "missingFeesPct": 88,
    "volumeHotzone": { "lower": 140, "upper": 146 },
    "recommendation": "rebalance"
  }
}
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Rebalance model

### Drift measurement

```
driftBins = abs(activeBin - positionCenter)
driftSeverity = driftBins / positionWidth
```

| Severity | Condition | Meaning |
|---|---|---|
| `in-range` | driftBins = 0 | Position is active, earning fees |
| `edge` | driftBins < width/4 | Price near position edge, monitor closely |
| `drifted` | driftBins < width | Partially out of range, reduced fee capture |
| `stranded` | driftBins >= width | Fully out of range, earning zero fees |

### Volume distribution analysis

Fetches per-bin volume data and identifies the "hotzone" — the bin range capturing 80% of recent volume. Optimal position should center on this hotzone.

### Cost-benefit calculation

```
rebalanceCost = withdrawGas + depositGas + slippageCost
projectedFeeGain = (hotzoneAPR - currentCaptureRate) * positionValue * timeHorizon
netBenefit = projectedFeeGain - rebalanceCost
recommendation = netBenefit > 0 ? "rebalance" : "hold"
```

## Data sources

| Source | Data | Endpoint |
|---|---|---|
| Bitflow App API | Pool list, TVL, APR, volume | `bff.bitflowapis.finance/api/app/v1/pools` |
| Bitflow App API | Single pool detail, bin data | `bff.bitflowapis.finance/api/app/v1/pools/{id}` |
| Bitflow Quotes API | Active bin, price data | `bff.bitflowapis.finance/api/quotes/v1/pools` |
| Hiro Stacks API | Gas fee estimates | `api.hiro.so/v2/fees/transfer` |

## Integration chain

```
hodlmm-pulse scan                      → is any pool hot right now?
bitflow-lp-rebalance-advisor analyze    → is my position capturing those fees?
bitflow-lp-rebalance-advisor recommend  → should I move, and where?
hodlmm-advisor entry-plan              → confirm new range parameters
bitflow withdraw-liquidity-simple       → exit old range (human approval)
bitflow add-liquidity-simple            → enter new range (human approval)
```

## Known constraints

- Bin-level volume data depends on Bitflow API granularity; some pools may only expose aggregate volume
- Gas cost estimates use current fee rates which can spike during network congestion
- Rebalance recommendations assume single-sided or proportional withdrawal; complex multi-step rebalances are not modeled
- Position detection requires the wallet address to have an active HODLMM position in the specified pool
- Freshly deployed pools (< 24h) lack sufficient volume history for reliable hotzone computation
