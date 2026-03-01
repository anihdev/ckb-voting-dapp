// /**
//  * CKB Chain Configuration
//  * ========================
//  * After deploying the voting contract, paste the hashes here.
//  *
//  * File: frontend/src/lib/ckb.ts
//  */

// import { ccc } from "@ckb-ccc/core";

// // ─── PASTE YOUR DEPLOYED HASHES HERE ─────────────────────────────────────────
// // These are populated after running: cd backend/deploy && npm run deploy

// export const VOTING_SCRIPT_CODE_HASH =
//   "0x0000000000000000000000000000000000000000000000000000000000000000"; // <- replace after deploy

// export const VOTING_SCRIPT_TX_HASH =
//   "0x0000000000000000000000000000000000000000000000000000000000000000"; // <- replace after deploy

// // ckb-js-vm (the TypeScript VM that runs our contract)
// // Testnet deployment maintained by Nervos Foundation
// export const CKB_JS_VM_CODE_HASH =
//   "0xbf6fb538763efec2a70a6a3dcb7242787087e1030a4f6c878e50b0f1e0b5a6d0";

// // ─── Script builders ──────────────────────────────────────────────────────────

// /** Operation codes embedded in script args */
// export const OP = {
//   CREATE_POLL: 0x01,
//   CAST_VOTE:   0x02,
//   CLOSE_POLL:  0x03,
// } as const;

// /**
//  * Build the type script for a POLL cell.
//  * args: [op_code(1)] — the ckb-js-vm convention is to prefix args with
//  *       the JS code cell out_point so the VM knows which script to load.
//  */
// export function buildPollTypeScript(op: number): ccc.Script {
//   // ckb-js-vm args convention:
//   //   bytes 0..4  = JS code cell out_point tx_hash (first 4 bytes for fast lookup)
//   //   bytes 4..   = actual script args
//   // For simplicity here we embed op code directly.
//   const argsHex = "0x" + op.toString(16).padStart(2, "0");
//   return ccc.Script.from({
//     codeHash: VOTING_SCRIPT_CODE_HASH,
//     hashType: "data1",
//     args: argsHex,
//   });
// }

// /** Build the type script for a VOTE RECEIPT cell */
// export function buildVoteReceiptTypeScript(pollTypeHash: string): ccc.Script {
//   // Vote receipt args: [OP_CAST_VOTE (1)] + poll_type_hash (32 bytes)
//   const argsHex =
//     "0x" +
//     OP.CAST_VOTE.toString(16).padStart(2, "0") +
//     pollTypeHash.replace("0x", "");
//   return ccc.Script.from({
//     codeHash: VOTING_SCRIPT_CODE_HASH,
//     hashType: "data1",
//     args: argsHex,
//   });
// }

// // ─── CKB network client ───────────────────────────────────────────────────────

// export function createClient(network: "testnet" | "mainnet" = "testnet"): ccc.Client {
//   if (network === "mainnet") {
//     return new ccc.ClientPublicMainnet();
//   }
//   return new ccc.ClientPublicTestnet();
// }

// // ─── Capacity helpers ─────────────────────────────────────────────────────────

// /** 1 CKByte = 100_000_000 shannons */
// export const SHANNON_PER_CKB = 100_000_000n;

// export function ckbToShannons(ckb: number): bigint {
//   return BigInt(Math.round(ckb * 1e8));
// }

// export function shannonsToCkb(shannons: bigint): string {
//   const whole = shannons / SHANNON_PER_CKB;
//   const frac  = shannons % SHANNON_PER_CKB;
//   return `${whole}.${frac.toString().padStart(8, "0")}`;
// }

// /**
//  * Minimum poll cell capacity:
//  *   lock (~53 bytes) + type (~69 bytes) + data (variable) + 8 bytes capacity field
//  */
// export function estimatePollCellCapacity(dataBytes: number): bigint {
//   const fixedOverhead = 53 + 69 + 8; // bytes
//   const total = fixedOverhead + dataBytes;
//   return BigInt(total) * SHANNON_PER_CKB;
// }