/**
 * Deploy Script
 * =============
 * Deploys the Rust-built governance ELF to CKB testnet.
 * The contract binary is stored in a cell's data field.
 * Its type hash becomes the "voting type script code_hash".
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
} from "./config";

// ─── Read private key from environment ───────────────────────────────────────
const PRIVATE_KEY = process.env.CKB_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Set CKB_PRIVATE_KEY env var before running deploy");
  process.exit(1);
}

// ─── Main deploy function ─────────────────────────────────────────────────────
async function deploy(): Promise<void> {
  console.log("=== CKB Voting Contract Deployer ===");
  console.log(`RPC: ${RPC_URL}`);

  // 1. Create CCC client
  const client = new ccc.ClientPublicTestnet({ url: RPC_URL });

  // 2. Create signer from private key
  const signer = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY!);
  const deployerAddress = await signer.getAddressObjSecp256k1();
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
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 1000); // 1000 shannons/KB fee rate

  console.log("Signing transaction...");
  await signer.signTransaction(tx);

  console.log("Sending transaction...");
  const txHash = await client.sendTransaction(tx);
  console.log(`\n✅ Deploy TX sent: ${txHash}`);
  console.log(`   View on explorer: https://pudge.explorer.nervos.org/transaction/${txHash}`);

  // 6. Wait for confirmation
  console.log(`Waiting for ${MIN_CONFIRMATIONS} confirmations...`);
  await waitForConfirmation(client, txHash, MIN_CONFIRMATIONS);

  // 7. Derive the type hash of the code cell
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
  const POLL_INTERVAL = 5000; // 5 seconds
  let attempts = 0;
  while (true) {
    await sleep(POLL_INTERVAL);
    attempts++;
    try {
      const tx = await client.getTransaction(txHash) as any;
      if (tx && (tx.timeAddedToPool || tx.txStatus || tx.transaction)) {
        console.log(`  Confirmed after ~${attempts * 5}s`);
        return;
      }
    } catch (_) {}
    console.log(`  Waiting... (${attempts * 5}s elapsed)`);
    if (attempts > 120) {
      console.warn("  Timed out waiting for confirmation");
      return;
    }
  }
}

async function computeDataHash(
  client: ccc.Client,
  txHash: string,
  outputIndex: number
): Promise<string> {
  const tx = await client.getTransaction(txHash);
  if (!tx) throw new Error("Transaction not found");
  const data = tx.transaction.outputsData[outputIndex];
  // CKB uses blake2b-256 with "ckb-default-hash" personalization
  const hash = ccc.hashCkb(ccc.bytesFrom(data));
  return ccc.hexFrom(hash);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// ─── Run ──────────────────────────────────────────────────────────────────────
deploy().catch((e) => {
  console.error("Deploy failed:", e);
  process.exit(1);
});
