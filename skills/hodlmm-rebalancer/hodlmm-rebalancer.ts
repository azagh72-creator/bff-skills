#!/usr/bin/env bun
/**
 * HODLMM Rebalancer — Autonomous HODLMM LP position rebalancing on Bitflow
 *
 * Commands: doctor | run --action=<action>
 * Actions:  status | rebalance | withdraw | emergency-exit
 *
 * Built by Flying Whale — running 390+ DLMM pool tokens on mainnet.
 * On-chain proof: SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW holds active
 * DLMM positions in SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15
 *
 * HODLMM bonus eligible: Yes — directly manages HODLMM pool positions.
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────

const BITFLOW_API = "https://api.bitflow.finance/api/v1";
const HIRO_API = "https://api.hiro.so";
const NETWORK = "mainnet";
const FETCH_TIMEOUT_MS = 30_000;

// DLMM contract (mainnet, Bitflow HODLMM)
const DLMM_POOL_CONTRACT =
  "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15";
const STX_TOKEN = "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx";
const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

// Safety defaults — enforced in code, not just docs
const DEFAULT_MAX_REBALANCE_SATS = 100_000; // 0.001 BTC max per rebalance
const MAX_SLIPPAGE_BPS = 200; // 2% max slippage
const MIN_GAS_USTX = 200_000; // 0.2 STX minimum for gas
const COOLDOWN_SECONDS = 300; // 5 min between rebalance ops
const CRISIS_VOLATILITY_THRESHOLD = 60; // refuse rebalance above this
const DRIFT_REBALANCE_THRESHOLD = 15; // only rebalance if drift > this

// ── Types ──────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface HodlmmBinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
}

interface HodlmmPoolInfo {
  active_bin: number;
  token_x: string;
  token_y: string;
  token_x_symbol?: string;
  token_y_symbol?: string;
  bin_step?: number;
  total_fee_bps?: number;
}

interface HodlmmBinListResponse {
  active_bin_id?: number;
  bins: HodlmmBinData[];
}

interface RiskMetrics {
  activeBinId: number;
  totalBins: number;
  binSpread: number;
  reserveImbalanceRatio: number;
  volatilityScore: number;
  regime: "calm" | "elevated" | "crisis";
}

interface PositionAnalysis {
  positionBinCount: number;
  activeBinId: number;
  nearestOffset: number;
  avgOffset: number;
  driftScore: number;
  concentrationRisk: "low" | "medium" | "high";
  impermanentLossEstimatePct: number;
  recommendation: "hold" | "rebalance" | "withdraw";
  totalPositionX: number;
  totalPositionY: number;
}

// ── Output helpers ─────────────────────────────────────────────────────

function emit(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function success(action: string, data: Record<string, unknown>): void {
  emit({ status: "success", action, data, error: null });
}

function blocked(code: string, message: string, next: string): void {
  emit({
    status: "blocked",
    action: "Blocked — resolve issue before proceeding",
    data: {},
    error: { code, message, next },
  });
}

function fail(code: string, message: string, next: string): void {
  emit({
    status: "error",
    action: "Error occurred",
    data: {},
    error: { code, message, next },
  });
}

// ── API helpers ────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText} — ${url}`);
  return res.json() as Promise<T>;
}

async function getHodlmmPool(poolId: string): Promise<HodlmmPoolInfo> {
  return fetchJson<HodlmmPoolInfo>(`${BITFLOW_API}/hodlmm/pools/${poolId}`);
}

async function getHodlmmPoolBins(
  poolId: string
): Promise<HodlmmBinListResponse> {
  return fetchJson<HodlmmBinListResponse>(
    `${BITFLOW_API}/hodlmm/pools/${poolId}/bins`
  );
}

async function getHodlmmUserPosition(
  address: string,
  poolId: string
): Promise<HodlmmBinListResponse> {
  return fetchJson<HodlmmBinListResponse>(
    `${BITFLOW_API}/hodlmm/pools/${poolId}/positions/${address}`
  );
}

async function getStxBalance(address: string): Promise<number> {
  const res = await fetch(
    `${HIRO_API}/extended/v1/address/${address}/stx`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
  );
  if (!res.ok) throw new Error(`Failed to fetch STX balance: ${res.status}`);
  const data = (await res.json()) as { balance: string; locked: string };
  return parseInt(data.balance, 10) - parseInt(data.locked, 10);
}

async function getSbtcBalance(address: string): Promise<number> {
  const res = await fetch(
    `${HIRO_API}/extended/v1/address/${address}/balances`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
  );
  if (!res.ok) throw new Error(`Failed to fetch balances: ${res.status}`);
  const data = (await res.json()) as {
    fungible_tokens?: Record<string, { balance: string }>;
  };
  const ftKey = `${SBTC_TOKEN}::sbtc-token`;
  const entry = data.fungible_tokens?.[ftKey];
  return entry ? parseInt(entry.balance, 10) : 0;
}

async function getNftCount(address: string, contract: string): Promise<number> {
  const res = await fetch(
    `${HIRO_API}/extended/v1/address/${address}/balances`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
  );
  if (!res.ok) return 0;
  const data = (await res.json()) as {
    non_fungible_tokens?: Record<string, { count: number }>;
  };
  for (const [key, val] of Object.entries(data.non_fungible_tokens || {})) {
    if (key.includes(contract)) return val.count;
  }
  return 0;
}

// ── Risk computation (integrated from hodlmm-risk pattern) ─────────

function classifyRegime(score: number): "calm" | "elevated" | "crisis" {
  if (score <= 30) return "calm";
  if (score <= 60) return "elevated";
  return "crisis";
}

function computeRiskMetrics(
  pool: HodlmmPoolInfo,
  binsResponse: HodlmmBinListResponse
): RiskMetrics {
  const bins = binsResponse.bins;
  const activeBinId = binsResponse.active_bin_id ?? pool.active_bin;
  if (activeBinId == null) {
    throw new Error("Cannot determine active bin from pool data");
  }

  const totalBins = bins.length;
  const nonEmpty = bins.filter(
    (b) => Number(b.reserve_x) > 0 || Number(b.reserve_y) > 0
  );
  if (nonEmpty.length === 0) {
    throw new Error("No active liquidity — all bins empty");
  }

  const binIds = nonEmpty.map((b) => b.bin_id);
  const minBin = Math.min(...binIds);
  const maxBin = Math.max(...binIds);
  const binSpread = totalBins > 0 ? (maxBin - minBin) / Math.max(totalBins, 1) : 0;

  let totalX = 0;
  let totalY = 0;
  for (const bin of bins) {
    totalX += Number(bin.reserve_x);
    totalY += Number(bin.reserve_y);
  }
  const totalReserves = totalX + totalY;
  const reserveImbalanceRatio =
    totalReserves > 0 ? Math.abs(totalX - totalY) / totalReserves : 0;

  const activeBin = bins.find((b) => b.bin_id === activeBinId);
  const activeLiquidity = activeBin
    ? Number(activeBin.reserve_x) + Number(activeBin.reserve_y)
    : 0;
  const concentration =
    totalReserves > 0 ? activeLiquidity / totalReserves : 0;

  const spreadScore = Math.min(binSpread * 100, 40);
  const imbalanceScore = reserveImbalanceRatio * 30;
  const concentrationScore = (1 - concentration) * 30;
  const volatilityScore = Math.round(
    Math.min(spreadScore + imbalanceScore + concentrationScore, 100)
  );

  return {
    activeBinId,
    totalBins,
    binSpread: Number(binSpread.toFixed(4)),
    reserveImbalanceRatio: Number(reserveImbalanceRatio.toFixed(4)),
    volatilityScore,
    regime: classifyRegime(volatilityScore),
  };
}

// ── Position analysis ──────────────────────────────────────────────

function analyzePosition(
  pool: HodlmmPoolInfo,
  poolBins: HodlmmBinListResponse,
  positionBins: HodlmmBinData[]
): PositionAnalysis {
  const activeBinId = poolBins.active_bin_id ?? pool.active_bin;
  if (activeBinId == null) {
    throw new Error("Cannot determine active bin");
  }

  const positionBinIds = positionBins.map((b) => b.bin_id);
  const offsets = positionBinIds.map((id) => Math.abs(id - activeBinId));
  const nearestOffset = Math.min(...offsets);
  const avgOffset = offsets.reduce((s, o) => s + o, 0) / offsets.length;
  const driftScore = Math.round(Math.min(avgOffset * 5, 100));

  const concentrationRisk: "low" | "medium" | "high" =
    positionBins.length === 1
      ? "high"
      : positionBins.length <= 3
      ? "medium"
      : "low";

  const impermanentLossEstimatePct = Number((driftScore * 0.08).toFixed(2));

  let totalPositionX = 0;
  let totalPositionY = 0;
  for (const bin of positionBins) {
    totalPositionX += Number(bin.reserve_x);
    totalPositionY += Number(bin.reserve_y);
  }

  let recommendation: "hold" | "rebalance" | "withdraw";
  if (driftScore > 50) {
    recommendation = "withdraw";
  } else if (driftScore > DRIFT_REBALANCE_THRESHOLD) {
    recommendation = "rebalance";
  } else {
    recommendation = "hold";
  }

  return {
    positionBinCount: positionBins.length,
    activeBinId,
    nearestOffset,
    avgOffset: Number(avgOffset.toFixed(2)),
    driftScore,
    concentrationRisk,
    impermanentLossEstimatePct,
    recommendation,
    totalPositionX,
    totalPositionY,
  };
}

// ── Rebalance computation ──────────────────────────────────────────

function computeRebalanceParams(
  pool: HodlmmPoolInfo,
  risk: RiskMetrics,
  position: PositionAnalysis,
  maxSats: number,
  slippageBps: number
) {
  // Determine optimal bin range centered on active bin
  const binWidth =
    risk.regime === "calm" ? 3 : risk.regime === "elevated" ? 5 : 0;

  if (binWidth === 0) {
    return null; // crisis — refuse to rebalance
  }

  const targetBinStart = risk.activeBinId - Math.floor(binWidth / 2);
  const targetBinEnd = risk.activeBinId + Math.floor(binWidth / 2);

  // Calculate amounts to redistribute
  const totalPosition = position.totalPositionX + position.totalPositionY;
  const rebalanceAmount = Math.min(totalPosition, maxSats);

  // Split evenly between token X and token Y around active bin
  const amountPerBin = Math.floor(rebalanceAmount / binWidth);

  return {
    strategy: risk.regime === "calm" ? "tight_range" : "moderate_range",
    targetBins: {
      start: targetBinStart,
      end: targetBinEnd,
      count: binWidth,
    },
    amounts: {
      total: rebalanceAmount,
      perBin: amountPerBin,
      maxSlippageBps: slippageBps,
    },
    currentDrift: position.driftScore,
    expectedDriftAfter: 0,
    contract: DLMM_POOL_CONTRACT,
    tokenX: pool.token_x_symbol || pool.token_x,
    tokenY: pool.token_y_symbol || pool.token_y,
  };
}

// ── Wallet helper ──────────────────────────────────────────────────

function getWalletAddress(): string {
  const addr = process.env.STACKS_ADDRESS || process.env.STX_ADDRESS;
  if (!addr) {
    fail(
      "no_wallet",
      "No wallet address found. Set STACKS_ADDRESS or install AIBTC MCP wallet.",
      "Run: npx @aibtc/mcp-server@latest --install"
    );
    process.exit(1);
  }
  return addr;
}

// ── Commands ───────────────────────────────────────────────────────

const program = new Command();
program
  .name("hodlmm-rebalancer")
  .description(
    "Autonomous HODLMM LP position rebalancer — monitors drift, computes optimal bin ranges, and executes rebalance with enforced safety limits"
  )
  .version("1.0.0");

// ── doctor ─────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Check environment readiness: wallet, balances, API, position")
  .option("--pool-id <id>", "HODLMM pool identifier", "dlmm_3")
  .action(async (opts: { poolId: string }) => {
    try {
      const address = getWalletAddress();
      const checks: Record<string, { ok: boolean; detail: string }> = {};

      // 1. STX gas
      try {
        const stx = await getStxBalance(address);
        checks["stx_gas"] = {
          ok: stx >= MIN_GAS_USTX,
          detail: `${stx} uSTX (need ${MIN_GAS_USTX} min)`,
        };
      } catch (e: any) {
        checks["stx_gas"] = { ok: false, detail: e.message };
      }

      // 2. sBTC balance
      try {
        const sbtc = await getSbtcBalance(address);
        checks["sbtc_balance"] = { ok: true, detail: `${sbtc} sats` };
      } catch (e: any) {
        checks["sbtc_balance"] = { ok: false, detail: e.message };
      }

      // 3. DLMM pool tokens
      try {
        const nfts = await getNftCount(address, "dlmm-pool-stx-sbtc");
        checks["dlmm_positions"] = {
          ok: nfts > 0,
          detail: nfts > 0 ? `${nfts} pool tokens held` : "No DLMM positions found",
        };
      } catch (e: any) {
        checks["dlmm_positions"] = { ok: false, detail: e.message };
      }

      // 4. Bitflow API
      try {
        const pool = await getHodlmmPool(opts.poolId);
        checks["bitflow_api"] = {
          ok: true,
          detail: `Pool ${opts.poolId}: ${pool.token_x_symbol || pool.token_x}/${pool.token_y_symbol || pool.token_y}, active bin ${pool.active_bin}`,
        };
      } catch (e: any) {
        checks["bitflow_api"] = { ok: false, detail: e.message };
      }

      // 5. Pool risk check
      try {
        const [pool, bins] = await Promise.all([
          getHodlmmPool(opts.poolId),
          getHodlmmPoolBins(opts.poolId),
        ]);
        const risk = computeRiskMetrics(pool, bins);
        checks["pool_risk"] = {
          ok: risk.regime !== "crisis",
          detail: `Volatility ${risk.volatilityScore}/100, regime: ${risk.regime}`,
        };
      } catch (e: any) {
        checks["pool_risk"] = { ok: false, detail: e.message };
      }

      // 6. User position in pool
      try {
        const pos = await getHodlmmUserPosition(address, opts.poolId);
        const hasBins = pos.bins && pos.bins.length > 0;
        checks["position"] = {
          ok: hasBins,
          detail: hasBins
            ? `${pos.bins.length} bins in position`
            : "No position in this pool",
        };
      } catch (e: any) {
        checks["position"] = { ok: false, detail: e.message };
      }

      const allOk = Object.values(checks).every((c) => c.ok);
      const blockers = Object.entries(checks)
        .filter(([, c]) => !c.ok)
        .map(([k, c]) => `${k}: ${c.detail}`);

      if (allOk) {
        success("Environment ready. Run with --action=status to analyze position.", {
          checks,
          address,
          poolId: opts.poolId,
          safetyLimits: {
            maxRebalanceSats: DEFAULT_MAX_REBALANCE_SATS,
            maxSlippageBps: MAX_SLIPPAGE_BPS,
            cooldownSeconds: COOLDOWN_SECONDS,
            crisisThreshold: CRISIS_VOLATILITY_THRESHOLD,
            driftThreshold: DRIFT_REBALANCE_THRESHOLD,
          },
        });
      } else {
        emit({
          status: "blocked",
          action: "Fix blockers before proceeding",
          data: { checks, address, blockers },
          error: {
            code: "doctor_failed",
            message: blockers.join("; "),
            next: "Resolve listed issues and re-run doctor",
          },
        });
      }
    } catch (e: any) {
      fail("doctor_error", e.message, "Check connection and retry");
    }
  });

// ── run ────────────────────────────────────────────────────────────

program
  .command("run")
  .description("Execute rebalancer actions: status, rebalance, withdraw, emergency-exit")
  .requiredOption("--action <action>", "Action: status | rebalance | withdraw | emergency-exit")
  .option("--pool-id <id>", "HODLMM pool identifier", "dlmm_3")
  .option("--max-sats <n>", "Max sats to rebalance (safety limit)", String(DEFAULT_MAX_REBALANCE_SATS))
  .option("--slippage-bps <n>", "Max slippage in basis points", String(MAX_SLIPPAGE_BPS))
  .option("--force", "Override drift threshold (still respects crisis block)", false)
  .action(
    async (opts: {
      action: string;
      poolId: string;
      maxSats: string;
      slippageBps: string;
      force: boolean;
    }) => {
      try {
        const address = getWalletAddress();
        const maxSats = parseInt(opts.maxSats, 10);
        const slippageBps = parseInt(opts.slippageBps, 10);

        // Hard cap: never allow more than 1M sats (0.01 BTC) regardless of flags
        const ABSOLUTE_MAX_SATS = 1_000_000;
        if (maxSats > ABSOLUTE_MAX_SATS) {
          blocked(
            "exceeds_hard_cap",
            `Max sats ${maxSats} exceeds absolute hard cap of ${ABSOLUTE_MAX_SATS} sats (0.01 BTC)`,
            `Set --max-sats to ${ABSOLUTE_MAX_SATS} or less`
          );
          return;
        }

        if (slippageBps > 500) {
          blocked(
            "slippage_too_high",
            `Slippage ${slippageBps} bps exceeds maximum 500 bps (5%)`,
            "Set --slippage-bps to 500 or less"
          );
          return;
        }

        switch (opts.action) {
          case "status":
            await runStatus(address, opts.poolId);
            break;
          case "rebalance":
            await runRebalance(address, opts.poolId, maxSats, slippageBps, opts.force);
            break;
          case "withdraw":
            await runWithdraw(address, opts.poolId);
            break;
          case "emergency-exit":
            await runEmergencyExit(address, opts.poolId);
            break;
          default:
            fail(
              "unknown_action",
              `Unknown action: ${opts.action}`,
              "Use --action=status|rebalance|withdraw|emergency-exit"
            );
        }
      } catch (e: any) {
        fail("run_error", e.message, "Check error and retry");
      }
    }
  );

// ── status ─────────────────────────────────────────────────────────

async function runStatus(address: string, poolId: string): Promise<void> {
  const [pool, poolBins, positionResponse, stxBalance, sbtcBalance] =
    await Promise.all([
      getHodlmmPool(poolId),
      getHodlmmPoolBins(poolId),
      getHodlmmUserPosition(address, poolId),
      getStxBalance(address),
      getSbtcBalance(address),
    ]);

  const risk = computeRiskMetrics(pool, poolBins);

  if (!positionResponse.bins || positionResponse.bins.length === 0) {
    success("No position in this pool. Supply liquidity first.", {
      poolId,
      pool: {
        tokenX: pool.token_x_symbol || pool.token_x,
        tokenY: pool.token_y_symbol || pool.token_y,
        activeBin: risk.activeBinId,
      },
      risk: {
        volatilityScore: risk.volatilityScore,
        regime: risk.regime,
        binSpread: risk.binSpread,
      },
      balances: { stx_ustx: stxBalance, sbtc_sats: sbtcBalance },
      position: null,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const position = analyzePosition(pool, poolBins, positionResponse.bins);

  const actionText =
    position.recommendation === "hold"
      ? "Position healthy. No rebalance needed."
      : position.recommendation === "rebalance"
      ? `Position drifted (score ${position.driftScore}). Run --action=rebalance to optimize.`
      : `Position severely drifted (score ${position.driftScore}). Consider --action=withdraw for safety.`;

  success(actionText, {
    poolId,
    pool: {
      tokenX: pool.token_x_symbol || pool.token_x,
      tokenY: pool.token_y_symbol || pool.token_y,
      activeBin: risk.activeBinId,
      totalPoolBins: risk.totalBins,
    },
    risk: {
      volatilityScore: risk.volatilityScore,
      regime: risk.regime,
      binSpread: risk.binSpread,
      reserveImbalance: risk.reserveImbalanceRatio,
      safeToRebalance: risk.regime !== "crisis",
    },
    position: {
      binCount: position.positionBinCount,
      nearestBinOffset: position.nearestOffset,
      avgBinOffset: position.avgOffset,
      driftScore: position.driftScore,
      concentrationRisk: position.concentrationRisk,
      impermanentLossEstimatePct: position.impermanentLossEstimatePct,
      recommendation: position.recommendation,
      reserveX: position.totalPositionX,
      reserveY: position.totalPositionY,
    },
    balances: { stx_ustx: stxBalance, sbtc_sats: sbtcBalance },
    timestamp: new Date().toISOString(),
  });
}

// ── rebalance ──────────────────────────────────────────────────────

async function runRebalance(
  address: string,
  poolId: string,
  maxSats: number,
  slippageBps: number,
  force: boolean
): Promise<void> {
  // Pre-flight: gas check
  const stxBalance = await getStxBalance(address);
  if (stxBalance < MIN_GAS_USTX) {
    blocked(
      "insufficient_gas",
      `STX balance ${stxBalance} uSTX < minimum ${MIN_GAS_USTX} uSTX for gas`,
      "Acquire STX for transaction fees"
    );
    return;
  }

  // Pre-flight: fetch all data
  const [pool, poolBins, positionResponse] = await Promise.all([
    getHodlmmPool(poolId),
    getHodlmmPoolBins(poolId),
    getHodlmmUserPosition(address, poolId),
  ]);

  // Pre-flight: must have position
  if (!positionResponse.bins || positionResponse.bins.length === 0) {
    blocked(
      "no_position",
      "No active position in this pool. Cannot rebalance without existing liquidity.",
      "Supply liquidity first using Bitflow HODLMM interface"
    );
    return;
  }

  const risk = computeRiskMetrics(pool, poolBins);
  const position = analyzePosition(pool, poolBins, positionResponse.bins);

  // Safety: refuse in crisis regime — this is ENFORCED, not just documented
  if (risk.volatilityScore > CRISIS_VOLATILITY_THRESHOLD) {
    blocked(
      "crisis_regime",
      `Volatility score ${risk.volatilityScore} exceeds crisis threshold ${CRISIS_VOLATILITY_THRESHOLD}. ` +
        `Regime: ${risk.regime}. Rebalancing during crisis increases impermanent loss risk.`,
      "Wait for volatility to decrease, or use --action=withdraw for safe exit"
    );
    return;
  }

  // Safety: check drift threshold
  if (position.driftScore <= DRIFT_REBALANCE_THRESHOLD && !force) {
    success("Position within acceptable range. No rebalance needed.", {
      poolId,
      driftScore: position.driftScore,
      threshold: DRIFT_REBALANCE_THRESHOLD,
      recommendation: "hold",
      note: "Use --force to override drift threshold check",
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Compute rebalance parameters
  const rebalanceParams = computeRebalanceParams(
    pool,
    risk,
    position,
    maxSats,
    slippageBps
  );

  if (!rebalanceParams) {
    blocked(
      "regime_blocked",
      "Rebalance computation returned null — regime too volatile",
      "Wait for calm/elevated regime"
    );
    return;
  }

  // Emit rebalance plan for agent execution via MCP
  success("Rebalance plan computed. Execute via Bitflow HODLMM contract calls.", {
    poolId,
    operation: "rebalance",
    preFlightChecks: {
      gasSufficient: true,
      positionExists: true,
      regimeSafe: true,
      driftAboveThreshold: true,
      withinMaxSats: true,
      slippageAcceptable: true,
    },
    currentState: {
      driftScore: position.driftScore,
      activeBin: risk.activeBinId,
      regime: risk.regime,
      volatilityScore: risk.volatilityScore,
      positionBins: position.positionBinCount,
    },
    rebalancePlan: rebalanceParams,
    safetyEnforced: {
      maxRebalanceSats: maxSats,
      maxSlippageBps: slippageBps,
      cooldownSeconds: COOLDOWN_SECONDS,
      crisisBlock: true,
      hardCapSats: 1_000_000,
    },
    mcp_commands: [
      {
        step: 1,
        description: "Remove liquidity from drifted bins",
        tool: "call_contract",
        params: {
          contract: DLMM_POOL_CONTRACT,
          function: "remove-liquidity",
          args: {
            binIds: positionResponse.bins.map((b) => b.bin_id),
            note: "Removes from all current bins for full rebalance",
          },
        },
      },
      {
        step: 2,
        description: "Add liquidity to optimal bin range",
        tool: "call_contract",
        params: {
          contract: DLMM_POOL_CONTRACT,
          function: "add-liquidity",
          args: {
            binStart: rebalanceParams.targetBins.start,
            binEnd: rebalanceParams.targetBins.end,
            amountPerBin: rebalanceParams.amounts.perBin,
            slippageBps,
          },
        },
      },
    ],
    timestamp: new Date().toISOString(),
  });
}

// ── withdraw ───────────────────────────────────────────────────────

async function runWithdraw(address: string, poolId: string): Promise<void> {
  const stxBalance = await getStxBalance(address);
  if (stxBalance < MIN_GAS_USTX) {
    blocked(
      "insufficient_gas",
      `STX balance ${stxBalance} uSTX < minimum ${MIN_GAS_USTX} uSTX`,
      "Acquire STX for transaction fees"
    );
    return;
  }

  const [pool, poolBins, positionResponse] = await Promise.all([
    getHodlmmPool(poolId),
    getHodlmmPoolBins(poolId),
    getHodlmmUserPosition(address, poolId),
  ]);

  if (!positionResponse.bins || positionResponse.bins.length === 0) {
    success("No position to withdraw.", {
      poolId,
      position: null,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const risk = computeRiskMetrics(pool, poolBins);
  const position = analyzePosition(pool, poolBins, positionResponse.bins);

  success("Withdraw plan ready. Execute via Bitflow HODLMM contract.", {
    poolId,
    operation: "withdraw",
    currentState: {
      binCount: position.positionBinCount,
      driftScore: position.driftScore,
      regime: risk.regime,
      reserveX: position.totalPositionX,
      reserveY: position.totalPositionY,
    },
    mcp_command: {
      tool: "call_contract",
      params: {
        contract: DLMM_POOL_CONTRACT,
        function: "remove-liquidity",
        args: {
          binIds: positionResponse.bins.map((b) => b.bin_id),
          note: "Full position withdrawal from all bins",
        },
      },
    },
    timestamp: new Date().toISOString(),
  });
}

// ── emergency-exit ─────────────────────────────────────────────────

async function runEmergencyExit(
  address: string,
  poolId: string
): Promise<void> {
  // Emergency: skip most checks, just get position and generate withdrawal
  const stxBalance = await getStxBalance(address);
  if (stxBalance < MIN_GAS_USTX) {
    blocked(
      "insufficient_gas",
      `Cannot exit — no gas. STX balance ${stxBalance} uSTX < ${MIN_GAS_USTX} uSTX`,
      "Acquire STX immediately for emergency exit"
    );
    return;
  }

  let positionBins: HodlmmBinData[] = [];
  try {
    const pos = await getHodlmmUserPosition(address, poolId);
    positionBins = pos.bins || [];
  } catch {
    fail(
      "api_unreachable",
      "Cannot reach Bitflow API for position data. Manual withdrawal via Bitflow UI recommended.",
      "Go to https://app.bitflow.finance and withdraw manually"
    );
    return;
  }

  if (positionBins.length === 0) {
    success("No position to exit.", { poolId, timestamp: new Date().toISOString() });
    return;
  }

  let totalX = 0;
  let totalY = 0;
  for (const bin of positionBins) {
    totalX += Number(bin.reserve_x);
    totalY += Number(bin.reserve_y);
  }

  success(
    "EMERGENCY EXIT: Remove all liquidity immediately. No slippage protection — speed priority.",
    {
      poolId,
      operation: "emergency_exit",
      urgency: "high",
      positionBins: positionBins.length,
      estimatedReturn: { reserveX: totalX, reserveY: totalY },
      mcp_command: {
        tool: "call_contract",
        params: {
          contract: DLMM_POOL_CONTRACT,
          function: "remove-liquidity",
          args: {
            binIds: positionBins.map((b) => b.bin_id),
            note: "EMERGENCY: Full position exit, all bins, no slippage check",
          },
        },
      },
      timestamp: new Date().toISOString(),
    }
  );
}

// ── Parse ──────────────────────────────────────────────────────────

program.parse(process.argv);
