# Agent Behavior — Bitflow Pool Monitor

## Decision order
1. Run doctor first. If it fails, stop and surface the blocker.
2. Run run to fetch pool data.
3. Parse JSON output and route on status.
4. Use data.pools to compare APY/TVL across pools.
5. If top_apy_pool APY > threshold, flag for rebalance consideration.

## Guardrails
- This skill is read-only — never initiate transactions based solely on this output.
- Never expose wallet keys in arguments or logs.
- Always surface error payloads with a suggested next action.
- If status is error, do not retry more than 3 times.
- Do not act on stale data — check fetched_at timestamp.

## Output contract
{"status": "success|error|blocked", "action": "next action", "data": {}, "error": null}

## On error
- Log the error payload
- Do not retry silently
- Surface to user with the action field guidance
