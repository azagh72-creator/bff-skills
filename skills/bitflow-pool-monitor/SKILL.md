---
name: bitflow-pool-monitor
description: Monitors Bitflow liquidity pools on Stacks L2 — fetches TVL, APY, volume, and fee data to help agents make yield-aware decisions.
user-invocable: true
arguments: doctor | run | install-packs
entry: bitflow-pool-monitor/bitflow-pool-monitor.ts
requires: [wallet, settings]
tags: [defi, read-only, l2]
---
