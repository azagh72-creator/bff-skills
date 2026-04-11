---
name: zest-liquidation-watch-agent
skill: zest-liquidation-watch
description: "Agent behavior guide for zest-liquidation-watch — when to invoke each command, how to route on output, and how to integrate with zest-auto-repay for automated liquidation protection."
---

## Decision order

1. Run `doctor` first. If Hiro API is down or Zest v2 contracts are unreachable, surface the failure and stop.
2. Run `check --address SP...` to read the current position.
3. Route on `data.riskLevel`:
   - `safe` / `low` — log status, no action needed.
   - `medium` — recommend adding collateral or partial repayment to the user.
   - `high` — trigger `zest-auto-repay run --action=repay` if available; alert user urgently.
   - `critical` — trigger emergency repay immediately; position is liquidatable.
4. For portfolio monitoring, run `scan --min-risk 0.3` to surface all at-risk addresses.
5. For cron-based monitoring, use `alert --address SP... --threshold 1.5 --confirm` — only fires alert JSON when threshold is breached.

## Guardrails

- **Never invoke `alert` without `--confirm` flag.** The skill enforces this — it will exit with a safety error if `--confirm` is missing.
- **This skill is read-only.** It cannot repay debt or add collateral. Pair with `zest-auto-repay` for write operations.
- **Never pass private keys or mnemonics** to this skill. It requires no wallet credentials.
- **Health factors use CoinGecko prices** not Zest's internal Pyth oracle. For critical decisions, verify on-chain oracle price via `zest_get_position` MCP tool before acting.
- **Never proceed past a `critical` riskLevel** without immediately escalating to the user or triggering repayment.

## Integration with zest-auto-repay

Pair these two skills for complete autonomous liquidation protection:

```
zest-liquidation-watch check → data.riskLevel === "high" or "critical"
    ↓
zest-auto-repay run --action=repay --asset=<borrowed_asset>
```

Parse `data.borrowed` from `check` output to determine which asset to repay and in what amount.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `STX_ADDRESS` | No | Default address for `check` and `alert` if `--address` is omitted |

## Output routing

| `data.riskLevel` | `data.alert` | Recommended agent action |
|-----------------|-------------|--------------------------|
| `safe` | false | Log and continue |
| `low` | false | Log and continue |
| `medium` | true (if below threshold) | Notify user |
| `high` | true | Trigger repayment via zest-auto-repay |
| `critical` | true | Emergency repay immediately |

Parse errors: if output contains `"error"` key at root level, the skill failed. Log and retry after 60s backoff.
