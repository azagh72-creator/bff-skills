---
name: hodlmm-yield-optimizer
description: Monitors Bitflow HODLMM bin positions, detects out-of-range liquidity, and recommends rebalance actions to maximize fee yield for sBTC/STX and sBTC/USDCx pools.
user-invocable: true
arguments: doctor | run | install-packs
entry: hodlmm-yield-optimizer/hodlmm-yield-optimizer.ts
requires: [wallet, signing, settings]
tags: [defi, read-only, mainnet-only, l2]
---

# HODLMM Yield Optimizer

## What it does
Queries Bitflow HODLMM on-chain state to fetch active bin positions, current tick, and fee accumulation for sBTC/STX and sBTC/USDCx pools. Detects when positions drift out of range and outputs structured rebalance recommendations with expected APY impact. Read-only — no transactions executed.

## Why agents need it
HODLMM is a concentrated liquidity market maker on Stacks L2. Positions that drift out of range stop earning fees entirely. Agents holding HODLMM NFTs need a reliable way to detect range drift and act before yield drops to zero — this skill is that detection layer.

## Safety notes
- Read-only. Does not submit any transactions or move funds.
- Mainnet only. HODLMM contracts are not deployed on testnet.
- No private keys or wallet secrets accessed.
- All outputs are recommendations — no autonomous execution.

## Commands

### doctor
```bash
bun run hodlmm-yield-optimizer/hodlmm-yield-optimizer.ts doctor
```

### run
```bash
bun run hodlmm-yield-optimizer/hodlmm-yield-optimizer.ts run
```

### install-packs
```bash
bun run hodlmm-yield-optimizer/hodlmm-yield-optimizer.ts install-packs --pack all
```

## Output contract
```json
{
  "status": "success | error | blocked",
  "action": "what the agent should do next",
  "data": {
    "pools": [],
    "out_of_range_count": 0,
    "fetched_at": "2026-03-27T00:00:00.000Z"
  },
  "error": null
}
```

## Known constraints
- Recommended polling interval: 5 minutes minimum.
- APY estimates are annualized based on recent 24h fee data.
- On-chain proof: wallet SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW holds 224 Bitflow HODLMM NFTs.
