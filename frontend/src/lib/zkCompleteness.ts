/**
 * ZK Completeness Model Helpers
 * =============================
 * Deterministic TypeScript-only helpers for future completeness proofs. These
 * do not verify proofs and do not add an on-chain vote-completeness guarantee.
 */
import { ccc } from "@ckb-ccc/core";

import { deriveTallyShardId } from "./ckb";
import { MAX_OPTIONS, MAX_TALLY_SHARDS, VOTER_DEPOSIT_SHANNONS } from "./constants";
import { VoteIntentData, hexToBytes } from "./molecule";

export const ZK_INTENT_RECORD_DOMAIN = "CKB_GOV_INTENT_RECORD_V1";
export const ZK_EMPTY_INTENT_ROOT_DOMAIN = "CKB_GOV_EMPTY_INTENT_ROOT_V1";
export const ZK_INTENT_NODE_DOMAIN = "CKB_GOV_INTENT_NODE_V1";
export const ZK_INTENT_COMMITMENT_SET_DOMAIN = "CKB_GOV_INTENT_COMMITMENT_SET_V1";
export const ZK_SHARD_COMPLETENESS_PUBLIC_INPUTS_DOMAIN =
  "CKB_GOV_SHARD_COMPLETENESS_PUBLIC_INPUTS_V1";
export const ZK_INTENT_RECORD_VERSION = 1;
export const MIN_ZK_OPTION_COUNT = 2;

const UINT64_MAX = (1n << 64n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;

export interface NormalizedIntentRecord {
  poll_type_hash: Uint8Array;
  shard_id: number;
  voter_lock_hash: Uint8Array;
  option_index: number;
  voted_at_epoch: bigint;
  refund_lock_hash: Uint8Array;
  intent_id: Uint8Array;
  capacity_shannons: bigint;
  record_version: number;
}

export interface NormalizedIntentRecordValidationContext {
  shard_count?: number;
  option_count?: number;
  expected_poll_type_hash?: Uint8Array;
  expected_shard_id?: number;
  require_minimum_capacity?: boolean;
}

export interface CreateNormalizedIntentRecordInput {
  poll_type_hash: Uint8Array;
  voter_lock_hash: Uint8Array;
  option_index: number;
  voted_at_epoch: bigint;
  refund_lock_hash: Uint8Array;
  intent_id: Uint8Array;
  capacity_shannons: bigint;
  shard_count: number;
  record_version?: number;
}

export interface NormalizeVoteIntentCellInput {
  intent: VoteIntentData;
  out_point: {
    txHash: string;
    index: number;
  };
  capacity_shannons: bigint;
  shard_count: number;
  refund_lock_hash: Uint8Array;
  record_version?: number;
}

export interface IntentCommitmentModel {
  poll_type_hash: Uint8Array;
  shard_id: number;
  shard_count: number;
  window_id: number;
  leaf_count: number;
  root: Uint8Array;
  record_version: number;
}

export interface IntentCommitmentSetModel {
  poll_type_hash: Uint8Array;
  shard_id: number;
  shard_count: number;
  window_count: number;
  total_leaf_count: number;
  commitment_set_hash: Uint8Array;
  record_version: number;
  windows: IntentCommitmentModel[];
}

export interface BuildIntentCommitmentModelInput {
  poll_type_hash: Uint8Array;
  shard_id: number;
  shard_count: number;
  window_id: number;
  option_count: number;
  records: NormalizedIntentRecord[];
}

export interface CompleteSetCoverageInput extends BuildIntentCommitmentModelInput {
  commitment: IntentCommitmentModel;
}

export interface ShardCompletenessPublicInputsV1 {
  circuit_version: number;
  poll_type_hash: Uint8Array;
  shard_id: number;
  shard_count: number;
  commitment_set_hash: Uint8Array;
  leaf_count: number;
  previous_shard_data_hash: Uint8Array;
  finalized_shard_data_hash: Uint8Array;
  option_count: number;
  tally_hash: Uint8Array;
  total_voters: bigint;
  verifying_key_hash: Uint8Array;
}

const textEncoder = new TextEncoder();

function domainBytes(domain: string): Uint8Array {
  return textEncoder.encode(domain);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

function hashCkb(input: Uint8Array): Uint8Array {
  return (ccc as any).bytesFrom(
    ccc.hexFrom((ccc as any).hashCkb(input))
  );
}

function encodeUint8(value: number, fieldName: string): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${fieldName} must be a uint8`);
  }
  return new Uint8Array([value]);
}

function encodeUint32(value: number, fieldName: string): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${fieldName} must be a uint32`);
  }

  const bytes = new Uint8Array(4);
  bytes[0] = value & 0xff;
  bytes[1] = (value >> 8) & 0xff;
  bytes[2] = (value >> 16) & 0xff;
  bytes[3] = (value >> 24) & 0xff;
  return bytes;
}

function encodeUint64(value: bigint, fieldName: string): Uint8Array {
  if (value < 0n || value > UINT64_MAX) {
    throw new Error(`${fieldName} must be a uint64`);
  }

  const bytes = new Uint8Array(8);
  let current = value;
  for (let index = 0; index < 8; index += 1) {
    bytes[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  return bytes;
}

function assertBytes(fieldName: string, bytes: Uint8Array, expectedLength: number): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== expectedLength) {
    throw new Error(`${fieldName} must be ${expectedLength} bytes`);
  }
}

function assertBytes32(fieldName: string, bytes: Uint8Array): void {
  assertBytes(fieldName, bytes, 32);
}

function assertShardCount(shardCount: number): void {
  if (!Number.isInteger(shardCount) || shardCount <= 0 || shardCount > MAX_TALLY_SHARDS) {
    throw new Error(`shard_count must be between 1 and ${MAX_TALLY_SHARDS}`);
  }
}

function assertOptionCount(optionCount: number): void {
  if (!Number.isInteger(optionCount) || optionCount < MIN_ZK_OPTION_COUNT || optionCount > MAX_OPTIONS) {
    throw new Error(`option_count must be between ${MIN_ZK_OPTION_COUNT} and ${MAX_OPTIONS}`);
  }
}

function assertEqualBytes(fieldName: string, left: Uint8Array, right: Uint8Array): void {
  assertBytes(fieldName, left, right.length);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      throw new Error(`${fieldName} does not match`);
    }
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function bytesKey(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const minLength = Math.min(left.length, right.length);
  for (let index = 0; index < minLength; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function cloneRecord(record: NormalizedIntentRecord): NormalizedIntentRecord {
  return {
    poll_type_hash: record.poll_type_hash.slice(),
    shard_id: record.shard_id,
    voter_lock_hash: record.voter_lock_hash.slice(),
    option_index: record.option_index,
    voted_at_epoch: record.voted_at_epoch,
    refund_lock_hash: record.refund_lock_hash.slice(),
    intent_id: record.intent_id.slice(),
    capacity_shannons: record.capacity_shannons,
    record_version: record.record_version,
  };
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function validateWindowId(windowId: number): void {
  if (!Number.isInteger(windowId) || windowId < 0 || windowId > 0xffffffff) {
    throw new Error("window_id must be a uint32");
  }
}

function validateLeafCount(leafCount: number): void {
  if (!Number.isInteger(leafCount) || leafCount < 0 || leafCount > 0xffffffff) {
    throw new Error("leaf_count must be a uint32");
  }
}

function validateRecordVersion(recordVersion: number): void {
  if (!Number.isInteger(recordVersion) || recordVersion <= 0 || recordVersion > 0xffffffff) {
    throw new Error("record_version must be a positive uint32");
  }
}

function encodeIntentIdFromOutPoint(outPoint: NormalizeVoteIntentCellInput["out_point"]): Uint8Array {
  const txHash = hexToBytes(outPoint.txHash);
  assertBytes("out_point.txHash", txHash, 32);
  const indexBytes = encodeUint32(outPoint.index, "out_point.index");
  return concat([txHash, indexBytes]);
}

export function createNormalizedIntentRecord(input: CreateNormalizedIntentRecordInput): NormalizedIntentRecord {
  assertShardCount(input.shard_count);
  const record: NormalizedIntentRecord = {
    poll_type_hash: input.poll_type_hash.slice(),
    shard_id: deriveTallyShardId(input.poll_type_hash, input.voter_lock_hash, input.shard_count),
    voter_lock_hash: input.voter_lock_hash.slice(),
    option_index: input.option_index,
    voted_at_epoch: input.voted_at_epoch,
    refund_lock_hash: input.refund_lock_hash.slice(),
    intent_id: input.intent_id.slice(),
    capacity_shannons: input.capacity_shannons,
    record_version: input.record_version ?? ZK_INTENT_RECORD_VERSION,
  };

  validateNormalizedIntentRecord(record, {
    shard_count: input.shard_count,
    require_minimum_capacity: true,
  });
  return record;
}

export function normalizeVoteIntentCell(input: NormalizeVoteIntentCellInput): NormalizedIntentRecord {
  return createNormalizedIntentRecord({
    poll_type_hash: input.intent.poll_type_hash,
    voter_lock_hash: input.intent.voter_lock_hash,
    option_index: input.intent.option_index,
    voted_at_epoch: input.intent.voted_at_epoch,
    refund_lock_hash: input.refund_lock_hash,
    intent_id: encodeIntentIdFromOutPoint(input.out_point),
    capacity_shannons: input.capacity_shannons,
    shard_count: input.shard_count,
    record_version: input.record_version,
  });
}

export function validateNormalizedIntentRecord(
  record: NormalizedIntentRecord,
  context: NormalizedIntentRecordValidationContext = {}
): void {
  assertBytes32("poll_type_hash", record.poll_type_hash);
  assertBytes32("voter_lock_hash", record.voter_lock_hash);
  assertBytes32("refund_lock_hash", record.refund_lock_hash);
  assertBytes("intent_id", record.intent_id, 36);
  encodeUint32(record.shard_id, "shard_id");
  encodeUint8(record.option_index, "option_index");
  encodeUint64(record.voted_at_epoch, "voted_at_epoch");
  encodeUint64(record.capacity_shannons, "capacity_shannons");
  validateRecordVersion(record.record_version);

  if (context.expected_poll_type_hash) {
    assertEqualBytes("poll_type_hash", record.poll_type_hash, context.expected_poll_type_hash);
  }

  if (context.shard_count !== undefined) {
    assertShardCount(context.shard_count);
    if (record.shard_id >= context.shard_count) {
      throw new Error("shard_id must be less than shard_count");
    }

    const derivedShardId = deriveTallyShardId(
      record.poll_type_hash,
      record.voter_lock_hash,
      context.shard_count
    );
    if (record.shard_id !== derivedShardId) {
      throw new Error("shard_id must match derived shard assignment");
    }
  }

  if (context.expected_shard_id !== undefined && record.shard_id !== context.expected_shard_id) {
    throw new Error("record shard_id does not match commitment shard");
  }

  if (context.option_count !== undefined) {
    assertOptionCount(context.option_count);
    if (record.option_index >= context.option_count) {
      throw new Error("option_index must be less than option_count");
    }
  }

  if (context.require_minimum_capacity !== false && record.capacity_shannons < VOTER_DEPOSIT_SHANNONS) {
    throw new Error("capacity_shannons is below voter deposit");
  }
}

export function encodeNormalizedIntentRecord(record: NormalizedIntentRecord): Uint8Array {
  validateNormalizedIntentRecord(record);
  return concat([
    record.poll_type_hash,
    encodeUint32(record.shard_id, "shard_id"),
    record.voter_lock_hash,
    encodeUint8(record.option_index, "option_index"),
    encodeUint64(record.voted_at_epoch, "voted_at_epoch"),
    record.refund_lock_hash,
    record.intent_id,
    encodeUint64(record.capacity_shannons, "capacity_shannons"),
    encodeUint32(record.record_version, "record_version"),
  ]);
}

export function hashNormalizedIntentRecord(record: NormalizedIntentRecord): Uint8Array {
  return hashCkb(concat([
    domainBytes(ZK_INTENT_RECORD_DOMAIN),
    encodeNormalizedIntentRecord(record),
  ]));
}

export function sortIntentRecords(records: NormalizedIntentRecord[]): NormalizedIntentRecord[] {
  return records
    .map(cloneRecord)
    .sort((left, right) => {
      const voterCompare = compareBytes(left.voter_lock_hash, right.voter_lock_hash);
      return voterCompare !== 0 ? voterCompare : compareBytes(left.intent_id, right.intent_id);
    });
}

function computeMerkleRoot(leafHashes: Uint8Array[]): Uint8Array {
  if (leafHashes.length === 0) {
    return hashCkb(domainBytes(ZK_EMPTY_INTENT_ROOT_DOMAIN));
  }

  let level: Uint8Array[] = leafHashes.map(copyBytes);
  const nodeDomain = domainBytes(ZK_INTENT_NODE_DOMAIN);

  while (level.length > 1) {
    const nextLevel: Uint8Array[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      nextLevel.push(hashCkb(concat([nodeDomain, left, right])));
    }
    level = nextLevel;
  }

  return level[0];
}

export function buildIntentCommitmentModel(input: BuildIntentCommitmentModelInput): IntentCommitmentModel {
  assertBytes32("poll_type_hash", input.poll_type_hash);
  assertShardCount(input.shard_count);
  assertOptionCount(input.option_count);
  validateWindowId(input.window_id);
  if (!Number.isInteger(input.shard_id) || input.shard_id < 0 || input.shard_id >= input.shard_count) {
    throw new Error("shard_id must be within shard_count");
  }

  const records = sortIntentRecords(input.records);
  const voterKeys = new Set<string>();
  const intentKeys = new Set<string>();
  let recordVersion: number | undefined;

  for (const record of records) {
    validateNormalizedIntentRecord(record, {
      expected_poll_type_hash: input.poll_type_hash,
      expected_shard_id: input.shard_id,
      shard_count: input.shard_count,
      option_count: input.option_count,
      require_minimum_capacity: true,
    });

    if (recordVersion === undefined) {
      recordVersion = record.record_version;
    } else if (record.record_version !== recordVersion) {
      throw new Error("all records in a commitment window must use the same record_version");
    }

    const voterKey = bytesKey(record.voter_lock_hash);
    if (voterKeys.has(voterKey)) {
      throw new Error("duplicate voter_lock_hash in commitment window");
    }
    voterKeys.add(voterKey);

    const intentKey = bytesKey(record.intent_id);
    if (intentKeys.has(intentKey)) {
      throw new Error("duplicate intent_id in commitment window");
    }
    intentKeys.add(intentKey);
  }

  const leafHashes = records.map(hashNormalizedIntentRecord);
  return {
    poll_type_hash: input.poll_type_hash.slice(),
    shard_id: input.shard_id,
    shard_count: input.shard_count,
    window_id: input.window_id,
    leaf_count: records.length,
    root: computeMerkleRoot(leafHashes),
    record_version: recordVersion ?? ZK_INTENT_RECORD_VERSION,
  };
}

export function validateCompleteSetCoverage(input: CompleteSetCoverageInput): boolean {
  const rebuilt = buildIntentCommitmentModel(input);
  return (
    equalBytes(rebuilt.poll_type_hash, input.commitment.poll_type_hash) &&
    rebuilt.shard_id === input.commitment.shard_id &&
    rebuilt.shard_count === input.commitment.shard_count &&
    rebuilt.window_id === input.commitment.window_id &&
    rebuilt.leaf_count === input.commitment.leaf_count &&
    rebuilt.record_version === input.commitment.record_version &&
    equalBytes(rebuilt.root, input.commitment.root)
  );
}

function sortCommitmentWindows(windows: IntentCommitmentModel[]): IntentCommitmentModel[] {
  return windows
    .map((window) => ({
      poll_type_hash: window.poll_type_hash.slice(),
      shard_id: window.shard_id,
      shard_count: window.shard_count,
      window_id: window.window_id,
      leaf_count: window.leaf_count,
      root: window.root.slice(),
      record_version: window.record_version,
    }))
    .sort((left, right) => left.window_id - right.window_id);
}

function encodeCommitmentWindow(window: IntentCommitmentModel): Uint8Array {
  assertBytes32("window.poll_type_hash", window.poll_type_hash);
  assertShardCount(window.shard_count);
  if (!Number.isInteger(window.shard_id) || window.shard_id < 0 || window.shard_id >= window.shard_count) {
    throw new Error("window shard_id must be within shard_count");
  }
  validateWindowId(window.window_id);
  validateLeafCount(window.leaf_count);
  assertBytes32("window.root", window.root);
  validateRecordVersion(window.record_version);

  return concat([
    encodeUint32(window.window_id, "window_id"),
    window.root,
    encodeUint32(window.leaf_count, "leaf_count"),
    encodeUint32(window.record_version, "record_version"),
  ]);
}

export function buildIntentCommitmentSetModel(input: {
  poll_type_hash: Uint8Array;
  shard_id: number;
  shard_count: number;
  windows: IntentCommitmentModel[];
}): IntentCommitmentSetModel {
  assertBytes32("poll_type_hash", input.poll_type_hash);
  assertShardCount(input.shard_count);
  if (!Number.isInteger(input.shard_id) || input.shard_id < 0 || input.shard_id >= input.shard_count) {
    throw new Error("shard_id must be within shard_count");
  }

  const windows = sortCommitmentWindows(input.windows);
  const seenWindowIds = new Set<number>();
  let recordVersion: number | undefined;
  let totalLeafCount = 0;

  for (const window of windows) {
    if (!equalBytes(window.poll_type_hash, input.poll_type_hash)) {
      throw new Error("commitment window poll_type_hash does not match set");
    }
    if (window.shard_id !== input.shard_id) {
      throw new Error("commitment window shard_id does not match set");
    }
    if (window.shard_count !== input.shard_count) {
      throw new Error("commitment window shard_count does not match set");
    }
    if (seenWindowIds.has(window.window_id)) {
      throw new Error("duplicate commitment window_id");
    }
    seenWindowIds.add(window.window_id);
    if (recordVersion === undefined) {
      recordVersion = window.record_version;
    } else if (window.record_version !== recordVersion) {
      throw new Error("all commitment windows must use the same record_version");
    }
    totalLeafCount += window.leaf_count;
    validateLeafCount(totalLeafCount);
  }

  const setHash = hashCkb(concat([
    domainBytes(ZK_INTENT_COMMITMENT_SET_DOMAIN),
    input.poll_type_hash,
    encodeUint32(input.shard_id, "shard_id"),
    encodeUint32(input.shard_count, "shard_count"),
    encodeUint32(windows.length, "window_count"),
    encodeUint32(totalLeafCount, "total_leaf_count"),
    encodeUint32(recordVersion ?? ZK_INTENT_RECORD_VERSION, "record_version"),
    ...windows.map(encodeCommitmentWindow),
  ]));

  return {
    poll_type_hash: input.poll_type_hash.slice(),
    shard_id: input.shard_id,
    shard_count: input.shard_count,
    window_count: windows.length,
    total_leaf_count: totalLeafCount,
    commitment_set_hash: setHash,
    record_version: recordVersion ?? ZK_INTENT_RECORD_VERSION,
    windows,
  };
}

function readLittleEndianBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    result = (result << 8n) | BigInt(bytes[index]);
  }
  return result;
}

export function splitDigestTo128BitLimbsLE(digest: Uint8Array): [bigint, bigint] {
  assertBytes32("digest", digest);
  const low = readLittleEndianBigInt(digest.slice(0, 16));
  const high = readLittleEndianBigInt(digest.slice(16, 32));
  if (low > UINT128_MAX || high > UINT128_MAX) {
    throw new Error("digest limb exceeds uint128");
  }
  return [low, high];
}

export function packDigestForBn254PublicInputs(digest: Uint8Array): bigint[] {
  return splitDigestTo128BitLimbsLE(digest);
}

function validatePublicInputs(input: ShardCompletenessPublicInputsV1): void {
  encodeUint32(input.circuit_version, "circuit_version");
  assertBytes32("poll_type_hash", input.poll_type_hash);
  assertShardCount(input.shard_count);
  if (!Number.isInteger(input.shard_id) || input.shard_id < 0 || input.shard_id >= input.shard_count) {
    throw new Error("shard_id must be within shard_count");
  }
  assertBytes32("commitment_set_hash", input.commitment_set_hash);
  validateLeafCount(input.leaf_count);
  assertBytes32("previous_shard_data_hash", input.previous_shard_data_hash);
  assertBytes32("finalized_shard_data_hash", input.finalized_shard_data_hash);
  assertOptionCount(input.option_count);
  assertBytes32("tally_hash", input.tally_hash);
  encodeUint64(input.total_voters, "total_voters");
  assertBytes32("verifying_key_hash", input.verifying_key_hash);
}

export function encodeShardCompletenessPublicInputsV1(input: ShardCompletenessPublicInputsV1): Uint8Array {
  validatePublicInputs(input);
  return concat([
    encodeUint32(input.circuit_version, "circuit_version"),
    input.poll_type_hash,
    encodeUint32(input.shard_id, "shard_id"),
    encodeUint32(input.shard_count, "shard_count"),
    input.commitment_set_hash,
    encodeUint32(input.leaf_count, "leaf_count"),
    input.previous_shard_data_hash,
    input.finalized_shard_data_hash,
    encodeUint32(input.option_count, "option_count"),
    input.tally_hash,
    encodeUint64(input.total_voters, "total_voters"),
    input.verifying_key_hash,
  ]);
}

export function hashShardCompletenessPublicInputsV1(input: ShardCompletenessPublicInputsV1): Uint8Array {
  return hashCkb(concat([
    domainBytes(ZK_SHARD_COMPLETENESS_PUBLIC_INPUTS_DOMAIN),
    encodeShardCompletenessPublicInputsV1(input),
  ]));
}

export function packShardCompletenessPublicInputsV1(input: ShardCompletenessPublicInputsV1): bigint[] {
  validatePublicInputs(input);
  return [
    BigInt(input.circuit_version),
    ...packDigestForBn254PublicInputs(input.poll_type_hash),
    BigInt(input.shard_id),
    BigInt(input.shard_count),
    ...packDigestForBn254PublicInputs(input.commitment_set_hash),
    BigInt(input.leaf_count),
    ...packDigestForBn254PublicInputs(input.previous_shard_data_hash),
    ...packDigestForBn254PublicInputs(input.finalized_shard_data_hash),
    BigInt(input.option_count),
    ...packDigestForBn254PublicInputs(input.tally_hash),
    input.total_voters,
    ...packDigestForBn254PublicInputs(input.verifying_key_hash),
  ];
}
