---
name: bitflow-lp-rebalance-advisor-agent
skill: bitflow-lp-rebalance-advisor
description: "Autonomous LP position drift monitor for Bitflow HODLMM pools. Detects out-of-range positions and recommends optimal rebalance targets. Read-only — no funds moved, no transactions submitted."
---

# Agent Behavior — Bitflow LP Rebalance Advisor

## Decision order

1. Run `doctor` first. If Bitflow APIs are unreachable, surface the error and stop.
2. Run `scan` to identify pools with significant bin drift across the ecosystem.
3. For each flagged pool where the agent has an active position, run `analyze --pool-id <id>`.
4. If analysis shows `drifted` or `stranded` status with > 50% fee capture loss, run `recommend`.
5. Present the rebalance plan to the user. **Never execute without explicit human approval.**
6. After rebalance, run `analyze` again to confirm the new position is in-range.

## Guardrails

- **Never rebalance automatically.** This skill is advisory only. All withdrawals and deposits require human confirmation.
- **Never recommend rebalancing when net benefit is negative.** If gas + slippage > projected fee gain, recommend "hold" even if position is drifted.
- **Never chase micro-drift.** Positions within 2 bins of active price are "in-range" and should not trigger rebalance recommendations.
- **Never ignore gas costs.** A $0.50 rebalance that saves $0.10 in fees is a net loss. Always present the cost-benefit calculation.
- **Never recommend rebalancing during high volatility.** If `hodlmm-pulse` signal is `spike`, price is moving fast — wait for stabilization before rebalancing.
- **Use `--min-tvl 5000`** in production. Low-TVL pools have unreliable volume distribution data.

## Polling cadence

| Phase | Action | Frequency |
|---|---|---|
| Idle (no positions) | `scan --min-drift 5` | Every 60 min |
| Active position, in-range | `analyze --pool-id <id>` | Every 15 min |
| Active position, edge | `analyze --pool-id <id>` | Every 5 min |
| Active position, drifted | `recommend --pool-id <id>` | Once, then wait for user |
| Active position, stranded | `recommend --pool-id <id>` + urgent alert | Once, then wait for user |
| Post-rebalance | `analyze --pool-id <id>` | Confirm, then resume idle |

## Drift severity → action mapping

| Drift Status | Fee Capture | Action |
|---|---|---|
| `in-range` | > 80% | No action. Position is optimal. |
| `edge` | 50-80% | Monitor. Log drift direction. Prepare rebalance plan but do not alert yet. |
| `drifted` | 10-50% | Alert user. Run `recommend`. Present cost-benefit analysis. |
| `stranded` | < 10% | **Urgent alert.** Position earning near-zero fees. Recommend immediate rebalance or full withdrawal. |

## Cross-skill coordination

| Condition | Action |
|---|---|
| `hodlmm-pulse` signal is `spike` | **Do NOT rebalance.** Price is volatile. Wait for `stable` or `cooling` signal. |
| `hodlmm-pulse` signal is `cooling` | Safe to rebalance. Volume normalizing, price stabilizing. |
| `hodlmm-risk` flags high IL risk | Factor IL into cost-benefit. May recommend withdrawal over rebalance. |
| `hodlmm-advisor` has new entry plan | Compare advisor's suggested range against rebalance target. Use the tighter of the two. |

## On error

- Log the full `{ "error": "..." }` payload
- Do not retry silently — surface the error with the endpoint that failed
- If Bitflow API returns stale data (> 10 min old), warn the user and do not generate recommendations
- If bin-level data is unavailable for a pool, fall back to aggregate volume distribution

## On success

- For `analyze`: always show drift distance, fee capture rate, and whether action is needed
- For `scan`: sort by drift severity descending, highlight `stranded` positions first
- For `recommend`: present full cost-benefit breakdown — never show just the recommendation without the numbers

## Example workflow

```
# Morning check: any positions drifted overnight?
bitflow-lp-rebalance-advisor scan --min-drift 3

# Pool dlmm_1 flagged — check our position
bitflow-lp-rebalance-advisor analyze --pool-id dlmm_1

# Position is stranded (drift: 8 bins, fee capture: 3%)
# Check if market is stable before rebalancing
hodlmm-pulse scan  # signal: "normal" — safe to proceed

# Generate rebalance plan
bitflow-lp-rebalance-advisor recommend --pool-id dlmm_1
# Output: move from bins 128-138 to bins 140-150
# Cost: ~2,500 microSTX gas, Benefit: +$4.20/day fees
# Net positive — present to user for approval

# After user approves and executes:
bitflow-lp-rebalance-advisor analyze --pool-id dlmm_1
# Confirm: in-range, fee capture 94%
```
