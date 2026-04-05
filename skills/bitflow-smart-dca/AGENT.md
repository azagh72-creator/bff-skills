---
name: bitflow-smart-dca-agent
skill: bitflow-smart-dca
description: "Executes recurring DCA swaps on Bitflow DEX with slippage guards, surfacing blockers before any funds move."
---

# Agent Behavior — Bitflow Smart DCA

## Decision order

1. Run `doctor --token-in <X> --token-out <Y>` first. If it fails for any reason, **stop immediately** and surface the blocker to the user. Do not proceed.
2. Run `status --amount <amount>` to preview the quote. Confirm price impact is within tolerance.
3. If status shows `blocked`, report the reason and ask user to adjust amount, timing, or slippage threshold.
4. Only after both doctor and status pass: execute `run --token-in <X> --token-out <Y> --amount <amount>`.
5. Parse JSON output. On success, log the txid and report completion. On error or blocked, surface immediately.

## Guardrails

- **Never skip `doctor`.** Even in automated loops, always validate readiness before execution.
- **Never expose the wallet mnemonic or private keys** in CLI arguments, logs, or responses.
- **Never retry a failed transaction silently.** If broadcast fails, surface the error and stop.
- **Never exceed `--max-slippage 5`** even if the user requests it — 5% is the absolute hard cap.
- **Minimum amount is 1,000,000 microSTX (1 STX).** Reject requests below this threshold.
- Default to `--max-slippage 2` unless the user explicitly overrides.
- In automated DCA loops, add at least 60 seconds between executions to avoid mempool congestion.

## On error

- Log the full error payload from stdout.
- Do not retry automatically — surface to the user with the txid (if partial) and suggested next action.
- If the error is "wallet locked", prompt the user to unlock before retrying.
- If the error is "insufficient funds", calculate the shortfall and surface it clearly.

## On success

- Extract and display `data.txid` — link to `https://explorer.hiro.so/txid/{txid}`.
- Confirm `data.amountOut` received and `data.priceImpact` was within bounds.
- If running in a scheduled DCA loop, log the execution timestamp and update cumulative DCA position.
- Report: "DCA executed — swapped {amountIn} {tokenIn} → {amountOut} {tokenOut} | txid: {txid}"

## Automated DCA scheduling

When the user sets up a recurring DCA:
1. Validate parameters once via `doctor`.
2. Store the schedule (token pair, amount, interval).
3. On each trigger: run full doctor → status → run flow.
4. Abort the entire schedule on 3 consecutive failures — surface to user for review.
