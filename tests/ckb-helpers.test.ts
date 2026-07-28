/** Focused tests for production CKB protocol helpers. */

import { describe, expect, test } from "vitest";

import {
  absoluteEpochSince,
  buildGovernanceTypeScript,
  buildPollLockScript,
  buildTallyMergeResultTypeScript,
  buildTallyShardTypeScript,
  deduplicateHeaderHashes,
  derivePollTypeIdFromSeedInput,
  deriveTallyShardId,
  epochNumber,
  getChainTipStatus,
  hashTallyShardAssignmentInput,
  shannonsToCkb,
  validateCreatePollInput,
} from "../frontend/src/lib/ckb";
import { MAX_TALLY_SHARDS, OP, SHANNONS_PER_CKB } from "../frontend/src/lib/constants";
import { bytesToHex, hexToBytes } from "../frontend/src/lib/molecule";

describe("CKB protocol helpers", () => {
  test("normalizes CCC epoch values and rejects malformed input", () => {
    expect(epochNumber({ integer: 42n, numerator: 7n, denominator: 1800n })).toBe(42n);
    expect(epochNumber([43n, 0n, 1800n])).toBe(43n);
    expect(epochNumber("44,0,1800")).toBe(44n);
    expect(() => epochNumber({ integer: "invalid" })).toThrow("invalid epoch");
  });

  test("reads fractional epoch and optional RPC-node sync state", async () => {
    const status = await getChainTipStatus({
      getTipHeader: async () => ({
        epoch: { integer: 42n, numerator: 250n, denominator: 1000n },
        number: 900n,
        timestamp: 1_000n,
      }),
      requestor: {
        request: async (method: string) => {
          expect(method).toBe("sync_state");
          return {
            best_known_block_number: "0x3e8",
            best_known_block_timestamp: "0x7d0",
            ibd: true,
          };
        },
      },
    });

    expect(status).toEqual({
      epoch: 42n,
      epochIndex: 250n,
      epochLength: 1000n,
      blockNumber: 900n,
      blockTimestamp: 1_000n,
      bestKnownBlockNumber: 1_000n,
      bestKnownBlockTimestamp: 2_000n,
      initialBlockDownload: true,
    });
  });

  test("builds operation-scoped governance scripts", () => {
    const pollHash = `0x${"11".repeat(32)}`;
    const pollLock = buildPollLockScript(pollHash);
    const shard = buildTallyShardTypeScript(pollHash, 0x01020304);
    const merge = buildTallyMergeResultTypeScript(pollHash);

    expect(buildGovernanceTypeScript(OP.CREATE_POLL).args).toBe("0x01");
    expect(pollLock.args).toBe(`0x04${pollHash.slice(2)}`);
    expect(shard.args).toBe(`0x07${pollHash.slice(2)}04030201`);
    expect(merge.args).toBe(`0x08${pollHash.slice(2)}`);
    expect(() => buildTallyShardTypeScript(pollHash, -1)).toThrow("non-negative integer");
  });

  test("derives Type ID poll identities from the pinned seed and output index", () => {
    const seedA = { outPoint: { txHash: `0x${"21".repeat(32)}`, index: 0 } };
    const seedB = { outPoint: { txHash: `0x${"22".repeat(32)}`, index: 0 } };
    const first = derivePollTypeIdFromSeedInput(seedA, 0);

    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    expect(derivePollTypeIdFromSeedInput(seedA, 1)).not.toBe(first);
    expect(derivePollTypeIdFromSeedInput(seedB, 0)).not.toBe(first);
  });

  test("matches deterministic CKB shard-assignment vectors", () => {
    const vectors = [
      {
        poll: new Uint8Array(32),
        voter: new Uint8Array(32),
        shardCount: 1,
        digest: "0xb084041e7c8511e9279eaa616b52599f0c397f389afb6b48e087ca488d9aa7d7",
        shardId: 0,
      },
      {
        poll: new Uint8Array(32).fill(0x11),
        voter: new Uint8Array(32).fill(0x22),
        shardCount: 4,
        digest: "0xe994f19a5b320be7699c49732d5d6b029223e2bfdd128707a4c5991ef5d5b42f",
        shardId: 1,
      },
      {
        poll: hexToBytes("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
        voter: hexToBytes("0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"),
        shardCount: 32,
        digest: "0xa4f084f6e2668fdfa01f5a612fbdefbdb2002828a5efc0696d82ef6863bf82c4",
        shardId: 4,
      },
    ];

    for (const vector of vectors) {
      expect(bytesToHex(hashTallyShardAssignmentInput(vector.poll, vector.voter))).toBe(vector.digest);
      expect(deriveTallyShardId(vector.poll, vector.voter, vector.shardCount)).toBe(vector.shardId);
    }
  });

  test("rejects malformed shard-assignment inputs", () => {
    const hash = new Uint8Array(32);
    expect(() => deriveTallyShardId(hash.slice(1), hash, 4)).toThrow("poll_type_hash");
    expect(() => deriveTallyShardId(hash, hash.slice(1), 4)).toThrow("voter_lock_hash");
    expect(() => deriveTallyShardId(hash, hash, 0)).toThrow("shard_count");
    expect(() => deriveTallyShardId(hash, hash, MAX_TALLY_SHARDS + 1)).toThrow("shard_count");
  });

  test("encodes absolute epoch since and deduplicates origin headers", () => {
    expect(absoluteEpochSince(201n)).toBe(0x20000100000000c9n);
    expect(() => absoluteEpochSince(1n << 24n)).toThrow("24-bit");
    expect(deduplicateHeaderHashes([
      { hash: "0xAA" },
      { hash: "0xaa" },
      { hash: "0xBB" },
    ])).toEqual(["0xAA", "0xBB"]);
  });

  test("validates poll form boundaries and formats capacity without floating point", () => {
    expect(validateCreatePollInput({ question: "Proposal", options: ["Yes", "No"], durationEpochs: 10 })).toBeNull();
    expect(validateCreatePollInput({ question: "", options: ["Yes", "No"], durationEpochs: 10 })).toBe("Question is required");
    expect(validateCreatePollInput({ question: "Proposal", options: ["Yes"], durationEpochs: 10 })).toContain("between 2 and 10");
    expect(validateCreatePollInput({ question: "Proposal", options: ["Yes", "No"], durationEpochs: 0 })).toContain("between 1 and 1000");
    expect(validateCreatePollInput({ question: "é".repeat(129), options: ["Yes", "No"], durationEpochs: 10 })).toContain("UTF-8 bytes");
    expect(validateCreatePollInput({ question: "Proposal", options: ["é".repeat(33), "No"], durationEpochs: 10 })).toContain("UTF-8 bytes");
    expect(validateCreatePollInput({ question: "Proposal", options: ["Yes", "No"], durationEpochs: 1.5 })).toContain("whole number");
    expect(shannonsToCkb(61n * SHANNONS_PER_CKB + 123n)).toBe("61.00000123");
  });

  test("keeps retired opcodes reserved", () => {
    expect(OP.RETIRED_AGGREGATE_VOTES).toBe(0x03);
    expect(OP.RETIRED_REVOKE_DELEGATION).toBe(0x06);
    expect(OP.CREATE_TALLY_SHARD).toBe(0x07);
    expect(OP.MERGE_TALLY_SHARDS).toBe(0x08);
  });
});
