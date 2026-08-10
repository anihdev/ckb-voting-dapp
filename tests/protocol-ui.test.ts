/** Focused tests for lifecycle, tally-frontier, and refund UI helpers. */

import { describe, expect, test } from "vitest";

import {
  buildProtocolTimeline,
  canDelegateForPoll,
  canFinalizeTallyShardFromUi,
  countAggregationBatches,
  computeCanonicalTallyFrontier,
  CREATOR_VOTING_DISABLED_MESSAGE,
  derivePollOutcome,
  deriveVoteAuthorityOptions,
  describeIndexerQueryError,
  epochSpanInUnit,
  estimatePollCloseHours,
  finalizationReadinessNeedsCaution,
  filterPollsByLifecycle,
  FINALIZE_PENDING_INTENTS_WARNING,
  formatFinalizationReadinessCheck,
  formatApproxEpochDuration,
  formatApproxWallClockDuration,
  formatPollDurationUnit,
  getDelegationLifecycle,
  getFinalizeShardConfirmationMessage,
  getPollFilterCounts,
  isLeadingOption,
  isPollVotingSupported,
  minimumPollDurationValue,
  pollDurationToEpochs,
  selectCloseTimeIntentRefunds,
  selectDefaultTimelinePoll,
  sortPollsForTimeline,
  summarizeFinalizationReadiness,
  summarizeDelegations,
  tallyMergeCoverageComplete,
  tallyMergeCoverageCount,
  UNSUPPORTED_WEIGHTED_POLL_LABEL,
  validatePollDurationSelection,
} from "../frontend/src/lib/protocolUi";
import { bytesToHex } from "../frontend/src/lib/molecule";
import {
  DelegationRecord,
  Poll,
  TallyMergeResult,
  TallyShard,
  VoteIntent,
} from "../frontend/src/lib/types";

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
    countedVoterRoot: `0x${"00".repeat(32)}`,
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
    authorityOptions: [],
    aggregationBatchCount: 0,
    outstandingIntentCount: 0,
    lateIntentCount: 0,
    refundableIntentCount: 0,
    ...overrides,
  };
}

function makeIntent(overrides: Partial<VoteIntent> = {}): VoteIntent {
  return {
    id: "intent-0",
    pollId: POLL_ID,
    outPoint: { txHash: `0x${"51".repeat(32)}`, index: 0 },
    voterLockHash: `0x${"bb".repeat(32)}`,
    optionIndex: 0,
    votedAtEpoch: 0n,
    createdEpoch: 20n,
    aggregated: false,
    capacity: 61n * 100_000_000n,
    ...overrides,
  };
}

function makeDelegation(overrides: Partial<DelegationRecord> = {}): DelegationRecord {
  return {
    id: "delegation-0",
    outPoint: { txHash: `0x${"52".repeat(32)}`, index: 0 },
    delegatorLockHash: `0x${"cc".repeat(32)}`,
    delegateLockHash: `0x${"bb".repeat(32)}`,
    pollId: POLL_ID,
    expiresEpoch: 0n,
    capacity: 61n * 100_000_000n,
    isDelegator: false,
    ...overrides,
  };
}

describe("vote authority derivation", () => {
  const VIEWER = `0x${"bb".repeat(32)}`;

  test("clears wallet authority when no viewer is connected", () => {
    expect(
      deriveVoteAuthorityOptions({
        poll: makePoll(),
        intents: [],
        delegations: [],
        viewerLockHash: null,
      })
    ).toEqual([]);
  });

  test("derives direct authority immediately from cached indexed intents", () => {
    const available = deriveVoteAuthorityOptions({
      poll: makePoll(),
      intents: [],
      delegations: [],
      viewerLockHash: VIEWER,
    });
    const used = deriveVoteAuthorityOptions({
      poll: makePoll(),
      intents: [makeIntent()],
      delegations: [],
      viewerLockHash: VIEWER.toUpperCase(),
    });

    expect(available).toMatchObject([
      {
        id: "self",
        voterLockHash: VIEWER,
        hasIntent: false,
        recordedOptionIndex: null,
        hasConflictingIntentChoices: false,
      },
    ]);
    expect(used).toMatchObject([
      {
        id: "self",
        hasIntent: true,
        hasPendingIntent: true,
        hasAggregatedIntent: false,
        recordedOptionIndex: 0,
        hasConflictingIntentChoices: false,
      },
    ]);
  });

  test("includes only live poll-scoped delegations for this viewer", () => {
    const creator = makePoll().creator;
    const authorities = deriveVoteAuthorityOptions({
      poll: makePoll(),
      intents: [makeIntent({ voterLockHash: `0x${"cc".repeat(32)}`, aggregated: true })],
      delegations: [
        makeDelegation(),
        makeDelegation({ id: "wrong-poll", pollId: `0x${"91".repeat(32)}` }),
        makeDelegation({ id: "global", pollId: null }),
        makeDelegation({ id: "expired", expiresEpoch: 1n }),
        makeDelegation({ id: "wrong-delegate", delegateLockHash: `0x${"92".repeat(32)}` }),
        makeDelegation({ id: "creator", delegatorLockHash: creator }),
      ],
      viewerLockHash: VIEWER,
    });

    expect(authorities.map((authority) => authority.id)).toEqual(["self", "delegation-0"]);
    expect(authorities[1]).toMatchObject({
      mode: "delegation",
      hasIntent: true,
      hasPendingIntent: false,
      hasAggregatedIntent: true,
      recordedOptionIndex: 0,
      hasConflictingIntentChoices: false,
    });
  });

  test("does not invent one recorded choice for conflicting indexed intents", () => {
    const authorities = deriveVoteAuthorityOptions({
      poll: makePoll(),
      intents: [makeIntent({ optionIndex: 0 }), makeIntent({ id: "intent-1", optionIndex: 1 })],
      delegations: [],
      viewerLockHash: VIEWER,
    });

    expect(authorities[0]).toMatchObject({
      hasIntent: true,
      recordedOptionIndex: null,
      hasConflictingIntentChoices: true,
    });
  });
});

describe("aggregation batch presentation", () => {
  test("counts one-lane chunks without combining different underfilled lanes", () => {
    expect(countAggregationBatches([40])).toBe(1);
    expect(countAggregationBatches([60])).toBe(2);
    expect(countAggregationBatches([30, 20])).toBe(2);
    expect(countAggregationBatches([50, 50, 1])).toBe(3);
  });
});

describe("indexer warning presentation", () => {
  test("explains a browser fetch failure as stale CKB data, not a contract error", () => {
    expect(describeIndexerQueryError("Failed to fetch")).toEqual({
      message:
        "The app could not reach the configured CKB RPC/indexer. Existing poll data may be stale; check your connection and retry.",
      detail: "Failed to fetch",
    });
  });
});

describe("delegation lifecycle", () => {
  const CREATOR = `0x${"aa".repeat(32)}`;
  const VIEWER = `0x${"bb".repeat(32)}`;
  const delegator = { pollId: POLL_ID, isDelegator: true };
  const delegate = { pollId: POLL_ID, isDelegator: false };

  test("reports a scoped open poll before its deadline as usable authority", () => {
    const lifecycle = getDelegationLifecycle(delegator, [makePoll()], 50n);

    expect(lifecycle.state).toBe("usable");
    expect(lifecycle.usable).toBe(true);
    expect(lifecycle.revocableByViewer).toBe(true);
  });

  test("reports a past-deadline poll as expired but still revocable", () => {
    const lifecycle = getDelegationLifecycle(delegator, [makePoll()], 101n);

    expect(lifecycle.state).toBe("expired");
    expect(lifecycle.usable).toBe(false);
    // Capacity recovery is the delegator's remaining action.
    expect(lifecycle.revocableByViewer).toBe(true);
  });

  test("reports a closed poll as closed but still revocable", () => {
    const lifecycle = getDelegationLifecycle(delegator, [makePoll({ isClosed: true })], 50n);

    expect(lifecycle.state).toBe("closed");
    expect(lifecycle.usable).toBe(false);
    expect(lifecycle.revocableByViewer).toBe(true);
  });

  test("reports an unindexed scope as unknown rather than usable", () => {
    const lifecycle = getDelegationLifecycle(delegator, [], 50n);

    expect(lifecycle.state).toBe("unknown");
    expect(lifecycle.usable).toBe(false);
  });

  test("reports a zero-scope cell as a testnet legacy global delegation", () => {
    const lifecycle = getDelegationLifecycle({ pollId: null, isDelegator: true }, [makePoll()], 50n);

    expect(lifecycle.state).toBe("legacy-global");
    expect(lifecycle.usable).toBe(false);
    expect(lifecycle.label).toContain("legacy");
  });

  test("never offers revocation to a delegate, at any lifecycle state", () => {
    const polls = [makePoll()];
    expect(getDelegationLifecycle(delegate, polls, 50n).revocableByViewer).toBe(false);
    expect(getDelegationLifecycle(delegate, polls, 101n).revocableByViewer).toBe(false);
    expect(
      getDelegationLifecycle(delegate, [makePoll({ isClosed: true })], 50n).revocableByViewer
    ).toBe(false);
  });

  test("summarizes usable authorities apart from recovery-only cells", () => {
    const closedId = `0x${"44".repeat(32)}`;
    const summary = summarizeDelegations(
      [delegator, { pollId: closedId, isDelegator: true }, { pollId: null, isDelegator: false }],
      [makePoll(), makePoll({ id: closedId, isClosed: true })],
      50n
    );

    expect(summary).toEqual({ total: 3, usable: 1, recoveryOnly: 2, revocableByViewer: 2 });
  });

  test("gates new delegations to a connected non-creator on an open poll", () => {
    const poll = makePoll({ creator: CREATOR });

    expect(canDelegateForPoll(poll, VIEWER, 50n)).toBe(true);
    // Disconnected wallet: nothing to delegate from.
    expect(canDelegateForPoll(poll, null, 50n)).toBe(false);
    // The creator cannot delegate authority on their own poll.
    expect(canDelegateForPoll(poll, CREATOR, 50n)).toBe(false);
    // Needs-close: past the deadline, no new intent can be created.
    expect(canDelegateForPoll(poll, VIEWER, 101n)).toBe(false);
    expect(canDelegateForPoll(makePoll({ creator: CREATOR, isClosed: true }), VIEWER, 50n)).toBe(false);
  });
});

describe("finalized tally outcome", () => {
  test("reports no counted votes for an empty tally", () => {
    expect(derivePollOutcome([])).toEqual({ kind: "no-votes" });
    expect(derivePollOutcome([0n, 0n, 0n])).toEqual({ kind: "no-votes" });
  });

  test("reports a single leading option as a leader, not a winner", () => {
    expect(derivePollOutcome([1n, 3n, 0n])).toEqual({
      kind: "leader",
      optionIndex: 1,
      votes: 3n,
    });
  });

  test("reports equal leading counts as a tie instead of collapsing to one index", () => {
    expect(derivePollOutcome([2n, 2n, 0n])).toEqual({
      kind: "tie",
      optionIndices: [0, 1],
      votesEach: 2n,
    });
  });

  test("reports ties across more than two options", () => {
    expect(derivePollOutcome([2n, 2n, 2n])).toEqual({
      kind: "tie",
      optionIndices: [0, 1, 2],
      votesEach: 2n,
    });
    expect(derivePollOutcome([1n, 5n, 5n, 5n])).toEqual({
      kind: "tie",
      optionIndices: [1, 2, 3],
      votesEach: 5n,
    });
  });

  test("ignores zero-count options when they tie with each other", () => {
    // Two options on zero votes are not a tie for the lead.
    expect(derivePollOutcome([4n, 0n, 0n])).toEqual({
      kind: "leader",
      optionIndex: 0,
      votes: 4n,
    });
  });

  test("marks every leading option, and only leading options", () => {
    const tie = derivePollOutcome([2n, 2n, 1n]);
    expect(isLeadingOption(tie, 0)).toBe(true);
    expect(isLeadingOption(tie, 1)).toBe(true);
    expect(isLeadingOption(tie, 2)).toBe(false);

    const leader = derivePollOutcome([1n, 3n, 0n]);
    expect(isLeadingOption(leader, 1)).toBe(true);
    expect(isLeadingOption(leader, 0)).toBe(false);

    expect(isLeadingOption(derivePollOutcome([0n, 0n]), 0)).toBe(false);
  });
});

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

  test("uses stable bracketed duration unit labels", () => {
    expect(formatPollDurationUnit("hours")).toBe("Hour(s)");
    expect(formatPollDurationUnit("days")).toBe("Day(s)");
    expect(formatPollDurationUnit("epochs")).toBe("Epoch(s)");
  });

  test("rejects misleading sub-epoch human duration selections", () => {
    expect(minimumPollDurationValue("hours")).toBe(8);
    expect(minimumPollDurationValue("days")).toBe(1);
    expect(minimumPollDurationValue("epochs")).toBe(1);
    expect(validatePollDurationSelection(1, "hours")).toContain("at least 8");
    expect(validatePollDurationSelection(8, "hours")).toBeNull();
    expect(validatePollDurationSelection(0.25, "days")).toContain("at least 1");
  });

  test("keeps creator voting feedback explicit", () => {
    expect(CREATOR_VOTING_DISABLED_MESSAGE).toBe(
      "Voting is not allowed for poll creator."
    );
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

  test("separates timely, late, aggregated, and unresolved intents for finalization", () => {
    const check = summarizeFinalizationReadiness(
      [
        { aggregated: false, createdEpoch: 100n },
        { aggregated: false, createdEpoch: 101n },
        { aggregated: false, createdEpoch: null },
        { aggregated: true, createdEpoch: 100n },
      ],
      100n,
      1
    );

    expect(check).toEqual({
      timelyPendingIntentCount: 1,
      latePendingIntentCount: 1,
      unresolvedIntentCount: 2,
    });
    expect(finalizationReadinessNeedsCaution(check)).toBe(true);
    expect(formatFinalizationReadinessCheck(check)).toBe(
      "1 timely pending intent remains. Finalizing now can leave it permanently uncounted."
    );
    expect(getFinalizeShardConfirmationMessage(makePoll(), check)).toBe(
      "1 timely pending intent remains. Finalizing now can leave it permanently uncounted."
    );
  });

  test("keeps the finalization warning concise for many pending intents", () => {
    const check = summarizeFinalizationReadiness(
      Array.from({ length: 15 }, () => ({ aggregated: false, createdEpoch: 100n })),
      100n
    );

    expect(formatFinalizationReadinessCheck(check)).toBe(
      "15 timely pending intents remain. Finalizing now can leave them permanently uncounted."
    );
  });

  test("does not treat authenticated late intents as finalization blockers", () => {
    const check = summarizeFinalizationReadiness(
      [{ aggregated: false, createdEpoch: 101n }],
      100n
    );

    expect(finalizationReadinessNeedsCaution(check)).toBe(false);
    expect(formatFinalizationReadinessCheck(check)).toContain(
      "No indexed timely pending intents remain"
    );
    expect(formatFinalizationReadinessCheck(check)).toContain(
      "1 late intent cannot count and remains refundable"
    );
  });

  test("shows the active sharded protocol timeline for one poll", () => {
    const timeline = buildProtocolTimeline(makePoll({ pendingIntentCount: 1n }), 50n);
    expect(timeline.map((step) => step.op)).toContain("CREATE_TALLY_SHARD");
    expect(timeline.map((step) => step.op)).not.toContain("AGGREGATE_VOTES");
    // Delegation is not a poll lifecycle stage; it is reported in its own panel.
    expect(timeline.map((step) => step.op)).not.toContain("DELEGATE");
    expect(timeline.some((step) => step.label.toLowerCase().includes("delegat"))).toBe(false);
  });

  test("reports bounded multi-lane finalization", () => {
    const timeline = buildProtocolTimeline(
      makePoll({
        shardCount: 2,
        tallyShards: [makeShard({ shardId: 0, finalized: true }), makeShard({ id: "shard-1", shardId: 1 })],
      }),
      101n
    );
    const finalizeStep = timeline.find((step) => step.label === "Finalize lanes");

    expect(finalizeStep?.detail).toContain("1/2 lanes finalized");
    expect(finalizeStep?.detail).toContain("Up to 8 ordered lanes");
    expect(finalizeStep?.detail).toContain("one transaction");
  });

  test("marks aggregation ended when finalized lanes leave indexed intents uncounted", () => {
    const timeline = buildProtocolTimeline(
      makePoll({
        pendingIntentCount: 2n,
        shardCount: 1,
        tallyShards: [makeShard({ finalized: true })],
      }),
      101n
    );
    const aggregate = timeline.find((step) => step.label === "Aggregate into lanes");

    expect(aggregate?.state).toBe("ended");
    expect(aggregate?.detail).toContain("2 indexed timely intent(s) remain uncounted");
    expect(aggregate?.detail).toContain("refundable after close");
  });

  test("returns a placeholder timeline when no poll is selected", () => {
    const timeline = buildProtocolTimeline(null, 50n);

    expect(timeline.length).toBeGreaterThan(0);
    // Nothing has happened yet, so no stage may claim completion.
    expect(timeline.some((step) => step.state === "completed")).toBe(false);
    expect(timeline.map((step) => step.op)).not.toContain("DELEGATE");
  });

  test("does not report a closed poll's consumed lanes as zero finalized", () => {
    // Close consumes the lane cells, so a closed poll indexes none of them.
    const timeline = buildProtocolTimeline(
      makePoll({ isClosed: true, shardCount: 8, tallyShards: [], totalVotes: 1n, totalVoters: 1n }),
      200n
    );
    const finalizeStep = timeline.find((step) => step.label === "Finalize lanes");

    expect(finalizeStep?.state).toBe("completed");
    expect(finalizeStep?.detail).not.toContain("0/8");
    expect(finalizeStep?.detail).toContain("finalized before this poll closed");
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
    const timeline = buildProtocolTimeline(weighted, 50n);

    // Terminal, not pending: a disabled path is not unfinished normal work.
    expect(timeline.find((step) => step.op === "CREATE_VOTE_INTENT")?.state).toBe("skipped");
    const aggregate = timeline.find((step) => step.label === "Aggregate into lanes");
    expect(aggregate?.state).toBe("skipped");
    expect(aggregate?.detail).toContain("recovery-only");
  });

  test("does not leave a closed zero-vote poll's stages reading as pending work", () => {
    const timeline = buildProtocolTimeline(
      makePoll({ isClosed: true, shardCount: 8, tallyShards: [], totalVotes: 0n, totalVoters: 0n }),
      200n
    );

    // Nothing can still be aggregated: close already consumed the lane cells.
    expect(timeline.some((step) => step.state === "pending")).toBe(false);
    expect(timeline.some((step) => step.state === "live")).toBe(false);
    const aggregate = timeline.find((step) => step.label === "Aggregate into lanes");
    expect(aggregate?.state).toBe("skipped");
    expect(aggregate?.detail).toContain("closed with no counted votes");
    expect(timeline.find((step) => step.op === "CREATE_VOTE_INTENT")?.state).toBe("skipped");
    expect(timeline.find((step) => step.label === "Close or recover")?.state).toBe("completed");
  });
});

describe("timeline poll selection", () => {
  const open = makePoll({ id: `0x${"01".repeat(32)}`, createdEpoch: 20n, deadline: 100n });
  const newerOpen = makePoll({ id: `0x${"02".repeat(32)}`, createdEpoch: 40n, deadline: 100n });
  const needsClose = makePoll({ id: `0x${"03".repeat(32)}`, createdEpoch: 45n, deadline: 30n });
  const archived = makePoll({ id: `0x${"04".repeat(32)}`, createdEpoch: 48n, isClosed: true });

  test("prefers the newest open poll no matter what order the indexer returned", () => {
    // The hook does not sort; PollList sorts its own copy. Any input order must
    // resolve to the same subject.
    const orders = [
      [open, newerOpen, needsClose, archived],
      [archived, needsClose, newerOpen, open],
      [needsClose, archived, open, newerOpen],
    ];

    for (const polls of orders) {
      expect(selectDefaultTimelinePoll(polls, 50n)?.id).toBe(newerOpen.id);
      expect(sortPollsForTimeline(polls, 50n).map((poll) => poll.id)).toEqual([
        newerOpen.id,
        open.id,
        needsClose.id,
        archived.id,
      ]);
    }
  });

  test("falls back to needs-close, then archived, then nothing", () => {
    expect(selectDefaultTimelinePoll([archived, needsClose], 50n)?.id).toBe(needsClose.id);
    expect(selectDefaultTimelinePoll([archived], 50n)?.id).toBe(archived.id);
    expect(selectDefaultTimelinePoll([], 50n)).toBeNull();
  });

  test("breaks ties by deadline then id so the order is total", () => {
    const sameEpochA = makePoll({ id: `0x${"0a".repeat(32)}`, createdEpoch: 40n, deadline: 100n });
    const sameEpochB = makePoll({ id: `0x${"0b".repeat(32)}`, createdEpoch: 40n, deadline: 100n });
    const laterDeadline = makePoll({ id: `0x${"0c".repeat(32)}`, createdEpoch: 40n, deadline: 120n });

    expect(
      sortPollsForTimeline([sameEpochB, laterDeadline, sameEpochA], 50n).map((poll) => poll.id)
    ).toEqual([laterDeadline.id, sameEpochA.id, sameEpochB.id]);
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
