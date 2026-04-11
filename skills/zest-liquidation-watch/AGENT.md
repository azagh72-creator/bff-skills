# zest-liquidation-watch — Agent Guide

## Purpose

This skill reads Zest Protocol v2 lending positions on Stacks mainnet and computes liquidation risk. Use it in agents that manage DeFi portfolios or run autonomous liquidation protection.

## When to invoke

- User asks: "check my Zest position health" → `check --address SP...`
- User asks: "am I at risk of liquidation?" → `check --address SP...`
- User asks: "scan for at-risk Zest positions" → `scan --min-risk 0.3`
- Periodic cron monitoring → `alert --address SP... --threshold 1.5 --confirm`
- Before executing a Zest borrow → `check` first to see current health factor

## Command reference

| Command | Use case | Writes? |
|---------|----------|---------|
| `doctor` | Verify environment | No |
| `check --address SP...` | Single position health | No |
| `scan [--min-risk 0.5]` | Portfolio scan | No |
| `alert --address SP... --threshold N --confirm` | Monitoring alert | No |

## Integration with zest-auto-repay

This skill is a **monitor** — it does not repay debt. Pair it with `zest-auto-repay` for a complete liquidation protection system:

1. `zest-liquidation-watch alert` → detects risk, outputs JSON
2. Agent parses `data.alert === true` and `data.severity`
3. If `critical` or `warning` → trigger `zest-auto-repay run --action=repay`

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `STX_ADDRESS` | No | Default address for check/alert if --address omitted |

## Error handling

All commands exit with code 0 and emit JSON (even on error). Parse `result.error` to detect failures. Network timeouts (30s per call) are handled gracefully — the skill returns empty positions rather than crashing.
