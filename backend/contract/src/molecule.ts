/**
 * Molecule Encoding/Decoding — v3
 * ==================================
 * Cell data types:
 *   PollData         — poll cell body (includes pending_intent_count and counted voters)
 *   VoteIntentData   — vote intent cell (replaces VoteData — no poll contention)
 *   DelegationData   — delegation cell (scoped voting authority)
 *
 * All integers are little-endian. Strings are prefixed with uint32_LE length.
 * Fixed-size byte arrays (lock hashes etc.) are stored raw with no length prefix.
 *
 * This encoding mirrors the pattern in CKB Position Guardian's collateral cells
 * (collateral/borrowed/owner as u64 LE at fixed offsets).
 */

import { panic } from "./utils";

// ─── Primitive helpers ────────────────────────────────────────────────────────
function encodeUint32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0]=n&0xff; b[1]=(n>>8)&0xff; b[2]=(n>>16)&0xff; b[3]=(n>>24)&0xff;
  return b;
}
function decodeUint32(b: Uint8Array, o=0): number {
  return b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24);
}
function encodeUint64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  let v = n;
  for (let i=0;i<8;i++) { b[i]=Number(v&0xffn); v>>=8n; }
  return b;
}
function decodeUint64(b: Uint8Array, o=0): bigint {
  let r=0n;
  for (let i=7;i>=0;i--) r=(r<<8n)|BigInt(b[o+i]);
  return r;
}
function encodeString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4+bytes.length);
  out.set(encodeUint32(bytes.length));
  out.set(bytes, 4);
  return out;
}
function decodeString(b: Uint8Array, o: number): [string, number] {
  const len = decodeUint32(b, o);
  return [new TextDecoder().decode(b.slice(o+4, o+4+len)), o+4+len];
}
function encodeStringVec(arr: string[]): Uint8Array {
  return concat([encodeUint32(arr.length), ...arr.map(encodeString)]);
}
function decodeStringVec(b: Uint8Array, o: number): [string[], number] {
  const count = decodeUint32(b, o); o+=4;
  const r: string[] = [];
  for (let i=0;i<count;i++) { const [s,no]=decodeString(b,o); r.push(s); o=no; }
  return [r, o];
}
function encodeUint64Vec(arr: bigint[]): Uint8Array {
  return concat([encodeUint32(arr.length), ...arr.map(encodeUint64)]);
}
function decodeUint64Vec(b: Uint8Array, o: number): [bigint[], number] {
  const count = decodeUint32(b, o); o+=4;
  const r: bigint[] = [];
  for (let i=0;i<count;i++) { r.push(decodeUint64(b,o)); o+=8; }
  return [r, o];
}
function encodeBytes32Vec(arr: Uint8Array[]): Uint8Array {
  for (const item of arr) {
    if (item.length !== 32) panic("bytes32 vector item must be 32 bytes");
  }
  return concat([encodeUint32(arr.length), ...arr]);
}
function decodeBytes32Vec(b: Uint8Array, o: number): [Uint8Array[], number] {
  const count = decodeUint32(b, o); o += 4;
  const r: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    r.push(b.slice(o, o + 32));
    o += 32;
  }
  return [r, o];
}
function concat(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((a,b)=>a+b.length, 0);
  const out = new Uint8Array(total);
  let pos=0;
  for (const a of arrays) { out.set(a,pos); pos+=a.length; }
  return out;
}

function encodeBytes(bytes: Uint8Array): Uint8Array {
  return concat([encodeUint32(bytes.length), bytes]);
}

function decodeBytes(bytes: Uint8Array, offset: number): [Uint8Array, number] {
  const len = decodeUint32(bytes, offset);
  return [bytes.slice(offset + 4, offset + 4 + len), offset + 4 + len];
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  const output = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    output[index / 2] = parseInt(normalized.slice(index, index + 2), 16);
  }
  return output;
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export interface EncodedScript {
  code_hash: string;
  hash_type: "type" | "data" | "data1" | "data2";
  args: string;
}

function hashTypeToByte(hashType: EncodedScript["hash_type"]): number {
  switch (hashType) {
    case "data": return 0;
    case "type": return 1;
    case "data1": return 2;
    case "data2": return 4;
  }
}

function byteToHashType(value: number): EncodedScript["hash_type"] {
  switch (value) {
    case 0: return "data";
    case 1: return "type";
    case 2: return "data1";
    case 4: return "data2";
    default: panic(`Unknown hash_type byte: ${value}`);
  }
}

function encodeScript(script: EncodedScript): Uint8Array {
  const codeHashBytes = hexToBytes(script.code_hash);
  if (codeHashBytes.length !== 32) panic("script.code_hash must be 32 bytes");

  return concat([
    codeHashBytes,
    new Uint8Array([hashTypeToByte(script.hash_type)]),
    encodeBytes(hexToBytes(script.args)),
  ]);
}

function decodeScript(bytes: Uint8Array, offset: number): [EncodedScript, number] {
  const code_hash = bytesToHex(bytes.slice(offset, offset + 32));
  offset += 32;
  const hash_type = byteToHashType(bytes[offset]);
  offset += 1;
  const [argsBytes, nextOffset] = decodeBytes(bytes, offset);
  return [{ code_hash, hash_type, args: bytesToHex(argsBytes) }, nextOffset];
}

// ─── PollData ────────────────────────────────────────────────────────────────
export interface PollData {
  question:              string;
  options:               string[];
  vote_counts:           bigint[];
  deadline:              bigint;
  creator:               Uint8Array;  // 32 bytes — lock hash
  is_closed:             boolean;
  total_voters:          bigint;      // aggregated voter count
  creator_deposit:       bigint;      // shannons locked by creator
  pending_intent_count:  bigint;      // intents created but not yet aggregated
  counted_voter_lock_hashes: Uint8Array[]; // on-chain uniqueness registry
  token_weighted:        boolean;     // future: weight by xUDT balance
  udt_type_hash:         Uint8Array;  // 32 bytes (zero if not token-weighted)
}

/**
 * Layout:
 *   string           question
 *   string[]         options
 *   uint64[]         vote_counts
 *   uint64           deadline
 *   bytes32          creator
 *   uint8            is_closed
 *   uint64           total_voters
 *   uint64           creator_deposit
 *   uint64           pending_intent_count  ← new in v3
 *   bytes32[]        counted_voter_lock_hashes
 *   uint8            token_weighted
 *   bytes32          udt_type_hash
 */
export function encodePollData(p: PollData): Uint8Array {
  if (p.creator.length !== 32) panic("creator must be 32 bytes");
  if (p.udt_type_hash.length !== 32) panic("udt_type_hash must be 32 bytes");
  return concat([
    encodeString(p.question),
    encodeStringVec(p.options),
    encodeUint64Vec(p.vote_counts),
    encodeUint64(p.deadline),
    p.creator,
    new Uint8Array([p.is_closed?1:0]),
    encodeUint64(p.total_voters),
    encodeUint64(p.creator_deposit),
    encodeUint64(p.pending_intent_count),
    encodeBytes32Vec(p.counted_voter_lock_hashes),
    new Uint8Array([p.token_weighted?1:0]),
    p.udt_type_hash,
  ]);
}

export function decodePollData(b: Uint8Array): PollData {
  let o=0;
  const [question,o1]=decodeString(b,o);           o=o1;
  const [options,o2]=decodeStringVec(b,o);          o=o2;
  const [vote_counts,o3]=decodeUint64Vec(b,o);      o=o3;
  const deadline=decodeUint64(b,o);                 o+=8;
  const creator=b.slice(o,o+32);                    o+=32;
  const is_closed=b[o]===1;                         o+=1;
  const total_voters=decodeUint64(b,o);             o+=8;
  const creator_deposit=decodeUint64(b,o);          o+=8;
  const pending_intent_count=decodeUint64(b,o);     o+=8;
  const [counted_voter_lock_hashes,o4]=decodeBytes32Vec(b,o); o=o4;
  const token_weighted=b[o]===1;                    o+=1;
  const udt_type_hash=b.slice(o,o+32);
  return {
    question, options, vote_counts, deadline, creator, is_closed,
    total_voters, creator_deposit, pending_intent_count, counted_voter_lock_hashes,
    token_weighted, udt_type_hash,
  };
}

// ─── VoteIntentData ──────────────────────────────────────────────────────────
/**
 * Replaces VoteData. A vote intent records the voter's choice without
 * touching the poll cell — eliminating UTXO contention.
 *
 * Layout:
 *   bytes32  poll_type_hash   — identifies which poll this intent belongs to
 *   bytes32  voter_lock_hash  — voter's lock hash (delegator's if via delegation)
 *   uint8    option_index     — which option was chosen
 *   uint64   voted_at_epoch   — epoch when intent was created
 *   uint8    aggregated       — 0=pending, 1=counted in poll vote_counts
 *   Script   refund_lock      — exact lock script used for deposit return
 */
export interface VoteIntentData {
  poll_type_hash:  Uint8Array;  // 32 bytes
  voter_lock_hash: Uint8Array;  // 32 bytes
  option_index:    number;
  voted_at_epoch:  bigint;
  aggregated:      boolean;     // key field — set by AGGREGATE_VOTES
  refund_lock:     EncodedScript;
}

export function encodeVoteIntentData(v: VoteIntentData): Uint8Array {
  if (v.poll_type_hash.length !== 32) panic("poll_type_hash must be 32 bytes");
  if (v.voter_lock_hash.length !== 32) panic("voter_lock_hash must be 32 bytes");
  return concat([
    v.poll_type_hash,
    v.voter_lock_hash,
    new Uint8Array([v.option_index]),
    encodeUint64(v.voted_at_epoch),
    new Uint8Array([v.aggregated?1:0]),
    encodeScript(v.refund_lock),
  ]);
}

export function decodeVoteIntentData(b: Uint8Array): VoteIntentData {
  if (b.length < 74) panic(`VoteIntentData too short: ${b.length} (need >= 74)`);
  let o=0;
  const poll_type_hash=b.slice(o,o+32);   o+=32;
  const voter_lock_hash=b.slice(o,o+32);  o+=32;
  const option_index=b[o];                o+=1;
  const voted_at_epoch=decodeUint64(b,o); o+=8;
  const aggregated=b[o]===1;              o+=1;
  const [refund_lock] = decodeScript(b, o);
  return { poll_type_hash, voter_lock_hash, option_index, voted_at_epoch, aggregated, refund_lock };
}

// ─── DelegationData ──────────────────────────────────────────────────────────
/**
 * Layout (104 bytes fixed):
 *   bytes32  delegator_lock_hash
 *   bytes32  delegate_lock_hash
 *   bytes32  poll_type_hash      (0x00...00 = applies to all polls)
 *   uint64   expires_epoch       (0 = no expiry)
 */
export interface DelegationData {
  delegator_lock_hash: Uint8Array;
  delegate_lock_hash:  Uint8Array;
  poll_type_hash:      Uint8Array;
  expires_epoch:       bigint;
}

export function encodeDelegationData(d: DelegationData): Uint8Array {
  if (d.delegator_lock_hash.length !== 32) panic("delegator_lock_hash must be 32 bytes");
  if (d.delegate_lock_hash.length !== 32) panic("delegate_lock_hash must be 32 bytes");
  if (d.poll_type_hash.length !== 32) panic("poll_type_hash must be 32 bytes");
  return concat([
    d.delegator_lock_hash,
    d.delegate_lock_hash,
    d.poll_type_hash,
    encodeUint64(d.expires_epoch),
  ]);
}

export function decodeDelegationData(b: Uint8Array): DelegationData {
  if (b.length < 104) panic(`DelegationData too short: ${b.length} (need 104)`);
  let o=0;
  const delegator_lock_hash=b.slice(o,o+32); o+=32;
  const delegate_lock_hash=b.slice(o,o+32);  o+=32;
  const poll_type_hash=b.slice(o,o+32);       o+=32;
  const expires_epoch=decodeUint64(b,o);
  return { delegator_lock_hash, delegate_lock_hash, poll_type_hash, expires_epoch };
}
