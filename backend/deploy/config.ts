/**
 * Deploy Configuration
 * ====================
 * Centralizes network selection and contract artifact lookup for deployment.
 */

export const NETWORK: "testnet" | "mainnet" = "testnet";

export const RPC_URLS = {
  testnet: "https://testnet.ckb.dev/rpc",
  mainnet: "https://mainnet.ckb.dev/rpc",
};

export const RPC_URL = RPC_URLS[NETWORK];

export const CONTRACT_PATH = "../contract/dist/voting_script.js";
export const MIN_CONFIRMATIONS = 3;
