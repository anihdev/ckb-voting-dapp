/** Focused tests for lifecycle, tally-frontier, and refund UI helpers. */

import { describe, expect, test } from "vitest";

import {
  buildProtocolTimeline,
  canFinalizeTallyShardFromUi,
  computeCanonicalTallyFrontier,
  epochSpanInUnit,
  estimatePollCloseHours,
  filterPollsByLifecycle,
  FINALIZE_PENDING_INTENTS_WARNING,
  formatApproxEpochDuration,
  formatApproxWallClockDuration,
  getFinalizeShardConfirmationMessage,
  getPollFilterCounts,
  isPollVotingSupported,
  pollDurationToEpochs,
  selectCloseTimeIntentRefunds,
  tallyMergeCoverageComplete,
  tallyMergeCoverageCount,
  UNSUPPORTED_WEIGHTED_POLL_LABEL,
} from "../frontend/src/lib/protocolUi";
import { bytesToHex } from "../frontend/src/lib/molecule";
import { Poll, TallyMergeResult, TallyShard } from "../frontend/src/lib/types";

const POLL_ID = `0x${"11".repeat(32)}`;

function coverage(...shardIds: number[]): string {
  const bytes = new Uint8Array(32);
  for (const shardId of shardIds) {
    bytes[Math.floor(shardId / 8)] |= 1 << (shardId % 8);
  }
  return bytesToHex(bytes);
}

function makeShard(overrides: Partial<TallyShard> = {}): TallyShard {
  return {
    id: "shard-0",
    pollId: POLL_ID,
    outPoint: { txHash: `0x${"31".repeat(32)}`, index: 0 },
    shardId: 0,
    shardCount: 4,
    voteCounts: [0n, 0n, 0n],
    totalVoters: 0n,
    finalized: false,
    capacity: 61n * 100_000_000n,
    ...overrides,
  };
}

function makeMerge(overrides: Partial<TallyMergeResult> = {}): TallyMergeResult {
  return {
    id: "merge-0",
    pollId: POLL_ID,
    outPoint: { txHash: `0x${"32".repeat(32)}`, index: 0 },
    coverage: coverage(0),
    voteCounts: [0n, 0n, 0n],
    totalVoters: 0n,
    mergeLevel: 1,
    version: 1,
    capacity: 61n * 100_000_000n,
    ...overrides,
  };
}

function makePoll(overrides: Partial<Poll> = {}): Poll {
  return {
    id: POLL_ID,
    outPoint: { txHash: `0x${"33".repeat(32)}`, index: 0 },
    question: "Should the protocol use the sharded lifecycle?",
    options: ["Yes", "No", "Abstain"],
    voteCounts: [0n, 0n, 0n],
    createdEpoch: 10n,
    deadline: 100n,
    creator: `0x${"aa".repeat(32)}`,
    isClosed: false,
    totalVoters: 0n,
    creatorDeposit: 500n * 100_000_000n,
    pendingIntentCount: 0n,
    protocolPendingIntentCount: 0n,
    tokenWeighted: false,
    udtTypeHash: `0x${"00".repeat(32)}`,
    shardCount: 4,
    tallyShards: [],
    tallyMergeResults: [],
    tallyFrontier: {
      source: "live-shards",
      coveredShardCount: 0,
      shardCount: 4,
      coverageComplete: false,
      selectedMergeResultIds: [],
      selectedShardIds: [],
      uncoveredShardIds: [0, 1, 2, 3],
    },
    totalVotes: 0n,
    winnerIndex: null,
    authorityOptions: [],
    outstandingIntentCount: 0,
    lateIntentCount: 0,
    refundableIntentCount: 0,
    ...overrides,
  };
}

describe("poll lifecycle UI", () => {
  test("uses the four-hour CKB epoch target for approximate wall-clock copy", () => {
    expect(formatApproxEpochDuration(0n)).toBe("0 epochs (~0 hours)");
    expect(formatApproxEpochDuration(1n)).toBe("1 epoch (~4 hours)");
    expect(formatApproxEpochDuration(6n)).toBe("6 epochs (~1 day)");
    expect(formatApproxEpochDuration(100n)).toBe("100 epochs (~16.7 days)");
  });

  test("converts human poll durations to whole epochs without rounding down", () => {
    expect(pollDurationToEpochs(3, "days")).toBe(18);
    expect(pollDurationToEpochs(5, "hours")).toBe(2);
    expect(pollDurationToEpochs(1.2, "epochs")).toBe(2);
    expect(pollDurationToEpochs(0, "days")).toBe(0);
    expect(epochSpanInUnit(18, "days")).toBe(3);
    expect(epochSpanInUnit(18, "hours")).toBe(72);
  });

  test("estimates the close window from the fractional tip epoch", () => {
    expect(estimatePollCloseHours(100n, { epoch: 100n, index: 50n, length: 100n })).toBe(2);
    expect(estimatePollCloseHours(100n, { epoch: 99n, index: 50n, length: 100n })).toBe(6);
    expect(estimatePollCloseHours(100n, { epoch: 101n, index: 0n, length: 100n })).toBe(0);
    expect(formatApproxWallClockDuration(6)).toBe("about 6 hours");
  });

  test("filters and sorts lifecycle states without hiding archived polls entirely", () => {
    const open = makePoll({ id: "open", deadline: 100n, createdEpoch: 10n });
    const needsClose = makePoll({ id: "needs", deadline: 20n, createdEpoch: 11n });
    const archived = makePoll({ id: "archived", deadline: 20n, createdEpoch: 12n, isClosed: true });
    const polls = [archived, open, needsClose];

    expect(filterPollsByLifecycle(polls, "open", 50n).map((poll) => poll.id)).toEqual(["open"]);
    expect(filterPollsByLifecycle(polls, "archived", 50n).map((poll) => poll.id)).toEqual(["archived"]);
    expect(filterPollsByLifecycle(polls, "all", 50n).map((poll) => poll.id)).toEqual(["needs", "open", "archived"]);
    expect(getPollFilterCounts(polls, 50n)).toEqual({ open: 1, needsClose: 1, archived: 1, all: 3 });
  });

  test("allows post-deadline finalization and warns about indexed pending intents", () => {
    const poll = makePoll({
      pendingIntentCount: 2n,
      tallyShards: [makeShard({ shardId: 0 }), makeShard({ id: "shard-1", shardId: 1, finalized: true })],
    });

    expect(canFinalizeTallyShardFromUi(poll, 100n)).toBe(false);
    expect(canFinalizeTallyShardFromUi(poll, 101n)).toBe(true);
    expect(getFinalizeShardConfirmationMessage(poll)).toContain(FINALIZE_PENDING_INTENTS_WARNING);
  });

  test("shows the active sharded protocol timeline", () => {
    const timeline = buildProtocolTimeline([makePoll({ pendingIntentCount: 1n })], [], 50n);
    expect(timeline.map((step) => step.op)).toContain("CREATE_TALLY_SHARD");
    expect(timeline.map((step) => step.op)).not.toContain("AGGREGATE_VOTES");
  });

  test("marks weighted polls unsupported while retaining recovery finalization", () => {
    const weighted = makePoll({
      tokenWeighted: true,
      tallyShards: [makeShard()],
    });

    expect(isPollVotingSupported(weighted)).toBe(false);
    expect(UNSUPPORTED_WEIGHTED_POLL_LABEL).toBe("Weighted voting disabled; recovery only");
    expect(canFinalizeTallyShardFromUi(weighted, weighted.deadline + 1n)).toBe(true);
  });

  test("does not advertise weighted vote or aggregation operations as live", () => {
    const weighted = makePoll({
      tokenWeighted: true,
      pendingIntentCount: 1n,
      totalVotes: 4n,
    });
    const timeline = buildProtocolTimeline([weighted], [], 50n);

    expect(timeline.find((step) => step.op === "CREATE_VOTE_INTENT")?.state).toBe("pending");
    expect(timeline.find((step) => step.label === "Shard aggregation")?.state).toBe("pending");
  });
});

describe("canonical tally frontier", () => {
  test("uses a complete merge result instead of stale live shards", () => {
    const frontier = computeCanonicalTallyFrontier({
      optionCount: 3,
      shardCount: 4,
      shards: [makeShard({ voteCounts: [99n, 99n, 99n], totalVoters: 297n })],
      mergeResults: [makeMerge({
        id: "complete",
        coverage: coverage(0, 1, 2, 3),
        voteCounts: [4n, 3n, 2n],
        totalVoters: 9n,
      })],
    });

    expect(frontier.source).toBe("complete-merge");
    expect(frontier.voteCounts).toEqual([4n, 3n, 2n]);
    expect(frontier.coverageComplete).toBe(true);
  });

  test("combines disjoint partial merges with uncovered live shards", () => {
    const frontier = computeCanonicalTallyFrontier({
      optionCount: 3,
      shardCount: 4,
      shards: [
        makeShard({ id: "shard-0-stale", shardId: 0, voteCounts: [99n, 0n, 0n], totalVoters: 99n }),
        makeShard({ id: "shard-2", shardId: 2, voteCounts: [0n, 0n, 3n], totalVoters: 3n }),
        makeShard({ id: "shard-3", shardId: 3, voteCounts: [4n, 0n, 0n], totalVoters: 4n }),
      ],
      mergeResults: [makeMerge({
        id: "merge-01",
        coverage: coverage(0, 1),
        voteCounts: [1n, 2n, 0n],
        totalVoters: 3n,
      })],
    });

    expect(frontier.source).toBe("merge-frontier");
    expect(frontier.voteCounts).toEqual([5n, 2n, 3n]);
    expect(frontier.totalVoters).toBe(10n);
    expect(frontier.selectedShardIds).toEqual([2, 3]);
    expect(frontier.coverageComplete).toBe(true);
  });

  test("ignores overlapping, malformed, and out-of-range candidates", () => {
    const frontier = computeCanonicalTallyFrontier({
      optionCount: 3,
      shardCount: 4,
      shards: [
        makeShard({ id: "shard-2", shardId: 2, voteCounts: [0n, 0n, 3n], totalVoters: 3n }),
        makeShard({ id: "bad-shard", shardId: 9, voteCounts: [100n, 0n, 0n], totalVoters: 100n }),
      ],
      mergeResults: [
        makeMerge({ id: "merge-01", coverage: coverage(0, 1), voteCounts: [1n, 2n, 0n], totalVoters: 3n }),
        makeMerge({ id: "overlap", coverage: coverage(1, 2), voteCounts: [100n, 100n, 100n], totalVoters: 300n }),
        makeMerge({ id: "malformed", coverage: "0x1234", voteCounts: [100n, 100n, 100n], totalVoters: 300n }),
      ],
    });

    expect(frontier.voteCounts).toEqual([1n, 2n, 3n]);
    expect(frontier.selectedMergeResultIds).toEqual(["merge-01"]);
    expect(frontier.coverageComplete).toBe(false);
    expect(frontier.uncoveredShardIds).toEqual([3]);
  });

  test("uses the closed poll result after tally cells are consumed", () => {
    const frontier = computeCanonicalTallyFrontier({
      optionCount: 3,
      shardCount: 4,
      pollVoteCounts: [5n, 2n, 1n],
      pollTotalVoters: 8n,
      pollIsClosed: true,
      shards: [],
      mergeResults: [],
    });

    expect(frontier.source).toBe("closed-poll");
    expect(frontier.voteCounts).toEqual([5n, 2n, 1n]);
    expect(frontier.coverageComplete).toBe(true);
  });

  test("rejects retired non-sharded display and validates coverage bounds", () => {
    expect(() => computeCanonicalTallyFrontier({
      optionCount: 2,
      shardCount: 0,
      shards: [],
      mergeResults: [],
    })).toThrow("Non-sharded poll-cell aggregation is retired");

    expect(tallyMergeCoverageCount(coverage(0, 1, 3))).toBe(3);
    expect(tallyMergeCoverageComplete(coverage(0, 1, 2, 3), 4)).toBe(true);
    expect(tallyMergeCoverageComplete(coverage(0, 1, 2, 4), 4)).toBe(false);
  });
});

describe("close-time refund selection", () => {
  test("prefers pending intents, filters another poll, and leaves overflow refundable", () => {
    const candidates = [
      { cell: "aggregated", pollTypeHash: POLL_ID, aggregated: true, sortKey: "002" },
      { cell: "wrong-poll", pollTypeHash: `0x${"22".repeat(32)}`, aggregated: false, sortKey: "000" },
      { cell: "pending-b", pollTypeHash: POLL_ID, aggregated: false, sortKey: "001" },
      { cell: "pending-a", pollTypeHash: POLL_ID, aggregated: false, sortKey: "000" },
    ];
    const selection = selectCloseTimeIntentRefunds(candidates, {
      pollTypeHash: POLL_ID,
      trackedPendingLowerBound: 2n,
      maxRefunds: 2,
    });

    expect(selection.included.map((candidate) => candidate.cell)).toEqual(["pending-a", "pending-b"]);
    expect(selection.omitted.map((candidate) => candidate.cell)).toEqual(["aggregated"]);
    expect(selection.omittedAggregatedCount).toBe(1);
  });

  test("rejects missing tracked pending intents and an impossible cap", () => {
    const onePending = [{ cell: "pending", pollTypeHash: POLL_ID, aggregated: false }];
    expect(() => selectCloseTimeIntentRefunds(onePending, {
      pollTypeHash: POLL_ID,
      trackedPendingLowerBound: 2n,
      maxRefunds: 2,
    })).toThrow("at least the pending intents tracked");
    expect(() => selectCloseTimeIntentRefunds(onePending, {
      pollTypeHash: POLL_ID,
      trackedPendingLowerBound: 2n,
      maxRefunds: 1,
    })).toThrow("exceed the frontend close-time refund cap");
  });
});
