/**
 * Frontend Molecule Codec
 * =======================
 * Mirrors the backend contract codec so frontend builders and indexers
 * serialize exactly the same poll, intent, and delegation layouts.
 */

import {
  MAX_TALLY_AGGREGATION_PROOF_BYTES,
  TALLY_AGGREGATION_PROOF_VERSION,
  TALLY_SHARD_CODEC_VERSION,
} from "./constants.js";

export interface PollData {
  question: string;
  options: string[];
  vote_counts: bigint[];
  deadline: bigint;
  creator: Uint8Array;
  creator_lock: EncodedScript;
  is_closed: boolean;
  total_voters: bigint;
  creator_deposit: bigint;
  pending_intent_count: bigint;
  counted_voter_lock_hashes: Uint8Array[];
  token_weighted: boolean;
  udt_type_hash: Uint8Array;
  shard_count: number;
}

export interface VoteIntentData {
  poll_type_hash: Uint8Array;
  voter_lock_hash: Uint8Array;
  option_index: number;
  // Legacy codec field retained for compatibility. It is caller-selected and
  // must never be used as consensus submission time.
  voted_at_epoch: bigint;
  aggregated: boolean;
  refund_lock: EncodedScript;
}

export interface DelegationData {
  delegator_lock_hash: Uint8Array;
  delegate_lock_hash: Uint8Array;
  poll_type_hash: Uint8Array;
  // Reserved in v1. The contract requires zero and delegation ends by revoke.
  expires_epoch: bigint;
}

export interface TallyShardData {
  version: number;
  poll_type_hash: Uint8Array;
  shard_id: number;
  shard_count: number;
  vote_counts: bigint[];
  total_voters: bigint;
  counted_voter_root: Uint8Array;
  finalized: boolean;
}

export interface TallyAggregationProof {
  version: number;
  compiled_proof: Uint8Array;
}

export interface TallyMergeResultData {
  poll_type_hash: Uint8Array;
  coverage: Uint8Array;
  vote_counts: bigint[];
  total_voters: bigint;
  merge_level: number;
  version: number;
}

export interface EncodedScript {
  code_hash: string;
  hash_type: "type" | "data" | "data1" | "data2";
  args: string;
}

function assertCodec(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function decodeBool(bytes: Uint8Array, offset: number, fieldName: string): boolean {
  assertCodec(bytes.length > offset, `${fieldName} decode out of bounds`);
  assertCodec(bytes[offset] === 0 || bytes[offset] === 1, `${fieldName} must be 0 or 1`);
  return bytes[offset] === 1;
}

function encodeUint32(value: number): Uint8Array {
  assertCodec(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, "uint32 value out of range");
  const bytes = new Uint8Array(4);
  bytes[0] = value & 0xff;
  bytes[1] = (value >> 8) & 0xff;
  bytes[2] = (value >> 16) & 0xff;
  bytes[3] = (value >> 24) & 0xff;
  return bytes;
}

function decodeUint32(bytes: Uint8Array, offset = 0): number {
  assertCodec(bytes.length >= offset + 4, "uint32 decode out of bounds");
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function encodeUint64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let current = value;
  for (let index = 0; index < 8; index += 1) {
    bytes[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  return bytes;
}

function decodeUint64(bytes: Uint8Array, offset = 0): bigint {
  assertCodec(bytes.length >= offset + 8, "uint64 decode out of bounds");
  let result = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    result = (result << 8n) | BigInt(bytes[offset + index]);
  }
  return result;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function encodeString(value: string): Uint8Array {
  const textBytes = new TextEncoder().encode(value);
  const output = new Uint8Array(4 + textBytes.length);
  output.set(encodeUint32(textBytes.length), 0);
  output.set(textBytes, 4);
  return output;
}

function decodeString(bytes: Uint8Array, offset: number): [string, number] {
  const length = decodeUint32(bytes, offset);
  assertCodec(bytes.length >= offset + 4 + length, "string decode out of bounds");
  return [new TextDecoder().decode(bytes.slice(offset + 4, offset + 4 + length)), offset + 4 + length];
}

function encodeStringVec(values: string[]): Uint8Array {
  return concat([encodeUint32(values.length), ...values.map(encodeString)]);
}

function decodeStringVec(bytes: Uint8Array, offset: number): [string[], number] {
  const count = decodeUint32(bytes, offset);
  let currentOffset = offset + 4;
  const values: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const [value, nextOffset] = decodeString(bytes, currentOffset);
    values.push(value);
    currentOffset = nextOffset;
  }

  return [values, currentOffset];
}

function encodeUint64Vec(values: bigint[]): Uint8Array {
  return concat([encodeUint32(values.length), ...values.map(encodeUint64)]);
}

function decodeUint64Vec(bytes: Uint8Array, offset: number): [bigint[], number] {
  const count = decodeUint32(bytes, offset);
  let currentOffset = offset + 4;
  const values: bigint[] = [];

  for (let index = 0; index < count; index += 1) {
    values.push(decodeUint64(bytes, currentOffset));
    currentOffset += 8;
  }

  return [values, currentOffset];
}

function encodeBytes32Vec(values: Uint8Array[]): Uint8Array {
  for (const value of values) {
    assertCodec(value.length === 32, "counted voter lock hash must be 32 bytes");
  }

  return concat([encodeUint32(values.length), ...values]);
}

function decodeBytes32Vec(bytes: Uint8Array, offset: number): [Uint8Array[], number] {
  const count = decodeUint32(bytes, offset);
  let currentOffset = offset + 4;
  const values: Uint8Array[] = [];

  for (let index = 0; index < count; index += 1) {
    assertCodec(bytes.length >= currentOffset + 32, "bytes32 vec decode out of bounds");
    values.push(bytes.slice(currentOffset, currentOffset + 32));
    currentOffset += 32;
  }

  return [values, currentOffset];
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

function encodeBytes(bytes: Uint8Array): Uint8Array {
  return concat([encodeUint32(bytes.length), bytes]);
}

function decodeBytes(bytes: Uint8Array, offset: number): [Uint8Array, number] {
  const length = decodeUint32(bytes, offset);
  assertCodec(bytes.length >= offset + 4 + length, "bytes decode out of bounds");
  return [bytes.slice(offset + 4, offset + 4 + length), offset + 4 + length];
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
    default: throw new Error(`Unknown hash_type byte: ${value}`);
  }
}

function encodeScript(script: EncodedScript): Uint8Array {
  const codeHashBytes = hexToBytes(script.code_hash);
  assertCodec(codeHashBytes.length === 32, "script.code_hash must be 32 bytes");
  return concat([
    codeHashBytes,
    new Uint8Array([hashTypeToByte(script.hash_type)]),
    encodeBytes(hexToBytes(script.args)),
  ]);
}

function decodeScript(bytes: Uint8Array, offset: number): [EncodedScript, number] {
  const code_hash = bytesToHex(bytes.slice(offset, offset + 32));
  assertCodec(bytes.length >= offset + 32, "script code_hash decode out of bounds");
  offset += 32;
  assertCodec(bytes.length > offset, "script hash_type decode out of bounds");
  const hash_type = byteToHashType(bytes[offset]);
  offset += 1;
  const [argsBytes, nextOffset] = decodeBytes(bytes, offset);
  return [{ code_hash, hash_type, args: bytesToHex(argsBytes) }, nextOffset];
}

export function encodePollData(poll: PollData): Uint8Array {
  assertCodec(poll.creator.length === 32, "creator must be 32 bytes");
  assertCodec(poll.udt_type_hash.length === 32, "udt_type_hash must be 32 bytes");
  assertCodec(poll.shard_count > 0, "poll.shard_count must be positive");
  assertCodec(poll.shard_count <= 256, "poll.shard_count exceeds protocol maximum");

  return concat([
    encodeString(poll.question),
    encodeStringVec(poll.options),
    encodeUint64Vec(poll.vote_counts),
    encodeUint64(poll.deadline),
    poll.creator,
    encodeScript(poll.creator_lock),
    new Uint8Array([poll.is_closed ? 1 : 0]),
    encodeUint64(poll.total_voters),
    encodeUint64(poll.creator_deposit),
    encodeUint64(poll.pending_intent_count),
    encodeBytes32Vec(poll.counted_voter_lock_hashes),
    new Uint8Array([poll.token_weighted ? 1 : 0]),
    poll.udt_type_hash,
    encodeUint32(poll.shard_count),
  ]);
}

export function decodePollData(bytes: Uint8Array): PollData {
  let offset = 0;
  const [question, nextQuestionOffset] = decodeString(bytes, offset);
  offset = nextQuestionOffset;
  const [options, nextOptionsOffset] = decodeStringVec(bytes, offset);
  offset = nextOptionsOffset;
  const [vote_counts, nextCountsOffset] = decodeUint64Vec(bytes, offset);
  offset = nextCountsOffset;

  const deadline = decodeUint64(bytes, offset);
  offset += 8;
  assertCodec(bytes.length >= offset + 32, "creator decode out of bounds");
  const creator = bytes.slice(offset, offset + 32);
  offset += 32;
  const [creator_lock, nextCreatorLockOffset] = decodeScript(bytes, offset);
  offset = nextCreatorLockOffset;
  const is_closed = decodeBool(bytes, offset, "is_closed");
  offset += 1;
  const total_voters = decodeUint64(bytes, offset);
  offset += 8;
  const creator_deposit = decodeUint64(bytes, offset);
  offset += 8;
  const pending_intent_count = decodeUint64(bytes, offset);
  offset += 8;
  const [counted_voter_lock_hashes, nextRegistryOffset] = decodeBytes32Vec(bytes, offset);
  offset = nextRegistryOffset;
  const token_weighted = decodeBool(bytes, offset, "token_weighted");
  offset += 1;
  assertCodec(bytes.length >= offset + 32, "udt_type_hash decode out of bounds");
  const udt_type_hash = bytes.slice(offset, offset + 32);
  offset += 32;
  const shard_count = decodeUint32(bytes, offset);
  offset += 4;
  assertCodec(offset === bytes.length, "PollData has trailing bytes");

  return {
    question,
    options,
    vote_counts,
    deadline,
    creator,
    creator_lock,
    is_closed,
    total_voters,
    creator_deposit,
    pending_intent_count,
    counted_voter_lock_hashes,
    token_weighted,
    udt_type_hash,
    shard_count,
  };
}

export function encodeVoteIntentData(intent: VoteIntentData): Uint8Array {
  assertCodec(intent.poll_type_hash.length === 32, "poll_type_hash must be 32 bytes");
  assertCodec(intent.voter_lock_hash.length === 32, "voter_lock_hash must be 32 bytes");

  return concat([
    intent.poll_type_hash,
    intent.voter_lock_hash,
    new Uint8Array([intent.option_index]),
    encodeUint64(intent.voted_at_epoch),
    new Uint8Array([intent.aggregated ? 1 : 0]),
    encodeScript(intent.refund_lock),
  ]);
}

export function decodeVoteIntentData(bytes: Uint8Array): VoteIntentData {
  assertCodec(bytes.length >= 74, `VoteIntentData too short: ${bytes.length}`);

  let offset = 0;
  const poll_type_hash = bytes.slice(offset, offset + 32);
  offset += 32;
  const voter_lock_hash = bytes.slice(offset, offset + 32);
  offset += 32;
  const option_index = bytes[offset];
  offset += 1;
  const voted_at_epoch = decodeUint64(bytes, offset);
  offset += 8;
  const aggregated = decodeBool(bytes, offset, "aggregated");
  offset += 1;
  const [refund_lock, nextOffset] = decodeScript(bytes, offset);
  assertCodec(nextOffset === bytes.length, "VoteIntentData has trailing bytes");

  return { poll_type_hash, voter_lock_hash, option_index, voted_at_epoch, aggregated, refund_lock };
}

export function encodeDelegationData(delegation: DelegationData): Uint8Array {
  assertCodec(delegation.delegator_lock_hash.length === 32, "delegator_lock_hash must be 32 bytes");
  assertCodec(delegation.delegate_lock_hash.length === 32, "delegate_lock_hash must be 32 bytes");
  assertCodec(delegation.poll_type_hash.length === 32, "poll_type_hash must be 32 bytes");

  return concat([
    delegation.delegator_lock_hash,
    delegation.delegate_lock_hash,
    delegation.poll_type_hash,
    encodeUint64(delegation.expires_epoch),
  ]);
}

export function decodeDelegationData(bytes: Uint8Array): DelegationData {
  assertCodec(bytes.length >= 104, `DelegationData too short: ${bytes.length}`);

  let offset = 0;
  const delegator_lock_hash = bytes.slice(offset, offset + 32);
  offset += 32;
  const delegate_lock_hash = bytes.slice(offset, offset + 32);
  offset += 32;
  const poll_type_hash = bytes.slice(offset, offset + 32);
  offset += 32;
  const expires_epoch = decodeUint64(bytes, offset);
  offset += 8;
  assertCodec(offset === bytes.length, "DelegationData has trailing bytes");

  return { delegator_lock_hash, delegate_lock_hash, poll_type_hash, expires_epoch };
}

export function encodeTallyShardData(shard: TallyShardData): Uint8Array {
  // The leading version makes the fixed-root lane layout impossible to
  // confuse with historical variable-length voter registries.
  assertCodec(shard.version === TALLY_SHARD_CODEC_VERSION, "unsupported TallyShardData version");
  assertCodec(shard.poll_type_hash.length === 32, "poll_type_hash must be 32 bytes");
  assertCodec(shard.counted_voter_root.length === 32, "counted_voter_root must be 32 bytes");
  assertCodec(shard.shard_count > 0, "shard_count must be positive");
  assertCodec(shard.shard_count <= 256, "shard_count exceeds protocol maximum");
  assertCodec(shard.shard_id >= 0 && shard.shard_id < shard.shard_count, "shard_id must be inside shard_count");

  return concat([
    new Uint8Array([shard.version]),
    shard.poll_type_hash,
    encodeUint32(shard.shard_id),
    encodeUint32(shard.shard_count),
    encodeUint64Vec(shard.vote_counts),
    encodeUint64(shard.total_voters),
    shard.counted_voter_root,
    new Uint8Array([shard.finalized ? 1 : 0]),
  ]);
}

export function decodeTallyShardData(bytes: Uint8Array): TallyShardData {
  assertCodec(bytes.length >= 86, `TallyShardData too short: ${bytes.length}`);

  let offset = 0;
  const version = bytes[offset];
  offset += 1;
  assertCodec(
    version === TALLY_SHARD_CODEC_VERSION,
    `unsupported TallyShardData version: ${version}`
  );
  const poll_type_hash = bytes.slice(offset, offset + 32);
  offset += 32;
  const shard_id = decodeUint32(bytes, offset);
  offset += 4;
  const shard_count = decodeUint32(bytes, offset);
  offset += 4;
  const [vote_counts, nextCountsOffset] = decodeUint64Vec(bytes, offset);
  offset = nextCountsOffset;
  const total_voters = decodeUint64(bytes, offset);
  offset += 8;
  const counted_voter_root = bytes.slice(offset, offset + 32);
  offset += 32;
  assertCodec(bytes.length > offset, "finalized decode out of bounds");
  const finalized = decodeBool(bytes, offset, "finalized");
  offset += 1;
  assertCodec(shard_count > 0, "shard_count must be positive");
  assertCodec(shard_count <= 256, "shard_count exceeds protocol maximum");
  assertCodec(shard_id < shard_count, "shard_id must be inside shard_count");
  assertCodec(offset === bytes.length, "TallyShardData has trailing bytes");

  return {
    version,
    poll_type_hash,
    shard_id,
    shard_count,
    vote_counts,
    total_voters,
    counted_voter_root,
    finalized,
  };
}

export function encodeTallyAggregationProof(proof: TallyAggregationProof): Uint8Array {
  assertCodec(
    proof.version === TALLY_AGGREGATION_PROOF_VERSION,
    "unsupported tally aggregation proof version"
  );
  assertCodec(proof.compiled_proof.length > 0, "compiled tally proof must not be empty");
  assertCodec(
    proof.compiled_proof.length <= MAX_TALLY_AGGREGATION_PROOF_BYTES,
    "compiled tally proof is too large"
  );
  return concat([new Uint8Array([proof.version]), encodeBytes(proof.compiled_proof)]);
}

export function decodeTallyAggregationProof(bytes: Uint8Array): TallyAggregationProof {
  assertCodec(bytes.length >= 6, `TallyAggregationProof too short: ${bytes.length}`);
  const version = bytes[0];
  assertCodec(
    version === TALLY_AGGREGATION_PROOF_VERSION,
    `unsupported tally aggregation proof version: ${version}`
  );
  const [compiled_proof, offset] = decodeBytes(bytes, 1);
  assertCodec(compiled_proof.length > 0, "compiled tally proof must not be empty");
  assertCodec(
    compiled_proof.length <= MAX_TALLY_AGGREGATION_PROOF_BYTES,
    "compiled tally proof is too large"
  );
  assertCodec(offset === bytes.length, "TallyAggregationProof has trailing bytes");
  return { version, compiled_proof };
}

export function encodeTallyMergeResultData(result: TallyMergeResultData): Uint8Array {
  assertCodec(result.poll_type_hash.length === 32, "poll_type_hash must be 32 bytes");
  assertCodec(result.coverage.length === 32, "coverage must be 32 bytes");

  return concat([
    result.poll_type_hash,
    result.coverage,
    encodeUint64Vec(result.vote_counts),
    encodeUint64(result.total_voters),
    encodeUint32(result.merge_level),
    encodeUint32(result.version),
  ]);
}

export function decodeTallyMergeResultData(bytes: Uint8Array): TallyMergeResultData {
  assertCodec(bytes.length >= 80, `TallyMergeResultData too short: ${bytes.length}`);

  let offset = 0;
  const poll_type_hash = bytes.slice(offset, offset + 32);
  offset += 32;
  const coverage = bytes.slice(offset, offset + 32);
  offset += 32;
  const [vote_counts, nextCountsOffset] = decodeUint64Vec(bytes, offset);
  offset = nextCountsOffset;
  const total_voters = decodeUint64(bytes, offset);
  offset += 8;
  const merge_level = decodeUint32(bytes, offset);
  offset += 4;
  const version = decodeUint32(bytes, offset);
  offset += 4;
  assertCodec(offset === bytes.length, "TallyMergeResultData has trailing bytes");

  return {
    poll_type_hash,
    coverage,
    vote_counts,
    total_voters,
    merge_level,
    version,
  };
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  const output = new Uint8Array(normalized.length / 2);

  for (let index = 0; index < normalized.length; index += 2) {
    output[index / 2] = parseInt(normalized.slice(index, index + 2), 16);
  }

  return output;
}

export function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
