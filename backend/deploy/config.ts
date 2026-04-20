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
  testnet: "https://testnet.ckb.dev/rpc",
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
