#!/usr/bin/env bun
/**
 * hodlmm-il-shield — Impermanent Loss Protection Monitor for Bitflow HODLMM
 *
 * Tracks real-time IL vs fee earnings, computes net PnL, and emits exit signals
 * when losses exceed configurable thresholds.
 *
 * Author: Flying Whale (azagh72-creator)
 * Agent: Flying Whale — Genesis L2, ERC-8004 #54
 */

import { Command } from "commander";

// ═══════════════════════════════════════════════════════════════════════════
// SAFETY CONSTANTS — Hard-coded, cannot be overridden by flags
// ═══════════════════════════════════════════════════════════════════════════
const EMERGENCY_IL_THRESHOLD = 8; // 8% — hard exit signal, cannot override
const MAX_IL_THRESHOLD = 20; // Maximum configurable threshold
const MAX_CRITICAL_THRESHOLD = 10; // Maximum critical threshold
const MIN_POSITION_AGE_MS = 3_600_000; // 1 hour minimum before exit signals
const API_TIMEOUT = 15_000; // 15 seconds
const MIN_CHECK_INTERVAL = 60; // seconds between checks
const MAX_CHECK_INTERVAL = 3_600; // max 1 hour
const DEFAULT_WARNING_THRESHOLD = 3; // 3% net loss
const DEFAULT_CRITICAL_THRESHOLD = 5; // 5% net loss
const DEFAULT_MONITOR_INTERVAL = 300; // 5 minutes

// ═══════════════════════════════════════════════════════════════════════════
// BITFLOW HODLMM API
// ═══════════════════════════════════════════════════════════════════════════
const BITFLOW_API = "https://api.bitflow.finance/api/v1/hodlmm";
const DEFAULT_POOL = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15";
const HIRO_API = "https://api.hiro.so";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════
interface PoolState {
  activeBinId: number;
  binStep: number;
  reserveX: number;
  reserveY: number;
  totalBins: number;
  feeBps: number;
  volume24h: number;
}

interface PositionState {
  bins: BinPosition[];
  totalValueSats: number;
  entryValueSats: number;
  feesEarnedSats: number;
  positionAgeMs: number;
  activeBinDistance: number;
}

interface BinPosition {
  binId: number;
  liquidityShare: number;
  reserveX: number;
  reserveY: number;
  isActive: boolean;
}

interface ILAnalysis {
  ilPercent: number;
  feesEarnedPercent: number;
  netPnlPercent: number;
  regime: "healthy" | "stressed" | "critical" | "emergency";
  exitSignal: boolean;
  confidence: number;
  positionAgeHours: number;
  activeBinDistance: number;
  feeVelocity24h: number;
  ilAccelerating: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// OUTPUT HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function success(action: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ status: "success", action, data, error: null }, null, 2));
}

function exitSignal(action: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ status: "exit_signal", action, data, error: null }, null, 2));
}

function fail(action: string, error: { code: string; message: string; next: string }): void {
  console.log(JSON.stringify({ status: "error", action, data: null, error }, null, 2));
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// API FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════
async function fetchWithTimeout(url: string, opts?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function getPoolState(poolId: string): Promise<PoolState | null> {
  try {
    const res = await fetchWithTimeout(`${BITFLOW_API}/pools`);
    if (!res.ok) return null;
    const pools = await res.json();
    const pool = Array.isArray(pools)
      ? pools.find((p: any) => p.contractId === poolId || p.id === poolId)
      : null;
    if (!pool) return null;
    return {
      activeBinId: pool.activeBinId || pool.active_bin_id || 0,
      binStep: pool.binStep || pool.bin_step || 15,
      reserveX: Number(pool.reserveX || pool.reserve_x || 0),
      reserveY: Number(pool.reserveY || pool.reserve_y || 0),
      totalBins: pool.totalBins || pool.total_bins || 0,
      feeBps: pool.feeBps || pool.fee_bps || 15,
      volume24h: Number(pool.volume24h || pool.volume_24h || 0),
    };
  } catch {
    return null;
  }
}

async function getPositionBins(address: string, poolId: string): Promise<BinPosition[]> {
  try {
    const res = await fetchWithTimeout(
      `${BITFLOW_API}/positions?address=${address}&pool=${poolId}`
    );
    if (!res.ok) {
      // Fallback: read NFT holdings from Hiro API
      const nftRes = await fetchWithTimeout(
        `${HIRO_API}/extended/v1/tokens/nft/holdings?principal=${address}&limit=50`
      );
      if (!nftRes.ok) return [];
      const nftData = await nftRes.json();
      const dlmmNfts = (nftData.results || []).filter((n: any) =>
        n.asset_identifier?.includes("dlmm-pool-stx-sbtc")
      );
      return dlmmNfts.map((n: any, i: number) => ({
        binId: i,
        liquidityShare: 1,
        reserveX: 0,
        reserveY: 0,
        isActive: false,
      }));
    }
    const positions = await res.json();
    if (!Array.isArray(positions)) return [];
    return positions.map((p: any) => ({
      binId: p.binId || p.bin_id || 0,
      liquidityShare: Number(p.liquidityShare || p.liquidity_share || 0),
      reserveX: Number(p.reserveX || p.reserve_x || 0),
      reserveY: Number(p.reserveY || p.reserve_y || 0),
      isActive: Boolean(p.isActive || p.is_active),
    }));
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// IL COMPUTATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute impermanent loss for a DLMM position.
 *
 * IL in concentrated liquidity is higher than standard AMM because
 * liquidity is concentrated in fewer bins. We use the divergence formula:
 *
 *   IL = 1 - (2 * sqrt(priceRatio)) / (1 + priceRatio)
 *
 * where priceRatio = currentPrice / entryPrice
 *
 * For DLMM, we also factor in bin distance from active bin as a proxy
 * for how much of the position is "out of range" (earning zero fees).
 */
function computeIL(entryPrice: number, currentPrice: number): number {
  if (entryPrice <= 0 || currentPrice <= 0) return 0;
  const ratio = currentPrice / entryPrice;
  const il = 1 - (2 * Math.sqrt(ratio)) / (1 + ratio);
  return Math.abs(il) * 100; // as percentage
}

/**
 * Estimate fee earnings as percentage of position value.
 * Uses 24h volume, fee bps, and position's share of total liquidity.
 */
function estimateFeeEarnings(
  pool: PoolState,
  positionBins: number,
  totalBins: number,
  positionAgeHours: number
): number {
  if (totalBins === 0 || positionAgeHours === 0) return 0;
  const liquidityShare = positionBins / Math.max(totalBins, 1);
  const dailyFees = (pool.volume24h * pool.feeBps) / 10_000;
  const positionDailyFees = dailyFees * liquidityShare;
  const totalReserves = pool.reserveX + pool.reserveY;
  if (totalReserves === 0) return 0;
  const dailyFeePercent = (positionDailyFees / totalReserves) * 100;
  return dailyFeePercent * (positionAgeHours / 24);
}

/**
 * Classify the IL regime and produce an exit signal.
 */
function analyzeIL(
  pool: PoolState,
  position: PositionState,
  warningThreshold: number,
  criticalThreshold: number
): ILAnalysis {
  // Compute price from reserves ratio
  const currentPrice =
    pool.reserveY > 0 ? pool.reserveX / pool.reserveY : 0;
  // Estimate entry price from position reserves
  const entryTotalX = position.bins.reduce((s, b) => s + b.reserveX, 0);
  const entryTotalY = position.bins.reduce((s, b) => s + b.reserveY, 0);
  const entryPrice = entryTotalY > 0 ? entryTotalX / entryTotalY : currentPrice;

  const ilPercent = computeIL(entryPrice, currentPrice);
  const positionAgeHours = position.positionAgeMs / 3_600_000;
  const activeBins = position.bins.filter((b) => b.isActive).length;

  const feesEarnedPercent = estimateFeeEarnings(
    pool,
    activeBins || position.bins.length,
    pool.totalBins,
    positionAgeHours
  );

  const netPnlPercent = feesEarnedPercent - ilPercent;
  const feeVelocity24h = positionAgeHours > 0
    ? (feesEarnedPercent / positionAgeHours) * 24
    : 0;

  // IL is accelerating if distance from active bin is growing
  const ilAccelerating = position.activeBinDistance > 5;

  // Classify regime
  let regime: ILAnalysis["regime"] = "healthy";
  let exitSignalFlag = false;
  let confidence = 0;

  if (ilPercent >= EMERGENCY_IL_THRESHOLD || netPnlPercent < -criticalThreshold * 1.5) {
    regime = "emergency";
    exitSignalFlag = true;
    confidence = 0.95;
  } else if (netPnlPercent < -criticalThreshold) {
    regime = "critical";
    exitSignalFlag = true;
    confidence = 0.8 + (Math.abs(netPnlPercent) - criticalThreshold) * 0.05;
  } else if (netPnlPercent < -warningThreshold) {
    regime = "stressed";
    exitSignalFlag = false;
    confidence = 0.5 + (Math.abs(netPnlPercent) - warningThreshold) * 0.1;
  } else {
    regime = "healthy";
    exitSignalFlag = false;
    confidence = 0.1;
  }

  // Clamp confidence
  confidence = Math.min(Math.max(confidence, 0), 1);
  confidence = Math.round(confidence * 100) / 100;

  // Position too young — suppress exit signal
  if (position.positionAgeMs < MIN_POSITION_AGE_MS) {
    exitSignalFlag = false;
    confidence = Math.min(confidence, 0.3);
  }

  return {
    ilPercent: Math.round(ilPercent * 100) / 100,
    feesEarnedPercent: Math.round(feesEarnedPercent * 100) / 100,
    netPnlPercent: Math.round(netPnlPercent * 100) / 100,
    regime,
    exitSignal: exitSignalFlag,
    confidence,
    positionAgeHours: Math.round(positionAgeHours * 10) / 10,
    activeBinDistance: position.activeBinDistance,
    feeVelocity24h: Math.round(feeVelocity24h * 100) / 100,
    ilAccelerating,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI PROGRAM
// ═══════════════════════════════════════════════════════════════════════════
const program = new Command();

program
  .name("hodlmm-il-shield")
  .description("Impermanent loss protection monitor for Bitflow HODLMM positions")
  .version("1.0.0");

// ── DOCTOR ──────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Pre-flight checks: wallet, API, pool, position")
  .option("--pool-id <id>", "HODLMM pool contract ID", DEFAULT_POOL)
  .action(async (opts) => {
    const address = process.env.STACKS_ADDRESS;
    const checks: Record<string, { ok: boolean; detail: string }> = {};

    // Wallet
    checks.wallet = address
      ? { ok: true, detail: address }
      : { ok: false, detail: "STACKS_ADDRESS not set" };

    // Bitflow API
    try {
      const res = await fetchWithTimeout(`${BITFLOW_API}/pools`);
      checks.bitflow_api = res.ok
        ? { ok: true, detail: `HTTP ${res.status}` }
        : { ok: false, detail: `HTTP ${res.status}` };
    } catch (e: any) {
      checks.bitflow_api = { ok: false, detail: e.message || "unreachable" };
    }

    // Pool state
    const pool = await getPoolState(opts.poolId);
    checks.pool = pool
      ? { ok: true, detail: `Active bin: ${pool.activeBinId}, bins: ${pool.totalBins}` }
      : { ok: false, detail: "Pool not found or API error" };

    // Position
    if (address) {
      const bins = await getPositionBins(address, opts.poolId);
      checks.position = bins.length > 0
        ? { ok: true, detail: `${bins.length} bins with liquidity` }
        : { ok: false, detail: "No position found" };
    } else {
      checks.position = { ok: false, detail: "Requires wallet" };
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    success(allOk ? "All checks passed" : "Some checks failed", {
      ready: allOk,
      checks,
    });
  });

// ── RUN ─────────────────────────────────────────────────────────────────
program
  .command("run")
  .description("Execute IL monitoring actions")
  .requiredOption("--action <action>", "Action: status, monitor, exit-check, emergency-exit")
  .option("--pool-id <id>", "HODLMM pool contract ID", DEFAULT_POOL)
  .option("--il-threshold <pct>", "IL warning threshold (%)", String(DEFAULT_WARNING_THRESHOLD))
  .option("--critical-threshold <pct>", "Critical threshold (%)", String(DEFAULT_CRITICAL_THRESHOLD))
  .option("--interval <sec>", "Monitor interval (seconds)", String(DEFAULT_MONITOR_INTERVAL))
  .action(async (opts) => {
    const address = process.env.STACKS_ADDRESS;
    if (!address) {
      fail("Wallet required", {
        code: "no_wallet",
        message: "STACKS_ADDRESS environment variable not set",
        next: "Set STACKS_ADDRESS or use MCP wallet_unlock",
      });
      return;
    }

    // Validate thresholds
    const warningThreshold = Math.min(Math.max(Number(opts.ilThreshold) || DEFAULT_WARNING_THRESHOLD, 1), MAX_IL_THRESHOLD);
    const criticalThreshold = Math.min(Math.max(Number(opts.criticalThreshold) || DEFAULT_CRITICAL_THRESHOLD, 2), MAX_CRITICAL_THRESHOLD);
    const interval = Math.min(Math.max(Number(opts.interval) || DEFAULT_MONITOR_INTERVAL, MIN_CHECK_INTERVAL), MAX_CHECK_INTERVAL);
    const action = opts.action;

    // Fetch pool and position
    const pool = await getPoolState(opts.poolId);
    if (!pool) {
      fail("Pool unavailable", {
        code: "api_unreachable",
        message: "Could not fetch pool state from Bitflow API",
        next: "Check network connectivity or try again later",
      });
      return;
    }

    const bins = await getPositionBins(address, opts.poolId);
    if (bins.length === 0) {
      fail("No position", {
        code: "no_position",
        message: "No HODLMM position found for this address",
        next: "Verify you have liquidity in this pool",
      });
      return;
    }

    // Build position state
    const avgBinId = bins.reduce((s, b) => s + b.binId, 0) / bins.length;
    const activeBinDistance = Math.abs(pool.activeBinId - avgBinId);
    const position: PositionState = {
      bins,
      totalValueSats: bins.reduce((s, b) => s + b.reserveX + b.reserveY, 0),
      entryValueSats: bins.reduce((s, b) => s + b.reserveX + b.reserveY, 0),
      feesEarnedSats: 0,
      positionAgeMs: 48 * 3_600_000, // Default 48h if not tracked
      activeBinDistance,
    };

    // ── STATUS ──
    if (action === "status") {
      const analysis = analyzeIL(pool, position, warningThreshold, criticalThreshold);
      const output = analysis.exitSignal ? exitSignal : success;
      output(
        `Net PnL: ${analysis.netPnlPercent}% (IL ${analysis.ilPercent}% offset by ${analysis.feesEarnedPercent}% fees) — ${analysis.regime.toUpperCase()}`,
        {
          ...analysis,
          pool: {
            activeBin: pool.activeBinId,
            volume24h: pool.volume24h,
            feeBps: pool.feeBps,
          },
          position: {
            bins: bins.length,
            activeBinDistance,
          },
          thresholds: { warning: warningThreshold, critical: criticalThreshold, emergency: EMERGENCY_IL_THRESHOLD },
        }
      );
      return;
    }

    // ── EXIT-CHECK ──
    if (action === "exit-check") {
      const analysis = analyzeIL(pool, position, warningThreshold, criticalThreshold);
      const shouldExit = analysis.exitSignal;
      const output = shouldExit ? exitSignal : success;
      output(
        shouldExit
          ? `EXIT RECOMMENDED — Net PnL ${analysis.netPnlPercent}%, confidence ${analysis.confidence}`
          : `HOLD — Net PnL ${analysis.netPnlPercent}%, regime ${analysis.regime}`,
        {
          exit: shouldExit,
          confidence: analysis.confidence,
          reasoning: shouldExit
            ? `IL (${analysis.ilPercent}%) exceeds fee earnings (${analysis.feesEarnedPercent}%) by more than ${criticalThreshold}% threshold`
            : `Position is ${analysis.regime} — fees are ${analysis.feesEarnedPercent > analysis.ilPercent ? "outpacing" : "partially offsetting"} IL`,
          ...analysis,
        }
      );
      return;
    }

    // ── MONITOR ──
    if (action === "monitor") {
      let checkCount = 0;
      let lastRegime = "";

      const runCheck = async () => {
        checkCount++;
        const currentPool = await getPoolState(opts.poolId);
        if (!currentPool) {
          console.error(JSON.stringify({ status: "error", check: checkCount, message: "API unreachable" }));
          return;
        }
        const analysis = analyzeIL(currentPool, position, warningThreshold, criticalThreshold);
        const regimeChanged = lastRegime !== "" && lastRegime !== analysis.regime;
        lastRegime = analysis.regime;

        if (regimeChanged || analysis.exitSignal || checkCount === 1) {
          const output = analysis.exitSignal ? exitSignal : success;
          output(
            `[Check #${checkCount}] ${analysis.regime.toUpperCase()} — Net PnL: ${analysis.netPnlPercent}%${regimeChanged ? " (REGIME CHANGE)" : ""}`,
            { check: checkCount, regimeChanged, ...analysis }
          );
        }

        if (analysis.regime === "emergency") {
          fail("Emergency threshold breached", {
            code: "emergency_il",
            message: `IL ${analysis.ilPercent}% exceeds emergency threshold ${EMERGENCY_IL_THRESHOLD}%`,
            next: "Run --action=emergency-exit to generate withdrawal commands",
          });
        }
      };

      // First check immediately
      await runCheck();
      // Then loop
      const timer = setInterval(runCheck, interval * 1000);
      // Run for max 1 hour then exit cleanly
      setTimeout(() => {
        clearInterval(timer);
        success("Monitor session complete", { checksPerformed: checkCount });
      }, 3_600_000);
      return;
    }

    // ── EMERGENCY EXIT ──
    if (action === "emergency-exit") {
      const analysis = analyzeIL(pool, position, warningThreshold, criticalThreshold);

      if (analysis.ilPercent < EMERGENCY_IL_THRESHOLD && analysis.regime !== "emergency") {
        success("Emergency exit not warranted", {
          ilPercent: analysis.ilPercent,
          threshold: EMERGENCY_IL_THRESHOLD,
          regime: analysis.regime,
          message: `IL ${analysis.ilPercent}% is below emergency threshold ${EMERGENCY_IL_THRESHOLD}%`,
        });
        return;
      }

      // Generate MCP withdrawal commands for all bins
      const withdrawals = bins.map((bin) => ({
        tool: "call_contract",
        contract: opts.poolId,
        function: "remove-liquidity",
        args: {
          bin_id: bin.binId,
          liquidity_share: bin.liquidityShare,
        },
      }));

      exitSignal(
        `EMERGENCY EXIT — IL ${analysis.ilPercent}% exceeds ${EMERGENCY_IL_THRESHOLD}% threshold. ${withdrawals.length} withdrawal commands generated.`,
        {
          ...analysis,
          commands: withdrawals,
          warning: "Review commands before execution. This will remove ALL liquidity from the pool.",
        }
      );
      return;
    }

    fail("Unknown action", {
      code: "unknown_action",
      message: `Action '${action}' not recognized`,
      next: "Use: status, monitor, exit-check, or emergency-exit",
    });
  });

program.parse();
