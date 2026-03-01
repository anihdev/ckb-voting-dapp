// /**
//  * Molecule Encoding/Decoding
//  * ==========================
//  * CKB uses the Molecule serialization format.
//  * This file provides pure TypeScript encode/decode for:
//  *   - PollData  (poll cell body)
//  *   - VoteData  (vote receipt cell body)
//  *
//  * Molecule layout reference:
//  *   https://github.com/nervosnetwork/molecule
//  *
//  * File: backend/contract/src/molecule.ts
//  */

// import { hexToBytes, bytesToHex, panic } from "./utils";

// // ─── Molecule Primitive Helpers ───────────────────────────────────────────────

// /** Write a uint32 little-endian into a 4-byte array */
// function encodeUint32(n: number): Uint8Array {
//   const buf = new Uint8Array(4);
//   buf[0] = n & 0xff;
//   buf[1] = (n >> 8) & 0xff;
//   buf[2] = (n >> 16) & 0xff;
//   buf[3] = (n >> 24) & 0xff;
//   return buf;
// }

// function decodeUint32(buf: Uint8Array, offset: number = 0): number {
//   return (
//     buf[offset] |
//     (buf[offset + 1] << 8) |
//     (buf[offset + 2] << 16) |
//     (buf[offset + 3] << 24)
//   );
// }

// /** Write a uint64 little-endian into an 8-byte array */
// function encodeUint64(n: bigint): Uint8Array {
//   const buf = new Uint8Array(8);
//   let v = n;
//   for (let i = 0; i < 8; i++) {
//     buf[i] = Number(v & 0xffn);
//     v >>= 8n;
//   }
//   return buf;
// }

// function decodeUint64(buf: Uint8Array, offset: number = 0): bigint {
//   let result = 0n;
//   for (let i = 7; i >= 0; i--) {
//     result = (result << 8n) | BigInt(buf[offset + i]);
//   }
//   return result;
// }

// /** Encode a UTF-8 string as: uint32_le(len) || bytes */
// function encodeString(s: string): Uint8Array {
//   const enc = new TextEncoder();
//   const bytes = enc.encode(s);
//   const lenBytes = encodeUint32(bytes.length);
//   const out = new Uint8Array(4 + bytes.length);
//   out.set(lenBytes, 0);
//   out.set(bytes, 4);
//   return out;
// }

// function decodeString(buf: Uint8Array, offset: number): [string, number] {
//   const len = decodeUint32(buf, offset);
//   const end = offset + 4 + len;
//   const dec = new TextDecoder();
//   const s = dec.decode(buf.slice(offset + 4, end));
//   return [s, end];
// }

// /** Encode a string[] as: uint32_le(count) || (uint32_le(len) || bytes)* */
// function encodeStringVec(arr: string[]): Uint8Array {
//   const parts: Uint8Array[] = [encodeUint32(arr.length)];
//   for (const s of arr) {
//     parts.push(encodeString(s));
//   }
//   return concatBytes(parts);
// }

// function decodeStringVec(buf: Uint8Array, offset: number): [string[], number] {
//   const count = decodeUint32(buf, offset);
//   offset += 4;
//   const result: string[] = [];
//   for (let i = 0; i < count; i++) {
//     const [s, next] = decodeString(buf, offset);
//     result.push(s);
//     offset = next;
//   }
//   return [result, offset];
// }

// /** Encode a bigint[] (uint64 each) as: uint32_le(count) || uint64_le* */
// function encodeUint64Vec(arr: bigint[]): Uint8Array {
//   const countBytes = encodeUint32(arr.length);
//   const parts: Uint8Array[] = [countBytes];
//   for (const n of arr) {
//     parts.push(encodeUint64(n));
//   }
//   return concatBytes(parts);
// }

// function decodeUint64Vec(buf: Uint8Array, offset: number): [bigint[], number] {
//   const count = decodeUint32(buf, offset);
//   offset += 4;
//   const result: bigint[] = [];
//   for (let i = 0; i < count; i++) {
//     result.push(decodeUint64(buf, offset));
//     offset += 8;
//   }
//   return [result, offset];
// }

// function concatBytes(arrays: Uint8Array[]): Uint8Array {
//   const total = arrays.reduce((acc, a) => acc + a.length, 0);
//   const out = new Uint8Array(total);
//   let pos = 0;
//   for (const a of arrays) {
//     out.set(a, pos);
//     pos += a.length;
//   }
//   return out;
// }

// // ─── PollData ─────────────────────────────────────────────────────────────────

// export interface PollData {
//   question:     string;    // Poll question text
//   options:      string[];  // Answer options (2–10)
//   vote_counts:  bigint[];  // Votes per option (parallel array)
//   deadline:     bigint;    // Epoch number after which no voting
//   creator:      Uint8Array;// 32-byte lock script hash of creator
//   is_closed:    boolean;   // Has the poll been explicitly closed?
//   total_voters: bigint;    // Count of unique voters
// }

// /**
//  * Binary layout (all little-endian):
//  *   [question: string]
//  *   [options: string[]]
//  *   [vote_counts: uint64[]]
//  *   [deadline: uint64]
//  *   [creator: bytes32]
//  *   [is_closed: uint8]  (0x00 = false, 0x01 = true)
//  *   [total_voters: uint64]
//  */
// export function encodePollData(poll: PollData): Uint8Array {
//   if (poll.creator.length !== 32) {
//     panic(`creator must be 32 bytes, got ${poll.creator.length}`);
//   }
//   return concatBytes([
//     encodeString(poll.question),
//     encodeStringVec(poll.options),
//     encodeUint64Vec(poll.vote_counts),
//     encodeUint64(poll.deadline),
//     poll.creator,
//     new Uint8Array([poll.is_closed ? 1 : 0]),
//     encodeUint64(poll.total_voters),
//   ]);
// }

// export function decodePollData(buf: Uint8Array): PollData {
//   let offset = 0;

//   const [question, o1] = decodeString(buf, offset);
//   offset = o1;

//   const [options, o2] = decodeStringVec(buf, offset);
//   offset = o2;

//   const [vote_counts, o3] = decodeUint64Vec(buf, offset);
//   offset = o3;

//   const deadline = decodeUint64(buf, offset);
//   offset += 8;

//   const creator = buf.slice(offset, offset + 32);
//   offset += 32;

//   const is_closed = buf[offset] === 1;
//   offset += 1;

//   const total_voters = decodeUint64(buf, offset);

//   return { question, options, vote_counts, deadline, creator, is_closed, total_voters };
// }

// // ─── VoteData ─────────────────────────────────────────────────────────────────

// export interface VoteData {
//   poll_type_hash: Uint8Array; // 32-byte type script hash of poll cell
//   voter_lock_hash: Uint8Array;// 32-byte lock script hash of voter
//   option_index:   number;     // Which option was selected
//   voted_at_epoch: bigint;     // Epoch at time of vote
// }

// /**
//  * Binary layout:
//  *   [poll_type_hash: bytes32]
//  *   [voter_lock_hash: bytes32]
//  *   [option_index: uint8]
//  *   [voted_at_epoch: uint64]
//  */
// export function encodeVoteData(vote: VoteData): Uint8Array {
//   if (vote.poll_type_hash.length !== 32) {
//     panic("poll_type_hash must be 32 bytes");
//   }
//   if (vote.voter_lock_hash.length !== 32) {
//     panic("voter_lock_hash must be 32 bytes");
//   }
//   return concatBytes([
//     vote.poll_type_hash,
//     vote.voter_lock_hash,
//     new Uint8Array([vote.option_index]),
//     encodeUint64(vote.voted_at_epoch),
//   ]);
// }

// export function decodeVoteData(buf: Uint8Array): VoteData {
//   let offset = 0;

//   const poll_type_hash = buf.slice(offset, offset + 32);
//   offset += 32;

//   const voter_lock_hash = buf.slice(offset, offset + 32);
//   offset += 32;

//   const option_index = buf[offset];
//   offset += 1;

//   const voted_at_epoch = decodeUint64(buf, offset);

//   return { poll_type_hash, voter_lock_hash, option_index, voted_at_epoch };
// }