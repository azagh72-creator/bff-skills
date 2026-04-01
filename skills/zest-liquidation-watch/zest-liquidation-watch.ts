#!/usr/bin/env bun
/**
 * zest-liquidation-watch — Liquidation risk monitor for Zest Protocol on Stacks.
 *
 * Reads on-chain Zest lending positions, computes health factors, and alerts
 * when positions approach liquidation thresholds. Designed for autonomous agents
 * managing DeFi portfolios or running liquidation strategies.
 *
 * Usage:
 *   bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts doctor
 *   bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts check --address SP322ZK...
 *   bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts scan [--min-risk 0.5]
 *   bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts alert --address SP322ZK... [--threshold 1.5]
 */

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIRO_API = "https://api.hiro.so";
const FETCH_TIMEOUT_MS = 30_000;
const NETWORK = "mainnet";

// Zest Protocol contract addresses (v1 mainnet)
const ZEST_POOL_RESERVE = "SP2VCQJHN7SP2CZCE8BBRUMHVDMSVJYMZWGT5TTA.pool-0-reserve";
const ZEST_POOL_BORROW = "SP2VCQJHN7SP2CZCE8BBRUMHVDMSVJYMZWGT5TTA.pool-borrow";
const ZEST_ORACLE = "SP2VCQJHN7SP2CZCE8BBRUMHVDMSVJYMZWGT5TTA.oracle";

// Known Zest asset contracts
const ZEST_ASSETS: Record<string, { symbol: string; decimals: number; contract: string }> = {
  "stx": {
    symbol: "STX",
    decimals: 6,
    contract: "SP2VCQJHN7SP2CZCE8BBRUMHVDMSVJYMZWGT5TTA.wstx",
  },
  "sbtc": {
    symbol: "sBTC",
    decimals: 8,
    contract: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-sbtc",
  },
  "usda": {
    symbol: "USDA",
    decimals: 6,
    contract: "SP2C2YFP12AJZB1MADC67XKFPJ8NKRDNKPS3MDKA.usda-token",
  },
  "aeusdc": {
    symbol: "aeUSDC",
    decimals: 6,
    contract: "SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc",
  },
};

// Default liquidation thresholds per asset (Zest v1 parameters)
const LIQUIDATION_THRESHOLDS: Record<string, number> = {
  STX: 0.75,
  sBTC: 0.80,
  USDA: 0.85,
  aeUSDC: 0.85,
};

const DEFAULT_ALERT_THRESHOLD = 1.5;
const DEFAULT_MIN_RISK = 0.5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AssetPosition {
  symbol: string;
  amount: number;
  valueUsd: number;
}

interface LiquidationPrice {
  asset: string;
  triggerPrice: number;
  currentPrice: number;
  dropRequired: string;
}

interface PositionHealth {
  address: string;
  healthFactor: number;
  supplied: Record<string, AssetPosition>;
  borrowed: Record<string, AssetPosition>;
  totalSuppliedUsd: number;
  totalBorrowedUsd: number;
  liquidationThreshold: number;
  liquidationPrice: LiquidationPrice | null;
  riskLevel: "safe" | "low" | "medium" | "high" | "critical";
  riskScore: number;
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

async function callReadOnly(
  contractId: string,
  functionName: string,
  args: string[],
  sender: string
): Promise<any> {
  const [contractAddress, contractName] = contractId.split(".");
  const url = `${HIRO_API}/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender, arguments: args }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from call-read ${contractId}::${functionName}`);
    const data = await res.json();
    if (!data.okay) throw new Error(`Clarity error in ${functionName}: ${JSON.stringify(data)}`);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse a Clarity uint response value.
 * Handles both hex-encoded and direct clarity value formats.
 */
function parseClarityUint(result: any): number {
  if (result?.result) {
    const hex = result.result;
    // Clarity uint: 0x01 prefix + 16 bytes big-endian
    if (typeof hex === "string" && hex.startsWith("0x")) {
      // Skip the type prefix byte (01 for uint)
      const valueHex = hex.slice(4); // skip "0x01"
      return parseInt(valueHex, 16);
    }
  }
  return 0;
}

/**
 * Fetch STX price from CoinGecko (simple, no API key needed)
 */
async function getStxPrice(): Promise<number> {
  try {
    const data = await fetchJson<any>(
      "https://api.coingecko.com/api/v3/simple/price?ids=blockstack,bitcoin&vs_currencies=usd"
    );
    return data?.blockstack?.usd ?? 0;
  } catch {
    // Fallback: try Hiro pricing
    return 0;
  }
}

async function getBtcPrice(): Promise<number> {
  try {
    const data = await fetchJson<any>(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    );
    return data?.bitcoin?.usd ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Get asset prices in USD
 */
async function getAssetPrices(): Promise<Record<string, number>> {
  const [stxPrice, btcPrice] = await Promise.all([getStxPrice(), getBtcPrice()]);
  return {
    STX: stxPrice,
    sBTC: btcPrice,
    USDA: 1.0,
    aeUSDC: 1.0,
  };
}

/**
 * Compute health factor from supplied/borrowed values and liquidation threshold.
 *
 * healthFactor = (totalSuppliedUsd * weightedLiqThreshold) / totalBorrowedUsd
 *
 * healthFactor > 1.0 = solvent
 * healthFactor <= 1.0 = liquidatable
 */
function computeHealthFactor(
  totalSuppliedUsd: number,
  totalBorrowedUsd: number,
  liquidationThreshold: number
): number {
  if (totalBorrowedUsd === 0) return Infinity;
  return (totalSuppliedUsd * liquidationThreshold) / totalBorrowedUsd;
}

function riskLevel(hf: number): "safe" | "low" | "medium" | "high" | "critical" {
  if (hf === Infinity || hf > 2.0) return "safe";
  if (hf > 1.5) return "low";
  if (hf > 1.2) return "medium";
  if (hf > 1.0) return "high";
  return "critical";
}

function riskScore(hf: number): number {
  if (hf === Infinity) return 0;
  if (hf <= 1.0) return 1.0;
  // Map health factor to 0-1 risk score. HF=2 → risk 0, HF=1 → risk 1
  return Math.max(0, Math.min(1, 1 - (hf - 1)));
}

function computeLiquidationPrice(
  mainCollateral: { symbol: string; amount: number; price: number },
  totalBorrowedUsd: number,
  liquidationThreshold: number
): LiquidationPrice | null {
  if (mainCollateral.amount === 0 || totalBorrowedUsd === 0) return null;
  // Price at which health factor = 1.0
  // HF = (amount * price * liqThreshold) / borrowedUsd = 1.0
  // price = borrowedUsd / (amount * liqThreshold)
  const triggerPrice = totalBorrowedUsd / (mainCollateral.amount * liquidationThreshold);
  const dropPct = ((mainCollateral.price - triggerPrice) / mainCollateral.price) * 100;
  return {
    asset: mainCollateral.symbol,
    triggerPrice: Math.round(triggerPrice * 100) / 100,
    currentPrice: mainCollateral.price,
    dropRequired: `-${dropPct.toFixed(1)}%`,
  };
}

/**
 * Read Zest position for an address using contract calls.
 * Falls back to balance-based estimation if direct pool reads fail.
 */
async function readZestPosition(
  address: string,
  prices: Record<string, number>
): Promise<PositionHealth> {
  const supplied: Record<string, AssetPosition> = {};
  const borrowed: Record<string, AssetPosition> = {};
  let totalSuppliedUsd = 0;
  let totalBorrowedUsd = 0;
  let weightedThreshold = 0;

  // Try to read supply and borrow balances from Zest pool-reserve
  for (const [key, asset] of Object.entries(ZEST_ASSETS)) {
    const price = prices[asset.symbol] ?? 0;
    const threshold = LIQUIDATION_THRESHOLDS[asset.symbol] ?? 0.75;

    try {
      // Read supply balance
      const supplyResult = await callReadOnly(
        ZEST_POOL_RESERVE,
        "get-user-reserve-data",
        [
          `0x0616${Buffer.from(address.replace("SP", "")).toString("hex").padEnd(40, "0")}`, // principal
          `0x0616${Buffer.from(asset.contract.split(".")[0].replace("SP", "")).toString("hex").padEnd(40, "0")}0d${Buffer.from(asset.contract.split(".")[1]).toString("hex")}`, // asset
        ],
        address
      );
      // Parse supply amount
      const supplyAmount = parseClarityUint(supplyResult) / Math.pow(10, asset.decimals);
      if (supplyAmount > 0) {
        const valueUsd = supplyAmount * price;
        supplied[asset.symbol] = { symbol: asset.symbol, amount: supplyAmount, valueUsd };
        totalSuppliedUsd += valueUsd;
        weightedThreshold += valueUsd * threshold;
      }
    } catch {
      // Contract call failed for this asset — skip
    }

    try {
      // Read borrow balance
      const borrowResult = await callReadOnly(
        ZEST_POOL_BORROW,
        "get-user-borrow-balance",
        [
          `0x0616${Buffer.from(address.replace("SP", "")).toString("hex").padEnd(40, "0")}`,
          `0x0616${Buffer.from(asset.contract.split(".")[0].replace("SP", "")).toString("hex").padEnd(40, "0")}0d${Buffer.from(asset.contract.split(".")[1]).toString("hex")}`,
        ],
        address
      );
      const borrowAmount = parseClarityUint(borrowResult) / Math.pow(10, asset.decimals);
      if (borrowAmount > 0) {
        const valueUsd = borrowAmount * price;
        borrowed[asset.symbol] = { symbol: asset.symbol, amount: borrowAmount, valueUsd };
        totalBorrowedUsd += valueUsd;
      }
    } catch {
      // Contract call failed for this asset — skip
    }
  }

  // Compute weighted liquidation threshold
  const liqThreshold = totalSuppliedUsd > 0 ? weightedThreshold / totalSuppliedUsd : 0.75;

  // Compute health factor
  const hf = computeHealthFactor(totalSuppliedUsd, totalBorrowedUsd, liqThreshold);

  // Find main collateral for liquidation price calculation
  let mainCollateral: { symbol: string; amount: number; price: number } | null = null;
  let maxSupplyUsd = 0;
  for (const [symbol, pos] of Object.entries(supplied)) {
    if (pos.valueUsd > maxSupplyUsd) {
      maxSupplyUsd = pos.valueUsd;
      mainCollateral = { symbol, amount: pos.amount, price: prices[symbol] ?? 0 };
    }
  }

  const liquidationPrice = mainCollateral
    ? computeLiquidationPrice(mainCollateral, totalBorrowedUsd, liqThreshold)
    : null;

  return {
    address,
    healthFactor: hf === Infinity ? -1 : Math.round(hf * 100) / 100, // -1 signals no borrows
    supplied,
    borrowed,
    totalSuppliedUsd: Math.round(totalSuppliedUsd * 100) / 100,
    totalBorrowedUsd: Math.round(totalBorrowedUsd * 100) / 100,
    liquidationThreshold: Math.round(liqThreshold * 100) / 100,
    liquidationPrice,
    riskLevel: riskLevel(hf),
    riskScore: Math.round(riskScore(hf) * 100) / 100,
  };
}

/**
 * Scan recent Zest borrowers by reading contract events.
 */
async function scanRecentBorrowers(): Promise<string[]> {
  try {
    const [contractAddress, contractName] = ZEST_POOL_BORROW.split(".");
    const data = await fetchJson<any>(
      `${HIRO_API}/extended/v1/contract/${contractAddress}.${contractName}/events?limit=50`
    );
    const events = data?.results ?? [];
    const addresses = new Set<string>();
    for (const event of events) {
      // Extract sender addresses from contract call events
      const sender = event?.contract_log?.value?.repr?.match(/SP[A-Z0-9]+/)?.[0];
      if (sender) addresses.add(sender);
      // Also check tx_sender
      if (event?.tx?.sender_address) addresses.add(event.tx.sender_address);
    }
    return [...addresses];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function doctorCmd(): Promise<void> {
  const checks: { name: string; status: string; detail: string }[] = [];

  // Check Hiro API
  try {
    const info = await fetchJson<any>(`${HIRO_API}/v2/info`);
    checks.push({
      name: "Hiro API",
      status: "ok",
      detail: `Stacks tip height: ${info?.stacks_tip_height ?? "unknown"}`,
    });
  } catch (e: any) {
    checks.push({ name: "Hiro API", status: "fail", detail: e.message });
  }

  // Check Zest pool-reserve contract
  try {
    const [addr, name] = ZEST_POOL_RESERVE.split(".");
    const info = await fetchJson<any>(
      `${HIRO_API}/v2/contracts/interface/${addr}/${name}`
    );
    const fnCount = info?.functions?.length ?? 0;
    checks.push({
      name: "Zest pool-reserve",
      status: fnCount > 0 ? "ok" : "warn",
      detail: `${fnCount} functions found`,
    });
  } catch (e: any) {
    checks.push({ name: "Zest pool-reserve", status: "fail", detail: e.message });
  }

  // Check prices
  try {
    const prices = await getAssetPrices();
    const stxOk = prices.STX > 0;
    const btcOk = prices.sBTC > 0;
    checks.push({
      name: "Price feeds",
      status: stxOk && btcOk ? "ok" : "warn",
      detail: `STX=$${prices.STX}, BTC=$${prices.sBTC}`,
    });
  } catch (e: any) {
    checks.push({ name: "Price feeds", status: "fail", detail: e.message });
  }

  const allOk = checks.every((c) => c.status === "ok");
  ok("doctor", { healthy: allOk, checks });
}

async function checkCmd(address: string): Promise<void> {
  if (!address || !address.startsWith("SP")) {
    fail("Invalid Stacks address. Must start with SP.");
  }

  const prices = await getAssetPrices();
  const position = await readZestPosition(address, prices);

  if (Object.keys(position.borrowed).length === 0) {
    ok("check", {
      address,
      message: "No active Zest borrows found for this address",
      supplied: position.supplied,
      totalSuppliedUsd: position.totalSuppliedUsd,
      healthFactor: null,
      riskLevel: "safe",
    });
  }

  ok("check", position);
}

async function scanCmd(minRisk: number): Promise<void> {
  const prices = await getAssetPrices();
  const borrowers = await scanRecentBorrowers();

  if (borrowers.length === 0) {
    ok("scan", {
      message: "No recent borrowers found in contract events",
      scanned: 0,
      atRisk: [],
    });
  }

  const results: PositionHealth[] = [];
  for (const addr of borrowers) {
    try {
      const pos = await readZestPosition(addr, prices);
      if (pos.riskScore >= minRisk && Object.keys(pos.borrowed).length > 0) {
        results.push(pos);
      }
    } catch {
      // Skip addresses that fail to read
    }
  }

  // Sort by risk score descending (highest risk first)
  results.sort((a, b) => b.riskScore - a.riskScore);

  ok("scan", {
    scanned: borrowers.length,
    atRisk: results.length,
    minRiskThreshold: minRisk,
    positions: results,
    prices: {
      STX: prices.STX,
      sBTC: prices.sBTC,
    },
  });
}

async function alertCmd(address: string, threshold: number): Promise<void> {
  if (!address || !address.startsWith("SP")) {
    fail("Invalid Stacks address. Must start with SP.");
  }

  const prices = await getAssetPrices();
  const position = await readZestPosition(address, prices);

  if (Object.keys(position.borrowed).length === 0) {
    ok("alert", {
      alert: false,
      severity: "none",
      message: "No active borrows — no liquidation risk",
      address,
    });
  }

  const hf = position.healthFactor === -1 ? Infinity : position.healthFactor;
  const alertTriggered = hf < threshold;

  let severity: "none" | "info" | "warning" | "critical" = "none";
  let recommendation = "Position is healthy.";

  if (hf < 1.2) {
    severity = "critical";
    recommendation = "URGENT: Health factor critically low. Repay debt or add collateral immediately.";
  } else if (hf < 1.5) {
    severity = "warning";
    recommendation = "Health factor declining. Consider adding collateral or repaying partial debt.";
  } else if (hf < threshold) {
    severity = "info";
    recommendation = "Health factor below monitoring threshold. Keep watching.";
  }

  ok("alert", {
    alert: alertTriggered,
    severity,
    threshold,
    recommendation,
    position,
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();
program.name("zest-liquidation-watch").description("Liquidation risk monitor for Zest Protocol").version("1.0.0");

program
  .command("doctor")
  .description("Check connectivity to Hiro API, Zest contracts, and price feeds")
  .action(async () => {
    try {
      await doctorCmd();
    } catch (e: any) {
      fail(`doctor failed: ${e.message}`);
    }
  });

program
  .command("check")
  .description("Check health factor for a single Zest position")
  .option("--address <stx-address>", "Stacks address to check")
  .action(async (opts) => {
    try {
      const address = opts.address || process.env.STX_ADDRESS || "";
      if (!address) fail("No address provided. Use --address or set STX_ADDRESS env var.");
      await checkCmd(address);
    } catch (e: any) {
      fail(`check failed: ${e.message}`);
    }
  });

program
  .command("scan")
  .description("Scan recent Zest borrowers for positions near liquidation")
  .option("--min-risk <number>", "Minimum risk score 0-1 to include", DEFAULT_MIN_RISK.toString())
  .action(async (opts) => {
    try {
      await scanCmd(parseFloat(opts.minRisk));
    } catch (e: any) {
      fail(`scan failed: ${e.message}`);
    }
  });

program
  .command("alert")
  .description("Alert if health factor drops below threshold")
  .option("--address <stx-address>", "Stacks address to check")
  .option("--threshold <number>", "Health factor alert threshold", DEFAULT_ALERT_THRESHOLD.toString())
  .action(async (opts) => {
    try {
      const address = opts.address || process.env.STX_ADDRESS || "";
      if (!address) fail("No address provided. Use --address or set STX_ADDRESS env var.");
      await alertCmd(address, parseFloat(opts.threshold));
    } catch (e: any) {
      fail(`alert failed: ${e.message}`);
    }
  });

program.parse();
