#!/usr/bin/env bun
/**
 * zest-liquidation-watch — Liquidation risk monitor for Zest Protocol v2 on Stacks.
 *
 * Reads on-chain Zest v2 lending positions, computes health factors, and alerts
 * when positions approach liquidation thresholds. Designed for autonomous agents
 * managing DeFi portfolios or running liquidation strategies.
 *
 * Author: Flying Whale (azagh72-creator)
 * Agent: Flying Whale — Genesis L2, ERC-8004 #54
 * Fixed: v2.0.0 — correct Clarity principal encoding + Zest v2 contracts
 *
 * Usage:
 *   bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts doctor
 *   bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts check --address SP322ZK...
 *   bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts scan [--min-risk 0.5]
 *   bun run skills/zest-liquidation-watch/zest-liquidation-watch.ts alert --address SP322ZK... [--threshold 1.5] [--confirm]
 */

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIRO_API = "https://api.hiro.so";
const FETCH_TIMEOUT_MS = 30_000;
const NETWORK = "mainnet";

// Zest Protocol v2 — deployer SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7
// v0-1-data.get-user-position(principal) → (ok {collateral: list, debt: list, health-factor: uint})
const ZEST_DEPLOYER = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7";
const ZEST_DATA = `${ZEST_DEPLOYER}.v0-1-data`;
const ZEST_MARKET = `${ZEST_DEPLOYER}.v0-4-market`;

// Zest v2 supported assets — assetId must match on-chain registry
const ZEST_ASSETS: Record<string, { symbol: string; decimals: number; assetId: number; liquidationLtv: number; contract: string }> = {
  sBTC:    { symbol: "sBTC",   decimals: 8, assetId: 2,  liquidationLtv: 85, contract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token" },
  wSTX:    { symbol: "wSTX",   decimals: 6, assetId: 0,  liquidationLtv: 80, contract: `${ZEST_DEPLOYER}.wstx` },
  stSTX:   { symbol: "stSTX",  decimals: 6, assetId: 4,  liquidationLtv: 80, contract: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token" },
  USDC:    { symbol: "aeUSDC", decimals: 6, assetId: 6,  liquidationLtv: 85, contract: "SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc" },
  USDH:    { symbol: "USDH",   decimals: 8, assetId: 8,  liquidationLtv: 85, contract: "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1" },
  stSTXbtc:{ symbol: "stSTXbtc",decimals: 6,assetId: 10, liquidationLtv: 80, contract: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststxbtc-token-v2" },
};

const DEFAULT_ALERT_THRESHOLD = 1.5;
const DEFAULT_MIN_RISK = 0.5;

// ---------------------------------------------------------------------------
// Clarity principal encoding — no external deps
// Must encode Stacks addresses as Clarity wire-format hex for call-read API.
//
// BUG FIX: The original skill used Buffer.from(address.replace("SP","")).toString("hex")
// which encodes the c32check ASCII string as UTF-8 bytes — completely wrong.
// The correct encoding decodes the c32check address to extract the actual
// 20-byte hash160, then prepends the type tag and version byte.
// ---------------------------------------------------------------------------

const C32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Decode c32check-encoded Stacks address body → raw bytes [checksum(4) | hash160(20)] */
function c32decode(input: string): Buffer {
  const s = input.toUpperCase();
  let bits = 0, value = 0;
  const output: number[] = [];
  for (const char of s) {
    const idx = C32_ALPHABET.indexOf(char);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >> bits) & 0xff);
    }
  }
  return Buffer.from(output);
}

/**
 * Encode a Stacks standard address as a Clarity principal hex argument.
 * Clarity StandardPrincipal: 0x05 + version byte (1) + hash160 (20) = 22 bytes total.
 *
 * Stacks address: 'S' + c32_version_char + c32check(checksum[4] + hash160[20])
 * The c32 alphabet index of the version char IS the version byte.
 * SP (mainnet) → 'P' = index 22 = 0x16.
 */
function encodeStandardPrincipal(address: string): string {
  if (!address.startsWith("S") || address.length < 5) {
    throw new Error(`Invalid Stacks address: ${address}`);
  }
  const versionByte = C32_ALPHABET.indexOf(address[1].toUpperCase());
  const decoded = c32decode(address.slice(2)); // 24 bytes: checksum(4) + hash160(20)
  const hash160 = decoded.slice(4, 24);       // drop 4-byte checksum

  const buf = Buffer.alloc(22);
  buf[0] = 0x05; // Clarity StandardPrincipal type tag
  buf[1] = versionByte;
  hash160.copy(buf, 2);
  return "0x" + buf.toString("hex");
}

/**
 * Encode a Stacks contract principal as a Clarity principal hex argument.
 * Clarity ContractPrincipal: 0x06 + version(1) + hash160(20) + name_len(1) + name_bytes
 */
function encodeContractPrincipal(contractId: string): string {
  const dotIdx = contractId.indexOf(".");
  if (dotIdx < 0) throw new Error(`Not a contract: ${contractId}`);
  const address = contractId.slice(0, dotIdx);
  const name = contractId.slice(dotIdx + 1);

  if (!address.startsWith("S") || address.length < 5) {
    throw new Error(`Invalid contract address in: ${contractId}`);
  }
  const versionByte = C32_ALPHABET.indexOf(address[1].toUpperCase());
  const decoded = c32decode(address.slice(2));
  const hash160 = decoded.slice(4, 24);

  const nameBytes = Buffer.from(name, "ascii");
  const buf = Buffer.alloc(22 + 1 + nameBytes.length);
  buf[0] = 0x06; // Clarity ContractPrincipal type tag
  buf[1] = versionByte;
  hash160.copy(buf, 2);
  buf[22] = nameBytes.length; // 1-byte name length
  nameBytes.copy(buf, 23);
  return "0x" + buf.toString("hex");
}

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
  healthFactor: number;   // -1 = no borrows (infinite)
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
 * Find the collateral amount for a specific zTokenId in get-user-position hex response.
 * Collateral list entry structure: { aid: uint (zTokenId), amount: uint, ... }
 */
function extractCollateralForZToken(hexResult: string, zTokenId: number): number {
  const hex = hexResult.replace(/^0x/, "").toLowerCase();
  // "aid" field: 03 + hex("aid") + 01 (uint type) + 16-byte value
  const aidNameHex = "03" + Buffer.from("aid", "ascii").toString("hex");
  const aidValueHex = "01" + "00".repeat(15) + zTokenId.toString(16).padStart(2, "0");
  const searchFor = aidNameHex + aidValueHex;

  let pos = 0;
  while (pos < hex.length) {
    const idx = hex.indexOf(searchFor, pos);
    if (idx < 0) break;
    // Found the aid entry — scan forward for "amount"
    const window = hex.slice(idx, idx + 200);
    const amtHex = "06" + Buffer.from("amount", "ascii").toString("hex") + "01";
    const amtIdx = window.indexOf(amtHex);
    if (amtIdx >= 0) {
      const vStart = amtIdx + amtHex.length;
      const vHex = window.slice(vStart, vStart + 32);
      if (vHex.length === 32) return parseInt(vHex.slice(16), 16) || 0;
    }
    pos = idx + 2;
  }
  return 0;
}

/**
 * Find the actual-debt for a specific assetId in get-user-position hex response.
 * Debt list entry structure: { asset-id: uint, actual-debt: uint, ... }
 */
function extractDebtForAsset(hexResult: string, assetId: number): number {
  const hex = hexResult.replace(/^0x/, "").toLowerCase();
  const assetIdNameHex = "08" + Buffer.from("asset-id", "ascii").toString("hex");
  const assetIdValueHex = "01" + "00".repeat(15) + assetId.toString(16).padStart(2, "0");
  const searchFor = assetIdNameHex + assetIdValueHex;

  let pos = 0;
  while (pos < hex.length) {
    const idx = hex.indexOf(searchFor, pos);
    if (idx < 0) break;
    const window = hex.slice(idx, idx + 300);
    const debtFieldHex = "0b" + Buffer.from("actual-debt", "ascii").toString("hex") + "01";
    const debtIdx = window.indexOf(debtFieldHex);
    if (debtIdx >= 0) {
      const valueStart = debtIdx + debtFieldHex.length;
      const valueHex = window.slice(valueStart, valueStart + 32);
      if (valueHex.length === 32) return parseInt(valueHex.slice(16), 16) || 0;
    }
    pos = idx + 2;
  }
  return 0;
}

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

async function getAssetPrices(): Promise<Record<string, number>> {
  const [stxPrice, btcPrice] = await Promise.all([getStxPrice(), getBtcPrice()]);
  return {
    sBTC: btcPrice,
    wSTX: stxPrice,
    stSTX: stxPrice * 1.05, // stSTX trades at a small premium to STX
    aeUSDC: 1.0,
    USDH: 1.0,
    stSTXbtc: btcPrice * 0.01, // rough estimate: stSTXbtc is a BTC derivative
  };
}

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
  return Math.max(0, Math.min(1, 1 - (hf - 1)));
}

function computeLiquidationPrice(
  mainCollateral: { symbol: string; amount: number; price: number },
  totalBorrowedUsd: number,
  liquidationThreshold: number
): LiquidationPrice | null {
  if (mainCollateral.amount === 0 || totalBorrowedUsd === 0) return null;
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
 * Read Zest v2 position for a given address using v0-1-data.get-user-position.
 *
 * FIX: Previously used broken principal encoding:
 *   Buffer.from(address.replace("SP","")).toString("hex").padEnd(40,"0")
 * This encodes the ASCII c32 string bytes — completely wrong. The correct
 * method decodes the c32check address to extract the raw hash160 bytes.
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

  // Call v0-1-data.get-user-position with correct principal encoding
  const principalArg = encodeStandardPrincipal(address);
  let positionHex: string | null = null;

  try {
    const [dataAddr, dataName] = ZEST_DATA.split(".");
    const result = await callReadOnly(
      `${dataAddr}.${dataName}`,
      "get-user-position",
      [principalArg],
      address
    );
    if (result?.result && typeof result.result === "string") {
      positionHex = result.result;
    }
  } catch {
    // contract unavailable — return empty position
  }

  if (positionHex) {
    for (const [, asset] of Object.entries(ZEST_ASSETS)) {
      const price = prices[asset.symbol] ?? 0;
      const threshold = asset.liquidationLtv / 100;

      // Collateral: zTokenId = assetId + 1
      const collateralRaw = extractCollateralForZToken(positionHex, asset.assetId + 1);
      if (collateralRaw > 0) {
        const amount = collateralRaw / Math.pow(10, asset.decimals);
        const valueUsd = amount * price;
        supplied[asset.symbol] = { symbol: asset.symbol, amount, valueUsd };
        totalSuppliedUsd += valueUsd;
        weightedThreshold += valueUsd * threshold;
      }

      // Debt
      const debtRaw = extractDebtForAsset(positionHex, asset.assetId);
      if (debtRaw > 0) {
        const amount = debtRaw / Math.pow(10, asset.decimals);
        const valueUsd = amount * price;
        borrowed[asset.symbol] = { symbol: asset.symbol, amount, valueUsd };
        totalBorrowedUsd += valueUsd;
      }
    }
  }

  const liqThreshold = totalSuppliedUsd > 0 ? weightedThreshold / totalSuppliedUsd : 0.80;
  const hf = computeHealthFactor(totalSuppliedUsd, totalBorrowedUsd, liqThreshold);

  let mainCollateral: { symbol: string; amount: number; price: number } | null = null;
  let maxSupplyUsd = 0;
  for (const [symbol, pos] of Object.entries(supplied)) {
    if (pos.valueUsd > maxSupplyUsd) {
      maxSupplyUsd = pos.valueUsd;
      mainCollateral = { symbol, amount: pos.amount, price: prices[symbol] ?? 0 };
    }
  }

  return {
    address,
    healthFactor: hf === Infinity ? -1 : Math.round(hf * 100) / 100,
    supplied,
    borrowed,
    totalSuppliedUsd: Math.round(totalSuppliedUsd * 100) / 100,
    totalBorrowedUsd: Math.round(totalBorrowedUsd * 100) / 100,
    liquidationThreshold: Math.round(liqThreshold * 100) / 100,
    liquidationPrice: mainCollateral
      ? computeLiquidationPrice(mainCollateral, totalBorrowedUsd, liqThreshold)
      : null,
    riskLevel: riskLevel(hf),
    riskScore: Math.round(riskScore(hf) * 100) / 100,
  };
}

async function scanRecentBorrowers(): Promise<string[]> {
  try {
    const [contractAddress, contractName] = ZEST_MARKET.split(".");
    const data = await fetchJson<any>(
      `${HIRO_API}/extended/v1/contract/${contractAddress}.${contractName}/events?limit=50`
    );
    const events = data?.results ?? [];
    const addresses = new Set<string>();
    for (const event of events) {
      const sender = event?.contract_log?.value?.repr?.match(/SP[A-Z0-9]+/)?.[0];
      if (sender) addresses.add(sender);
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

  // Check Zest v2 data contract
  try {
    const [addr, name] = ZEST_DATA.split(".");
    const info = await fetchJson<any>(`${HIRO_API}/v2/contracts/interface/${addr}/${name}`);
    const fnCount = info?.functions?.length ?? 0;
    checks.push({
      name: `Zest v2 data (${ZEST_DATA})`,
      status: fnCount > 0 ? "ok" : "warn",
      detail: `${fnCount} functions found`,
    });
  } catch (e: any) {
    checks.push({ name: "Zest v2 data", status: "fail", detail: e.message });
  }

  // Check Zest v2 market contract
  try {
    const [addr, name] = ZEST_MARKET.split(".");
    const info = await fetchJson<any>(`${HIRO_API}/v2/contracts/interface/${addr}/${name}`);
    const fnCount = info?.functions?.length ?? 0;
    checks.push({
      name: `Zest v2 market (${ZEST_MARKET})`,
      status: fnCount > 0 ? "ok" : "warn",
      detail: `${fnCount} functions found`,
    });
  } catch (e: any) {
    checks.push({ name: "Zest v2 market", status: "fail", detail: e.message });
  }

  // Check prices
  try {
    const prices = await getAssetPrices();
    const stxOk = prices.wSTX > 0;
    const btcOk = prices.sBTC > 0;
    checks.push({
      name: "Price feeds",
      status: stxOk && btcOk ? "ok" : "warn",
      detail: `STX=$${prices.wSTX.toFixed(4)}, BTC=$${prices.sBTC.toFixed(0)}`,
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
      message: "No active Zest v2 borrows found for this address",
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
      message: "No recent borrowers found in Zest v2 market events",
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

  results.sort((a, b) => b.riskScore - a.riskScore);

  ok("scan", {
    scanned: borrowers.length,
    atRisk: results.length,
    minRiskThreshold: minRisk,
    positions: results,
    prices: {
      wSTX: prices.wSTX,
      sBTC: prices.sBTC,
    },
  });
}

async function alertCmd(address: string, threshold: number, confirm: boolean): Promise<void> {
  if (!address || !address.startsWith("SP")) {
    fail("Invalid Stacks address. Must start with SP.");
  }

  if (!confirm) {
    fail(
      "Safety gate: --confirm flag required to run alert mode. " +
      "Example: alert --address SP... --threshold 1.5 --confirm"
    );
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
program
  .name("zest-liquidation-watch")
  .description("Liquidation risk monitor for Zest Protocol v2 on Stacks mainnet")
  .version("2.0.0");

program
  .command("doctor")
  .description("Check connectivity to Hiro API, Zest v2 contracts, and price feeds")
  .action(async () => {
    try {
      await doctorCmd();
    } catch (e: any) {
      fail(`doctor failed: ${e.message}`);
    }
  });

program
  .command("check")
  .description("Check health factor for a single Zest v2 position")
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
  .description("Scan recent Zest v2 borrowers for positions near liquidation")
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
  .description("Alert if health factor drops below threshold (requires --confirm)")
  .option("--address <stx-address>", "Stacks address to check")
  .option("--threshold <number>", "Health factor alert threshold", DEFAULT_ALERT_THRESHOLD.toString())
  .option("--confirm", "Confirm you want to run alert mode (safety gate)")
  .action(async (opts) => {
    try {
      const address = opts.address || process.env.STX_ADDRESS || "";
      if (!address) fail("No address provided. Use --address or set STX_ADDRESS env var.");
      await alertCmd(address, parseFloat(opts.threshold), !!opts.confirm);
    } catch (e: any) {
      fail(`alert failed: ${e.message}`);
    }
  });

program.parse();
