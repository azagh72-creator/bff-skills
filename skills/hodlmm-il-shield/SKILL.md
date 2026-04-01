---
name: hodlmm-il-shield
description: "Impermanent loss protection monitor for Bitflow HODLMM — tracks real-time IL, fee offset ratio, and emits exit signals when losses exceed configurable thresholds."
metadata:
  author: "azagh72-creator"
  author-agent: "Flying Whale"
  user-invocable: "false"
  arguments: "doctor | run --action=status | run --action=monitor | run --action=exit-check | run --action=emergency-exit"
  entry: "hodlmm-il-shield/hodlmm-il-shield.ts"
  requires: "wallet, signing, settings"
  tags: "defi, read-only, mainnet-only, l2"
---

## What it does

Real-time impermanent loss (IL) shield for Bitflow HODLMM DLMM positions. Continuously tracks IL against fee earnings, computes a net PnL ratio, and emits actionable exit signals when losses exceed configurable thresholds. This is a **safety-first read skill** — it monitors and warns, letting the agent decide whether to act.

## Why agents need it

HODLMM LPs earn fees from active bins, but price divergence creates impermanent loss. Without monitoring, agents hold losing positions indefinitely. This skill:

1. **Tracks IL in real-time** — computes divergence loss from entry price vs current price
2. **Measures fee offset** — compares accumulated fees against IL to determine net profitability
3. **Emits exit signals** — when IL exceeds fees by a configurable margin, signal EXIT
4. **Classifies regime** — calm (hold), stressed (alert), critical (exit recommended)

Without this, agents have no way to know when an HODLMM position has turned net-negative.

## HODLMM Integration

Direct integration with Bitflow HODLMM pools:
- Reads pool state from `https://api.bitflow.finance/api/v1/hodlmm/`
- Targets `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15`
- Reads bin distribution, active bin, reserve balances, and fee accrual
- Computes IL from bin drift and reserve ratio divergence
- Integrates with hodlmm-pulse fee velocity data when available

## Commands

### `doctor`
Pre-flight checks: wallet, API connectivity, pool state, position existence.

```bash
bun run hodlmm-il-shield.ts doctor --pool-id dlmm_3
```

### `run --action=status`
Full position IL analysis with fee offset and net PnL classification.

```bash
bun run hodlmm-il-shield.ts run --action=status --pool-id dlmm_3
```

### `run --action=monitor`
Continuous monitoring mode — checks IL every interval and logs state changes.

```bash
bun run hodlmm-il-shield.ts run --action=monitor --pool-id dlmm_3 --interval=300
```

### `run --action=exit-check`
One-shot exit signal — returns YES/NO with confidence score and reasoning.

```bash
bun run hodlmm-il-shield.ts run --action=exit-check --pool-id dlmm_3 --il-threshold=5
```

### `run --action=emergency-exit`
Generates MCP withdrawal commands when IL exceeds emergency threshold.

```bash
bun run hodlmm-il-shield.ts run --action=emergency-exit --pool-id dlmm_3
```

## Safety notes

All thresholds are enforced in code:

| Control | Default | Enforced |
|---------|---------|----------|
| IL warning threshold | 3% net loss | `--il-threshold` flag, hard cap 20% |
| IL critical threshold | 5% net loss | Cannot be set above 10% |
| Emergency exit threshold | 8% net loss | Hard-coded, cannot be overridden |
| Minimum position age | 1 hour | Prevents exit on short-term noise |
| Fee data required | true | Refuses to compute IL without fee baseline |
| API timeout | 15 seconds | Prevents hanging on slow responses |
| Cooldown between checks | 60 seconds | Prevents API rate limiting |

**Key safety rule:** The skill NEVER executes withdrawals automatically in monitor mode. It emits exit signals that the agent must explicitly act on. Only `emergency-exit` generates MCP commands, and only when IL exceeds the hard-coded emergency threshold.

## Output contract

All commands output structured JSON:

```json
{
  "status": "success | error | exit_signal",
  "action": "Human-readable recommendation",
  "data": {
    "il_percent": 2.3,
    "fees_earned_percent": 1.8,
    "net_pnl_percent": -0.5,
    "regime": "calm | stressed | critical",
    "exit_signal": false,
    "confidence": 0.72,
    "position_age_hours": 48.5
  },
  "error": null
}
```

### Error Codes

| Code | Meaning |
|------|---------|
| `no_wallet` | STACKS_ADDRESS not set |
| `no_position` | No active HODLMM position found |
| `api_unreachable` | Bitflow API not responding |
| `insufficient_data` | Not enough fee data to compute IL offset |
| `position_too_young` | Position age below minimum threshold |
| `threshold_invalid` | IL threshold outside allowed range |

## On-Chain Proof

| Evidence | Detail |
|----------|--------|
| Wallet | `SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW` |
| BTC Address | `bc1qdfm56pmmq40me84aau2fts3725ghzqlwf6ys7p` |
| DLMM Pool Tokens | 390 NFTs in `dlmm-pool-stx-sbtc-v-1-bps-15` |
| sBTC Balance | 28,826 sats active |
| Agent | Flying Whale — Genesis L2, ERC-8004 #54 on aibtc.com |
| Explorer | [View on Hiro](https://explorer.hiro.so/address/SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW?chain=mainnet) |

## Architecture

```
Agent invokes skill
  → doctor: pre-flight checks (wallet, API, pool, position)
  → status: fetch pool + bins + fees → compute IL → classify regime → report
  → monitor: loop(status) → emit signal on regime change
  → exit-check: one-shot IL vs threshold → YES/NO with confidence
  → emergency-exit: IL > 8% → emit MCP remove-liquidity commands
```

The skill separates monitoring from execution. Exit signals are advisory — the agent framework decides whether to act. This prevents automated panic exits during flash crashes.
