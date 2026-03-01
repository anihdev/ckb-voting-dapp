// /**
//  * Frontend Molecule Codec
//  * =======================
//  * Mirrors backend/contract/src/molecule.ts exactly.
//  * Used to encode TX data before sending and decode cell data when querying.
//  *
//  * File: frontend/src/lib/molecule.ts
//  */

// export interface PollData {
//   question:     string;
//   options:      string[];
//   vote_counts:  bigint[];
//   deadline:     bigint;
//   creator:      Uint8Array; // 32 bytes
//   is_closed:    boolean;
//   total_voters: bigint;
// }

// export interface VoteData {
//   poll_type_hash:  Uint8Array; // 32 bytes
//   voter_lock_hash: Uint8Array; // 32 bytes
//   option_index:    number;
//   voted_at_epoch:  bigint;
// }

// // ─── Primitives ───────────────────────────────────────────────────────────────

// function encodeUint32(n: number): Uint8Array {
//   const b = new Uint8Array(4);
//   b[0] = n & 0xff;  b[1] = (n >> 8) & 0xff;
//   b[2] = (n >> 16) & 0xff;  b[3] = (n >> 24) & 0xff;
//   return b;
// }
// function decodeUint32(b: Uint8Array, o = 0): number {
//   return b[o] | (b[o+1]<<8) | (b[o+2]<<16) | (b[o+3]<<24);
// }
// function encodeUint64(n: bigint): Uint8Array {
//   const b = new Uint8Array(8);
//   let v = n;
//   for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
//   return b;
// }
// function decodeUint64(b: Uint8Array, o = 0): bigint {
//   let r = 0n;
//   for (let i = 7; i >= 0; i--) r = (r << 8n) | BigInt(b[o + i]);
//   return r;
// }
// function encodeStr(s: string): Uint8Array {
//   const bytes = new TextEncoder().encode(s);
//   const out = new Uint8Array(4 + bytes.length);
//   out.set(encodeUint32(bytes.length), 0);
//   out.set(bytes, 4);
//   return out;
// }
// function decodeStr(b: Uint8Array, o: number): [string, number] {
//   const len = decodeUint32(b, o);
//   return [new TextDecoder().decode(b.slice(o+4, o+4+len)), o+4+len];
// }
// function encodeStrVec(arr: string[]): Uint8Array {
//   return concat([encodeUint32(arr.length), ...arr.map(encodeStr)]);
// }
// function decodeStrVec(b: Uint8Array, o: number): [string[], number] {
//   const count = decodeUint32(b, o); o += 4;
//   const res: string[] = [];
//   for (let i = 0; i < count; i++) { const [s, n] = decodeStr(b, o); res.push(s); o = n; }
//   return [res, o];
// }
// function encodeU64Vec(arr: bigint[]): Uint8Array {
//   return concat([encodeUint32(arr.length), ...arr.map(encodeUint64)]);
// }
// function decodeU64Vec(b: Uint8Array, o: number): [bigint[], number] {
//   const count = decodeUint32(b, o); o += 4;
//   const res: bigint[] = [];
//   for (let i = 0; i < count; i++) { res.push(decodeUint64(b, o)); o += 8; }
//   return [res, o];
// }
// function concat(arrays: Uint8Array[]): Uint8Array {
//   const total = arrays.reduce((s, a) => s + a.length, 0);
//   const out = new Uint8Array(total);
//   let pos = 0;
//   for (const a of arrays) { out.set(a, pos); pos += a.length; }
//   return out;
// }

// // ─── Public API ───────────────────────────────────────────────────────────────

// export function encodePollData(p: PollData): Uint8Array {
//   return concat([
//     encodeStr(p.question),
//     encodeStrVec(p.options),
//     encodeU64Vec(p.vote_counts),
//     encodeUint64(p.deadline),
//     p.creator,
//     new Uint8Array([p.is_closed ? 1 : 0]),
//     encodeUint64(p.total_voters),
//   ]);
// }

// export function decodePollData(buf: Uint8Array): PollData {
//   let o = 0;
//   const [question, o1] = decodeStr(buf, o); o = o1;
//   const [options, o2]  = decodeStrVec(buf, o); o = o2;
//   const [vote_counts, o3] = decodeU64Vec(buf, o); o = o3;
//   const deadline    = decodeUint64(buf, o); o += 8;
//   const creator     = buf.slice(o, o+32); o += 32;
//   const is_closed   = buf[o] === 1; o += 1;
//   const total_voters = decodeUint64(buf, o);
//   return { question, options, vote_counts, deadline, creator, is_closed, total_voters };
// }

// export function encodeVoteData(v: VoteData): Uint8Array {
//   return concat([
//     v.poll_type_hash,
//     v.voter_lock_hash,
//     new Uint8Array([v.option_index]),
//     encodeUint64(v.voted_at_epoch),
//   ]);
// }

// export function decodeVoteData(buf: Uint8Array): VoteData {
//   let o = 0;
//   const poll_type_hash  = buf.slice(o, o+32); o += 32;
//   const voter_lock_hash = buf.slice(o, o+32); o += 32;
//   const option_index    = buf[o]; o += 1;
//   const voted_at_epoch  = decodeUint64(buf, o);
//   return { poll_type_hash, voter_lock_hash, option_index, voted_at_epoch };
// }

// // ─── Convenience ─────────────────────────────────────────────────────────────

// export function hexToBytes(hex: string): Uint8Array {
//   const h = hex.startsWith("0x") ? hex.slice(2) : hex;
//   const b = new Uint8Array(h.length / 2);
//   for (let i = 0; i < h.length; i += 2) b[i/2] = parseInt(h.slice(i, i+2), 16);
//   return b;
// }

// export function bytesToHex(b: Uint8Array): string {
//   return "0x" + Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
// }