import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { CREATOR_VOTING_DISABLED_MESSAGE } from "../lib/protocolUi";
import { Poll, TxState } from "../lib/types";
import { VoteOnPoll } from "./VoteOnPoll";

const CREATOR = `0x${"aa".repeat(32)}`;
const VOTER = `0x${"bb".repeat(32)}`;

function pollFixture(): Poll {
  return {
    id: `0x${"11".repeat(32)}`,
    outPoint: { txHash: `0x${"22".repeat(32)}`, index: 0 },
    question: "Which is the best team?",
    options: ["Manchester United", "Chelsea", "Arsenal"],
    voteCounts: [0n, 0n, 0n],
    createdEpoch: 90n,
    deadline: 100n,
    creator: CREATOR,
    isClosed: false,
    totalVoters: 0n,
    creatorDeposit: 500n * 100_000_000n,
    pendingIntentCount: 0n,
    tokenWeighted: false,
    udtTypeHash: `0x${"00".repeat(32)}`,
    shardCount: 8,
    tallyShards: [],
    tallyMergeResults: [],
    tallyFrontier: {
      source: "live-shards",
      coveredShardCount: 8,
      shardCount: 8,
      coverageComplete: true,
      selectedMergeResultIds: [],
      selectedShardIds: [],
      uncoveredShardIds: [],
    },
    resultAssurance: null,
    totalVotes: 0n,
    authorityOptions: [
      {
        id: "self",
        mode: "self",
        label: "Vote as connected wallet",
        voterLockHash: VOTER,
        delegationId: null,
        hasIntent: false,
        hasPendingIntent: false,
        hasAggregatedIntent: false,
        recordedOptionIndex: null,
        hasConflictingIntentChoices: false,
      },
    ],
    aggregationBatchCount: 0,
    outstandingIntentCount: 0,
    lateIntentCount: 0,
    refundableIntentCount: 0,
  };
}

const idleTxState: TxState = { status: "idle", txHash: null, error: null, scope: null };
const action = async () => "0x01";
const finalizationCheck = async () => ({
  timelyPendingIntentCount: 0,
  latePendingIntentCount: 0,
  unresolvedIntentCount: 0,
});

function renderPoll(
  voterLockHash: string,
  overrides: Partial<Poll> = {},
  defaultExpanded?: boolean
): string {
  return renderToStaticMarkup(
    React.createElement(VoteOnPoll, {
      poll: { ...pollFixture(), ...overrides },
      voterAddress: "ckt1test",
      voterLockHash,
      txState: idleTxState,
      actionInFlight: false,
      ...(defaultExpanded === undefined ? {} : { defaultExpanded }),
      onVote: action,
      onAggregate: action,
      onCheckFinalizationReadiness: finalizationCheck,
      onFinalizeTallyShards: action,
      onMergeShards: action,
      onClose: action,
      onForceClose: action,
      onRefundClosedIntent: action,
      onRefundLateIntent: action,
      currentEpoch: 95n,
      currentEpochPosition: { epoch: 95n, index: 50n, length: 100n },
    })
  );
}

function renderPollWithTxState(txState: TxState, overrides: Partial<Poll> = {}): string {
  return renderToStaticMarkup(
    React.createElement(VoteOnPoll, {
      poll: { ...pollFixture(), ...overrides },
      voterAddress: "ckt1test",
      voterLockHash: VOTER,
      txState,
      actionInFlight: false,
      defaultExpanded: true,
      onVote: action,
      onAggregate: action,
      onCheckFinalizationReadiness: finalizationCheck,
      onFinalizeTallyShards: action,
      onMergeShards: action,
      onClose: action,
      onForceClose: action,
      onRefundClosedIntent: action,
      onRefundLateIntent: action,
      currentEpoch: 95n,
      currentEpochPosition: { epoch: 95n, index: 50n, length: 100n },
    })
  );
}

function renderPollWithDelegate(
  voterAddress: string | null,
  voterLockHash: string | null,
  overrides: Partial<Poll> = {},
  currentEpoch = 95n
): string {
  return renderToStaticMarkup(
    React.createElement(VoteOnPoll, {
      poll: { ...pollFixture(), ...overrides },
      voterAddress,
      voterLockHash,
      txState: idleTxState,
      actionInFlight: false,
      onVote: action,
      onAggregate: action,
      onCheckFinalizationReadiness: finalizationCheck,
      onFinalizeTallyShards: action,
      onMergeShards: action,
      onClose: action,
      onForceClose: action,
      onRefundClosedIntent: action,
      onRefundLateIntent: action,
      onDelegateForPoll: () => {},
      currentEpoch,
      currentEpochPosition: { epoch: currentEpoch, index: 50n, length: 100n },
    })
  );
}

describe("poll-card presentation", () => {
  test("collapses an active poll by default while keeping a direct voting shortcut", () => {
    const markup = renderPoll(VOTER);

    expect(markup).toContain("View details");
    expect(markup).toContain("Vote now");
    expect(markup).toContain("status-poll-live");
    expect(markup).not.toContain("Hide details");
    expect(markup).not.toContain("Lifecycle and tally details");
    expect(markup).not.toContain("Manchester United");
  });

  test("shows the creator restriction and places choices before lifecycle details", () => {
    const markup = renderPoll(CREATOR, {}, true);

    expect(markup).toContain(CREATOR_VOTING_DISABLED_MESSAGE);
    expect(markup.indexOf("Which is the best team?")).toBeLessThan(
      markup.indexOf("Manchester United")
    );
    expect(markup.indexOf("Manchester United")).toBeLessThan(
      markup.indexOf("Lifecycle and tally details")
    );
    expect(markup).toContain("Current tally: live tally lanes");
    expect(markup).toContain("Pending intents are not included until aggregation.");
  });

  test("places the intent-finality warning before an eligible voter's choices", () => {
    const markup = renderPoll(VOTER, {}, true);

    expect(markup.indexOf("Intent finality:")).toBeGreaterThan(-1);
    expect(markup.indexOf("Intent finality:")).toBeLessThan(
      markup.indexOf("Manchester United")
    );
  });

  // Every closed-result test below sets only raw vote counts. The card derives
  // the outcome itself, so a test cannot assert a reading the tally does not
  // support.
  test("collapses a closed poll to its header and tally leader", () => {
    const markup = renderPoll(VOTER, {
      isClosed: true,
      voteCounts: [1n, 3n, 0n],
      totalVotes: 4n,
      totalVoters: 4n,
    });

    // Header stays; the archive is scannable without opening every card.
    expect(markup).toContain("Which is the best team?");
    expect(markup).toContain("Finalized tally leader");
    expect(markup).toContain("Chelsea");
    expect(markup).toContain("3 of 4 counted votes");
    expect(markup).toContain("View details");
    // The contract defines no winner, so the card must not claim one.
    expect(markup).not.toContain("Winner");
    // Body is folded away until the user asks for it.
    expect(markup).not.toContain("Lifecycle and tally details");
  });

  test("marks an equal-count closed result as a tie", () => {
    const markup = renderPoll(VOTER, {
      isClosed: true,
      voteCounts: [2n, 2n, 0n],
      totalVotes: 4n,
      totalVoters: 4n,
    });

    expect(markup).toContain("Tied finalized tally");
    expect(markup).toContain("Manchester United / Chelsea");
    expect(markup).toContain("2 votes each of 4 counted");
    // A real tie is not an empty result, and no tie-break may be invented.
    expect(markup).not.toContain("No counted votes.");
    expect(markup).not.toContain("lowest option index");
  });

  test("reports a tie across more than two options", () => {
    const markup = renderPoll(VOTER, {
      isClosed: true,
      voteCounts: [2n, 2n, 2n],
      totalVotes: 6n,
      totalVoters: 6n,
    });

    expect(markup).toContain("Tied finalized tally");
    expect(markup).toContain("Manchester United / Chelsea / Arsenal");
    expect(markup).toContain("2 votes each of 6 counted");
  });

  test("reports a closed poll that counted no votes", () => {
    const markup = renderPoll(VOTER, { isClosed: true });

    expect(markup).toContain("No counted votes.");
  });

  test("hides lifecycle status belonging to another surface", () => {
    const markup = renderPollWithTxState({
      // A delegation transaction must never render inside a poll card.
      status: "confirming",
      txHash: `0x${"cc".repeat(32)}`,
      error: null,
      scope: { kind: "delegation" },
    });

    expect(markup).not.toContain(`0x${"cc".repeat(32)}`);
  });

  test("disables its own controls while another surface holds a transaction", () => {
    const idle = renderPollWithTxState(idleTxState);
    const foreignInFlight = renderPollWithTxState({
      status: "signing",
      txHash: `0x${"ee".repeat(32)}`,
      error: null,
      scope: { kind: "delegation" },
    });

    // Scoped rendering hides the foreign transaction, but the hook allows only
    // one action at a time, so this card's controls must still be locked.
    expect(foreignInFlight).not.toContain(`0x${"ee".repeat(32)}`);
    expect(idle).toContain("Select an option");
    expect(foreignInFlight).toContain("Select an option");
    expect(foreignInFlight).not.toContain("Submitting intent...");
    expect(idle.match(/disabled=""/g)?.length ?? 0).toBeLessThan(
      foreignInFlight.match(/disabled=""/g)?.length ?? 0
    );
  });

  test("hides directional tally results until close", () => {
    const liveMarkup = renderPoll(
      VOTER,
      {
        voteCounts: [2n, 1n, 0n],
        totalVotes: 3n,
        totalVoters: 3n,
      },
      true
    );
    const closedMarkup = renderPoll(
      VOTER,
      {
        isClosed: true,
        voteCounts: [2n, 1n, 0n],
        totalVotes: 3n,
        totalVoters: 3n,
      },
      true
    );

    expect(liveMarkup).not.toContain("poll-option-tally");
    expect(liveMarkup).not.toContain("poll-option-bar");
    expect(liveMarkup).toContain("option totals remain hidden here until the poll closes");
    expect(closedMarkup).toContain("poll-option-tally");
    expect(closedMarkup).toContain("poll-option-bar");
    expect(closedMarkup).toContain("(66%)");
  });

  test("highlights one indexed recorded choice without revealing live totals", () => {
    const recordedAuthority = {
      ...pollFixture().authorityOptions[0],
      hasIntent: true,
      hasPendingIntent: true,
      recordedOptionIndex: 1,
    };
    const markup = renderPoll(
      VOTER,
      { authorityOptions: [recordedAuthority], pendingIntentCount: 1n },
      true
    );

    expect(markup).toContain("recorded-choice");
    expect(markup).toContain("Your recorded choice");
    expect(markup.indexOf("Chelsea")).toBeLessThan(markup.indexOf("Your recorded choice"));
    expect(markup).not.toContain("poll-option-tally");
  });

  test("does not invent one recorded choice for conflicting indexed intents", () => {
    const conflictingAuthority = {
      ...pollFixture().authorityOptions[0],
      hasIntent: true,
      hasPendingIntent: true,
      recordedOptionIndex: null,
      hasConflictingIntentChoices: true,
    };
    const markup = renderPoll(
      VOTER,
      { authorityOptions: [conflictingAuthority], pendingIntentCount: 2n },
      true
    );

    expect(markup).toContain("Multiple indexed intents for this represented voter encode different choices");
    expect(markup).not.toContain("Your recorded choice");
    expect(markup).not.toContain("recorded-choice");
  });

  test("places poll transaction feedback before lifecycle details", () => {
    const txHash = `0x${"dd".repeat(32)}`;
    const markup = renderPollWithTxState({
      status: "confirming",
      txHash,
      error: null,
      scope: { kind: "poll", pollId: pollFixture().id },
    });

    expect(markup).toContain("poll-transaction-feedback");
    expect(markup.indexOf(txHash.slice(0, 20))).toBeLessThan(
      markup.indexOf("Lifecycle and tally details")
    );
  });

  test("uses Aggregate initially and Next Batch only after tally progress", () => {
    const oneBatch = renderPoll(VOTER, { aggregationBatchCount: 1 }, true);
    const initialMultipleBatches = renderPoll(VOTER, { aggregationBatchCount: 2 }, true);
    const remainingBatch = renderPoll(
      VOTER,
      { aggregationBatchCount: 1, totalVotes: 1n, totalVoters: 1n },
      true
    );
    const remainingMultipleBatches = renderPoll(
      VOTER,
      { aggregationBatchCount: 2, totalVotes: 1n, totalVoters: 1n },
      true
    );

    expect(oneBatch).toContain(">Aggregate</button>");
    expect(oneBatch).not.toContain("Aggregate Next Batch");
    expect(initialMultipleBatches).toContain(">Aggregate</button>");
    expect(initialMultipleBatches).not.toContain("Aggregate Next Batch");
    expect(initialMultipleBatches).toContain("About 2 aggregation transactions are currently required");
    expect(remainingBatch).toContain(">Aggregate Next Batch</button>");
    expect(remainingBatch).toContain("About 1 aggregation transaction remains");
    expect(remainingMultipleBatches).toContain(">Aggregate Next Batch</button>");
    expect(remainingMultipleBatches).toContain("About 2 aggregation transactions remain");
  });

  test("hides merge when the indexed frontier is incomplete", () => {
    const markup = renderPoll(
      VOTER,
      {
        shardCount: 9,
        tallyMergeResults: [
          {
            id: "merge-01",
            pollId: `0x${"11".repeat(32)}`,
            outPoint: { txHash: `0x${"44".repeat(32)}`, index: 0 },
            coverage: `0x${"ff"}00000000000000000000000000000000000000000000000000000000000000`,
            voteCounts: [8n, 0n, 0n],
            totalVoters: 8n,
            mergeLevel: 1,
            version: 1,
            capacity: 61n * 100_000_000n,
          },
        ],
        tallyFrontier: {
          source: "merge-frontier",
          coveredShardCount: 8,
          shardCount: 9,
          coverageComplete: false,
          selectedMergeResultIds: ["merge-01"],
          selectedShardIds: [],
          uncoveredShardIds: [8],
        },
      },
      true
    );

    expect(markup).not.toContain("Merge Shards");
    expect(markup).toContain("Incomplete lane set");
  });

  test("offers delegation only to a connected non-creator on an open poll", () => {
    const DELEGATE_ACTION = "Delegate for this poll";

    expect(renderPollWithDelegate("ckt1test", VOTER)).toContain(DELEGATE_ACTION);
    // Disconnected: the action would have no wallet to delegate from.
    expect(renderPollWithDelegate(null, null)).not.toContain(DELEGATE_ACTION);
    // The creator cannot delegate authority on their own poll.
    expect(renderPollWithDelegate("ckt1test", CREATOR)).not.toContain(DELEGATE_ACTION);
    // Needs close: past the deadline, no new intent can be created.
    expect(renderPollWithDelegate("ckt1test", VOTER, {}, 120n)).not.toContain(DELEGATE_ACTION);
    expect(renderPollWithDelegate("ckt1test", VOTER, { isClosed: true })).not.toContain(
      DELEGATE_ACTION
    );
  });

  test("renders safely when a disconnected viewer has no voting authority", () => {
    const markup = renderPollWithDelegate(null, null, { authorityOptions: [] });

    expect(markup).toContain("Which is the best team?");
    expect(markup).not.toContain("Vote now");
    expect(markup).not.toContain("Your recorded choice");
  });

  test("offers the compact voting shortcut only for an unused eligible authority", () => {
    const connected = renderPollWithDelegate("ckt1test", VOTER);
    const existingIntentAuthority = {
      ...pollFixture().authorityOptions[0],
      hasIntent: true,
      hasPendingIntent: true,
    };

    expect(connected).toContain("Vote now");
    expect(connected.indexOf("Copy Poll ID")).toBeLessThan(
      connected.indexOf("Delegate for this poll")
    );
    expect(connected.indexOf("Delegate for this poll")).toBeLessThan(
      connected.indexOf("Vote now")
    );
    expect(renderPollWithDelegate(null, null)).not.toContain("Vote now");
    expect(renderPollWithDelegate("ckt1test", CREATOR)).not.toContain("Vote now");
    expect(renderPollWithDelegate("ckt1test", VOTER, {}, 120n)).not.toContain("Vote now");
    expect(renderPollWithDelegate("ckt1test", VOTER, { isClosed: true })).not.toContain("Vote now");
    expect(
      renderPollWithDelegate("ckt1test", VOTER, {
        authorityOptions: [existingIntentAuthority],
      })
    ).not.toContain("Vote now");
  });

  test("keeps read-only controls usable while a transaction is in flight", () => {
    const markup = renderPollWithTxState({
      status: "confirming",
      txHash: `0x${"dd".repeat(32)}`,
      error: null,
      scope: { kind: "poll", pollId: `0x${"11".repeat(32)}` },
    });

    // Reading the card must never depend on a transaction finishing.
    expect(markup).toContain("Copy Poll ID");
    expect(markup).toMatch(/Copy Poll ID[\s\S]{0,40}<\/button>/);
    expect(markup).not.toMatch(/disabled=""[^>]*>\s*Copy Poll ID/);
    expect(markup).not.toMatch(/disabled=""[^>]*>\s*Hide details/);
  });
});
