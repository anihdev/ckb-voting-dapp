/**
 * Molecule Codec Tests
 * ====================
 * Validates the shared frontend codec layout used by deploy tooling and UI.
 */

import { describe, expect, test } from "vitest";
import {
  bytesToHex,
  decodeDelegationData,
  decodePollData,
  decodeVoteIntentData,
  encodeDelegationData,
  encodePollData,
  decodeTallyMergeResultData,
  decodeTallyAggregationProof,
  decodeTallyShardData,
  encodeTallyAggregationProof,
  encodeTallyMergeResultData,
  encodeTallyShardData,
  encodeVoteIntentData,
  hexToBytes,
  EncodedScript,
  PollData,
  VoteIntentData,
  DelegationData,
  TallyMergeResultData,
  TallyShardData,
} from "../frontend/src/lib/molecule";

function makeScript(overrides: Partial<EncodedScript> = {}): EncodedScript {
  return {
    code_hash: `0x${"13".repeat(32)}`,
    hash_type: "type",
    args: "0x1234",
    ...overrides,
  };
}

function makePoll(overrides: Partial<PollData> = {}): PollData {
  return {
    question: "Should Nervos governance use intent cells?",
    options: ["Yes", "No", "Abstain"],
    vote_counts: [10n, 2n, 1n],
    deadline: 512n,
    creator: new Uint8Array(32).fill(0x11),
    creator_lock: makeScript({ args: "0x1111" }),
    is_closed: false,
    total_voters: 13n,
    creator_deposit: 500n * 100_000_000n,
    // Codec-only compatibility data. Current protocol-valid polls require zero.
    pending_intent_count: 2n,
    counted_voter_lock_hashes: Array.from({ length: 13 }, (_, index) =>
      new Uint8Array(32).fill(index + 1)
    ),
    token_weighted: false,
    udt_type_hash: new Uint8Array(32),
    shard_count: 8,
    ...overrides,
  };
}

function makeIntent(overrides: Partial<VoteIntentData> = {}): VoteIntentData {
  return {
    poll_type_hash: new Uint8Array(32).fill(0xaa),
    voter_lock_hash: new Uint8Array(32).fill(0xbb),
    option_index: 1,
    voted_at_epoch: 42n,
    aggregated: false,
    refund_lock: makeScript(),
    ...overrides,
  };
}

function makeDelegation(overrides: Partial<DelegationData> = {}): DelegationData {
  return {
    delegator_lock_hash: new Uint8Array(32).fill(0x21),
    delegate_lock_hash: new Uint8Array(32).fill(0x22),
    poll_type_hash: new Uint8Array(32).fill(0x23),
    expires_epoch: 999n,
    ...overrides,
  };
}

function makeShard(overrides: Partial<TallyShardData> = {}): TallyShardData {
  return {
    version: 2,
    poll_type_hash: new Uint8Array(32).fill(0xa1),
    shard_id: 2,
    shard_count: 8,
    vote_counts: [3n, 0n, 7n],
    total_voters: 10n,
    counted_voter_root: new Uint8Array(32).fill(0x61),
    finalized: false,
    ...overrides,
  };
}

function makeMergeResult(overrides: Partial<TallyMergeResultData> = {}): TallyMergeResultData {
  const coverage = new Uint8Array(32);
  coverage[0] = 0b0000_0111;
  return {
    poll_type_hash: new Uint8Array(32).fill(0xa1),
    coverage,
    vote_counts: [4n, 5n, 6n],
    total_voters: 15n,
    merge_level: 1,
    version: 1,
    ...overrides,
  };
}

function pollBoolOffsets(encoded: Uint8Array): { isClosed: number; tokenWeighted: number } {
  const readU32 = (offset: number) =>
    (encoded[offset] |
      (encoded[offset + 1] << 8) |
      (encoded[offset + 2] << 16) |
      (encoded[offset + 3] << 24)) >>> 0;
  let offset = 0;
  offset += 4 + readU32(offset);
  const optionCount = readU32(offset);
  offset += 4;
  for (let index = 0; index < optionCount; index += 1) {
    offset += 4 + readU32(offset);
  }
  const voteCountLen = readU32(offset);
  offset += 4 + voteCountLen * 8;
  offset += 8 + 32;
  offset += 32 + 1;
  offset += 4 + readU32(offset);
  const isClosed = offset;
  offset += 1 + 8 + 8 + 8;
  const countedLen = readU32(offset);
  offset += 4 + countedLen * 32;
  return { isClosed, tokenWeighted: offset };
}

describe("poll codec", () => {
  test("round-trips poll bytes", () => {
    const poll = makePoll();
    const encoded = encodePollData(poll);

    expect(decodePollData(encoded)).toEqual(poll);
  });

  test("question length is still written as little-endian uint32", () => {
    const encoded = encodePollData(makePoll({ question: "Hello" }));
    expect(Array.from(encoded.slice(0, 4))).toEqual([5, 0, 0, 0]);
  });

  test("appends shard_count as little-endian uint32", () => {
    const encoded = encodePollData(makePoll({ shard_count: 16 }));
    expect(Array.from(encoded.slice(-4))).toEqual([16, 0, 0, 0]);
  });

  test("rejects invalid boolean bytes and trailing bytes", () => {
    const encoded = encodePollData(makePoll());
    const offsets = pollBoolOffsets(encoded);

    const invalidClosed = encoded.slice();
    invalidClosed[offsets.isClosed] = 2;
    expect(() => decodePollData(invalidClosed)).toThrow("is_closed");

    const invalidWeighted = encoded.slice();
    invalidWeighted[offsets.tokenWeighted] = 2;
    expect(() => decodePollData(invalidWeighted)).toThrow("token_weighted");

    const withTrailing = new Uint8Array(encoded.length + 1);
    withTrailing.set(encoded, 0);
    withTrailing[withTrailing.length - 1] = 0xff;
    expect(() => decodePollData(withTrailing)).toThrow("trailing");
  });
});

describe("vote intent codec", () => {
  test("round-trips intent bytes", () => {
    const intent = makeIntent();
    const encoded = encodeVoteIntentData(intent);

    expect(encoded.length).toBeGreaterThan(74);
    expect(decodeVoteIntentData(encoded)).toEqual(intent);
  });

  test("aggregated flag flips the final byte only", () => {
    const pending = encodeVoteIntentData(makeIntent({ aggregated: false }));
    const counted = encodeVoteIntentData(makeIntent({ aggregated: true }));

    expect(pending.slice(0, 73)).toEqual(counted.slice(0, 73));
    expect(pending[73]).toBe(0);
    expect(counted[73]).toBe(1);
  });

  test("rejects invalid aggregated byte and trailing bytes", () => {
    const encoded = encodeVoteIntentData(makeIntent());
    const invalidAggregated = encoded.slice();
    invalidAggregated[73] = 2;
    expect(() => decodeVoteIntentData(invalidAggregated)).toThrow("aggregated");

    const withTrailing = new Uint8Array(encoded.length + 1);
    withTrailing.set(encoded, 0);
    withTrailing[withTrailing.length - 1] = 0xff;
    expect(() => decodeVoteIntentData(withTrailing)).toThrow("trailing");
  });
});

describe("delegation codec", () => {
  test("round-trips delegation bytes", () => {
    const delegation = makeDelegation();
    const encoded = encodeDelegationData(delegation);

    expect(encoded.length).toBe(104);
    expect(decodeDelegationData(encoded)).toEqual(delegation);
  });

  test("rejects trailing bytes", () => {
    const encoded = encodeDelegationData(makeDelegation());
    const withTrailing = new Uint8Array(encoded.length + 1);
    withTrailing.set(encoded, 0);
    withTrailing[withTrailing.length - 1] = 0xff;

    expect(() => decodeDelegationData(withTrailing)).toThrow("trailing");
  });
});

describe("tally shard codec", () => {
  test("round-trips shard bytes", () => {
    const shard = makeShard();
    const encoded = encodeTallyShardData(shard);

    expect(decodeTallyShardData(encoded)).toEqual(shard);
  });

  test("uses the versioned fixed-root field order", () => {
    const shard = makeShard({
      shard_id: 5,
      shard_count: 16,
      vote_counts: [1n, 2n],
      total_voters: 3n,
      counted_voter_root: new Uint8Array(32).fill(0x7a),
      finalized: true,
    });
    const encoded = encodeTallyShardData(shard);

    expect(encoded[0]).toBe(2);
    expect(Array.from(encoded.slice(1, 33))).toEqual(Array.from(shard.poll_type_hash));
    expect(Array.from(encoded.slice(33, 37))).toEqual([5, 0, 0, 0]);
    expect(Array.from(encoded.slice(37, 41))).toEqual([16, 0, 0, 0]);
    expect(Array.from(encoded.slice(41, 45))).toEqual([2, 0, 0, 0]);
    expect(Array.from(encoded.slice(encoded.length - 33, encoded.length - 1))).toEqual(
      Array.from(shard.counted_voter_root)
    );
    expect(encoded.at(-1)).toBe(1);
  });

  test("rejects invalid shard_count", () => {
    expect(() => encodeTallyShardData(makeShard({ shard_count: 0 }))).toThrow("shard_count");
    expect(() => encodeTallyShardData(makeShard({ shard_count: 257 }))).toThrow("shard_count");

    const encoded = encodeTallyShardData(makeShard({ shard_id: 0, shard_count: 1 }));
    encoded[37] = 0;
    encoded[38] = 0;
    encoded[39] = 0;
    encoded[40] = 0;
    expect(() => decodeTallyShardData(encoded)).toThrow("shard_count");
  });

  test("rejects shard_id outside shard_count", () => {
    expect(() => encodeTallyShardData(makeShard({ shard_id: 8, shard_count: 8 }))).toThrow("shard_id");

    const encoded = encodeTallyShardData(makeShard({ shard_id: 0, shard_count: 8 }));
    encoded[33] = 8;
    expect(() => decodeTallyShardData(encoded)).toThrow("shard_id");
  });

  test("rejects invalid finalized byte", () => {
    const encoded = encodeTallyShardData(makeShard());
    encoded[encoded.length - 1] = 2;

    expect(() => decodeTallyShardData(encoded)).toThrow("finalized");
  });

  test("rejects an unknown layout version and malformed root", () => {
    expect(() => encodeTallyShardData(makeShard({ version: 1 }))).toThrow("version");
    expect(() =>
      encodeTallyShardData(makeShard({ counted_voter_root: new Uint8Array(31) }))
    ).toThrow("counted_voter_root");

    const encoded = encodeTallyShardData(makeShard());
    encoded[0] = 3;
    expect(() => decodeTallyShardData(encoded)).toThrow("version");
  });

  test("rejects trailing bytes", () => {
    const encoded = encodeTallyShardData(makeShard());
    const withTrailing = new Uint8Array(encoded.length + 1);
    withTrailing.set(encoded, 0);
    withTrailing[withTrailing.length - 1] = 0xff;

    expect(() => decodeTallyShardData(withTrailing)).toThrow("trailing");
  });
});

describe("tally aggregation proof codec", () => {
  test("round-trips a versioned compiled sparse-Merkle proof", () => {
    const proof = { version: 1, compiled_proof: new Uint8Array([0x4c, 0x4f, 0x50]) };
    expect(decodeTallyAggregationProof(encodeTallyAggregationProof(proof))).toEqual(proof);
  });

  test("rejects empty, unknown-version, truncated, and trailing proof bytes", () => {
    expect(() => encodeTallyAggregationProof({ version: 1, compiled_proof: new Uint8Array() })).toThrow(
      "empty"
    );
    expect(() =>
      encodeTallyAggregationProof({ version: 2, compiled_proof: new Uint8Array([1]) })
    ).toThrow("version");
    expect(() => decodeTallyAggregationProof(new Uint8Array([1, 3, 0, 0, 0, 1]))).toThrow();

    const encoded = encodeTallyAggregationProof({
      version: 1,
      compiled_proof: new Uint8Array([1, 2]),
    });
    const withTrailing = new Uint8Array(encoded.length + 1);
    withTrailing.set(encoded);
    withTrailing[withTrailing.length - 1] = 0xff;
    expect(() => decodeTallyAggregationProof(withTrailing)).toThrow("trailing");
  });
});

describe("tally merge result codec", () => {
  test("round-trips merge result bytes", () => {
    const result = makeMergeResult();
    const encoded = encodeTallyMergeResultData(result);

    expect(decodeTallyMergeResultData(encoded)).toEqual(result);
  });

  test("uses poll coverage counts total level version order", () => {
    const result = makeMergeResult({ merge_level: 2, version: 1 });
    const encoded = encodeTallyMergeResultData(result);

    expect(Array.from(encoded.slice(0, 32))).toEqual(Array.from(result.poll_type_hash));
    expect(Array.from(encoded.slice(32, 64))).toEqual(Array.from(result.coverage));
    expect(Array.from(encoded.slice(64, 68))).toEqual([3, 0, 0, 0]);
    expect(Array.from(encoded.slice(encoded.length - 8, encoded.length - 4))).toEqual([2, 0, 0, 0]);
    expect(Array.from(encoded.slice(encoded.length - 4))).toEqual([1, 0, 0, 0]);
  });

  test("rejects invalid coverage length and trailing bytes", () => {
    expect(() => encodeTallyMergeResultData(makeMergeResult({ coverage: new Uint8Array(31) }))).toThrow("coverage");

    const encoded = encodeTallyMergeResultData(makeMergeResult());
    const withTrailing = new Uint8Array(encoded.length + 1);
    withTrailing.set(encoded, 0);
    withTrailing[withTrailing.length - 1] = 0xff;

    expect(() => decodeTallyMergeResultData(withTrailing)).toThrow("trailing");
  });
});

describe("hex utilities", () => {
  test("hex strings round-trip", () => {
    const values = ["0x", "0x00", "0xdeadbeef", `0x${"ff".repeat(32)}`];
    for (const value of values) {
      expect(bytesToHex(hexToBytes(value))).toBe(value);
    }
  });
});
