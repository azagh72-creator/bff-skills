---
name: zest-liquidation-watch-agent
skill: zest-liquidation-watch
description: "Autonomous liquidation risk monitor for Zest Protocol positions. Read-only — no funds moved, no transactions submitted. Alerts agents before positions reach liquidation threshold."
---

# Agent Behavior — Zest Liquidation Watch

## Decision order

1. Run `doctor` first. If Hiro API or Zest contracts are unreachable, surface the error and stop.
2. Run `check` on the agent's own address. If no Zest position exists, report "no active borrows" and stop.
3. Evaluate health factor against threshold:
   - Health factor > 2.0 → **safe**. Log and continue idle polling.
   - Health factor 1.5–2.0 → **monitor**. Increase polling frequency.
   - Health factor 1.2–1.5 → **warning**. Alert user. Recommend adding collateral or repaying debt.
   - Health factor < 1.2 → **critical**. Urgent alert. Recommend immediate action.
4. Run `scan` periodically to detect network-wide liquidation risk (systemic events).
5. If multiple positions enter warning zone simultaneously, flag as potential market-wide event.

## Guardrails

- **Never act on stale data.** Each check is a fresh on-chain read. If the API returns an error, do not use cached values.
- **Never submit transactions.** This skill is advisory only. Repayments, collateral additions, and liquidation executions require explicit human confirmation.
- **Never recommend increasing leverage** when health factor is declining.
- **Alert early, not late.** Default threshold is 1.5, not 1.0. By the time health factor hits 1.0, it may be too late due to oracle lag.
- **Context matters.** A health factor of 1.3 on a stablecoin borrow is different from 1.3 on a volatile asset borrow. Factor in asset volatility when assessing urgency.

## Polling cadence

| Health Factor | Action | Frequency |
|---|---|---|
| > 2.0 | `check` — log and idle | Every 30 min |
| 1.5–2.0 | `check` — monitor | Every 10 min |
| 1.2–1.5 | `alert` — warn user | Every 5 min |
| < 1.2 | `alert` — urgent notification | Every 2 min |
| Any (scan) | `scan` — network health | Every 60 min |

## Alert → action mapping

| Health Factor | Trend | Action |
|---|---|---|
| > 2.0 | stable | No action. Position is healthy. |
| > 2.0 | declining | Monitor. Log the trend for early warning. |
| 1.5–2.0 | stable | Inform user. No urgency. |
| 1.5–2.0 | declining | Warn user. Suggest reviewing position. |
| 1.2–1.5 | any | **Alert user.** Recommend: add collateral or repay partial debt. |
| < 1.2 | any | **Urgent alert.** Recommend: repay debt immediately or add significant collateral. |

## On error

- Log the full `{ "error": "..." }` payload
- Do not retry silently — surface the error with the endpoint that failed
- If `doctor` reports API failure, pause all polling and alert user
- If Zest contract read fails, it may indicate a contract upgrade — flag for investigation

## On success

- For `check`: present health factor prominently, with liquidation price and distance percentage
- For `scan`: sort by risk score descending, highlight any positions below 1.5 health factor
- For `alert`: output structured alert with severity level, recommended action, and time estimate before liquidation at current price trend

## Integration chain

```
zest-liquidation-watch doctor   → verify connectivity
zest-liquidation-watch check    → assess own position health
zest-liquidation-watch alert    → automated monitoring via cron
zest-liquidation-watch scan     → network-wide risk assessment
zest-yield-manager status       → cross-reference with yield position
hodlmm-pulse scan               → check if DeFi conditions are deteriorating
```
