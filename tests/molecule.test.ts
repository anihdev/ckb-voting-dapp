/**
 * Molecule Codec Tests
 * ====================
 * Verifies that backend and frontend serialize the same bytes for poll,
 * vote intent, and delegation cells.
 */

import { describe, expect, test } from "vitest";
import {
  decodeDelegationData as decodeBackendDelegationData,
  decodePollData as decodeBackendPollData,
  decodeVoteIntentData as decodeBackendVoteIntentData,
  encodeDelegationData as encodeBackendDelegationData,
  encodePollData as encodeBackendPollData,
  encodeVoteIntentData as encodeBackendVoteIntentData,
} from "../backend/contract/src/molecule";
import {
  bytesToHex,
  decodeDelegationData,
  decodePollData,
  decodeVoteIntentData,
  encodeDelegationData,
  encodePollData,
  encodeVoteIntentData,
  hexToBytes,
  EncodedScript,
  PollData,
  VoteIntentData,
  DelegationData,
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
    is_closed: false,
    total_voters: 13n,
    creator_deposit: 500n * 100_000_000n,
    pending_intent_count: 2n,
    counted_voter_lock_hashes: Array.from({ length: 13 }, (_, index) =>
      new Uint8Array(32).fill(index + 1)
    ),
    token_weighted: false,
    udt_type_hash: new Uint8Array(32),
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

describe("poll codec parity", () => {
  test("frontend and backend encode the same poll bytes", () => {
    const poll = makePoll();
    const frontend = encodePollData(poll);
    const backend = encodeBackendPollData(poll as any);

    expect(bytesToHex(frontend)).toBe(bytesToHex(backend));
    expect(decodePollData(frontend)).toEqual(poll);
    expect(decodeBackendPollData(backend)).toEqual(poll);
  });

  test("question length is still written as little-endian uint32", () => {
    const encoded = encodePollData(makePoll({ question: "Hello" }));
    expect(Array.from(encoded.slice(0, 4))).toEqual([5, 0, 0, 0]);
  });
});

describe("vote intent codec parity", () => {
  test("frontend and backend encode the same intent bytes", () => {
    const intent = makeIntent();
    const frontend = encodeVoteIntentData(intent);
    const backend = encodeBackendVoteIntentData(intent as any);

    expect(frontend.length).toBeGreaterThan(74);
    expect(bytesToHex(frontend)).toBe(bytesToHex(backend));
    expect(decodeVoteIntentData(frontend)).toEqual(intent);
    expect(decodeBackendVoteIntentData(backend)).toEqual(intent);
  });

  test("aggregated flag flips the final byte only", () => {
    const pending = encodeVoteIntentData(makeIntent({ aggregated: false }));
    const counted = encodeVoteIntentData(makeIntent({ aggregated: true }));

    expect(pending.slice(0, 73)).toEqual(counted.slice(0, 73));
    expect(pending[73]).toBe(0);
    expect(counted[73]).toBe(1);
  });
});

describe("delegation codec parity", () => {
  test("frontend and backend encode the same delegation bytes", () => {
    const delegation = makeDelegation();
    const frontend = encodeDelegationData(delegation);
    const backend = encodeBackendDelegationData(delegation as any);

    expect(frontend.length).toBe(104);
    expect(bytesToHex(frontend)).toBe(bytesToHex(backend));
    expect(decodeDelegationData(frontend)).toEqual(delegation);
    expect(decodeBackendDelegationData(backend)).toEqual(delegation);
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
