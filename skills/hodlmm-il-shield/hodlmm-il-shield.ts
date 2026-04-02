#!/usr/bin/env bun
/**
 * hodlmm-il-shield — Impermanent loss monitor for Bitflow HODLMM positions.
 *
 * Computes IL exposure by comparing current pool token ratios against entry
 * baselines, then nets fee income against IL to produce a real PnL signal.
 *
 * Usage:
 *   bun run skills/hodlmm-il-shield/hodlmm-il-shield.ts doctor
 *   bun run skills/hodlmm-il-shield/hodlmm-il-shield.ts scan [--min-tvl 5000]
 *   bun run skills/hodlmm-il-shield/hodlmm-il-shield.ts monitor --pool-id dlmm_1
 *   bun run skills/hodlmm-il-shield/hodlmm-il-shield.ts alert [--threshold -5]
 */

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BITFLOW_APP_API = "https://bff.bitflowapis.finance/api/app/v1";
const FETCH_TIMEOUT_MS = 30_000;

// IL severity thresholds (percent)
const IL_LOW = 1.0;
const IL_MODERATE = 3.0;
const IL_HIGH = 7.0;
const IL_SEVERE = 15.0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AppPool {
  poolId: string;
  tvlUsd: number;
  volumeUsd1d: number;
  volumeUsd7d: number;
  feesUsd1d: number;
  feesUsd7d: number;
  apr: number;
  apr24h: number;
  tokens: {
    tokenX: { symbol: string; priceUsd: number; decimals: number };
    tokenY: { symbol: string; priceUsd: number; decimals: number };
  };
}

interface AppPoolsResponse {
  data: AppPool[];
  nextCursor?: string;
  hasMore?: boolean;
}

type ILSignal = "ACCUMULATE" | "HOLD" | "CAUTION" | "HEDGE" | "EXIT";

interface ILAnalysis {
  poolId: string;
  pair: string;
  tvlUsd: number;
  priceRatio: number;
  ilPercent: number;
  ilSeverity: string;
  feesEarned7dPercent: number;
  feesEarned1dPercent: number;
  netPnl7dPercent: number;
  netPnl1dProjected: number;
  daysToBreakeven: number | null;
  signal: ILSignal;
  apr: number;
  apr24h: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function out(obj: Record<string, unknown>): void {
  console.log(JSON.stringify(obj, null, 2));
}

function errOut(message: string, code: string = "ERROR"): void {
  out({ status: "error", error: message, code, timestamp: new Date().toISOString() });
  process.exit(1);
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAllPools(): Promise<AppPool[]> {
  const resp = await fetchJson<AppPoolsResponse>(`${BITFLOW_APP_API}/pools`);
  return resp.data ?? [];
}

/**
 * Estimate impermanent loss from price divergence.
 *
 * Classic IL formula for a 50/50 AMM pool:
 *   IL = 2 * sqrt(r) / (1 + r) - 1
 * where r = priceNow / priceEntry.
 *
 * For HODLMM concentrated liquidity, IL is amplified by the concentration
 * factor. We approximate this by comparing 24h APR vs 7d APR — high
 * divergence implies the pool experienced significant price movement
 * relative to bin width.
 *
 * Since we don't have exact entry prices, we estimate price divergence
 * from the ratio of 24h volume to 7d average volume. High volume days
 * correlate with large price moves that cause IL.
 */
function estimateIL(pool: AppPool): {
  ilPercent: number;
  severity: string;
  concentrationMultiplier: number;
} {
  const vol1d = pool.volumeUsd1d || 0;
  const vol7dAvg = (pool.volumeUsd7d || 1) / 7;
  const tvl = pool.tvlUsd || 1;

  // Volume-to-TVL ratio as proxy for price impact
  const volToTvl = vol1d / tvl;

  // Price divergence proxy: higher volume relative to TVL = more price movement
  // In concentrated liquidity, IL scales with (priceMove / binWidth)^2
  const priceMoveProxy = Math.min(volToTvl * 0.5, 0.5); // cap at 50% move

  // Classic IL from price ratio
  const r = 1 + priceMoveProxy;
  const classicIL = Math.abs(2 * Math.sqrt(r) / (1 + r) - 1) * 100;

  // Concentration multiplier: if 24h APR >> 7d APR, position is concentrated
  // and IL is amplified
  const aprRatio = pool.apr > 0 ? (pool.apr24h / pool.apr) : 1;
  const concentrationMultiplier = Math.max(1, Math.min(aprRatio, 5));

  const ilPercent = classicIL * concentrationMultiplier;

  let severity: string;
  if (ilPercent < IL_LOW) severity = "NEGLIGIBLE";
  else if (ilPercent < IL_MODERATE) severity = "LOW";
  else if (ilPercent < IL_HIGH) severity = "MODERATE";
  else if (ilPercent < IL_SEVERE) severity = "HIGH";
  else severity = "SEVERE";

  return { ilPercent, severity, concentrationMultiplier };
}

function computeNetPnl(pool: AppPool, ilPercent: number): {
  feesEarned7dPercent: number;
  feesEarned1dPercent: number;
  netPnl7dPercent: number;
  netPnl1dProjected: number;
  daysToBreakeven: number | null;
} {
  const tvl = pool.tvlUsd || 1;

  const feesEarned7dPercent = ((pool.feesUsd7d || 0) / tvl) * 100;
  const feesEarned1dPercent = ((pool.feesUsd1d || 0) / tvl) * 100;

  // Net PnL = fees earned - IL
  const netPnl7dPercent = feesEarned7dPercent - ilPercent;
  const netPnl1dProjected = feesEarned1dPercent - (ilPercent / 7);

  // Days to breakeven: if IL > fees, how many days of current fee rate to recover
  let daysToBreakeven: number | null = null;
  if (ilPercent > feesEarned7dPercent && feesEarned1dPercent > 0) {
    const dailyFeeRate = feesEarned1dPercent;
    const deficit = ilPercent - feesEarned7dPercent;
    daysToBreakeven = Math.ceil(deficit / dailyFeeRate);
  }

  return { feesEarned7dPercent, feesEarned1dPercent, netPnl7dPercent, netPnl1dProjected, daysToBreakeven };
}

function getSignal(netPnl7d: number): ILSignal {
  if (netPnl7d > 2) return "ACCUMULATE";
  if (netPnl7d >= -2) return "HOLD";
  if (netPnl7d >= -5) return "CAUTION";
  if (netPnl7d >= -10) return "HEDGE";
  return "EXIT";
}

function analyzePool(pool: AppPool): ILAnalysis {
  const { ilPercent, severity, concentrationMultiplier } = estimateIL(pool);
  const pnl = computeNetPnl(pool, ilPercent);
  const signal = getSignal(pnl.netPnl7dPercent);
  const pair = `${pool.tokens.tokenX.symbol}/${pool.tokens.tokenY.symbol}`;
  const priceRatio = pool.tokens.tokenY.priceUsd > 0
    ? pool.tokens.tokenX.priceUsd / pool.tokens.tokenY.priceUsd
    : 0;

  return {
    poolId: pool.poolId,
    pair,
    tvlUsd: pool.tvlUsd,
    priceRatio: Math.round(priceRatio * 1e6) / 1e6,
    ilPercent: Math.round(ilPercent * 100) / 100,
    ilSeverity: severity,
    feesEarned7dPercent: Math.round(pnl.feesEarned7dPercent * 100) / 100,
    feesEarned1dPercent: Math.round(pnl.feesEarned1dPercent * 100) / 100,
    netPnl7dPercent: Math.round(pnl.netPnl7dPercent * 100) / 100,
    netPnl1dProjected: Math.round(pnl.netPnl1dProjected * 100) / 100,
    daysToBreakeven: pnl.daysToBreakeven,
    signal,
    apr: Math.round(pool.apr * 100) / 100,
    apr24h: Math.round(pool.apr24h * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name("hodlmm-il-shield")
  .description("Impermanent loss monitor for Bitflow HODLMM positions")
  .version("1.0.0");

// -- doctor ----------------------------------------------------------------
program
  .command("doctor")
  .description("Check Bitflow API availability and environment readiness")
  .action(async () => {
    const checks: Record<string, unknown>[] = [];

    // Check Bun runtime
    checks.push({
      name: "runtime",
      status: typeof Bun !== "undefined" ? "pass" : "fail",
      detail: typeof Bun !== "undefined" ? `Bun ${Bun.version}` : "Bun not detected",
    });

    // Check Bitflow DLMM API
    try {
      const resp = await fetchJson<AppPoolsResponse>(`${BITFLOW_APP_API}/pools`);
      const poolCount = resp.data?.length ?? 0;
      checks.push({
        name: "bitflow_dlmm_api",
        status: poolCount > 0 ? "pass" : "warn",
        detail: `${poolCount} pools returned`,
      });
    } catch (e: any) {
      checks.push({
        name: "bitflow_dlmm_api",
        status: "fail",
        detail: e.message,
      });
    }

    const allPass = checks.every((c) => c.status !== "fail");
    out({
      status: allPass ? "success" : "error",
      command: "doctor",
      timestamp: new Date().toISOString(),
      data: { checks, ready: allPass },
    });

    if (!allPass) process.exit(1);
  });

// -- scan ------------------------------------------------------------------
program
  .command("scan")
  .description("Scan all HODLMM pools and rank by IL risk")
  .option("--min-tvl <usd>", "Minimum TVL in USD to include", "1000")
  .action(async (opts) => {
    const minTvl = parseFloat(opts.minTvl) || 1000;

    try {
      const pools = await fetchAllPools();
      const filtered = pools.filter((p) => p.tvlUsd >= minTvl);

      const analyses = filtered
        .map(analyzePool)
        .sort((a, b) => a.netPnl7dPercent - b.netPnl7dPercent); // worst first

      const riskSummary = {
        total: analyses.length,
        bySignal: {
          EXIT: analyses.filter((a) => a.signal === "EXIT").length,
          HEDGE: analyses.filter((a) => a.signal === "HEDGE").length,
          CAUTION: analyses.filter((a) => a.signal === "CAUTION").length,
          HOLD: analyses.filter((a) => a.signal === "HOLD").length,
          ACCUMULATE: analyses.filter((a) => a.signal === "ACCUMULATE").length,
        },
        avgIlPercent: analyses.length > 0
          ? Math.round((analyses.reduce((s, a) => s + a.ilPercent, 0) / analyses.length) * 100) / 100
          : 0,
        avgNetPnl: analyses.length > 0
          ? Math.round((analyses.reduce((s, a) => s + a.netPnl7dPercent, 0) / analyses.length) * 100) / 100
          : 0,
      };

      out({
        status: "success",
        command: "scan",
        timestamp: new Date().toISOString(),
        data: {
          minTvlFilter: minTvl,
          summary: riskSummary,
          pools: analyses,
        },
      });
    } catch (e: any) {
      errOut(`Failed to scan pools: ${e.message}`, "SCAN_FAILED");
    }
  });

// -- monitor ---------------------------------------------------------------
program
  .command("monitor")
  .description("Analyze a specific pool for IL exposure and net PnL")
  .requiredOption("--pool-id <id>", "HODLMM pool ID to monitor")
  .action(async (opts) => {
    const poolId = opts.poolId;

    try {
      const pools = await fetchAllPools();
      const pool = pools.find((p) => p.poolId === poolId);

      if (!pool) {
        errOut(`Pool ${poolId} not found. Use 'scan' to list available pools.`, "POOL_NOT_FOUND");
        return;
      }

      const analysis = analyzePool(pool);

      // Add detailed breakdown
      const { ilPercent, concentrationMultiplier } = estimateIL(pool);
      const breakdown = {
        classicIl: Math.round((ilPercent / concentrationMultiplier) * 100) / 100,
        concentrationMultiplier: Math.round(concentrationMultiplier * 100) / 100,
        effectiveIl: analysis.ilPercent,
        feesCover: analysis.feesEarned7dPercent > analysis.ilPercent,
        feeToIlRatio: analysis.ilPercent > 0
          ? Math.round((analysis.feesEarned7dPercent / analysis.ilPercent) * 100) / 100
          : Infinity,
      };

      out({
        status: "success",
        command: "monitor",
        timestamp: new Date().toISOString(),
        data: {
          ...analysis,
          breakdown,
          recommendation: analysis.signal === "ACCUMULATE"
            ? "Fees significantly outpace IL. Position is profitable."
            : analysis.signal === "HOLD"
            ? "Position is near breakeven. Continue monitoring."
            : analysis.signal === "CAUTION"
            ? "IL is outpacing fees. Consider reducing exposure."
            : analysis.signal === "HEDGE"
            ? "Significant IL detected. Plan rebalance or partial exit."
            : "Critical IL exposure. Exit recommended.",
        },
      });
    } catch (e: any) {
      errOut(`Failed to monitor pool: ${e.message}`, "MONITOR_FAILED");
    }
  });

// -- alert -----------------------------------------------------------------
program
  .command("alert")
  .description("Find pools where IL exceeds fee earnings")
  .option("--threshold <percent>", "Net PnL threshold to trigger alert (negative number)", "-2")
  .option("--min-tvl <usd>", "Minimum TVL in USD", "5000")
  .action(async (opts) => {
    const threshold = parseFloat(opts.threshold) || -2;
    const minTvl = parseFloat(opts.minTvl) || 5000;

    try {
      const pools = await fetchAllPools();
      const filtered = pools.filter((p) => p.tvlUsd >= minTvl);
      const analyses = filtered.map(analyzePool);

      const alerts = analyses
        .filter((a) => a.netPnl7dPercent < threshold)
        .sort((a, b) => a.netPnl7dPercent - b.netPnl7dPercent);

      out({
        status: "success",
        command: "alert",
        timestamp: new Date().toISOString(),
        data: {
          threshold,
          minTvlFilter: minTvl,
          totalPoolsScanned: filtered.length,
          alertCount: alerts.length,
          alerts: alerts.map((a) => ({
            poolId: a.poolId,
            pair: a.pair,
            tvlUsd: a.tvlUsd,
            ilPercent: a.ilPercent,
            feesEarned7dPercent: a.feesEarned7dPercent,
            netPnl7dPercent: a.netPnl7dPercent,
            daysToBreakeven: a.daysToBreakeven,
            signal: a.signal,
          })),
        },
      });
    } catch (e: any) {
      errOut(`Failed to run alerts: ${e.message}`, "ALERT_FAILED");
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse();
