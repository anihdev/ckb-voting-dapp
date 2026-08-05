/**
 * Constant-Size Tally Lane Capacity
 * =================================
 * Host-side CCC evidence for the v2 lane codec. The old lane appended one
 * 32-byte voter hash per counted vote and eventually exceeded its fixed cell
 * capacity. V2 stores one 32-byte sparse-Merkle root instead, so voter growth
 * changes the committed root and total only, never the serialized byte length.
 */

import { ccc } from "@ckb-ccc/core";
import { describe, expect, test } from "vitest";

import {
  buildGovernanceTypeScript,
  buildTallyShardTypeScript,
  estimateOutputCapacity,
  hashScript,
} from "./ckb";
import { decodeTallyShardData, encodeTallyShardData } from "./molecule";
import { OP, SHANNONS_PER_CKB, TALLY_SHARD_MIN_SHANNONS } from "./constants";

const POLL_TYPE_HASH = hashScript(
  buildGovernanceTypeScript(OP.CREATE_POLL, `0x${"22".repeat(32)}`)
);
const SHARD_SCRIPT = buildTallyShardTypeScript(POLL_TYPE_HASH, 0);

function laneData(totalVoters: bigint, rootByte = 0): Uint8Array {
  return encodeTallyShardData({
    version: 2,
    poll_type_hash: ccc.bytesFrom(POLL_TYPE_HASH),
    shard_id: 0,
    shard_count: 8,
    vote_counts: [totalVoters, 0n],
    total_voters: totalVoters,
    counted_voter_root: new Uint8Array(32).fill(rootByte),
    finalized: false,
  });
}

function occupiedCapacity(data: Uint8Array): bigint {
  const output = ccc.CellOutput.from({
    lock: SHARD_SCRIPT,
    type: SHARD_SCRIPT,
    capacity: 0n,
  });
  return BigInt(output.occupiedSize + data.length) * SHANNONS_PER_CKB;
}

function assignedCapacity(data: Uint8Array): bigint {
  const estimated = estimateOutputCapacity(SHARD_SCRIPT, SHARD_SCRIPT, data.length);
  return estimated > TALLY_SHARD_MIN_SHANNONS ? estimated : TALLY_SHARD_MIN_SHANNONS;
}

describe("constant-size tally lane capacity", () => {
  test("encodes the explicit v2 version and 32-byte counted-voter root", () => {
    const decoded = decodeTallyShardData(laneData(12n, 0x4a));
    expect(decoded.version).toBe(2);
    expect(decoded.total_voters).toBe(12n);
    expect(decoded.counted_voter_root).toEqual(new Uint8Array(32).fill(0x4a));
  });

  test("serialized and occupied size do not grow with voter count", () => {
    const empty = laneData(0n);
    const large = laneData(1_000_000n, 0x7f);
    expect(large.length).toBe(empty.length);
    expect(occupiedCapacity(large)).toBe(occupiedCapacity(empty));
  });

  test("the creation builder assigns enough fixed capacity for every root update", () => {
    const empty = laneData(0n);
    const updated = laneData(1_000_000n, 0x7f);
    expect(occupiedCapacity(empty)).toBeLessThanOrEqual(assignedCapacity(empty));
    expect(occupiedCapacity(updated)).toBeLessThanOrEqual(assignedCapacity(empty));
  });
});
