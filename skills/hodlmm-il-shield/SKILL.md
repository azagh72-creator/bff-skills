---
name: hodlmm-il-shield
description: "Monitors impermanent loss exposure on Bitflow HODLMM positions, tracks fee earnings vs IL, and alerts when net PnL turns negative."
metadata:
  author: "azagh72-creator"
  author-agent: "Flying Whale"
  user-invocable: "false"
  arguments: "doctor | scan | monitor | alert"
  entry: "hodlmm-il-shield/hodlmm-il-shield.ts"
  requires: "wallet"
  tags: "defi, read-only, mainnet-only, l2, hodlmm"
---

# HODLMM IL Shield

## What it does
Calculates real-time impermanent loss for HODLMM LP positions by comparing current position value against a hold-only baseline. Tracks cumulative fee earnings and produces a net PnL score that answers the question every LP needs: "Am I actually making money, or is IL eating my fees?"

## Why agents need it
Agents managing HODLMM positions lack visibility into whether fee income outpaces impermanent loss. Without this, an agent might hold a position that looks profitable on APR alone but is actually losing value. IL Shield gives agents a clear signal to hold, hedge, or exit.

## Safety notes
- Read-only: no transactions, no signing, no fund movement.
- Mainnet only: uses live Bitflow HODLMM pool data.
- No sensitive data accessed beyond public wallet balances.

## Commands

### doctor
Checks Bitflow API availability and wallet environment.
```bash
bun run hodlmm-il-shield/hodlmm-il-shield.ts doctor
```

### scan
Scans all HODLMM pools and ranks them by current IL risk based on price divergence and bin concentration.
```bash
bun run hodlmm-il-shield/hodlmm-il-shield.ts scan [--min-tvl 5000]
```

### monitor
Analyzes a specific pool position for IL exposure, fee earnings, and net PnL.
```bash
bun run hodlmm-il-shield/hodlmm-il-shield.ts monitor --pool-id <pool_id>
```

### alert
Checks all pools and returns only those where IL exceeds fee earnings (net negative positions).
```bash
bun run hodlmm-il-shield/hodlmm-il-shield.ts alert [--threshold -5]
```

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{
  "status": "success",
  "command": "monitor",
  "timestamp": "2026-04-02T12:00:00Z",
  "data": {
    "poolId": "dlmm_1",
    "pair": "STX/sBTC",
    "ilPercent": -2.3,
    "feesEarnedPercent": 4.1,
    "netPnlPercent": 1.8,
    "signal": "HOLD",
    "details": {}
  }
}
```

**Error:**
```json
{ "error": "Bitflow API unreachable", "code": "API_TIMEOUT" }
```

## Integration chain
1. **hodlmm-pulse** detects fee velocity spikes (entry timing)
2. **hodlmm-il-shield** monitors IL vs fees during the position (hold/exit decision)
3. **bitflow-lp-rebalance-advisor** plans rebalance when bins drift

## Polling cadence
- `scan`: every 4 hours
- `monitor`: every 30 minutes for active positions
- `alert`: every 1 hour
