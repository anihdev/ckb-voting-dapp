/**
 * Deploy Configuration
 * ====================
 * Centralizes network selection and ELF artifact lookup for deployment.
 */

import * as path from "path";
import { config as loadDotenv } from "dotenv";

// The deploy package runs with cwd=backend/deploy, so load the repo-root env
// file explicitly instead of relying on process cwd.
loadDotenv({ path: path.resolve(__dirname, "../../.env") });

export const NETWORK: "testnet" | "mainnet" = "testnet";

export const RPC_URLS = {
  testnet: "https://testnet.ckb.dev/",
  mainnet: "https://mainnet.ckb.dev/rpc",
};

export const RPC_URL =
  process.env.CKB_RPC_URL ??
  process.env.VITE_CKB_RPC_URL ??
  RPC_URLS[NETWORK];

// The deployer now targets the Rust CKB-VM ELF artifact, not the TS bundle.
export const CONTRACT_PATH =
  process.env.GOVERNANCE_ELF_PATH ??
  "../contracts-rust/target/riscv64imac-unknown-none-elf/release/governance-contract";
export const MIN_CONFIRMATIONS = 3;

// Optional previous code cell out point for capacity recycling during redeploys.
export const PREVIOUS_CONTRACT_TX_HASH = process.env.PREVIOUS_CONTRACT_TX_HASH;
export const PREVIOUS_CONTRACT_INDEX = Number(process.env.PREVIOUS_CONTRACT_INDEX ?? "0");
export const PREVIOUS_CONTRACT_OUTPOINTS = process.env.PREVIOUS_CONTRACT_OUTPOINTS;

function readFirstEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function assertHex32(
  value: string,
  label: string,
  options: { allowZero?: boolean } = {}
): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be a 32-byte hex string (0x + 64 hex chars).`);
  }
  if (!options.allowZero && value.toLowerCase() === `0x${"00".repeat(32)}`) {
    throw new Error(`${label} cannot be the zero hash.`);
  }
  return value;
}

export function assertRpcUrl(value: string, label = "RPC URL"): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label} must use http or https.`);
  }
  return value;
}

export function requirePrivateKey(): string {
  const privateKey = readFirstEnv(["CKB_PRIVATE_KEY"]);
  if (!privateKey) {
    throw new Error("Set CKB_PRIVATE_KEY before running this script.");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("CKB_PRIVATE_KEY must be a 32-byte hex string.");
  }
  return privateKey;
}

export function requireGovernanceHashes(): {
  codeHash: string;
  scriptTxHash: string;
} {
  const codeHash = readFirstEnv(["GOVERNANCE_CODE_HASH", "VITE_GOVERNANCE_CODE_HASH"]);
  const scriptTxHash = readFirstEnv(["GOVERNANCE_SCRIPT_TX_HASH", "VITE_GOVERNANCE_SCRIPT_TX_HASH"]);
  if (!codeHash) {
    throw new Error("Set GOVERNANCE_CODE_HASH or VITE_GOVERNANCE_CODE_HASH.");
  }
  if (!scriptTxHash) {
    throw new Error("Set GOVERNANCE_SCRIPT_TX_HASH or VITE_GOVERNANCE_SCRIPT_TX_HASH.");
  }
  return {
    codeHash: assertHex32(codeHash, "Governance code hash", { allowZero: false }),
    scriptTxHash: assertHex32(scriptTxHash, "Governance script tx hash", { allowZero: false }),
  };
}
