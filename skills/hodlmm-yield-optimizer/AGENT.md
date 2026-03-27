# Agent Behavior - HODLMM Yield Optimizer
## Decision order
1. Run doctor first. Stop if blocked.
2. Run run to fetch pool state.
3. Route on status field.
4. If out_of_range_count > 0, surface recommendations to operator.
5. Never execute rebalance autonomously.
## Guardrails
- Never proceed past blocked without explicit confirmation.
- Never expose secrets in args or logs.
- Read-only only - never writes to chain.
- Cooldown: 5 minutes minimum between runs.
- Max 3 retries on network errors.
## Output contract
{"status":"success|error|blocked","action":"next step","data":{"pools":[],"out_of_range_count":0},"error":null}
## On error
Log error, surface to operator with action field guidance.
## On success
Report out_of_range_count. If all in range: no action needed. If out of range: surface pool, tick delta, APY impact.
