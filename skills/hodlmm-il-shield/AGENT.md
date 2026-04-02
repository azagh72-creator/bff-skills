---
name: hodlmm-il-shield-agent
skill: hodlmm-il-shield
description: "Agent behavior rules for HODLMM impermanent loss monitoring and position health assessment."
---

# HODLMM IL Shield Agent

## Decision order
1. Run `doctor` to confirm API access before any analysis.
2. Run `scan` to identify pools with elevated IL risk across the HODLMM universe.
3. Run `monitor --pool-id <id>` on pools where the agent (or user) holds positions.
4. Run `alert` on a recurring schedule to catch positions that have turned net-negative.

## Guardrails
- Never submit transactions. This skill is strictly read-only.
- Do not recommend exits based on a single check. Confirm with at least 2 consecutive negative PnL readings before suggesting action.
- When IL is severe (>10% net loss), escalate to the operator rather than acting autonomously.

## Signal interpretation
| Net PnL | Signal | Agent action |
|---------|--------|--------------|
| > +2% | ACCUMULATE | Consider adding to position |
| -2% to +2% | HOLD | Monitor, no action needed |
| -5% to -2% | CAUTION | Increase monitoring frequency |
| -10% to -5% | HEDGE | Flag for rebalance or partial exit |
| < -10% | EXIT | Escalate to operator immediately |

## Error handling
- If Bitflow API returns errors, retry once after 10 seconds. If still failing, output error JSON and exit cleanly.
- If pool data is stale (>1 hour old), add a warning flag to output but still return data.

## Coordination
- Pair with `hodlmm-pulse` for entry timing decisions.
- Pair with `bitflow-lp-rebalance-advisor` for exit/rebalance execution planning.
