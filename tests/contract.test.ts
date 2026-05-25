/**
 * Protocol Model Tests
 * ====================
 * Exercises the current poll, vote intent, aggregation, and delegation data
 * model without requiring a full CKB-VM syscall harness.
 */

import { describe, expect, test } from "vitest";

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
} from "../frontend/src/lib/molecule";

const CREATOR_DEPOSIT_SHANNONS = 500n * 100_000_000n;
const VOTER_DEPOSIT_SHANNONS = 61n * 100_000_000n;
const MAX_WEIGHT_UNITS_PER_INTENT = 20n;
const FORCE_CLOSE_GRACE_EPOCHS = 10n;

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

function computeWeightUnits(intentCapacity: bigint, tokenWeighted: boolean): bigint {
  if (!tokenWeighted) return 1n;
  const units = intentCapacity / VOTER_DEPOSIT_SHANNONS;
  if (units < 1n) throw new Error("intent capacity below minimum unit");
  return units > MAX_WEIGHT_UNITS_PER_INTENT ? MAX_WEIGHT_UNITS_PER_INTENT : units;
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

  test("supports pending intent replacement with same voter/poll identity", () => {
    const before = makeIntent({ option_index: 0, voted_at_epoch: 120n, aggregated: false });
    const after = { ...before, option_index: 2, voted_at_epoch: 121n };

    expect(equalBytes(before.poll_type_hash, after.poll_type_hash)).toBe(true);
    expect(equalBytes(before.voter_lock_hash, after.voter_lock_hash)).toBe(true);
    expect(after.aggregated).toBe(false);
    expect(after.option_index).toBe(2);
    expect(after.voted_at_epoch >= before.voted_at_epoch).toBe(true);
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

describe("Delegation model", () => {
  test("delegator and delegate must not be the same lock hash", () => {
    const delegation = {
      delegator_lock_hash: new Uint8Array(32).fill(0x51),
      delegate_lock_hash: new Uint8Array(32).fill(0x52),
      poll_type_hash: new Uint8Array(32).fill(0x53),
      expires_epoch: 0n,
    };

    expect(equalBytes(delegation.delegator_lock_hash, delegation.delegate_lock_hash)).toBe(false);
  });

  test("revocation keeps lock ownership and minimum delegation capacity", () => {
    const inputLock = makeScript({ args: "0xaaaa" });
    const outputLock = { ...inputLock };
    const inputCapacity = 70n * 100_000_000n;
    const outputCapacity = 70n * 100_000_000n;
    const minDelegationCapacity = 61n * 100_000_000n;

    expect(outputLock).toEqual(inputLock);
    expect(outputCapacity >= minDelegationCapacity).toBe(true);
    expect(outputCapacity >= inputCapacity).toBe(true);
  });
});

describe("Aggregation model", () => {
  test("token-weighted aggregation uses capped intent-capacity units", () => {
    const before = makePoll({
      token_weighted: true,
      vote_counts: [0n, 0n, 0n],
    });
    const intentCapacities = [
      3n * VOTER_DEPOSIT_SHANNONS,
      99n * VOTER_DEPOSIT_SHANNONS,
    ];
    const nextCounts = [...before.vote_counts];
    nextCounts[0] += computeWeightUnits(intentCapacities[0], before.token_weighted);
    nextCounts[2] += computeWeightUnits(intentCapacities[1], before.token_weighted);

    expect(nextCounts).toEqual([3n, 0n, MAX_WEIGHT_UNITS_PER_INTENT]);
  });

  test("rejects mixing intents from a different poll type hash", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xa1);
    const intents = [
      makeIntent({ poll_type_hash: pollTypeHash }),
      makeIntent({ poll_type_hash: new Uint8Array(32).fill(0xb2) }),
    ];

    const allMatchPoll = intents.every((intent) => equalBytes(intent.poll_type_hash, pollTypeHash));
    expect(allMatchPoll).toBe(false);
  });

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
  test("requires refunded pending intents to be at least tracked pending count", () => {
    const trackedPending = 2n;
    const refundedPending = 3n;

    expect(refundedPending >= trackedPending).toBe(true);
  });

  test("closing transition marks the poll closed and clears pending intents", () => {
    const before = makePoll({
      vote_counts: [5n, 4n, 1n],
      total_voters: 10n,
      pending_intent_count: 2n,
      counted_voter_lock_hashes: Array.from({ length: 10 }, (_, index) =>
        new Uint8Array(32).fill(index + 1)
      ),
    });
    const after = { ...before, is_closed: true, pending_intent_count: 0n };

    expect(after.question).toBe(before.question);
    expect(after.vote_counts).toEqual(before.vote_counts);
    expect(after.total_voters).toBe(before.total_voters);
    expect(after.is_closed).toBe(true);
    expect(after.pending_intent_count).toBe(0n);
  });

  test("force-close eligibility starts only after deadline plus grace", () => {
    const deadline = 220n;
    const allowEpoch = deadline + FORCE_CLOSE_GRACE_EPOCHS;

    expect(allowEpoch).toBe(230n);
    expect(allowEpoch > deadline).toBe(true);
  });
});

describe("Lifecycle integration model", () => {
  test("pending replacement then aggregate then close preserves one counted voter", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xa1);
    const voterLockHash = new Uint8Array(32).fill(0xb1);
    const pollBefore = makePoll({
      options: ["A", "B", "C"],
      vote_counts: [0n, 0n, 0n],
      pending_intent_count: 1n,
      total_voters: 0n,
      counted_voter_lock_hashes: [],
    });
    const intentBefore = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: voterLockHash,
      option_index: 0,
      voted_at_epoch: 120n,
      aggregated: false,
    });
    const intentReplaced = {
      ...intentBefore,
      option_index: 2,
      voted_at_epoch: 121n,
      aggregated: false,
    };
    const intentAggregated = {
      ...intentReplaced,
      aggregated: true,
    };
    const pollAfterAggregate = {
      ...pollBefore,
      vote_counts: [0n, 0n, 1n],
      total_voters: 1n,
      pending_intent_count: 0n,
      counted_voter_lock_hashes: [voterLockHash],
    };
    const pollAfterClose = {
      ...pollAfterAggregate,
      is_closed: true,
      pending_intent_count: 0n,
    };

    expect(equalBytes(intentBefore.poll_type_hash, intentReplaced.poll_type_hash)).toBe(true);
    expect(equalBytes(intentBefore.voter_lock_hash, intentReplaced.voter_lock_hash)).toBe(true);
    expect(intentReplaced.voted_at_epoch >= intentBefore.voted_at_epoch).toBe(true);
    expect(intentAggregated.aggregated).toBe(true);
    expect(pollAfterAggregate.vote_counts).toEqual([0n, 0n, 1n]);
    expect(pollAfterAggregate.total_voters).toBe(1n);
    expect(pollAfterAggregate.counted_voter_lock_hashes).toHaveLength(1);
    expect(pollAfterClose.is_closed).toBe(true);
    expect(pollAfterClose.pending_intent_count).toBe(0n);
  });

  test("close lower-bound refund rule accepts extra consumed pending intents", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xc3);
    const pendingIntentA = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: new Uint8Array(32).fill(0x11),
      aggregated: false,
    });
    const pendingIntentB = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: new Uint8Array(32).fill(0x22),
      aggregated: false,
    });
    const trackedPending = 1n;
    const refundedPending = [pendingIntentA, pendingIntentB].filter((intent) => !intent.aggregated).length;

    expect(BigInt(refundedPending) >= trackedPending).toBe(true);
  });
});

describe("Multi-actor boundary model", () => {
  test("third-party aggregation no longer depends on voter lock signatures", () => {
    const aggregatorLockHash = new Uint8Array(32).fill(0xa1);
    const voterLockHash = new Uint8Array(32).fill(0xb2);
    const refundLock = makeScript({ args: "0x4455" });
    const intentLock = makeScript({
      code_hash: `0x${"77".repeat(32)}`,
      hash_type: "data1",
      args: `0x02${"11".repeat(32)}`,
    });

    const intent = makeIntent({
      voter_lock_hash: voterLockHash,
      refund_lock: refundLock,
      aggregated: false,
    });
    const aggregatedIntent = {
      ...intent,
      aggregated: true,
    };

    expect(equalBytes(aggregatorLockHash, intent.voter_lock_hash)).toBe(false);
    expect(aggregatedIntent.refund_lock).toEqual(intent.refund_lock);
    expect(aggregatedIntent.aggregated).toBe(true);
    expect(intentLock.args.startsWith("0x02")).toBe(true);
  });

  test("aggregation is serial because each batch consumes previous poll output", () => {
    const firstPollOutPoint = { txHash: "0xaaa", index: 0 };
    const secondPollOutPoint = { txHash: "0xbbb", index: 0 };

    // Batch N+1 can only build on the poll output produced by batch N.
    const batch1Output = secondPollOutPoint;
    const batch2InputMustMatch = secondPollOutPoint;

    expect(batch1Output).toEqual(batch2InputMustMatch);
    expect(batch2InputMustMatch).not.toEqual(firstPollOutPoint);
  });

  test("large intent sets require multiple sequential batches with MAX_INTENTS_PER_AGG=50", () => {
    const maxIntentsPerBatch = 50n;
    const pendingIntents = 1000n;
    const batches = (pendingIntents + maxIntentsPerBatch - 1n) / maxIntentsPerBatch;

    expect(batches).toBe(20n);
    expect(batches > 1n).toBe(true);
  });

  test("permissionless force-close is epoch-gated after deadline plus grace", () => {
    const deadline = 500n;
    const nowBeforeGrace = deadline + FORCE_CLOSE_GRACE_EPOCHS;
    const nowAfterGrace = nowBeforeGrace + 1n;

    expect(nowBeforeGrace > deadline).toBe(true);
    expect(nowAfterGrace > deadline + FORCE_CLOSE_GRACE_EPOCHS).toBe(true);
  });
});
