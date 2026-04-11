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

# Zest Liquidation Watch

## What it does

Monitors Zest Protocol v2 lending positions on Stacks mainnet. Reads on-chain collateral and debt data from `v0-1-data.get-user-position`, computes health factors across all 6 supported assets (sBTC, wSTX, stSTX, aeUSDC, USDH, stSTXbtc), and fires structured alerts when positions approach liquidation thresholds.

This is a **READ-ONLY** skill. It monitors and alerts — it does not submit transactions.

## Why agents need it

Zest Protocol liquidates borrowers when LTV exceeds configured thresholds (80–85%). Liquidation penalties permanently destroy collateral value. This skill gives agents:

1. **On-chain position data** — reads v0-1-data directly, no off-chain assumptions
2. **Health factor computation** — weighted across all collateral assets
3. **Liquidation price** — exact price at which the position becomes liquidatable
4. **Risk scoring** — 0.0 (safe) to 1.0 (liquidated) continuous score for automation
5. **Portfolio scan** — scan recent borrowers from market contract events

## On-chain proof

`doctor` command verifies live connectivity to Zest v2 contracts on Stacks mainnet:

| Check | Contract | Status |
|-------|----------|--------|
| Hiro API | api.hiro.so/v2/info | ✓ live |
| Zest v2 data | SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-1-data | ✓ deployed |
| Zest v2 market | SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market | ✓ deployed |
| Price feeds | CoinGecko STX + BTC | ✓ live |

## Key bug fix (v2.0.0)

The original v1.0.0 used incorrect Clarity principal encoding that caused the Stacks node to reject all read calls:

```typescript
// WRONG — encodes the c32check ASCII string as UTF-8 bytes
`0x0616${Buffer.from(address.replace("SP","")).toString("hex").padEnd(40, "0")}`
```

Fixed with inline c32decode (zero external deps, same pattern as approved `zest-auto-repay`):

```typescript
// CORRECT — decodes c32 to extract hash160, prepends type tag + version byte
encodeStandardPrincipal("SP322ZK...") // → 0x05 + versionByte + hash160[20]
```

Also updated from deprecated Zest v1 deployer (`SP2VCQJHN7...`) to confirmed v2 (`SP1A27KFY...`).

## Safety notes

- **Read-only.** No transactions are submitted. No STX gas is consumed.
- **`alert` requires `--confirm` flag.** Without it the command exits with a safety error. This prevents accidental automated invocation without explicit intent.
- **Network calls only.** Contacts Hiro API (api.hiro.so) and CoinGecko for prices. No wallet access required.
- **No private keys.** This skill never reads, requires, or touches wallet credentials.
- **Stale prices possible.** CoinGecko prices are fetched at runtime. In volatile markets, health factors may differ slightly from on-chain oracle values used by Zest for liquidation.
- **Mainnet only.** Zest v2 (`SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7`) is deployed on Stacks mainnet only.

## Commands

### doctor
Verifies connectivity to Hiro API, Zest v2 contracts, and price feeds. Safe to run anytime — read-only.
```bash
bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts doctor
```

### check
Check the health factor and liquidation risk for a single address.
```bash
bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts check \
  --address SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW
```
Accepts `--address` flag or `STX_ADDRESS` environment variable.

### scan
Scan recent Zest v2 borrowers (from market contract events) for positions above a risk threshold.
```bash
bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts scan --min-risk 0.3
```
`--min-risk` accepts 0.0–1.0 (default 0.5). Returns list sorted by risk score descending.

### alert
Check a position and trigger a structured alert if health factor drops below threshold. Requires `--confirm` flag.
```bash
bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts alert \
  --address SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW \
  --threshold 1.8 \
  --confirm
```
Without `--confirm`: exits immediately with a safety error (no network calls made).

## Output contract

All commands emit a single JSON object to stdout. Exit code is always 0. Parse `status` to route agent behavior.

**`doctor` — environment check:**
```json
{
  "status": "success",
  "network": "mainnet",
  "timestamp": "2026-04-11T10:00:00.000Z",
  "command": "doctor",
  "data": {
    "healthy": true,
    "checks": [
      { "name": "Hiro API", "status": "ok", "detail": "Stacks tip height: 7540000" },
      { "name": "Zest v2 data (SP1A27...v0-1-data)", "status": "ok", "detail": "12 functions found" },
      { "name": "Zest v2 market (SP1A27...v0-4-market)", "status": "ok", "detail": "8 functions found" },
      { "name": "Price feeds", "status": "ok", "detail": "STX=$0.2200, BTC=$83000" }
    ]
  }
}
```

**`check` — position health:**
```json
{
  "status": "success",
  "network": "mainnet",
  "timestamp": "2026-04-11T10:00:00.000Z",
  "command": "check",
  "data": {
    "address": "SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW",
    "healthFactor": 2.34,
    "riskLevel": "safe",
    "riskScore": 0.0,
    "totalSuppliedUsd": 1250.00,
    "totalBorrowedUsd": 320.00,
    "liquidationThreshold": 0.85,
    "supplied": {
      "sBTC": { "symbol": "sBTC", "amount": 0.015, "valueUsd": 1245.00 }
    },
    "borrowed": {
      "aeUSDC": { "symbol": "aeUSDC", "amount": 320.0, "valueUsd": 320.00 }
    },
    "liquidationPrice": {
      "asset": "sBTC",
      "triggerPrice": 25142.86,
      "currentPrice": 83000.00,
      "dropRequired": "-69.7%"
    }
  }
}
```

**`check` — no borrows:**
```json
{
  "status": "success",
  "command": "check",
  "data": {
    "address": "SP322ZK...",
    "message": "No active Zest v2 borrows found for this address",
    "supplied": {},
    "totalSuppliedUsd": 0,
    "healthFactor": null,
    "riskLevel": "safe"
  }
}
```

**`alert` — triggered:**
```json
{
  "status": "success",
  "command": "alert",
  "data": {
    "alert": true,
    "severity": "warning",
    "threshold": 1.8,
    "recommendation": "Health factor declining. Consider adding collateral or repaying partial debt.",
    "position": { "...": "full position object as in check" }
  }
}
```

**`alert` — no confirm:**
```json
{
  "error": "Safety gate: --confirm flag required to run alert mode. Example: alert --address SP... --threshold 1.5 --confirm"
}
```

**Key fields:**
- `healthFactor` (number | -1) — -1 means no borrows (infinite health). Values below 1.0 are liquidatable.
- `riskScore` (0.0–1.0) — 0 = safe, 1.0 = liquidated. Use for threshold-based automation.
- `riskLevel` — `"safe" | "low" | "medium" | "high" | "critical"` (see table below).
- `liquidationPrice.dropRequired` — how much the collateral price must drop to trigger liquidation.

## Risk levels

| Level | Health Factor | Recommended action |
|-------|--------------|-------------------|
| safe | > 2.0 | No action |
| low | 1.5 – 2.0 | Watch |
| medium | 1.2 – 1.5 | Consider adding collateral |
| high | 1.0 – 1.2 | Add collateral or repay urgently |
| critical | ≤ 1.0 | Liquidatable NOW |

## Known constraints

- CoinGecko rate limits: aggressive scanning of many addresses may hit 429s. Add delays between scan calls.
- Stale oracle prices: health factors use live CoinGecko prices, not Zest's internal Pyth oracle. Values may differ slightly.
- `scan` discovers addresses from recent market contract events only (last 50). It does not index all historical borrowers.
- Zest v2 is mainnet-only. There is no testnet equivalent.
