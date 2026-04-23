---
name: epc1-pre-execution-guard
description: "Call Flying Whale EPC-1 before any DeFi operation — returns EXECUTE/WARN/BLOCK verdict with P(success) score and risk breakdown"
metadata:
  author: "zaghmout.btc"
  author-agent: "Flying Whale"
  user-invocable: "false"
  arguments: "doctor | check --route=<PAIR> --amount=<N> [--caller=dex|bot|agent] | batch | install-packs"
  entry: "epc1-pre-execution-guard/epc1-guard.ts"
  requires: "network"
  tags: "safety, pre-execution, epc1, defi, bitflow, stacks, flying-whale"
---

# EPC-1 Pre-Execution Guard

Check any Bitflow or Stacks DeFi operation against the Flying Whale EPC-1 protocol before committing capital. Returns a cryptographically certified EXECUTE / WARN / BLOCK verdict with P(success) score in under 100ms.

## What it does

Before executing a swap, supply, borrow, or any DeFi operation, this skill calls `POST https://fwgate.to/epc/v1/evaluate` and evaluates the route feasibility against live on-chain state: liquidity depth, oracle quality, slippage risk, and routing viability. The verdict is policy-enforced per caller type (DEX strict, Bot standard, Agent permissive).

Every verdict produces a cryptographic certificate: cert_id + SHA-256 state_root + Stacks mainnet chain_anchor — making the pre-execution check auditable and non-repudiable.

## Why agents need it

Failed transactions waste gas and capital. Phantom liquidity appears real until execution fails. AI agents and bots have no standard pre-execution layer — they execute blindly. EPC-1 closes this gap: check first, execute only if viable.

Flying Whale processes live DeFi routes continuously. Current findings: STX→ALEX is NON_EXECUTABLE (pool broken, 0% feasibility). STX→sBTC is DEGRADED (51%, slippage detected). These are real, verifiable verdicts — confirmed at fwgate.to/proof/fw-s-abe25ee9c933.

## Commands

### `doctor`
Health check: EPC-1 endpoint reachability, response format, system status.

```bash
bun run epc1-pre-execution-guard/epc1-guard.ts doctor
```

### `check`
Evaluate a single route before execution. Returns verdict + P(success) + policy decision.

```bash
bun run epc1-pre-execution-guard/epc1-guard.ts check \
  --route="STX->sBTC" \
  --amount=1000 \
  --caller=bot
```

### `batch`
Evaluate multiple routes in parallel. Useful for multi-hop or comparative routing.

```bash
bun run epc1-pre-execution-guard/epc1-guard.ts batch \
  --routes='[{"route":"STX->sBTC","amount":500},{"route":"STX->ALEX","amount":500}]' \
  --caller=agent
```

### `install-packs`
No additional packages required. Uses native `fetch()` and `commander`.

## Safety notes

- **Blocks by default on BLOCK verdict.** Never proceeds when policy decision is BLOCK.
- **WARN is configurable.** Agent can be set to proceed or halt on WARN.
- **Certificate stored.** cert_id and state_root logged for audit trail.
- **Sub-100ms.** Adds negligible latency to any agent pipeline.
- **0.1 STX per call** (x402 payment, auto-handled). Less than one failed transaction.
- **Honest verdicts.** If EPC-1 endpoint is unreachable, skill reports outage and blocks execution — never executes blind.

## Output contract

```json
{
  "status": "success | error | blocked",
  "action": "check",
  "data": {
    "verdict": "non_executable | degraded | viable",
    "policy": {
      "decision": "BLOCK | WARN | EXECUTE",
      "execution_allowed": false,
      "reason": "P_EXECUTABLE_BELOW_THRESHOLD"
    },
    "probability": {
      "executable": 0.04,
      "degraded": 0.11,
      "fail": 0.85
    },
    "confidence": 0.89,
    "cert_id": "EPC-7892",
    "state_root": "a7e3d912...",
    "proof_url": "https://fwgate.to/proof/fw-s-..."
  },
  "error": null
}
```

## On-chain Proof

EPC-1 is anchored on Stacks mainnet via contract `SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW.fw-epc-v1`. Every verdict references a live chain_anchor. IP registration TX: `52ff861577...` (block confirmed).

Live proof for STX→ALEX NON_EXECUTABLE verdict: https://fwgate.to/proof/fw-s-abe25ee9c933

Protocol spec: https://fwgate.to/epc1

## Architecture

```
[Agent plans DeFi operation]
         |
[EPC-1 check: POST /epc/v1/evaluate]
         |
 [verdict + P(success) + policy]
    /         |          \
EXECUTE      WARN       BLOCK
(proceed) (decides)  (hard stop)
```

## Integration with Bitflow

Pairs directly with Bitflow swaps:

```typescript
// Before any bitflow_swap call:
const guard = await epc1Check({ route: "STX->sBTC", amount, caller: "dex" });
if (!guard.policy.execution_allowed) throw new Error("EPC-1 BLOCK: " + guard.policy.reason);
// proceed with swap
```

Also pairs with: Zest supply/borrow/repay, ALEX swaps, JingSwap cycles, any capital-committing operation.

## Limitations

- Probabilistic verdict — not a guarantee. P(success) is a score, not certainty.
- Dependent on EPC-1 oracle data quality (5 independent sources via FW_CONSENSUS_v1.0).
- 0.1 STX cost per evaluation (x402). Free calls not available.
- Single-pair evaluation per call (use batch for multi-route).
