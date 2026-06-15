/**
 * ZK Completeness Model Tests
 * ===========================
 * Covers deterministic off-chain commitment/public-input helpers for later
 * ZK completeness research. These tests do not execute a Groth16 verifier.
 */
import { describe, expect, test } from "vitest";

import { VOTER_DEPOSIT_SHANNONS } from "../frontend/src/lib/constants";
import { VoteIntentData, bytesToHex } from "../frontend/src/lib/molecule";
import {
  NormalizedIntentRecord,
  ShardCompletenessPublicInputsV1,
  buildIntentCommitmentSetModel,
  buildIntentCommitmentModel,
  createNormalizedIntentRecord,
  encodeNormalizedIntentRecord,
  hashNormalizedIntentRecord,
  hashShardCompletenessPublicInputsV1,
  normalizeVoteIntentCell,
  packDigestForBn254PublicInputs,
  packShardCompletenessPublicInputsV1,
  sortIntentRecords,
  splitDigestTo128BitLimbsLE,
  validateCompleteSetCoverage,
  validateNormalizedIntentRecord,
} from "../frontend/src/lib/zkCompleteness";

function filledBytes(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function intentId(txFill: number, index: number): Uint8Array {
  const id = new Uint8Array(36);
  id.fill(txFill, 0, 32);
  id[32] = index & 0xff;
  id[33] = (index >> 8) & 0xff;
  id[34] = (index >> 16) & 0xff;
  id[35] = (index >> 24) & 0xff;
  return id;
}

function makeRecord(overrides: Partial<NormalizedIntentRecord> = {}): NormalizedIntentRecord {
  const shardCount = 8;
  const base = createNormalizedIntentRecord({
    poll_type_hash: filledBytes(32, 0x11),
    voter_lock_hash: filledBytes(32, 0x21),
    option_index: 2,
    voted_at_epoch: 1000n,
    refund_lock_hash: filledBytes(32, 0x31),
    intent_id: intentId(0x41, 7),
    capacity_shannons: VOTER_DEPOSIT_SHANNONS + 123n,
    shard_count: shardCount,
  });

  return {
    ...base,
    poll_type_hash: overrides.poll_type_hash ?? base.poll_type_hash,
    shard_id: overrides.shard_id ?? base.shard_id,
    voter_lock_hash: overrides.voter_lock_hash ?? base.voter_lock_hash,
    option_index: overrides.option_index ?? base.option_index,
    voted_at_epoch: overrides.voted_at_epoch ?? base.voted_at_epoch,
    refund_lock_hash: overrides.refund_lock_hash ?? base.refund_lock_hash,
    intent_id: overrides.intent_id ?? base.intent_id,
    capacity_shannons: overrides.capacity_shannons ?? base.capacity_shannons,
    record_version: overrides.record_version ?? base.record_version,
  };
}

function makeRecordsForOneShard(count: number): NormalizedIntentRecord[] {
  const pollTypeHash = filledBytes(32, 0x55);
  const shardCount = 8;
  const records: NormalizedIntentRecord[] = [];
  let voterSeed = 0x10;

  while (records.length < count) {
    const candidate = createNormalizedIntentRecord({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: filledBytes(32, voterSeed),
      option_index: records.length % 3,
      voted_at_epoch: 200n + BigInt(records.length),
      refund_lock_hash: filledBytes(32, 0x80 + records.length),
      intent_id: intentId(0xa0 + records.length, records.length),
      capacity_shannons: VOTER_DEPOSIT_SHANNONS + BigInt(records.length),
      shard_count: shardCount,
    });

    if (records.length === 0 || candidate.shard_id === records[0].shard_id) {
      records.push(candidate);
    }
    voterSeed += 1;
  }

  return records;
}

function makeCommitment(records = makeRecordsForOneShard(3), windowId = 0) {
  return buildIntentCommitmentModel({
    poll_type_hash: records[0]?.poll_type_hash ?? filledBytes(32, 0x55),
    shard_id: records[0]?.shard_id ?? 0,
    shard_count: 8,
    window_id: windowId,
    option_count: 3,
    records,
  });
}

function makeCommitmentSet(records = makeRecordsForOneShard(3)) {
  const firstWindow = makeCommitment(records.slice(0, 1), 0);
  const secondWindow = makeCommitment(records.slice(1), 1);
  return buildIntentCommitmentSetModel({
    poll_type_hash: firstWindow.poll_type_hash,
    shard_id: firstWindow.shard_id,
    shard_count: firstWindow.shard_count,
    windows: [secondWindow, firstWindow],
  });
}

function makePublicInputs(
  overrides: Partial<ShardCompletenessPublicInputsV1> = {}
): ShardCompletenessPublicInputsV1 {
  const records = makeRecordsForOneShard(2);
  const commitmentSet = makeCommitmentSet(records);
  return {
    circuit_version: 1,
    poll_type_hash: commitmentSet.poll_type_hash,
    shard_id: commitmentSet.shard_id,
    shard_count: commitmentSet.shard_count,
    commitment_set_hash: commitmentSet.commitment_set_hash,
    leaf_count: commitmentSet.total_leaf_count,
    previous_shard_data_hash: filledBytes(32, 0x71),
    finalized_shard_data_hash: filledBytes(32, 0x72),
    option_count: 3,
    tally_hash: filledBytes(32, 0x73),
    total_voters: BigInt(commitmentSet.total_leaf_count),
    verifying_key_hash: filledBytes(32, 0x74),
    ...overrides,
  };
}

describe("normalized intent records", () => {
  test("encodes records with a stable canonical layout", () => {
    const record = makeRecord();
    const encoded = encodeNormalizedIntentRecord(record);

    expect(encoded.length).toBe(157);
    expect(bytesToHex(encoded.slice(0, 32))).toBe(`0x${"11".repeat(32)}`);
    expect(Array.from(encoded.slice(32, 36))).toEqual([
      record.shard_id,
      0,
      0,
      0,
    ]);
    expect(bytesToHex(encoded.slice(36, 68))).toBe(`0x${"21".repeat(32)}`);
    expect(encoded[68]).toBe(2);
    expect(Array.from(encoded.slice(69, 77))).toEqual([232, 3, 0, 0, 0, 0, 0, 0]);
    expect(bytesToHex(encoded.slice(77, 109))).toBe(`0x${"31".repeat(32)}`);
    expect(bytesToHex(encoded.slice(109, 145))).toBe(`0x${"41".repeat(32)}07000000`);
    expect(Array.from(encoded.slice(145, 153))).toEqual([123, 157, 150, 107, 1, 0, 0, 0]);
    expect(Array.from(encoded.slice(153, 157))).toEqual([1, 0, 0, 0]);
  });

  test("has a deterministic leaf hash vector", () => {
    expect(bytesToHex(hashNormalizedIntentRecord(makeRecord()))).toBe(
      "0xecfd54bb67b1c7f971a288306386856898b0725007183528bde164541cfd3b45"
    );
  });

  test("leaf hash changes when committed record fields change", () => {
    const base = makeRecord();
    const baseHash = bytesToHex(hashNormalizedIntentRecord(base));
    const variants = [
      makeRecord({ poll_type_hash: filledBytes(32, 0x12) }),
      makeRecord({ voter_lock_hash: filledBytes(32, 0x22) }),
      makeRecord({ option_index: 1 }),
      makeRecord({ voted_at_epoch: 1001n }),
      makeRecord({ refund_lock_hash: filledBytes(32, 0x32) }),
      makeRecord({ intent_id: intentId(0x42, 8) }),
      makeRecord({ capacity_shannons: VOTER_DEPOSIT_SHANNONS + 124n }),
      makeRecord({ record_version: 2 }),
    ];

    for (const variant of variants) {
      expect(bytesToHex(hashNormalizedIntentRecord(variant))).not.toBe(baseHash);
    }
  });

  test("rejects malformed lengths and insufficient capacity", () => {
    expect(() => encodeNormalizedIntentRecord(makeRecord({ poll_type_hash: filledBytes(31, 0x11) }))).toThrow("poll_type_hash");
    expect(() => encodeNormalizedIntentRecord(makeRecord({ voter_lock_hash: filledBytes(31, 0x21) }))).toThrow("voter_lock_hash");
    expect(() => encodeNormalizedIntentRecord(makeRecord({ refund_lock_hash: filledBytes(31, 0x31) }))).toThrow("refund_lock_hash");
    expect(() => encodeNormalizedIntentRecord(makeRecord({ intent_id: filledBytes(35, 0x41) }))).toThrow("intent_id");
    expect(() => encodeNormalizedIntentRecord(makeRecord({ capacity_shannons: VOTER_DEPOSIT_SHANNONS - 1n }))).toThrow("capacity");
  });

  test("validates option and derived shard bounds when context is available", () => {
    const record = makeRecord();
    expect(() => validateNormalizedIntentRecord(record, { shard_count: 8, option_count: 3 })).not.toThrow();
    expect(() => validateNormalizedIntentRecord(record, { option_count: 1 })).toThrow("option_count");
    expect(() => validateNormalizedIntentRecord({ ...record, option_index: 3 }, { option_count: 3 })).toThrow("option_index");
    expect(() => validateNormalizedIntentRecord({ ...record, shard_id: record.shard_id + 1 }, { shard_count: 8 })).toThrow("shard_id");
  });

  test("normalizes live pending and aggregated intent cells identically", () => {
    const intent: VoteIntentData = {
      poll_type_hash: filledBytes(32, 0x44),
      voter_lock_hash: filledBytes(32, 0x45),
      option_index: 1,
      voted_at_epoch: 900n,
      aggregated: false,
      refund_lock: {
        code_hash: `0x${"46".repeat(32)}`,
        hash_type: "type",
        args: "0x4700",
      },
    };
    const common = {
      out_point: { txHash: `0x${"48".repeat(32)}`, index: 9 },
      capacity_shannons: VOTER_DEPOSIT_SHANNONS + 9n,
      shard_count: 8,
      refund_lock_hash: filledBytes(32, 0x49),
    };
    const pending = normalizeVoteIntentCell({ intent, ...common });
    const aggregated = normalizeVoteIntentCell({
      intent: { ...intent, aggregated: true },
      ...common,
    });

    expect(aggregated).toEqual(pending);
    expect(bytesToHex(pending.intent_id)).toBe(`0x${"48".repeat(32)}09000000`);
  });
});

describe("intent commitment model", () => {
  test("sorts records by voter_lock_hash then intent_id", () => {
    const first = makeRecord({ voter_lock_hash: filledBytes(32, 0x10), intent_id: intentId(0x99, 2) });
    const second = makeRecord({ voter_lock_hash: filledBytes(32, 0x10), intent_id: intentId(0x98, 1) });
    const third = makeRecord({ voter_lock_hash: filledBytes(32, 0x09), intent_id: intentId(0x97, 3) });
    const sorted = sortIntentRecords([first, second, third]);

    expect(sorted.map((record) => bytesToHex(record.intent_id))).toEqual([
      bytesToHex(third.intent_id),
      bytesToHex(second.intent_id),
      bytesToHex(first.intent_id),
    ]);
  });

  test("rejects duplicate voters and duplicate intent ids", () => {
    const records = makeRecordsForOneShard(2);
    expect(() => makeCommitment([records[0], {
      ...records[1],
      shard_id: records[0].shard_id,
      voter_lock_hash: records[0].voter_lock_hash,
    }])).toThrow("duplicate voter");
    expect(() => makeCommitment([records[0], { ...records[1], intent_id: records[0].intent_id }])).toThrow("duplicate intent_id");
  });

  test("rejects wrong shard, poll, and option bounds", () => {
    const records = makeRecordsForOneShard(2);
    expect(() => makeCommitment([{ ...records[0], shard_id: (records[0].shard_id + 1) % 8 }])).toThrow("shard");
    expect(() => buildIntentCommitmentModel({
      poll_type_hash: filledBytes(32, 0x56),
      shard_id: records[0].shard_id,
      shard_count: 8,
      window_id: 0,
      option_count: 3,
      records,
    })).toThrow("poll_type_hash");
    expect(() => makeCommitment([{ ...records[0], option_index: 3 }])).toThrow("option_index");
  });

  test("omitting a record changes both leaf_count and root", () => {
    const records = makeRecordsForOneShard(3);
    const full = makeCommitment(records);
    const omitted = makeCommitment(records.slice(0, 2));

    expect(full.leaf_count).toBe(3);
    expect(omitted.leaf_count).toBe(2);
    expect(bytesToHex(omitted.root)).not.toBe(bytesToHex(full.root));
  });

  test("membership-only subsets are not treated as complete coverage", () => {
    const records = makeRecordsForOneShard(3);
    const full = makeCommitment(records);

    expect(validateCompleteSetCoverage({
      poll_type_hash: full.poll_type_hash,
      shard_id: full.shard_id,
      shard_count: full.shard_count,
      window_id: full.window_id,
      option_count: 3,
      records: records.slice(0, 2),
      commitment: full,
    })).toBe(false);
  });

  test("empty and odd-leaf Merkle roots are deterministic", () => {
    const empty = buildIntentCommitmentModel({
      poll_type_hash: filledBytes(32, 0x55),
      shard_id: 0,
      shard_count: 8,
      window_id: 0,
      option_count: 3,
      records: [],
    });
    const emptyAgain = buildIntentCommitmentModel({
      poll_type_hash: filledBytes(32, 0x55),
      shard_id: 0,
      shard_count: 8,
      window_id: 0,
      option_count: 3,
      records: [],
    });
    const odd = makeCommitment(makeRecordsForOneShard(3));
    const oddAgain = makeCommitment(makeRecordsForOneShard(3));

    expect(bytesToHex(empty.root)).toBe(bytesToHex(emptyAgain.root));
    expect(bytesToHex(odd.root)).toBe(bytesToHex(oddAgain.root));
    expect(odd.leaf_count).toBe(3);
  });

  test("builds commitment-set hash over ordered window metadata", () => {
    const records = makeRecordsForOneShard(3);
    const firstWindow = makeCommitment(records.slice(0, 1), 0);
    const secondWindow = makeCommitment(records.slice(1), 1);
    const set = buildIntentCommitmentSetModel({
      poll_type_hash: firstWindow.poll_type_hash,
      shard_id: firstWindow.shard_id,
      shard_count: firstWindow.shard_count,
      windows: [secondWindow, firstWindow],
    });

    expect(set.window_count).toBe(2);
    expect(set.total_leaf_count).toBe(3);
    expect(set.windows.map((window) => window.window_id)).toEqual([0, 1]);
    expect(bytesToHex(set.commitment_set_hash)).toBe(
      "0x7b69fe7869126c61ed564855ae3b59d0fc07d7f2dd7ac21c9fc69d445013c6d9"
    );

    const changedLeafCount = buildIntentCommitmentSetModel({
      poll_type_hash: firstWindow.poll_type_hash,
      shard_id: firstWindow.shard_id,
      shard_count: firstWindow.shard_count,
      windows: [firstWindow, { ...secondWindow, leaf_count: secondWindow.leaf_count + 1 }],
    });
    expect(bytesToHex(changedLeafCount.commitment_set_hash)).not.toBe(bytesToHex(set.commitment_set_hash));
    expect(() => buildIntentCommitmentSetModel({
      poll_type_hash: firstWindow.poll_type_hash,
      shard_id: firstWindow.shard_id,
      shard_count: firstWindow.shard_count,
      windows: [firstWindow, { ...secondWindow, window_id: firstWindow.window_id }],
    })).toThrow("duplicate commitment window_id");
  });
});

describe("BN254 public input packing", () => {
  test("splits digests into two little-endian 128-bit limbs", () => {
    const zero = new Uint8Array(32);
    expect(splitDigestTo128BitLimbsLE(zero)).toEqual([0n, 0n]);

    const vector = new Uint8Array(32);
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] = index;
    }

    expect(packDigestForBn254PublicInputs(vector)).toEqual([
      0x0f0e0d0c0b0a09080706050403020100n,
      0x1f1e1d1c1b1a19181716151413121110n,
    ]);
    expect(() => splitDigestTo128BitLimbsLE(filledBytes(31, 0))).toThrow("digest");
    expect(() => splitDigestTo128BitLimbsLE(filledBytes(33, 0))).toThrow("digest");
  });

  test("hashes and packs shard-completeness public inputs deterministically", () => {
    const input = makePublicInputs();
    const packed = packShardCompletenessPublicInputsV1(input);

    expect(packed).toHaveLength(18);
    expect(packed[0]).toBe(1n);
    expect(packed[3]).toBe(BigInt(input.shard_id));
    expect(packed[4]).toBe(8n);
    expect(packed[7]).toBe(BigInt(input.leaf_count));
    expect(packed[15]).toBe(input.total_voters);
    expect(bytesToHex(hashShardCompletenessPublicInputsV1(input))).toBe(
      "0x11ac281756ea2d88d74f4edc8d661e3cb917e78705a1f0d00ebb6e2ebd552b8f"
    );
  });

  test("public input hash binds important transaction-visible fields", () => {
    const input = makePublicInputs();
    const baseHash = bytesToHex(hashShardCompletenessPublicInputsV1(input));
    const variants: ShardCompletenessPublicInputsV1[] = [
      { ...input, commitment_set_hash: filledBytes(32, 0x81) },
      { ...input, shard_id: (input.shard_id + 1) % input.shard_count },
      { ...input, finalized_shard_data_hash: filledBytes(32, 0x82) },
      { ...input, leaf_count: input.leaf_count + 1 },
      { ...input, total_voters: input.total_voters + 1n },
      { ...input, verifying_key_hash: filledBytes(32, 0x83) },
    ];

    for (const variant of variants) {
      expect(bytesToHex(hashShardCompletenessPublicInputsV1(variant))).not.toBe(baseHash);
    }
  });
});
