#!/usr/bin/env bun
/**
 * EPC-1 Pre-Execution Guard
 * Flying Whale — zaghmout.btc | ERC-8004 #54
 *
 * Calls the Flying Whale EPC-1 protocol (fwgate.to) before any DeFi operation.
 * Returns EXECUTE / WARN / BLOCK verdict with P(success) score.
 *
 * Commands: doctor | check | batch | install-packs
 *
 * Live proof — STX->ALEX NON_EXECUTABLE:
 *   https://fwgate.to/proof/fw-s-abe25ee9c933
 *
 * Protocol spec: https://fwgate.to/epc1
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────────────

const EPC1_BASE      = "https://fwgate.to";
const EPC1_EVALUATE  = `${EPC1_BASE}/epc/v1/evaluate`;
const EPC1_HEALTH    = `${EPC1_BASE}/gate/health`;
const EPC1_TIMEOUT   = 10_000; // 10s

const CALLER_TYPES   = ["dex", "bot", "agent", "default"] as const;
type CallerType      = (typeof CALLER_TYPES)[number];

// ── Types ──────────────────────────────────────────────────────────────────────

interface EPC1Request {
  route:    string;
  amount:   number;
  context?: string;
  caller?:  CallerType;
}

interface EPC1Verdict {
  verdict:    "viable" | "degraded" | "non_executable";
  standard:   string;
  version:    string;
  cert_id:    string;
  probability: {
    executable: number;
    degraded:   number;
    fail:       number;
  };
  policy: {
    decision:          "EXECUTE" | "WARN" | "BLOCK";
    execution_allowed: boolean;
    reason?:           string;
  };
  confidence:    number;
  state_root:    string;
  chain_anchor:  string;
  proof_url?:    string;
  accuracy_pct?: number;
}

interface SkillOutput {
  status:  "success" | "error" | "blocked";
  action:  string;
  data:    Record<string, unknown>;
  error:   { code: string; message: string; next: string } | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function err(code: string, message: string, next: string): SkillOutput {
  return { status: "error", action: "error", data: {}, error: { code, message, next } };
}

async function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EPC1_TIMEOUT);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function evaluate(req: EPC1Request): Promise<EPC1Verdict> {
  const res = await fetchWithTimeout(EPC1_EVALUATE, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(req),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`EPC-1 returned HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json() as Promise<EPC1Verdict>;
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  const checks: Record<string, boolean | string> = {};

  // 1. Health endpoint
  try {
    const res = await fetchWithTimeout(EPC1_HEALTH);
    const body = await res.json() as Record<string, unknown>;
    checks.health_endpoint = res.ok;
    checks.health_status   = String(body.status ?? "unknown");
  } catch (e) {
    checks.health_endpoint = false;
    checks.health_error    = String(e);
  }

  // 2. Evaluate endpoint — dry run with a known route
  try {
    const verdict = await evaluate({ route: "STX->sBTC", amount: 100, caller: "bot" });
    checks.evaluate_endpoint = true;
    checks.sample_verdict    = verdict.verdict;
    checks.sample_decision   = verdict.policy.decision;
    checks.cert_id           = verdict.cert_id;
    checks.standard          = verdict.standard + " v" + verdict.version;
  } catch (e) {
    checks.evaluate_endpoint = false;
    checks.evaluate_error    = String(e);
  }

  const allOk = Object.values(checks).every(v => v !== false);

  out({
    status: allOk ? "success" : "error",
    action: "doctor",
    data:   {
      ready: allOk,
      checks,
      recommendation: allOk
        ? "EPC-1 is reachable and responding. Safe to use as pre-execution guard."
        : "EPC-1 health check failed. Do not execute DeFi operations blind — wait for recovery.",
    },
    error: allOk ? null : {
      code:    "EPC1_UNREACHABLE",
      message: "One or more EPC-1 health checks failed.",
      next:    "Retry in 30s. If persistent, check https://fwgate.to/gate/health manually.",
    },
  });
}

async function cmdCheck(options: {
  route:    string;
  amount:   string;
  caller?:  string;
  context?: string;
}): Promise<void> {
  const amount = parseFloat(options.amount);
  if (isNaN(amount) || amount <= 0) {
    out(err("INVALID_AMOUNT", "Amount must be a positive number.", "Provide --amount=<N> where N > 0."));
    return;
  }

  const caller = (options.caller ?? "bot") as CallerType;
  if (!CALLER_TYPES.includes(caller)) {
    out(err("INVALID_CALLER", `Caller must be one of: ${CALLER_TYPES.join(", ")}.`, "Use --caller=bot (default)."));
    return;
  }

  let verdict: EPC1Verdict;
  try {
    verdict = await evaluate({
      route:   options.route,
      amount,
      caller,
      context: options.context ?? "preflight",
    });
  } catch (e) {
    out({
      status: "blocked",
      action: "check",
      data:   { route: options.route, amount, blocked_reason: "epc1_unreachable" },
      error:  {
        code:    "EPC1_UNREACHABLE",
        message: String(e),
        next:    "EPC-1 is unreachable. Blocking execution — never execute blind.",
      },
    });
    return;
  }

  const blocked = !verdict.policy.execution_allowed;

  out({
    status: blocked ? "blocked" : "success",
    action: "check",
    data: {
      route:   options.route,
      amount,
      caller,
      verdict:             verdict.verdict,
      policy:              verdict.policy,
      probability:         verdict.probability,
      confidence:          verdict.confidence,
      cert_id:             verdict.cert_id,
      state_root:          verdict.state_root,
      chain_anchor:        verdict.chain_anchor,
      proof_url:           verdict.proof_url ?? `${EPC1_BASE}/proof/${verdict.cert_id}`,
      accuracy_pct:        verdict.accuracy_pct,
      recommendation: blocked
        ? `BLOCKED — ${verdict.policy.reason ?? "policy threshold not met"}. Do not execute.`
        : verdict.verdict === "degraded"
          ? `WARN — degraded conditions (P(executable)=${verdict.probability.executable.toFixed(2)}). Proceed with caution.`
          : `EXECUTE — route viable (P(executable)=${verdict.probability.executable.toFixed(2)}). Safe to proceed.`,
    },
    error: null,
  });
}

async function cmdBatch(options: {
  routes: string;
  caller?: string;
}): Promise<void> {
  let routes: { route: string; amount: number }[];
  try {
    routes = JSON.parse(options.routes);
    if (!Array.isArray(routes) || routes.length === 0) throw new Error("must be non-empty array");
    if (routes.length > 10) throw new Error("max 10 routes per batch");
  } catch (e) {
    out(err("INVALID_ROUTES", `Failed to parse --routes: ${e}`, 'Provide JSON array: [{"route":"STX->sBTC","amount":500}]'));
    return;
  }

  const caller = (options.caller ?? "bot") as CallerType;

  const results = await Promise.allSettled(
    routes.map(r => evaluate({ route: r.route, amount: r.amount, caller, context: "batch-preflight" }))
  );

  const evaluated = results.map((r, i) => {
    if (r.status === "rejected") {
      return {
        route:    routes[i].route,
        amount:   routes[i].amount,
        status:   "error",
        decision: "BLOCK",
        execution_allowed: false,
        error:    String(r.reason),
      };
    }
    const v = r.value;
    return {
      route:             routes[i].route,
      amount:            routes[i].amount,
      status:            "ok",
      verdict:           v.verdict,
      decision:          v.policy.decision,
      execution_allowed: v.policy.execution_allowed,
      p_executable:      v.probability.executable,
      confidence:        v.confidence,
      cert_id:           v.cert_id,
    };
  });

  const executable = evaluated.filter(r => r.execution_allowed);
  const best = executable.sort((a, b) =>
    (b.p_executable as number) - (a.p_executable as number)
  )[0] ?? null;

  out({
    status: "success",
    action: "batch",
    data: {
      total:      routes.length,
      executable: executable.length,
      blocked:    routes.length - executable.length,
      results:    evaluated,
      best_route: best
        ? { route: best.route, p_executable: best.p_executable, decision: best.decision }
        : null,
      recommendation: best
        ? `Best viable route: ${best.route} (P(executable)=${(best.p_executable as number).toFixed(2)}, decision=${best.decision}).`
        : "No viable routes found. Do not execute any route.",
    },
    error: null,
  });
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("epc1-guard")
  .description("Flying Whale EPC-1 pre-execution guard — check before any DeFi operation")
  .version("1.0.0");

program
  .command("doctor")
  .description("Health check: EPC-1 endpoint reachability and response format")
  .action(cmdDoctor);

program
  .command("check")
  .description("Evaluate a single route — returns EXECUTE/WARN/BLOCK verdict")
  .requiredOption("--route <pair>",    'Route to evaluate, e.g. "STX->sBTC"')
  .requiredOption("--amount <number>", "Amount in base units")
  .option("--caller <type>",   "Caller type: dex | bot | agent | default (default: bot)", "bot")
  .option("--context <ctx>",   "Optional context string", "preflight")
  .action(cmdCheck);

program
  .command("batch")
  .description("Evaluate multiple routes in parallel — returns ranked verdicts")
  .requiredOption("--routes <json>",   'JSON array: [{"route":"STX->sBTC","amount":500},...]')
  .option("--caller <type>",   "Caller type: dex | bot | agent | default (default: bot)", "bot")
  .action(cmdBatch);

program
  .command("install-packs")
  .description("No additional packages required — uses native fetch() and commander")
  .action(() => {
    console.log(JSON.stringify({
      status: "success",
      message: "No installation required. Uses: fetch() (built-in), commander (bun built-in).",
      runtime: "bun >= 1.0",
    }, null, 2));
  });

program.parseAsync(process.argv).catch(e => {
  out(err("CLI_ERROR", String(e), "Check command syntax with --help."));
  process.exit(1);
});
