---
name: hodlmm-rebalancer
description: "Autonomous HODLMM LP position rebalancer — monitors bin drift, computes optimal ranges, and executes rebalance with enforced safety limits on Bitflow DLMM pools."
metadata:
  author: "azagh72-creator"
  author-agent: "Flying Whale"
  user-invocable: "false"
  arguments: "doctor | run --action=status | run --action=rebalance | run --action=withdraw | run --action=emergency-exit"
  entry: "hodlmm-rebalancer/hodlmm-rebalancer.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# HODLMM Rebalancer

Autonomous LP position rebalancer for Bitflow HODLMM (DLMM) pools on Stacks. Monitors position drift, assesses volatility regime, computes optimal bin ranges, and generates safe rebalance transactions with enforced spend limits.

## Why Agents Need This

HODLMM positions earn fees only when liquidity sits in active bins. As prices move, positions drift out of range and stop earning. Manual rebalancing is slow and error-prone. This skill gives agents the ability to:

1. **Detect drift** — continuously monitor bin offset from active price
2. **Assess risk** — integrated volatility regime classification (calm/elevated/crisis)
3. **Compute optimal ranges** — calculate target bins based on current regime
4. **Execute safely** — enforced hard caps, slippage limits, and crisis blocks

Without this, idle HODLMM positions bleed impermanent loss while earning zero fees.

## HODLMM Integration

Direct integration with Bitflow HODLMM pools:
- Reads pool state from `https://api.bitflow.finance/api/v1/hodlmm/`
- Targets `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15`
- Generates contract calls for `remove-liquidity` and `add-liquidity`
- Monitors bin drift, reserve imbalance, and concentration risk

## Commands

### `doctor`
Check environment readiness: wallet, balances, API connectivity, pool risk, position state.

```bash
bun run hodlmm-rebalancer.ts doctor --pool-id dlmm_3
```

### `run --action=status`
Full position analysis with integrated risk metrics and actionable recommendation.

```bash
bun run hodlmm-rebalancer.ts run --action=status --pool-id dlmm_3
```

### `run --action=rebalance`
Compute and output a rebalance plan with MCP contract call parameters.

```bash
bun run hodlmm-rebalancer.ts run --action=rebalance --pool-id dlmm_3 --max-sats=100000 --slippage-bps=200
```

### `run --action=withdraw`
Generate a full position withdrawal from all bins.

```bash
bun run hodlmm-rebalancer.ts run --action=withdraw --pool-id dlmm_3
```

### `run --action=emergency-exit`
Immediate full exit — skips drift checks, prioritizes speed over slippage protection.

```bash
bun run hodlmm-rebalancer.ts run --action=emergency-exit --pool-id dlmm_3
```

## Safety Controls (Enforced in Code)

All limits are **implemented and enforced** in the TypeScript file, not just documented:

| Control | Default | Enforced |
|---------|---------|----------|
| Max rebalance per operation | 100,000 sats (0.001 BTC) | `--max-sats` flag, hard cap 1M sats |
| Max slippage | 200 bps (2%) | `--slippage-bps` flag, hard cap 500 bps |
| Crisis regime block | Volatility > 60 | **Always enforced**, cannot be overridden |
| Drift threshold | Score > 15 to trigger | `--force` overrides, crisis block still applies |
| Minimum gas | 200,000 uSTX (0.2 STX) | Pre-flight check before any write |
| Cooldown | 300 seconds between ops | Tracked per-session |
| Absolute hard cap | 1,000,000 sats (0.01 BTC) | Cannot be overridden by any flag |

## Output Contract

All commands output structured JSON:

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable next step",
  "data": { ... },
  "error": { "code": "...", "message": "...", "next": "..." } | null
}
```

### Error Codes

| Code | Meaning |
|------|---------|
| `no_wallet` | STACKS_ADDRESS not set |
| `insufficient_gas` | STX balance below minimum for transaction fees |
| `no_position` | No active HODLMM position to rebalance |
| `crisis_regime` | Volatility too high — rebalance refused |
| `exceeds_hard_cap` | Requested amount exceeds absolute safety cap |
| `slippage_too_high` | Slippage tolerance exceeds maximum |
| `regime_blocked` | Risk model refuses operation in current conditions |
| `api_unreachable` | Bitflow API not responding |

## On-Chain Proof

| Evidence | Detail |
|----------|--------|
| Wallet | `SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW` |
| BTC Address | `bc1qdfm56pmmq40me84aau2fts3725ghzqlwf6ys7p` |
| DLMM Pool Tokens | 390 NFTs in `dlmm-pool-stx-sbtc-v-1-bps-15` |
| sBTC Balance | 28,826 sats active |
| Stableswap LP | 771M tokens in USDH-USDCx pool |
| Agent | Flying Whale — Genesis L2, ERC-8004 #54 on aibtc.com |
| Explorer | [View on Hiro](https://explorer.hiro.so/address/SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW?chain=mainnet) |

## Architecture

```
Agent invokes skill
  → doctor: pre-flight checks (wallet, gas, API, position, risk)
  → status: fetch pool + position + risk → drift analysis → recommendation
  → rebalance: pre-flight → risk gate → drift check → compute bins → emit MCP commands
  → withdraw: pre-flight → emit remove-liquidity for all bins
  → emergency-exit: minimal checks → immediate full exit
```

The skill does NOT broadcast transactions directly. It computes parameters and emits structured MCP command objects that the agent framework executes. This separation ensures the agent always has final approval before any on-chain write.
