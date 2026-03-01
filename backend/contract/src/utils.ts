// /**
//  * Utility Functions
//  * =================
//  * Two sections:
//  *   1. Pure helpers: hexToBytes, bytesToHex, compareBytes, etc.
//  *   2. CKB syscall wrappers: loadInputCell, loadOutputCell, etc.
//  *      In real ckb-js-vm these call native C functions.
//  *      In Node.js test mode they use the mock TX_CONTEXT global.
//  *
//  * File: backend/contract/src/utils.ts
//  */

// import { CellInput, CellOutput, WitnessArgs } from "./types";

// // ─── Logging ──────────────────────────────────────────────────────────────────

// export function log(msg: string): void {
//   // ckb-js-vm exposes a global `ckb.debug()` — use console.log as fallback
//   if (typeof ckb !== "undefined" && typeof (ckb as any).debug === "function") {
//     (ckb as any).debug(msg);
//   } else {
//     console.log(`[CKB-SCRIPT] ${msg}`);
//   }
// }

// export function panic(msg: string): never {
//   log(`PANIC: ${msg}`);
//   throw new Error(`Script failed: ${msg}`);
// }

// export function assert(condition: boolean, msg: string): asserts condition {
//   if (!condition) {
//     panic(msg);
//   }
// }

// // ─── Pure Helpers ─────────────────────────────────────────────────────────────

// export function hexToBytes(hex: string): Uint8Array {
//   const h = hex.startsWith("0x") ? hex.slice(2) : hex;
//   if (h.length % 2 !== 0) {
//     panic(`Odd-length hex string: ${hex}`);
//   }
//   const bytes = new Uint8Array(h.length / 2);
//   for (let i = 0; i < h.length; i += 2) {
//     bytes[i / 2] = parseInt(h.slice(i, i + 2), 16);
//   }
//   return bytes;
// }

// export function bytesToHex(bytes: Uint8Array): string {
//   return (
//     "0x" +
//     Array.from(bytes)
//       .map((b) => b.toString(16).padStart(2, "0"))
//       .join("")
//   );
// }

// export function compareBytes(a: Uint8Array, b: Uint8Array): boolean {
//   if (a.length !== b.length) return false;
//   for (let i = 0; i < a.length; i++) {
//     if (a[i] !== b[i]) return false;
//   }
//   return true;
// }

// // ─── CKB Syscall Wrappers ─────────────────────────────────────────────────────

// /**
//  * In ckb-js-vm, these syscalls are native C bindings.
//  * For Node.js testing, we read from a global TX_CONTEXT object
//  * that tests inject before calling main().
//  *
//  * See tests/contract.test.ts for how TX_CONTEXT is set.
//  */

// declare const ckb: any;
// declare const TX_CONTEXT: {
//   script_args: Uint8Array;
//   inputs: Array<{ capacity: bigint; lock: any; lock_hash: Uint8Array; data: Uint8Array }>;
//   outputs: Array<{ capacity: bigint; lock: any; data: Uint8Array }>;
//   witnesses: Array<{ lock: Uint8Array; input_type: Uint8Array; output_type: Uint8Array }>;
//   current_epoch: bigint;
// };

// export function loadScriptArgs(): Uint8Array {
//   if (typeof ckb !== "undefined") {
//     return ckb.load_script_args();
//   }
//   return TX_CONTEXT.script_args;
// }

// export function loadInputCell(index: number): CellInput | null {
//   if (typeof ckb !== "undefined") {
//     const raw = ckb.load_cell(index, 0); // 0 = input source
//     if (!raw) return null;
//     return raw as CellInput;
//   }
//   const cell = TX_CONTEXT.inputs[index];
//   return cell ?? null;
// }

// export function loadOutputCell(index: number): CellOutput | null {
//   if (typeof ckb !== "undefined") {
//     const raw = ckb.load_cell(index, 1); // 1 = output source
//     if (!raw) return null;
//     return raw as CellOutput;
//   }
//   const cell = TX_CONTEXT.outputs[index];
//   return cell ?? null;
// }

// export function loadWitnessArgs(index: number): WitnessArgs | null {
//   if (typeof ckb !== "undefined") {
//     return ckb.load_witness_args(index, 0);
//   }
//   const w = TX_CONTEXT.witnesses[index];
//   return w ?? null;
// }

// export function currentEpoch(): bigint {
//   if (typeof ckb !== "undefined") {
//     const headerDep = ckb.load_header(0, 2); // latest header
//     return BigInt(headerDep.epoch);
//   }
//   return TX_CONTEXT.current_epoch;
// }