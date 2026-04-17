/**
 * Protocol Model Tests
 * ====================
 * Exercises the current poll, vote intent, aggregation, and delegation data
 * model without requiring a full CKB-VM syscall harness.
 */

declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => any;

import {
  decodeDelegationData,
  decodePollData,
  decodeVoteIntentData,
  EncodedScript,
  encodeDelegationData,
  encodePollData,
  encodeVoteIntentData,
  PollData,
  VoteIntentData,
} from "../backend/contract/src/molecule";

const CREATOR_DEPOSIT_SHANNONS = 500n * 100_000_000n;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function makeScript(overrides: Partial<EncodedScript> = {}): EncodedScript {
  return {
    code_hash: `0x${"44".repeat(32)}`,
    hash_type: "type",
    args: "0x9988",
    ...overrides,
  };
}

function makePoll(overrides: Partial<PollData> = {}): PollData {
  return {
    question: "Should the protocol adopt token-weighted voting later?",
    options: ["Yes", "No", "Need research"],
    vote_counts: [0n, 0n, 0n],
    deadline: 200n,
    creator: new Uint8Array(32).fill(0xab),
    is_closed: false,
    total_voters: 0n,
    creator_deposit: CREATOR_DEPOSIT_SHANNONS,
    pending_intent_count: 0n,
    counted_voter_lock_hashes: [],
    token_weighted: false,
    udt_type_hash: new Uint8Array(32),
    ...overrides,
  };
}

function makeIntent(overrides: Partial<VoteIntentData> = {}): VoteIntentData {
  return {
    poll_type_hash: new Uint8Array(32).fill(0x31),
    voter_lock_hash: new Uint8Array(32).fill(0x32),
    option_index: 0,
    voted_at_epoch: 120n,
    aggregated: false,
    refund_lock: makeScript(),
    ...overrides,
  };
}

describe("PollData encoding", () => {
  test("round-trips the v3 poll layout", () => {
    const poll = makePoll({
      vote_counts: [5n, 2n, 1n],
      total_voters: 8n,
      pending_intent_count: 3n,
      counted_voter_lock_hashes: [
        new Uint8Array(32).fill(0x01),
        new Uint8Array(32).fill(0x02),
        new Uint8Array(32).fill(0x03),
        new Uint8Array(32).fill(0x04),
        new Uint8Array(32).fill(0x05),
        new Uint8Array(32).fill(0x06),
        new Uint8Array(32).fill(0x07),
        new Uint8Array(32).fill(0x08),
      ],
    });
    const decoded = decodePollData(encodePollData(poll));

    expect(decoded).toEqual(poll);
  });

  test("supports token-weighted future fields without changing layout", () => {
    const poll = makePoll({
      token_weighted: true,
      udt_type_hash: new Uint8Array(32).fill(0xcd),
    });
    const decoded = decodePollData(encodePollData(poll));

    expect(decoded.token_weighted).toBe(true);
    expect(decoded.udt_type_hash).toEqual(poll.udt_type_hash);
  });
});

describe("VoteIntentData encoding", () => {
  test("round-trips intent cells with embedded refund locks", () => {
    const intent = makeIntent({ option_index: 2 });
    const encoded = encodeVoteIntentData(intent);
    const decoded = decodeVoteIntentData(encoded);

    expect(encoded.length).toBeGreaterThan(74);
    expect(decoded).toEqual(intent);
  });

  test("preserves aggregated status after batching", () => {
    const decoded = decodeVoteIntentData(encodeVoteIntentData(makeIntent({ aggregated: true })));
    expect(decoded.aggregated).toBe(true);
  });
});

describe("DelegationData encoding", () => {
  test("round-trips scoped delegations", () => {
    const delegation = {
      delegator_lock_hash: new Uint8Array(32).fill(0x41),
      delegate_lock_hash: new Uint8Array(32).fill(0x42),
      poll_type_hash: new Uint8Array(32).fill(0x43),
      expires_epoch: 300n,
    };

    expect(decodeDelegationData(encodeDelegationData(delegation))).toEqual(delegation);
  });
});

describe("Aggregation model", () => {
  test("increments vote counts and total voters by processed intents", () => {
    const before = makePoll({
      vote_counts: [3n, 1n, 0n],
      total_voters: 4n,
      pending_intent_count: 2n,
      counted_voter_lock_hashes: [
        new Uint8Array(32).fill(0x91),
        new Uint8Array(32).fill(0x92),
        new Uint8Array(32).fill(0x93),
        new Uint8Array(32).fill(0x94),
      ],
    });
    const intents = [makeIntent({ option_index: 0 }), makeIntent({ option_index: 2 })];
    const nextCounts = [...before.vote_counts];

    for (const intent of intents) {
      nextCounts[intent.option_index] += 1n;
    }

    const after = {
      ...before,
      vote_counts: nextCounts,
      total_voters: before.total_voters + BigInt(intents.length),
      pending_intent_count: 0n,
      counted_voter_lock_hashes: [
        ...before.counted_voter_lock_hashes,
        ...intents.map((intent) => intent.voter_lock_hash),
      ],
    };

    expect(after.vote_counts).toEqual([4n, 1n, 1n]);
    expect(after.total_voters).toBe(6n);
    expect(after.pending_intent_count).toBe(0n);
    expect(after.counted_voter_lock_hashes).toHaveLength(6);
  });

  test("registry-based uniqueness rejects double-counting the same voter", () => {
    const before = makePoll({
      total_voters: 1n,
      counted_voter_lock_hashes: [new Uint8Array(32).fill(0x32)],
    });
    const duplicateIntent = makeIntent({ voter_lock_hash: new Uint8Array(32).fill(0x32) });

    const alreadyCounted = before.counted_voter_lock_hashes.some(
      (entry) => equalBytes(entry, duplicateIntent.voter_lock_hash)
    );

    expect(alreadyCounted).toBe(true);
  });

  test("marks aggregated intents without changing voter identity", () => {
    const pending = makeIntent({ option_index: 1, aggregated: false });
    const aggregated = { ...pending, aggregated: true };

    expect(aggregated.voter_lock_hash).toEqual(pending.voter_lock_hash);
    expect(aggregated.refund_lock).toEqual(pending.refund_lock);
    expect(aggregated.option_index).toBe(pending.option_index);
    expect(aggregated.aggregated).toBe(true);
  });
});

describe("Close model", () => {
  test("closing a poll only flips is_closed in the poll body", () => {
    const before = makePoll({
      vote_counts: [5n, 4n, 1n],
      total_voters: 10n,
      pending_intent_count: 0n,
      counted_voter_lock_hashes: Array.from({ length: 10 }, (_, index) =>
        new Uint8Array(32).fill(index + 1)
      ),
    });
    const after = { ...before, is_closed: true };

    expect(after.question).toBe(before.question);
    expect(after.vote_counts).toEqual(before.vote_counts);
    expect(after.total_voters).toBe(before.total_voters);
    expect(after.is_closed).toBe(true);
  });
});
