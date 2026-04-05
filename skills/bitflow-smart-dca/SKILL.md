---
name: bitflow-smart-dca
description: "Executes a Dollar-Cost Averaging swap on Bitflow DEX — fetches the best route, validates slippage, and submits the transaction on-chain."
metadata:
  author: "azagh72-creator"
  author-agent: "Flying Whale (Genesis L2, ERC-8004 #54) — SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW | bc1qdfm56pmmq40me84aau2fts3725ghzqlwf6ys7p"
  user-invocable: "false"
  arguments: "doctor | status | run --token-in <SYMBOL> --token-out <SYMBOL> --amount <microunits>"
  entry: "bitflow-smart-dca/bitflow-smart-dca.ts"
  requires: "wallet, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# Bitflow Smart DCA

Executes Dollar-Cost Averaging (DCA) swaps on Bitflow DEX using the best available route with automatic slippage protection.

## What it does

Connects to the Bitflow readonly API to discover the best swap route between two tokens, validates the quote against a configurable slippage threshold, and submits the swap transaction on Stacks mainnet. Designed to be called repeatedly on a schedule for automated DCA accumulation of any Bitflow-listed token.

## Why agents need it

Manual DCA requires repeated human intervention. This skill lets an autonomous agent execute time-based or trigger-based DCA into any token pair on Bitflow without manual approval — while enforcing hard slippage guards to prevent execution in adverse market conditions.

## Safety notes

- **WRITE — submits a real Stacks transaction.** Funds will move on mainnet.
- **Mainnet-only.** Bitflow does not support testnet.
- **Requires funded wallet** with STX for both swap amount and transaction fees.
- Hard slippage cap: refuses to execute if price impact exceeds `--max-slippage` (default 2%).
- Irreversible once broadcast. Always run `doctor` and `status` first.
- Never executes if `doctor` check fails.

## Commands

### doctor
Checks wallet readiness, Bitflow API availability, and token pair validity. Safe to run anytime — no funds moved.
```bash
bun run bitflow-smart-dca/bitflow-smart-dca.ts doctor --token-in STX --token-out ALEX
```

### status
Read-only quote preview — shows expected output, price impact, and route without executing.
```bash
bun run bitflow-smart-dca/bitflow-smart-dca.ts status --token-in STX --token-out ALEX --amount 1000000
```

### run
Executes the DCA swap on Bitflow mainnet.
```bash
bun run bitflow-smart-dca/bitflow-smart-dca.ts run --token-in STX --token-out ALEX --amount 1000000
```
Options:
- `--token-in <SYMBOL>` — Source token symbol (e.g. STX, WELSH, USDA)
- `--token-out <SYMBOL>` — Target token symbol (e.g. ALEX, sBTC, stSTX)
- `--amount <microunits>` — Amount in microunits (1 STX = 1000000)
- `--max-slippage <pct>` — Max allowed slippage % (default: 2)

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{
  "status": "success",
  "action": "dca-swap-executed",
  "data": {
    "tokenIn": "STX",
    "tokenOut": "ALEX",
    "amountIn": 1000000,
    "amountOut": 42381,
    "priceImpact": "0.43%",
    "route": ["STX", "ALEX"],
    "txid": "0xabc123..."
  },
  "error": null
}
```

**Blocked (slippage exceeded):**
```json
{
  "status": "blocked",
  "action": "dca-swap-blocked",
  "data": { "priceImpact": "3.2%", "maxAllowed": "2%" },
  "error": "Slippage 3.2% exceeds maximum allowed 2%. Aborting."
}
```

**Error:**
```json
{
  "status": "error",
  "action": "dca-swap-failed",
  "data": null,
  "error": "descriptive message"
}
```

## Known constraints

- Requires Bitflow readonly API to be available (`https://api.hiro.so`)
- Token symbols must be listed on Bitflow mainnet
- Minimum swap: 1 STX (1,000,000 microSTX)
- Transaction fees (~0.01 STX) deducted from wallet balance separately
