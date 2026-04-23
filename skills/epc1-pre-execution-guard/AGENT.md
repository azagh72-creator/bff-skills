---
name: epc1-pre-execution-guard-agent
skill: epc1-pre-execution-guard
description: "Agent behavior rules for the EPC-1 pre-execution guard skill."
---

# EPC-1 Pre-Execution Guard — Agent Decision Guide

## When to use this skill

Run before ANY operation that commits capital on-chain. Specifically:
- Before `bitflow_swap` or any Bitflow route execution.
- Before `alex_swap` or ALEX DEX trades.
- Before `zest_supply`, `zest_borrow`, `zest_withdraw`, `zest_repay`.
- Before `jingswap_deposit_stx`, `jingswap_deposit_sbtc`.
- Before `transfer_stx` or `transfer_token` for large amounts.
- Before any multi-step DeFi sequence — check the first operation before committing.

Do NOT use for read-only operations: balance checks, price queries, position reads.

## Decision order

1. Run `doctor` once per session to verify EPC-1 is reachable.
2. Before each capital-committing operation: run `check` with the exact route and amount.
3. Read the `policy.decision` field:
   - `EXECUTE` → proceed immediately.
   - `WARN` → log the warning, check `probability.executable`, decide based on risk tolerance.
   - `BLOCK` → hard stop. Do not execute. Report reason to user.
4. Store `cert_id` and `proof_url` in the operation log for audit.
5. For multi-route comparisons (e.g. finding best swap path): use `batch` to evaluate all candidates in parallel, pick the highest `probability.executable` with `EXECUTE` or `WARN` verdict.

## Guardrails

- **Never execute when `execution_allowed` is false.** Hard rule. No exceptions.
- **Never execute when EPC-1 is unreachable.** If `doctor` fails, block all capital operations until resolved.
- **Re-check after parameter changes.** If amount, route, or caller type changes — run check again.
- **WARN threshold is context-dependent.** For large amounts (>10k STX equivalent), treat WARN as BLOCK. For small amounts, proceed with caution and log.
- **cert_id is your receipt.** Store it. If an operation is disputed later, the cert proves what was known pre-execution.

## Chaining with other skills

Pairs with every skill that executes DeFi operations:
- **Bitflow limit order / DCA:** Check route before placing order.
- **Zest Full Position Manager:** Check before supply, borrow, repay, collateral-remove.
- **sBTC Auto-Funnel:** Check STX→sBTC route before funnel execution.
- **HODLMM / range keeper:** Check liquidity routes before LP operations.
- **Contract Pre-Flight:** Complementary — EPC-1 checks route viability, pre-flight checks Clarity execution. Use both for maximum safety.

## Caller type selection

| Caller | Policy | Use when |
|--------|--------|----------|
| `dex` | Strict (high threshold) | User-facing swap UI |
| `bot` | Standard (default) | Autonomous agent operations |
| `agent` | Permissive (lower threshold) | High-frequency, small-amount strategies |

Default to `bot` when in doubt.

## Frequency

- **Before every capital operation:** Non-negotiable.
- **In batch mode for route selection:** Run once, get verdicts for all candidates.
- **On retry after BLOCK:** Re-check before retrying — market state changes.
