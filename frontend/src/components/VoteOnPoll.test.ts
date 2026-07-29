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
    protocolPendingIntentCount: 0n,
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
    totalVotes: 0n,
    winnerIndex: null,
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
      },
    ],
    outstandingIntentCount: 0,
    lateIntentCount: 0,
    refundableIntentCount: 0,
  };
}

const idleTxState: TxState = { status: "idle", txHash: null, error: null };
const action = async () => "0x01";

function renderPoll(voterLockHash: string): string {
  return renderToStaticMarkup(
    React.createElement(VoteOnPoll, {
      poll: pollFixture(),
      voterAddress: "ckt1test",
      voterLockHash,
      txState: idleTxState,
      onVote: action,
      onAggregate: action,
      onFinalizeShards: action,
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

describe("poll-card presentation", () => {
  test("shows the creator restriction and places choices before lifecycle details", () => {
    const markup = renderPoll(CREATOR);

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
    const markup = renderPoll(VOTER);

    expect(markup.indexOf("Intent finality:")).toBeGreaterThan(-1);
    expect(markup.indexOf("Intent finality:")).toBeLessThan(
      markup.indexOf("Manchester United")
    );
  });
});
