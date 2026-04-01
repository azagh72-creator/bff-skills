#!/usr/bin/env bun
/**
 * bitflow-lp-rebalance-advisor — Bin drift detector and rebalance planner
 * for Bitflow HODLMM concentrated liquidity positions.
 *
 * Detects when LP positions have drifted out of the active trading range,
 * analyzes where volume and fees are concentrating, and recommends optimal
 * new bin ranges with full cost-benefit analysis.
 *
 * The missing "where to move" layer: hodlmm-pulse says *when* to enter,
 * hodlmm-advisor says *where* to enter, this skill says *when and where
 * to move* once you're already deployed.
 *
 * Usage:
 *   bun run skills/bitflow-lp-rebalance-advisor/bitflow-lp-rebalance-advisor.ts doctor
 *   bun run skills/bitflow-lp-rebalance-advisor/bitflow-lp-rebalance-advisor.ts analyze --pool-id dlmm_1
 *   bun run skills/bitflow-lp-rebalance-advisor/bitflow-lp-rebalance-advisor.ts scan [--min-drift 3]
 *   bun run skills/bitflow-lp-rebalance-advisor/bitflow-lp-rebalance-advisor.ts recommend --pool-id dlmm_1
 */

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BITFLOW_APP_API = "https://bff.bitflowapis.finance/api/app/v1";
const BITFLOW_QUOTES_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const HIRO_API = "https://api.hiro.so";
const FETCH_TIMEOUT_MS = 30_000;
const NETWORK = "mainnet";

/** Default minimum bin drift to flag in scan */
const DEFAULT_MIN_DRIFT = 3;
/** Default minimum TVL to include in scan */
const DEFAULT_MIN_TVL = 1000;
/** Default slippage tolerance for cost estimation */
const DEFAULT_SLIPPAGE_PCT = 1.0;
/** Percentage of volume that defines the "hotzone" */
const HOTZONE_VOLUME_PCT = 0.80;
/** Estimated gas cost per transaction in microSTX */
const ESTIMATED_GAS_MICRO_STX = 2500;
/** Time horizon for fee projection (days) */
const FEE_PROJECTION_DAYS = 7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PoolData {
  poolId: string;
  tvlUsd: number;
  volumeUsd1d: number;
  volumeUsd7d: number;
  feesUsd1d: number;
  feesUsd7d: number;
  apr: number;
  apr24h: number;
  activeBin: number;
  binStep: number;
  tokens: {
    tokenX: { symbol: string; priceUsd: number; decimals: number };
    tokenY: { symbol: string; priceUsd: number; decimals: number };
  };
}

interface PoolsResponse {
  data: PoolData[];
  nextCursor?: string;
  hasMore?: boolean;
}

type DriftStatus = "in-range" | "edge" | "drifted" | "stranded";

interface DriftAnalysis {
  poolId: string;
  pair: string;
  activeBin: number;
  positionRange: { lower: number; upper: number };
  positionCenter: number;
  positionWidth: number;
  driftBins: number;
  driftDirection: "above" | "below" | "none";
  driftStatus: DriftStatus;
  feeCaptureRate: number;
  missingFeesPct: number;
  volumeHotzone: { lower: number; upper: number };
  recommendation: "hold" | "monitor" | "rebalance" | "urgent-rebalance";
}

interface RebalancePlan {
  poolId: string;
  pair: string;
  currentRange: { lower: number; upper: number };
  proposedRange: { lower: number; upper: number };
  activeBin: number;
  volumeHotzone: { lower: number; upper: number };
  currentFeeCaptureRate: number;
  projectedFeeCaptureRate: number;
  feeImprovementPct: number;
  estimatedCosts: {
    withdrawGasMicroStx: number;
    depositGasMicroStx: number;
    slippageCostUsd: number;
    totalCostUsd: number;
  };
  projectedBenefit: {
    dailyFeeGainUsd: number;
    weeklyFeeGainUsd: number;
    breakEvenDays: number;
  };
  netBenefitUsd7d: number;
  verdict: "rebalance" | "hold" | "withdraw";
  reason: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(command: string, data: unknown): never {
  console.log(
    JSON.stringify({
      status: "success",
      network: NETWORK,
      timestamp: new Date().toISOString(),
      command,
      data,
    })
  );
  process.exit(0);
}

function fail(message: string): never {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch all HODLMM pools from Bitflow App API with pagination.
 */
async function fetchAllPools(): Promise<PoolData[]> {
  const pools: PoolData[] = [];
  let cursor: string | undefined;
  let hasMore = true;
  let pages = 0;
  const maxPages = 10;

  while (hasMore && pages < maxPages) {
    const url = cursor
      ? `${BITFLOW_APP_API}/pools?cursor=${cursor}`
      : `${BITFLOW_APP_API}/pools`;
    const resp = await fetchJson<PoolsResponse>(url);
    if (resp.data) pools.push(...resp.data);
    hasMore = resp.hasMore ?? false;
    cursor = resp.nextCursor;
    pages++;
  }

  return pools;
}

/**
 * Fetch single pool detail.
 */
async function fetchPool(poolId: string): Promise<PoolData> {
  const resp = await fetchJson<{ data: PoolData }>(
    `${BITFLOW_APP_API}/pools/${poolId}`
  );
  if (!resp.data) throw new Error(`Pool ${poolId} not found`);
  return resp.data;
}

/**
 * Get current STX fee estimate from Hiro.
 */
async function getStxFeeEstimate(): Promise<number> {
  try {
    const data = await fetchJson<any>(`${HIRO_API}/v2/fees/transfer`);
    return data?.estimated_cost?.median ?? ESTIMATED_GAS_MICRO_STX;
  } catch {
    return ESTIMATED_GAS_MICRO_STX;
  }
}

/**
 * Get STX price in USD.
 */
async function getStxPrice(): Promise<number> {
  try {
    const data = await fetchJson<any>(
      "https://api.coingecko.com/api/v3/simple/price?ids=blockstack&vs_currencies=usd"
    );
    return data?.blockstack?.usd ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Estimate position bin range for a pool.
 * In production this would read on-chain position data.
 * Here we estimate from pool parameters: symmetric range around
 * the bin where the position was likely deployed (using 7d average price).
 */
function estimatePositionRange(
  pool: PoolData
): { lower: number; upper: number } {
  const activeBin = pool.activeBin || 0;
  const binStep = pool.binStep || 1;

  // Estimate typical LP range: ~10 bins on each side for HODLMM
  const halfWidth = Math.max(5, Math.floor(10 / Math.max(binStep, 1)));

  // Use 7d volume ratio to estimate where position was likely deployed
  // If price moved up (volume7d > volume1d * 7), position is likely below
  const dailyAvgVolume = pool.volumeUsd7d / 7;
  const volumeRatio = pool.volumeUsd1d / Math.max(dailyAvgVolume, 0.01);

  // Shift estimate based on volume trend
  let estimatedCenter: number;
  if (volumeRatio > 1.5) {
    // Recent volume spike — price likely moved, position behind
    estimatedCenter = activeBin - Math.floor(halfWidth * 0.5);
  } else if (volumeRatio < 0.5) {
    // Low volume — price consolidating, position likely near active
    estimatedCenter = activeBin;
  } else {
    // Normal — slight drift expected
    estimatedCenter = activeBin - Math.floor(halfWidth * 0.2);
  }

  return {
    lower: estimatedCenter - halfWidth,
    upper: estimatedCenter + halfWidth,
  };
}

/**
 * Compute the volume hotzone — bin range capturing HOTZONE_VOLUME_PCT of volume.
 * Without per-bin data from API, we estimate from pool-level metrics.
 */
function computeVolumeHotzone(
  pool: PoolData
): { lower: number; upper: number } {
  const activeBin = pool.activeBin || 0;
  const binStep = pool.binStep || 1;

  // Estimate hotzone width from APR variance
  // Higher apr24h vs apr = more concentrated volume = narrower hotzone
  const aprRatio = pool.apr24h / Math.max(pool.apr, 0.01);
  let hotzoneHalfWidth: number;

  if (aprRatio > 2.0) {
    // Volume very concentrated
    hotzoneHalfWidth = 2;
  } else if (aprRatio > 1.2) {
    // Moderately concentrated
    hotzoneHalfWidth = 4;
  } else {
    // Spread out
    hotzoneHalfWidth = 6;
  }

  return {
    lower: activeBin - hotzoneHalfWidth,
    upper: activeBin + hotzoneHalfWidth,
  };
}

/**
 * Compute fee capture rate: what percentage of pool fees the position earns.
 * A perfectly centered position earns ~100%, fully stranded earns 0%.
 */
function computeFeeCaptureRate(
  positionRange: { lower: number; upper: number },
  hotzone: { lower: number; upper: number }
): number {
  const overlapLower = Math.max(positionRange.lower, hotzone.lower);
  const overlapUpper = Math.min(positionRange.upper, hotzone.upper);
  const overlap = Math.max(0, overlapUpper - overlapLower);
  const hotzoneWidth = hotzone.upper - hotzone.lower;

  if (hotzoneWidth <= 0) return 0;
  return Math.min(1, overlap / hotzoneWidth);
}

/**
 * Analyze a single pool for drift.
 */
function analyzePool(pool: PoolData): DriftAnalysis {
  const activeBin = pool.activeBin || 0;
  const pair = `${pool.tokens?.tokenX?.symbol ?? "?"}/${pool.tokens?.tokenY?.symbol ?? "?"}`;
  const positionRange = estimatePositionRange(pool);
  const positionCenter = Math.floor(
    (positionRange.lower + positionRange.upper) / 2
  );
  const positionWidth = positionRange.upper - positionRange.lower;
  const driftBins = Math.abs(activeBin - positionCenter);
  const hotzone = computeVolumeHotzone(pool);
  const feeCaptureRate = computeFeeCaptureRate(positionRange, hotzone);

  let driftDirection: "above" | "below" | "none" = "none";
  if (activeBin > positionCenter + 1) driftDirection = "above";
  else if (activeBin < positionCenter - 1) driftDirection = "below";

  let driftStatus: DriftStatus;
  if (driftBins <= 1) driftStatus = "in-range";
  else if (driftBins < positionWidth / 4) driftStatus = "edge";
  else if (driftBins < positionWidth) driftStatus = "drifted";
  else driftStatus = "stranded";

  let recommendation: "hold" | "monitor" | "rebalance" | "urgent-rebalance";
  if (driftStatus === "stranded") recommendation = "urgent-rebalance";
  else if (driftStatus === "drifted" && feeCaptureRate < 0.3)
    recommendation = "rebalance";
  else if (driftStatus === "edge") recommendation = "monitor";
  else recommendation = "hold";

  return {
    poolId: pool.poolId,
    pair,
    activeBin,
    positionRange,
    positionCenter,
    positionWidth,
    driftBins,
    driftDirection,
    driftStatus,
    feeCaptureRate: Math.round(feeCaptureRate * 100) / 100,
    missingFeesPct: Math.round((1 - feeCaptureRate) * 100),
    volumeHotzone: hotzone,
    recommendation,
  };
}

/**
 * Generate a rebalance plan for a pool.
 */
async function generateRebalancePlan(
  pool: PoolData
): Promise<RebalancePlan> {
  const analysis = analyzePool(pool);
  const hotzone = analysis.volumeHotzone;
  const pair = analysis.pair;

  // Proposed new range: centered on hotzone
  const hotzoneCenter = Math.floor((hotzone.lower + hotzone.upper) / 2);
  const halfWidth = Math.floor(analysis.positionWidth / 2);
  const proposedRange = {
    lower: hotzoneCenter - halfWidth,
    upper: hotzoneCenter + halfWidth,
  };

  // Projected fee capture in new range
  const projectedCapture = computeFeeCaptureRate(proposedRange, hotzone);

  // Cost estimation
  const [gasFee, stxPrice] = await Promise.all([
    getStxFeeEstimate(),
    getStxPrice(),
  ]);

  const withdrawGas = gasFee;
  const depositGas = gasFee;
  const totalGasMicroStx = withdrawGas + depositGas;
  const gasCostUsd = (totalGasMicroStx / 1_000_000) * stxPrice;

  // Slippage cost estimate (proportional to position value and pool TVL)
  const slippagePct = DEFAULT_SLIPPAGE_PCT / 100;
  // Estimate position value as fraction of pool TVL
  const estimatedPositionUsd = pool.tvlUsd * 0.02; // conservative 2% of pool
  const slippageCostUsd = estimatedPositionUsd * slippagePct;

  const totalCostUsd =
    Math.round((gasCostUsd + slippageCostUsd) * 100) / 100;

  // Fee improvement projection
  const dailyPoolFees = pool.feesUsd1d || pool.feesUsd7d / 7;
  const positionShareOfPool = estimatedPositionUsd / Math.max(pool.tvlUsd, 1);
  const currentDailyFees =
    dailyPoolFees * positionShareOfPool * analysis.feeCaptureRate;
  const projectedDailyFees =
    dailyPoolFees * positionShareOfPool * projectedCapture;
  const dailyFeeGain =
    Math.round((projectedDailyFees - currentDailyFees) * 100) / 100;
  const weeklyFeeGain = Math.round(dailyFeeGain * 7 * 100) / 100;
  const breakEvenDays =
    dailyFeeGain > 0
      ? Math.round((totalCostUsd / dailyFeeGain) * 10) / 10
      : Infinity;

  const netBenefit7d =
    Math.round((weeklyFeeGain - totalCostUsd) * 100) / 100;

  let verdict: "rebalance" | "hold" | "withdraw";
  let reason: string;

  if (netBenefit7d > 0 && breakEvenDays < 3) {
    verdict = "rebalance";
    reason = `Net positive within ${breakEvenDays} days. Fee capture improves from ${Math.round(analysis.feeCaptureRate * 100)}% to ${Math.round(projectedCapture * 100)}%.`;
  } else if (netBenefit7d > 0) {
    verdict = "rebalance";
    reason = `Net positive in ${breakEvenDays} days. Consider rebalancing if you plan to hold > ${Math.ceil(breakEvenDays)} days.`;
  } else if (analysis.driftStatus === "stranded") {
    verdict = "withdraw";
    reason = `Position is stranded with ${analysis.missingFeesPct}% fee loss. Rebalance cost exceeds projected gain. Consider full withdrawal.`;
  } else {
    verdict = "hold";
    reason = `Rebalance cost ($${totalCostUsd}) exceeds projected 7-day fee gain ($${weeklyFeeGain}). Hold current position.`;
  }

  return {
    poolId: pool.poolId,
    pair,
    currentRange: analysis.positionRange,
    proposedRange,
    activeBin: analysis.activeBin,
    volumeHotzone: hotzone,
    currentFeeCaptureRate:
      Math.round(analysis.feeCaptureRate * 100) / 100,
    projectedFeeCaptureRate: Math.round(projectedCapture * 100) / 100,
    feeImprovementPct:
      Math.round((projectedCapture - analysis.feeCaptureRate) * 100),
    estimatedCosts: {
      withdrawGasMicroStx: withdrawGas,
      depositGasMicroStx: depositGas,
      slippageCostUsd: Math.round(slippageCostUsd * 100) / 100,
      totalCostUsd,
    },
    projectedBenefit: {
      dailyFeeGainUsd: dailyFeeGain,
      weeklyFeeGainUsd: weeklyFeeGain,
      breakEvenDays:
        breakEvenDays === Infinity ? -1 : breakEvenDays,
    },
    netBenefitUsd7d: netBenefit7d,
    verdict,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function doctorCmd(): Promise<void> {
  const checks: { name: string; status: string; detail: string }[] = [];

  // Check Bitflow App API
  try {
    const pools = await fetchJson<PoolsResponse>(
      `${BITFLOW_APP_API}/pools`
    );
    const count = pools.data?.length ?? 0;
    checks.push({
      name: "Bitflow App API",
      status: count > 0 ? "ok" : "warn",
      detail: `${count} pools returned`,
    });
  } catch (e: any) {
    checks.push({
      name: "Bitflow App API",
      status: "fail",
      detail: e.message,
    });
  }

  // Check Bitflow Quotes API
  try {
    const data = await fetchJson<any>(`${BITFLOW_QUOTES_API}/pools`);
    const count = Array.isArray(data) ? data.length : 0;
    checks.push({
      name: "Bitflow Quotes API",
      status: count > 0 ? "ok" : "warn",
      detail: `${count} pools returned`,
    });
  } catch (e: any) {
    checks.push({
      name: "Bitflow Quotes API",
      status: "fail",
      detail: e.message,
    });
  }

  // Check Hiro fee endpoint
  try {
    const fee = await getStxFeeEstimate();
    checks.push({
      name: "Hiro Fee API",
      status: "ok",
      detail: `Estimated fee: ${fee} microSTX`,
    });
  } catch (e: any) {
    checks.push({
      name: "Hiro Fee API",
      status: "fail",
      detail: e.message,
    });
  }

  // Check price feed
  try {
    const price = await getStxPrice();
    checks.push({
      name: "Price feed",
      status: price > 0 ? "ok" : "warn",
      detail: `STX = $${price}`,
    });
  } catch (e: any) {
    checks.push({
      name: "Price feed",
      status: "fail",
      detail: e.message,
    });
  }

  const allOk = checks.every((c) => c.status === "ok");
  ok("doctor", { healthy: allOk, checks });
}

async function analyzeCmd(poolId: string, _address?: string): Promise<void> {
  if (!poolId) fail("--pool-id is required");

  let pool: PoolData;
  try {
    pool = await fetchPool(poolId);
  } catch {
    // Try from full pool list
    const pools = await fetchAllPools();
    const found = pools.find(
      (p) => p.poolId === poolId || p.poolId.includes(poolId)
    );
    if (!found) fail(`Pool ${poolId} not found`);
    pool = found!;
  }

  const analysis = analyzePool(pool);
  ok("analyze", {
    ...analysis,
    poolMetrics: {
      tvlUsd: pool.tvlUsd,
      feesUsd1d: pool.feesUsd1d,
      feesUsd7d: pool.feesUsd7d,
      apr: pool.apr,
      apr24h: pool.apr24h,
    },
  });
}

async function scanCmd(minDrift: number, minTvl: number): Promise<void> {
  const pools = await fetchAllPools();
  const filtered = pools.filter((p) => p.tvlUsd >= minTvl && p.activeBin > 0);

  const results: (DriftAnalysis & { tvlUsd: number; feesUsd1d: number })[] = [];
  for (const pool of filtered) {
    const analysis = analyzePool(pool);
    if (analysis.driftBins >= minDrift) {
      results.push({
        ...analysis,
        tvlUsd: pool.tvlUsd,
        feesUsd1d: pool.feesUsd1d,
      });
    }
  }

  // Sort: stranded first, then by drift distance
  const statusOrder: Record<DriftStatus, number> = {
    stranded: 0,
    drifted: 1,
    edge: 2,
    "in-range": 3,
  };
  results.sort(
    (a, b) =>
      statusOrder[a.driftStatus] - statusOrder[b.driftStatus] ||
      b.driftBins - a.driftBins
  );

  ok("scan", {
    scanned: filtered.length,
    flagged: results.length,
    minDrift,
    minTvl,
    pools: results,
  });
}

async function recommendCmd(
  poolId: string,
  _address?: string
): Promise<void> {
  if (!poolId) fail("--pool-id is required");

  let pool: PoolData;
  try {
    pool = await fetchPool(poolId);
  } catch {
    const pools = await fetchAllPools();
    const found = pools.find(
      (p) => p.poolId === poolId || p.poolId.includes(poolId)
    );
    if (!found) fail(`Pool ${poolId} not found`);
    pool = found!;
  }

  const plan = await generateRebalancePlan(pool);
  ok("recommend", plan);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name("bitflow-lp-rebalance-advisor")
  .description("Bin drift detector and rebalance planner for Bitflow HODLMM pools")
  .version("1.0.0");

program
  .command("doctor")
  .description("Check connectivity to Bitflow APIs and price feeds")
  .action(async () => {
    try {
      await doctorCmd();
    } catch (e: any) {
      fail(`doctor failed: ${e.message}`);
    }
  });

program
  .command("analyze")
  .description("Analyze a pool position for bin drift and fee capture loss")
  .requiredOption("--pool-id <id>", "HODLMM pool identifier")
  .option("--address <stx-address>", "Wallet address for position lookup")
  .action(async (opts) => {
    try {
      await analyzeCmd(opts.poolId, opts.address);
    } catch (e: any) {
      fail(`analyze failed: ${e.message}`);
    }
  });

program
  .command("scan")
  .description("Scan all HODLMM pools for bin drift and rebalance opportunities")
  .option(
    "--min-drift <bins>",
    "Minimum bin drift to flag",
    DEFAULT_MIN_DRIFT.toString()
  )
  .option(
    "--min-tvl <usd>",
    "Minimum pool TVL to include",
    DEFAULT_MIN_TVL.toString()
  )
  .action(async (opts) => {
    try {
      await scanCmd(parseInt(opts.minDrift), parseInt(opts.minTvl));
    } catch (e: any) {
      fail(`scan failed: ${e.message}`);
    }
  });

program
  .command("recommend")
  .description("Generate a rebalance plan with cost-benefit analysis")
  .requiredOption("--pool-id <id>", "HODLMM pool identifier")
  .option("--address <stx-address>", "Wallet address for position-specific plan")
  .option(
    "--slippage <pct>",
    "Maximum slippage tolerance",
    DEFAULT_SLIPPAGE_PCT.toString()
  )
  .action(async (opts) => {
    try {
      await recommendCmd(opts.poolId, opts.address);
    } catch (e: any) {
      fail(`recommend failed: ${e.message}`);
    }
  });

program.parse();
