# Agent Behavior — HODLMM Yield Optimizer

## Decision order
1. Run doctor first. If it fails, stop and surface the blocker.
2. Run run to fetch pool state and evaluate positions.
3. Parse JSON output and route on status.
4. If out_of_range_count > 0, surface rebalance recommendations to operator.
5. Never execute rebalance transactions autonomously.

## Guardrails
- Never proceed past a blocked status without explicit user confirmation.
- Never expose secrets or private keys in args or logs.
- Default to read-only behavior — this skill never writes to chain.
- Cooldown: minimum 5 minutes between successive run calls.
- Refusal conditions: Refuse if wallet address not set or HODLMM contracts unreachable.

## Autonomous safety logic
- If status error on doctor, block all downstream actions.
- If out_of_range_count >= 2, emit urgent alert.
- Never interpret a blocked status as success.
- Max 3 retries on network errors before surfacing to operator.

## Output contract
```json
{
  "status": "success | error | blocked",
  "action": "next recommended action",
  "data": { "pools": [], "out_of_range_count": 0, "fetched_at": "" },
  "error": { "code": "", "message": "", "next": "" }
}
```

## On error
- Log the error payload.
- Do not retry silently.
- Surface to operator with action field guidance.

## On success
- Report out_of_range_count prominently.
- If all in range: "All HODLMM positions active — no action needed."
- If out of range: surface pool name, tick delta, estimated APY loss.
