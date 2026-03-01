// /**
//  * CKB Type Definitions
//  * =====================
//  * Mirrors the on-chain CKB data structures.
//  * These match the shapes returned by ckb-js-vm syscalls.
//  *
//  * File: backend/contract/src/types.ts
//  */

// export interface Script {
//   code_hash: string; // 0x-prefixed hex (32 bytes)
//   hash_type: "type" | "data" | "data1" | "data2";
//   args: string;      // 0x-prefixed hex
// }

// export interface CellOutput {
//   capacity: bigint;  // shannons
//   lock: Script;
//   type?: Script;
//   data: Uint8Array;
// }

// export interface CellInput {
//   capacity: bigint;
//   lock: Script;
//   lock_hash: Uint8Array; // 32 bytes
//   type?: Script;
//   data: Uint8Array;
// }

// export interface WitnessArgs {
//   lock: Uint8Array;
//   input_type: Uint8Array;
//   output_type: Uint8Array;
// }

// export interface Transaction {
//   inputs: CellInput[];
//   outputs: CellOutput[];
//   witnesses: WitnessArgs[];
// }