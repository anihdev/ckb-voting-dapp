/**
 * Deploy Script
 * =============
 * Deploys the Rust-built governance ELF to CKB testnet.
 * The contract binary is stored in a cell's data field.
 * Its data hash becomes the governance scripts' `data1` code hash.
 *
 * File: backend/deploy/deploy.ts
 * Run:  CKB_PRIVATE_KEY=0x... npx ts-node deploy/deploy.ts
 *
 * Prerequisites:
 *   pnpm build:contract:rust
 *   Your deployer address must have testnet CKB.
 *   Get testnet CKB: https://faucet.nervos.org/
 */

import { ccc } from "@ckb-ccc/core";
import * as fs from "fs";
import * as path from "path";
import {
  CONTRACT_PATH,
  RPC_URL,
  MIN_CONFIRMATIONS,
  PREVIOUS_CONTRACT_TX_HASH,
  PREVIOUS_CONTRACT_INDEX,
  PREVIOUS_CONTRACT_OUTPOINTS,
  assertRpcUrl,
  requirePrivateKey,
} from "./config";
import { waitForTransactionConfirmations } from "./tx-lifecycle";

// ─── Read private key from environment ───────────────────────────────────────
const PRIVATE_KEY = requirePrivateKey();
assertRpcUrl(RPC_URL, "CKB RPC URL");
const RPC_RETRY_MAX = 5;

async function withRpcRetry<T>(label: string, task: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RPC_RETRY_MAX; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const message = String((error as any)?.message ?? error).toLowerCase();
      const retryable =
        message.includes("fetch failed") ||
        message.includes("etimedout") ||
        message.includes("eai_again") ||
        message.includes("connect timeout");
      if (!retryable || attempt === RPC_RETRY_MAX) break;
      console.log(`[rpc-retry] ${label} attempt ${attempt}/${RPC_RETRY_MAX} failed; retrying...`);
      await sleep(1200 * attempt);
    }
  }
  throw lastError;
}

// ─── Main deploy function ─────────────────────────────────────────────────────
/**
 * @notice Deploys the governance ELF as a code cell and prints resulting hashes.
 * @dev Supports optional recycling of previous code-cell outpoints to save capacity.
 */
async function deploy(): Promise<void> {
  console.log("=== CKB Voting Contract Deployer ===");
  console.log(`RPC: ${RPC_URL}`);

  // 1. Create CCC client
  const client = new ccc.ClientPublicTestnet({
    url: RPC_URL,
    // Avoid flaky fallback DNS endpoint for deterministic deploy runs.
    fallbacks: [RPC_URL] as any,
  });

  // 2. Create signer from private key
  const signer = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY!);
  const deployerAddress = await withRpcRetry("getAddress", () => signer.getAddressObjSecp256k1());
  console.log(`Deployer address: ${deployerAddress.toString()}`);

  // 3. Read the compiled RISC-V ELF artifact
  const contractPath = path.resolve(__dirname, CONTRACT_PATH);
  if (!fs.existsSync(contractPath)) {
    console.error(`Contract not found at ${contractPath}`);
    console.error("Run: pnpm build:contract:rust");
    process.exit(1);
  }

  const contractCode = fs.readFileSync(contractPath);
  console.log(`Contract ELF: ${contractPath}`);
  console.log(`Contract size: ${(contractCode.length / 1024).toFixed(1)} KB`);

  // 4. Build the deploy transaction. When a previous code cell out point is
  //    supplied, we consume it first so its capacity is recycled into the new
  //    deployment instead of paying fresh occupied capacity every iteration.
  const contractData = ccc.bytesFrom(contractCode);
  const recycledInputs = parseRecycledOutPoints();
  if (recycledInputs.length > 0) {
    console.warn(
      "WARNING: recycling removes the old code dep. Do this only when no live historical data1 cells still require it."
    );
    console.log("Recycling previous code cells:");
    for (const input of recycledInputs) {
      console.log(`  - ${input.previousOutput.txHash}:${input.previousOutput.index}`);
    }
  }

  const tx = ccc.Transaction.from({
    inputs: recycledInputs,
    outputs: [
      {
        // Code cell: no type script, data = contract binary
        lock: deployerAddress.script,
        // capacity calculated by CCC based on data size
      },
    ],
    outputsData: [contractData],
  });

  // 5. Complete any additional inputs needed after recycling.
  await withRpcRetry("completeInputsByCapacity", () => tx.completeInputsByCapacity(signer));
  await withRpcRetry("completeFeeBy", () => tx.completeFeeBy(signer, 1000)); // 1000 shannons/KB fee rate

  console.log("Signing transaction...");
  await withRpcRetry("signTransaction", () => signer.signTransaction(tx));

  console.log("Sending transaction...");
  const txHash = await withRpcRetry("sendTransaction", () => client.sendTransaction(tx));
  console.log(`Deploy TX sent: ${txHash}`);
  console.log(`   View on explorer: https://pudge.explorer.nervos.org/transaction/${txHash}`);

  // 6. Wait for confirmation
  console.log(`Waiting for ${MIN_CONFIRMATIONS} confirmations...`);
  await waitForConfirmation(client, txHash, MIN_CONFIRMATIONS);

  // 7. Derive the data hash of the code cell
  //    code_hash = blake2b(data)  — this is what other scripts reference
  const codeHash = await computeDataHash(client, txHash, 0);

  console.log("\n=== DEPLOYMENT COMPLETE ===");
  console.log(`Contract TX hash:  ${txHash}`);
  console.log(`Contract out_point: { tx_hash: "${txHash}", index: "0x0" }`);
  console.log(`Code hash (blake2b of data): ${codeHash}`);
  if (recycledInputs.length > 0) {
    console.log("Recycled old out_points:");
    for (const input of recycledInputs) {
      console.log(
        `  { tx_hash: "${input.previousOutput.txHash}", index: "0x${Number(input.previousOutput.index).toString(16)}" }`
      );
    }
  }
  console.log("\nFrontend env values:");
  console.log(`VITE_GOVERNANCE_CODE_HASH=${codeHash}`);
  console.log(`VITE_GOVERNANCE_SCRIPT_TX_HASH=${txHash}`);
  console.log(`VITE_CKB_RPC_URL=${RPC_URL}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitForConfirmation(
  client: ccc.Client,
  txHash: string,
  minConf: number
): Promise<void> {
  const timeoutMs = 10 * 60 * 1000;
  const result = await waitForTransactionConfirmations(client, txHash, {
    confirmations: minConf,
    timeoutMs,
    pollIntervalMs: 5000,
    transientRetries: RPC_RETRY_MAX - 1,
    onTransientRetry: (retry, maxRetries) => {
      console.log(
        `[rpc-retry] confirmation polling retry ${retry}/${maxRetries}; transaction was already broadcast`
      );
    },
  });
  console.log(
    `  Confirmed at block ${String((result as any).blockNumber ?? "unknown")} with requested depth ${minConf}`
  );
}

/**
 * @notice Computes the deployed code hash from output data.
 * @dev Mirrors the hash used when constructing governance type scripts.
 */
async function computeDataHash(
  client: ccc.Client,
  txHash: string,
  outputIndex: number
): Promise<string> {
  const tx = await withRpcRetry("getTransaction.hash", () => client.getTransaction(txHash));
  if (!tx) throw new Error("Transaction not found");
  const data = tx.transaction.outputsData[outputIndex];
  // CKB uses blake2b-256 with "ckb-default-hash" personalization
  const hash = ccc.hashCkb(ccc.bytesFrom(data));
  return ccc.hexFrom(hash);
}

/** @notice Promise-based delay helper for polling loops. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @notice Parses optional previous code-cell outpoints for deployment recycling. */
function parseRecycledOutPoints(): Array<{ previousOutput: { txHash: string; index: number } }> {
  if (PREVIOUS_CONTRACT_OUTPOINTS) {
    return PREVIOUS_CONTRACT_OUTPOINTS.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [txHash, rawIndex = "0"] = entry.split(":");
        if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
          throw new Error(`Invalid recycled contract tx hash: ${entry}`);
        }
        const index = Number(rawIndex);
        if (!Number.isInteger(index) || index < 0) {
          throw new Error(`Invalid recycled contract index: ${entry}`);
        }
        return {
          previousOutput: {
            txHash,
            index,
          },
        };
      });
  }

  if (PREVIOUS_CONTRACT_TX_HASH) {
    return [{
      previousOutput: {
        txHash: PREVIOUS_CONTRACT_TX_HASH,
        index: PREVIOUS_CONTRACT_INDEX,
      },
    }];
  }

  return [];
}

deploy().catch((e) => {
  console.error("Deploy failed:", e);
  process.exit(1);
});
