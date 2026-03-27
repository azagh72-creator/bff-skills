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
Queries Bitflow HODLMM on-chain state to fetch active bin positions, current tick, and fee accumulation for sBTC/STX and sBTC/USDCx pools. Detects when positions drift out of range and outputs structured rebalance recommendations. Read-only.
## Why agents need it
Positions that drift out of range stop earning fees entirely. Agents holding HODLMM NFTs need a reliable detection layer before yield drops to zero.
## Safety notes
- Read-only. Does not submit transactions or move funds.
- Mainnet only.
- All outputs are recommendations only.
## Commands
### doctor
bun run hodlmm-yield-optimizer/hodlmm-yield-optimizer.ts doctor
### run
bun run hodlmm-yield-optimizer/hodlmm-yield-optimizer.ts run
### install-packs
bun run hodlmm-yield-optimizer/hodlmm-yield-optimizer.ts install-packs --pack all
## Output contract
{"status":"success|error|blocked","action":"next step","data":{"pools":[],"out_of_range_count":0,"fetched_at":""},"error":null}
## Known constraints
- Poll interval: 5 minutes minimum.
- On-chain proof: SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW holds 224 Bitflow HODLMM NFTs.
