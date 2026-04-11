---
name: zest-liquidation-watch
description: "Liquidation risk monitor for Zest Protocol v2 on Stacks — reads on-chain positions via v0-1-data, computes health factors, and alerts agents before collateral is liquidated."
metadata:
  author: "azagh72-creator"
  author-agent: "Flying Whale"
  user-invocable: "false"
  arguments: "doctor | check --address <SP...> | scan [--min-risk 0.5] | alert --address <SP...> [--threshold 1.5] --confirm"
  entry: "zest-liquidation-watch/zest-liquidation-watch.ts"
  requires: "network"
  tags: "defi, read, mainnet-only, l2, monitoring"
---

## What it does

Monitors Zest Protocol v2 lending positions on Stacks mainnet. Reads on-chain collateral and debt data from `v0-1-data.get-user-position`, computes health factors, classifies risk levels, and fires structured alerts when positions approach liquidation thresholds.

Supports all 6 Zest v2 assets: sBTC, wSTX, stSTX, aeUSDC, USDH, stSTXbtc.

## Why agents need it

Zest Protocol liquidates borrowers when LTV exceeds configured thresholds (80-85%). Liquidation penalties permanently destroy collateral value. This skill gives agents:

1. **On-chain position data** — reads v0-1-data directly, no assumptions
2. **Health factor computation** — weighted across all collateral assets
3. **Liquidation price** — exact price at which the position becomes liquidatable
4. **Risk scoring** — 0.0 (safe) to 1.0 (liquidated) continuous score for automation
5. **Portfolio scan** — scan recent borrowers from market contract events

This is a **READ-ONLY** skill. It monitors and alerts — it does not execute transactions.

## Zest v2 integration

Uses the confirmed Zest v2 deployer `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7`:

| Contract | Purpose |
|----------|---------|
| `v0-1-data` | `get-user-position(principal)` — collateral + debt data |
| `v0-4-market` | Contract events for borrower discovery |

## Key bug fix (v2.0.0)

The original v1.0.0 skill used incorrect Clarity principal encoding:
```typescript
// WRONG — encodes the c32check ASCII string as UTF-8 bytes
`0x0616${Buffer.from(address.replace("SP","")).toString("hex").padEnd(40, "0")}`
```

The correct encoding decodes the c32check address to extract the actual 20-byte hash160:
```typescript
// CORRECT — decodes c32 to extract hash160, prepends type tag + version byte
encodeStandardPrincipal(address)   // → 0x05 + versionByte + hash160[20]
encodeContractPrincipal(contractId) // → 0x06 + versionByte + hash160[20] + nameLen + name
```

This fix is implemented inline with no external dependencies (no `@stacks/transactions` required).

## Usage examples

```bash
# Check environment and contracts
bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts doctor

# Check a specific position
bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts check \
  --address SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW

# Scan recent borrowers for risk
bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts scan --min-risk 0.3

# Alert when health factor drops below 1.8 (requires --confirm)
bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts alert \
  --address SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW \
  --threshold 1.8 \
  --confirm
```

## Output format

All commands emit JSON to stdout:

```json
{
  "status": "success",
  "network": "mainnet",
  "timestamp": "2026-04-11T10:00:00.000Z",
  "command": "check",
  "data": {
    "address": "SP322ZK...",
    "healthFactor": 2.34,
    "riskLevel": "safe",
    "riskScore": 0.0,
    "totalSuppliedUsd": 1250.00,
    "totalBorrowedUsd": 320.00,
    "liquidationThreshold": 0.85,
    "liquidationPrice": {
      "asset": "sBTC",
      "triggerPrice": 52000.00,
      "currentPrice": 83000.00,
      "dropRequired": "-37.3%"
    }
  }
}
```

## Risk levels

| Level | Health Factor | Action |
|-------|--------------|--------|
| safe | > 2.0 | No action needed |
| low | 1.5 – 2.0 | Watch |
| medium | 1.2 – 1.5 | Consider adding collateral |
| high | 1.0 – 1.2 | Add collateral or repay urgently |
| critical | ≤ 1.0 | Liquidatable NOW |
