// /**
//  * Deploy Configuration
//  * =====================
//  * Edit NETWORK to switch between testnet/mainnet.
//  *
//  * File: backend/deploy/config.ts
//  */

// export const NETWORK: "testnet" | "mainnet" = "testnet";

// export const RPC_URLS = {
//   testnet: "https://testnet.ckb.dev/rpc",
//   mainnet: "https://mainnet.ckb.dev/rpc",
// };

// export const RPC_URL = RPC_URLS[NETWORK];

// // ckb-js-vm type script (already deployed by Nervos — use as dependency)
// // Source: https://github.com/nervosnetwork/ckb-js-vm
// export const CKB_JS_VM = {
//   testnet: {
//     code_hash: "0x01000000000000000000000000000000000000000000000000000000000000001",
//     hash_type: "data1" as const,
//     // The actual out_point of ckb-js-vm on testnet:
//     tx_hash: "0xbf6fb538763efec2a70a6a3dcb7242787087e1030a4f6c878e50b0f1e0b5a6d0",
//     index: "0x0",
//   },
// };

// // Path to compiled contract
// export const CONTRACT_PATH = "../contract/dist/voting_script.js";

// // Minimum confirmation blocks before we consider a tx final
// export const MIN_CONFIRMATIONS = 3;