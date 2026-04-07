#!/usr/bin/env bun
/**
 * bitflow-smart-dca
 *
 * Executes Dollar-Cost Averaging (DCA) swaps on Bitflow DEX.
 * Fetches best route via Bitflow BFF API, validates slippage,
 * builds and broadcasts the transaction locally on Stacks mainnet.
 *
 * Author: azagh72-creator (Flying Whale — Genesis L2, ERC-8004 #54)
 * Competition: AIBTC × Bitflow Skills Comp Day 12
 *
 * Mainnet proof TX: cb31d7da62df052e56b32a4ca2a86290f8a64b7ae3e62c2fbef77c50f0bd42a7
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Config
// ============================================================================

const BFF_HOST      = "https://bff.bitflowapis.finance";
const STACKS_API    = "https://api.hiro.so";
const EXPLORER_BASE = "https://explorer.hiro.so/txid";

const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR  = path.join(os.homedir(), ".aibtc", "wallets");

/** Hard cap enforced in code — CLI input above this value is rejected */
const MAX_SLIPPAGE_PCT    = 5;
/** Minimum swap: 1 STX */
const MIN_AMOUNT_MICROSTX = 1_000_000;

// ============================================================================
// Types
// ============================================================================

interface DcaResult {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: string | null;
}

interface BitflowToken {
  /** Full principal, e.g. "SP...contract.token-name" */
  tokenId: string;
  symbol: string;
  name: string;
  decimals: number;
}

interface BitflowQuote {
  amount_out: number;
  min_amount_out: number;
  execution_path: string[];
  /** Price impact in basis points — 100 bps = 1% */
  price_impact_bps: number;
  fee: number;
}

interface BitflowSwapParams {
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: unknown[];
  postConditions: unknown[];
}

// ============================================================================
// Output helpers
// ============================================================================

function out(result: DcaResult): void {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function fail(message: string, action = "dca-error"): void {
  out({ status: "error", action, data: {}, error: message });
}

// ============================================================================
// Bitflow BFF API helpers
// ============================================================================

async function fetchBitflowTokens(): Promise<BitflowToken[]> {
  const res = await fetch(`${BFF_HOST}/api/quotes/v1/tokens`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Bitflow tokens API error: ${res.status}`);
  return res.json() as Promise<BitflowToken[]>;
}

async function getBitflowQuote(
  inputToken: string,
  outputToken: string,
  amountIn: number
): Promise<BitflowQuote | null> {
  const res = await fetch(`${BFF_HOST}/api/quotes/v1/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ input_token: inputToken, output_token: outputToken, amount_in: amountIn }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return res.json() as Promise<BitflowQuote>;
}

async function getBitflowSwapParams(
  inputToken: string,
  outputToken: string,
  amountIn: number,
  slippageBps: number,
  senderAddress: string
): Promise<BitflowSwapParams> {
  const res = await fetch(`${BFF_HOST}/api/quotes/v1/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      input_token:    inputToken,
      output_token:   outputToken,
      amount_in:      amountIn,
      slippage_bps:   slippageBps,
      sender_address: senderAddress,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bitflow swap params API ${res.status}: ${body}`);
  }
  return res.json() as Promise<BitflowSwapParams>;
}

// ============================================================================
// Stacks balance helper
// ============================================================================

async function getStxBalance(address: string): Promise<number> {
  const res = await fetch(`${STACKS_API}/v2/accounts/${address}?proof=0`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Balance fetch failed: ${res.status}`);
  const data = await res.json() as { balance?: string };
  return parseInt(data.balance ?? "0x0", 16);
}

// ============================================================================
// Wallet helpers — AIBTC AES-256-GCM keystore + legacy fallbacks
// ============================================================================

async function decryptAibtcKeystore(enc: Record<string, unknown>, password: string): Promise<string> {
  const { scryptSync, createDecipheriv } = await import("crypto" as any);
  const { N, r, p, keyLen } = enc.scryptParams as Record<string, number>;
  const salt       = Buffer.from(enc.salt as string, "base64");
  const iv         = Buffer.from(enc.iv as string, "base64");
  const authTag    = Buffer.from(enc.authTag as string, "base64");
  const ciphertext = Buffer.from(enc.ciphertext as string, "base64");
  const key        = scryptSync(password, salt, keyLen ?? 32, { N, r, p });
  const decipher   = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8").trim();
}

async function getWalletKeys(password: string): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  // 1. Direct private key (CI / automation)
  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey, TransactionVersion } = await import("@stacks/transactions" as any);
    const key = process.env.STACKS_PRIVATE_KEY;
    return { stxPrivateKey: key, stxAddress: getAddressFromPrivateKey(key, TransactionVersion.Mainnet) };
  }

  const { generateWallet, deriveAccount, getStxAddress } = await import("@stacks/wallet-sdk" as any);

  // 2. AIBTC wallets.json keystore (AES-256-GCM + scrypt)
  if (fs.existsSync(WALLETS_FILE)) {
    try {
      const walletsJson  = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
      const activeWallet = (walletsJson.wallets ?? [])[0];
      if (activeWallet?.id) {
        const keystorePath = path.join(WALLETS_DIR, activeWallet.id, "keystore.json");
        if (fs.existsSync(keystorePath)) {
          const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
          const enc = keystore.encrypted;
          if (enc?.ciphertext) {
            const mnemonic = await decryptAibtcKeystore(enc, password);
            const wallet   = await generateWallet({ secretKey: mnemonic, password: "" });
            const account  = wallet.accounts[0] ?? deriveAccount(wallet, 0);
            return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
          }
          const legacyEnc = keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic;
          if (legacyEnc) {
            const { decryptMnemonic } = await import("@stacks/encryption" as any);
            const mnemonic = await decryptMnemonic(legacyEnc, password);
            const wallet   = await generateWallet({ secretKey: mnemonic, password: "" });
            const account  = wallet.accounts[0] ?? deriveAccount(wallet, 0);
            return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
          }
        }
      }
    } catch (e: any) {
      process.stderr.write(`Keystore decrypt error: ${e.message}\n`);
    }
  }

  // 3. CLIENT_MNEMONIC env var
  if (process.env.CLIENT_MNEMONIC) {
    const wallet  = await generateWallet({ secretKey: process.env.CLIENT_MNEMONIC, password: "" });
    const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
    return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
  }

  throw new Error(
    "No wallet found. Options:\n" +
    "  1. AIBTC wallet: npx @aibtc/mcp-server@latest --install\n" +
    "  2. Set CLIENT_MNEMONIC env var\n" +
    "  3. Set STACKS_PRIVATE_KEY env var"
  );
}

// ============================================================================
// Commands
// ============================================================================

async function cmdDoctor(tokenIn: string, tokenOut: string): Promise<void> {
  const checks: Record<string, string | boolean | number> = {};

  // Stacks RPC
  try {
    const res  = await fetch(`${STACKS_API}/v2/info`, { signal: AbortSignal.timeout(8_000) });
    const info = await res.json() as any;
    checks.stacks_api = res.ok ? `OK — block ${info.burn_block_height ?? "?"}` : `HTTP ${res.status}`;
  } catch (e: any) {
    checks.stacks_api = `unreachable: ${e.message}`;
  }

  // Bitflow BFF token list
  let tokens: BitflowToken[] = [];
  try {
    tokens = await fetchBitflowTokens();
    checks.bitflow_bff = `OK — ${tokens.length} tokens`;
  } catch (e: any) {
    checks.bitflow_bff = `error: ${e.message}`;
    out({ status: "blocked", action: "doctor-blocked", data: { checks }, error: "Bitflow BFF API unreachable." });
    return;
  }

  // Token lookup (full principal from BFF — not fabricated)
  const inTok  = tokens.find(t => t.symbol.toUpperCase() === tokenIn.toUpperCase());
  const outTok = tokens.find(t => t.symbol.toUpperCase() === tokenOut.toUpperCase());
  checks.token_in  = inTok  ? `${inTok.symbol}  — ${inTok.tokenId}`  : `NOT FOUND: ${tokenIn}`;
  checks.token_out = outTok ? `${outTok.symbol} — ${outTok.tokenId}` : `NOT FOUND: ${tokenOut}`;

  if (!inTok || !outTok) {
    out({
      status: "blocked", action: "doctor-blocked",
      data: { checks, available_symbols: tokens.map(t => t.symbol) },
      error: "Token(s) not found on Bitflow. Check symbol spelling.",
    });
    return;
  }

  // Wallet presence
  const hasWallet = fs.existsSync(WALLETS_FILE) || !!process.env.STACKS_PRIVATE_KEY || !!process.env.CLIENT_MNEMONIC;
  checks.wallet = hasWallet ? "present" : "NOT FOUND — run: npx @aibtc/mcp-server@latest --install";

  // Route probe (1 STX sample)
  try {
    const q = await getBitflowQuote(inTok.tokenId, outTok.tokenId, MIN_AMOUNT_MICROSTX);
    checks.route = q
      ? `OK — 1 ${inTok.symbol} → ~${(q.amount_out / Math.pow(10, outTok.decimals)).toFixed(6)} ${outTok.symbol} (${(q.price_impact_bps / 100).toFixed(2)}% impact)`
      : `NO ROUTE — pair may not be supported`;
  } catch (e: any) {
    checks.route = `quote error: ${e.message}`;
  }

  const allGreen = Object.values(checks).every(
    v => typeof v !== "string" || (!v.includes("NOT FOUND") && !v.includes("error") && !v.includes("unreachable") && !v.includes("NO ROUTE"))
  );
  out({ status: allGreen ? "success" : "blocked", action: "doctor", data: { checks, ready: allGreen }, error: allGreen ? null : "One or more checks failed." });
}

async function cmdStatus(
  tokenIn: string,
  tokenOut: string,
  amountMicro: number,
  maxSlippagePct: number
): Promise<void> {
  if (maxSlippagePct > MAX_SLIPPAGE_PCT) {
    fail(`--max-slippage ${maxSlippagePct}% exceeds hard cap of ${MAX_SLIPPAGE_PCT}%.`, "slippage-cap-exceeded");
    return;
  }
  if (amountMicro < MIN_AMOUNT_MICROSTX) {
    fail(`Amount ${amountMicro} is below minimum ${MIN_AMOUNT_MICROSTX} (1 STX).`, "amount-too-small");
    return;
  }

  let tokens: BitflowToken[];
  try { tokens = await fetchBitflowTokens(); } catch (e: any) {
    fail(`Bitflow BFF unreachable: ${e.message}`, "api-error"); return;
  }
  const inTok  = tokens.find(t => t.symbol.toUpperCase() === tokenIn.toUpperCase());
  const outTok = tokens.find(t => t.symbol.toUpperCase() === tokenOut.toUpperCase());
  if (!inTok)  { fail(`Token "${tokenIn}" not found on Bitflow.`, "token-not-found"); return; }
  if (!outTok) { fail(`Token "${tokenOut}" not found on Bitflow.`, "token-not-found"); return; }

  const quote = await getBitflowQuote(inTok.tokenId, outTok.tokenId, amountMicro);
  if (!quote) { fail(`No route for ${tokenIn} → ${tokenOut}.`, "no-route"); return; }

  const impactPct     = quote.price_impact_bps / 100;
  const slippageBlock = impactPct > maxSlippagePct;

  out({
    status: slippageBlock ? "blocked" : "success",
    action: "dca-preview",
    data: {
      tokenIn:         inTok.symbol,
      tokenInId:       inTok.tokenId,
      tokenOut:        outTok.symbol,
      tokenOutId:      outTok.tokenId,
      amountIn:        amountMicro,
      amountIn_human:  `${(amountMicro / Math.pow(10, inTok.decimals)).toFixed(6)} ${inTok.symbol}`,
      amountOut:       quote.amount_out,
      amountOut_human: `~${(quote.amount_out / Math.pow(10, outTok.decimals)).toFixed(8)} ${outTok.symbol}`,
      minOut_human:    `${(quote.min_amount_out / Math.pow(10, outTok.decimals)).toFixed(8)} ${outTok.symbol}`,
      priceImpact:     `${impactPct.toFixed(4)}%`,
      maxSlippage:     `${maxSlippagePct}%`,
      fee:             quote.fee,
      executionPath:   quote.execution_path,
      willExecute:     !slippageBlock,
      hint:            slippageBlock ? null : "Add --confirm to the run command to execute.",
    },
    error: slippageBlock
      ? `Price impact ${impactPct.toFixed(2)}% exceeds max ${maxSlippagePct}%. Wait for better conditions.`
      : null,
  });
}

async function cmdRun(
  tokenIn: string,
  tokenOut: string,
  amountMicro: number,
  maxSlippagePct: number,
  confirm: boolean,
  walletPassword: string | undefined
): Promise<void> {
  // ── Hard caps ──
  if (maxSlippagePct > MAX_SLIPPAGE_PCT) {
    fail(`--max-slippage ${maxSlippagePct}% exceeds hard cap of ${MAX_SLIPPAGE_PCT}%.`, "slippage-cap-exceeded");
    return;
  }
  if (amountMicro < MIN_AMOUNT_MICROSTX) {
    fail(`Amount ${amountMicro} is below minimum ${MIN_AMOUNT_MICROSTX} (1 STX).`, "amount-too-small");
    return;
  }

  // ── Resolve tokens via BFF (full principals — no ad-hoc construction) ──
  let tokens: BitflowToken[];
  try { tokens = await fetchBitflowTokens(); } catch (e: any) {
    fail(`Bitflow BFF unreachable: ${e.message}`, "api-error"); return;
  }
  const inTok  = tokens.find(t => t.symbol.toUpperCase() === tokenIn.toUpperCase());
  const outTok = tokens.find(t => t.symbol.toUpperCase() === tokenOut.toUpperCase());
  if (!inTok)  { fail(`Token "${tokenIn}" not found on Bitflow.`, "token-not-found"); return; }
  if (!outTok) { fail(`Token "${tokenOut}" not found on Bitflow.`, "token-not-found"); return; }

  // ── Quote ──
  const quote = await getBitflowQuote(inTok.tokenId, outTok.tokenId, amountMicro);
  if (!quote) { fail(`No swap route for ${tokenIn} → ${tokenOut}.`, "no-route"); return; }

  const impactPct  = quote.price_impact_bps / 100;
  const amountInH  = amountMicro / Math.pow(10, inTok.decimals);
  const amountOutH = quote.amount_out / Math.pow(10, outTok.decimals);

  // ── Slippage guard (enforced regardless of --confirm) ──
  if (impactPct > maxSlippagePct) {
    out({
      status: "blocked", action: "dca-swap-blocked",
      data: { priceImpact: `${impactPct.toFixed(4)}%`, maxAllowed: `${maxSlippagePct}%`, tokenIn: inTok.symbol, tokenOut: outTok.symbol },
      error: `Slippage ${impactPct.toFixed(2)}% exceeds maximum allowed ${maxSlippagePct}%. Aborting to protect funds.`,
    });
    return;
  }

  // ── Confirmation gate ──
  if (!confirm) {
    out({
      status: "blocked", action: "dca-awaiting-confirm",
      data: {
        tokenIn:         inTok.symbol,
        tokenOut:        outTok.symbol,
        amountIn_human:  `${amountInH.toFixed(6)} ${inTok.symbol}`,
        amountOut_human: `~${amountOutH.toFixed(8)} ${outTok.symbol}`,
        priceImpact:     `${impactPct.toFixed(4)}%`,
        executionPath:   quote.execution_path,
        hint:            "Add --confirm to authorize this swap on-chain.",
      },
      error: null,
    });
    return;
  }

  // ── Wallet ──
  const pwd = walletPassword ?? process.env.AIBTC_WALLET_PASSWORD;
  if (!pwd && !process.env.STACKS_PRIVATE_KEY && !process.env.CLIENT_MNEMONIC) {
    fail("Wallet password required. Pass --wallet-password or set AIBTC_WALLET_PASSWORD.", "no-password");
    return;
  }
  let walletKeys: { stxPrivateKey: string; stxAddress: string };
  try { walletKeys = await getWalletKeys(pwd ?? ""); } catch (e: any) {
    fail(`Wallet error: ${e.message}`, "wallet-error"); return;
  }

  // ── Balance check ──
  try {
    const bal    = await getStxBalance(walletKeys.stxAddress);
    const needed = amountMicro + 10_000; // 0.01 STX fee buffer
    if (bal < needed) {
      fail(`Insufficient balance: ${(bal / 1e6).toFixed(6)} STX available, need ${(needed / 1e6).toFixed(6)} STX.`, "insufficient-balance");
      return;
    }
  } catch {
    process.stderr.write("Warning: could not verify balance — proceeding\n");
  }

  // ── Get swap tx params from BFF (includes post-conditions) ──
  const slippageBps = Math.round(maxSlippagePct * 100);
  let swapParams: BitflowSwapParams;
  try {
    swapParams = await getBitflowSwapParams(inTok.tokenId, outTok.tokenId, amountMicro, slippageBps, walletKeys.stxAddress);
  } catch (e: any) {
    fail(`Failed to get swap params: ${e.message}`, "swap-params-error"); return;
  }

  // ── Sign and broadcast locally ──
  const { makeContractCall, broadcastTransaction, AnchorMode, PostConditionMode } = await import("@stacks/transactions" as any);
  const { STACKS_MAINNET } = await import("@stacks/network" as any);

  let txId: string;
  try {
    const tx = await makeContractCall({
      contractAddress:   swapParams.contractAddress,
      contractName:      swapParams.contractName,
      functionName:      swapParams.functionName,
      functionArgs:      swapParams.functionArgs,
      postConditions:    swapParams.postConditions,
      postConditionMode: PostConditionMode.Deny,
      network:           STACKS_MAINNET,
      senderKey:         walletKeys.stxPrivateKey,
      anchorMode:        AnchorMode.Any,
      fee:               5_000n,
    });
    const broadcastRes = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
    if (broadcastRes.error) throw new Error(`Broadcast: ${broadcastRes.error} — ${broadcastRes.reason ?? ""}`);
    txId = broadcastRes.txid as string;
  } catch (e: any) {
    fail(`Swap execution failed: ${e.message}`, "dca-swap-failed"); return;
  }

  out({
    status: "success", action: "dca-swap-executed",
    data: {
      tokenIn:         inTok.symbol,
      tokenInId:       inTok.tokenId,
      tokenOut:        outTok.symbol,
      tokenOutId:      outTok.tokenId,
      amountIn:        amountMicro,
      amountIn_human:  `${amountInH.toFixed(6)} ${inTok.symbol}`,
      amountOut:       quote.amount_out,
      amountOut_human: `~${amountOutH.toFixed(8)} ${outTok.symbol}`,
      priceImpact:     `${impactPct.toFixed(4)}%`,
      executionPath:   quote.execution_path,
      fee:             quote.fee,
      txid:            txId,
      explorer:        `${EXPLORER_BASE}/${txId}?chain=mainnet`,
      executor:        walletKeys.stxAddress,
    },
    error: null,
  });
}

// ============================================================================
// CLI
// ============================================================================

const program = new Command();

program
  .name("bitflow-smart-dca")
  .description("DCA swaps on Bitflow DEX via BFF API — slippage-guarded, confirm-gated")
  .version("2.0.0");

program
  .command("doctor")
  .description("Check environment, Bitflow BFF API, and token pair validity")
  .requiredOption("--token-in <symbol>",  "Source token symbol (e.g. STX)")
  .requiredOption("--token-out <symbol>", "Target token symbol (e.g. ALEX)")
  .action(async (opts) => { await cmdDoctor(opts.tokenIn, opts.tokenOut); });

program
  .command("status")
  .description("Preview swap quote — no funds moved")
  .requiredOption("--token-in <symbol>",   "Source token symbol")
  .requiredOption("--token-out <symbol>",  "Target token symbol")
  .requiredOption("--amount <microunits>", "Amount in microunits (1 STX = 1000000)", parseInt)
  .option("--max-slippage <pct>",          `Max price impact % (hard cap: ${MAX_SLIPPAGE_PCT}%)`, parseFloat, 2)
  .action(async (opts) => { await cmdStatus(opts.tokenIn, opts.tokenOut, opts.amount, opts.maxSlippage); });

program
  .command("run")
  .description("Execute DCA swap on Bitflow mainnet (irreversible — requires --confirm)")
  .requiredOption("--token-in <symbol>",   "Source token symbol")
  .requiredOption("--token-out <symbol>",  "Target token symbol")
  .requiredOption("--amount <microunits>", "Amount in microunits", parseInt)
  .option("--max-slippage <pct>",          `Max price impact % (hard cap: ${MAX_SLIPPAGE_PCT}%)`, parseFloat, 2)
  .option("--confirm",                     "Required to authorize on-chain execution (safety gate)")
  .option("--wallet-password <password>",  "Wallet decryption password (prefer AIBTC_WALLET_PASSWORD env var)")
  .action(async (opts) => {
    await cmdRun(opts.tokenIn, opts.tokenOut, opts.amount, opts.maxSlippage, opts.confirm === true, opts.walletPassword);
  });

program.parse();
