import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { DelegationRecord, Poll, TxState } from "../lib/types";
import { DelegatePower } from "./DelegatePower";

const idleTxState: TxState = { status: "idle", txHash: null, error: null, scope: null, batch: null };
const noop = async () => "0x01";

const VIEWER = `0x${"aa".repeat(32)}`;
const OTHER = `0x${"bb".repeat(32)}`;
const SCOPED_POLL = `0x${"cc".repeat(32)}`;

function pollFixture(overrides: Partial<Poll> = {}): Poll {
  return {
    id: SCOPED_POLL,
    outPoint: { txHash: `0x${"22".repeat(32)}`, index: 0 },
    question: "Which is the best team?",
    options: ["Manchester United", "Chelsea"],
    voteCounts: [0n, 0n],
    createdEpoch: 90n,
    deadline: 100n,
    // Not the viewer: a creator cannot delegate authority on their own poll.
    creator: OTHER,
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
    authorityOptions: [],
    outstandingIntentCount: 0,
    lateIntentCount: 0,
    refundableIntentCount: 0,
    ...overrides,
  };
}

function delegationFixture(overrides: Partial<DelegationRecord> = {}): DelegationRecord {
  return {
    id: "delegation-1",
    outPoint: { txHash: `0x${"11".repeat(32)}`, index: 0 },
    delegatorLockHash: VIEWER,
    delegateLockHash: OTHER,
    pollId: SCOPED_POLL,
    expiresEpoch: 100n,
    capacity: 61n * 100_000_000n,
    isDelegator: true,
    ...overrides,
  };
}

function renderPanel(overrides: {
  delegations?: DelegationRecord[];
  polls?: Poll[];
  currentEpoch?: bigint;
  viewerLockHash?: string | null;
  txState?: TxState;
  prefillPollScope?: { pollId: string; requestId: number } | null;
} = {}): string {
  return renderToStaticMarkup(
    React.createElement(DelegatePower, {
      delegations: overrides.delegations ?? [],
      polls: overrides.polls ?? [pollFixture()],
      currentEpoch: overrides.currentEpoch ?? 95n,
      viewerLockHash:
        overrides.viewerLockHash === undefined ? VIEWER : overrides.viewerLockHash,
      txState: overrides.txState ?? idleTxState,
      actionInFlight: false,
      onDelegate: noop,
      onRevoke: noop,
      prefillPollScope: overrides.prefillPollScope ?? null,
    })
  );
}

describe("delegation panel", () => {
  test("collapses to the summary and a create action", () => {
    const markup = renderPanel();

    expect(markup).toContain("Delegation authorizes another address to create an intent for you on one poll.");
    expect(markup).toContain("Delegation cells lock at least 61 CKB");
    expect(markup).toContain("Create Delegation");
    // Form internals and the delegation list stay folded until requested.
    expect(markup).not.toContain("Delegate address or lock hash");
    expect(markup).not.toContain("Poll scope");
    expect(markup).not.toContain("Indexed delegation cells");
  });

  test("separates usable authorities from recovery-only cells while collapsed", () => {
    const markup = renderPanel({
      polls: [
        pollFixture(),
        pollFixture({ id: `0x${"dd".repeat(32)}`, isClosed: true }),
      ],
      delegations: [
        delegationFixture(),
        delegationFixture({ id: "delegation-2", pollId: `0x${"dd".repeat(32)}` }),
      ],
    });

    // A live cell scoped to a closed poll is not an "active delegation".
    expect(markup).not.toContain("active delegation");
    expect(markup).toContain("2 delegation cells indexed");
    expect(markup).toContain("1 usable authority");
    expect(markup).toContain("1 recovery or revocation only");
    expect(markup).toContain("2 revocable by you");
  });

  test("ignores lifecycle status from another surface", () => {
    const foreignHash = `0x${"ab".repeat(32)}`;
    const markup = renderPanel({
      txState: {
        status: "confirming",
        txHash: foreignHash,
        error: null,
        scope: { kind: "poll", pollId: "0xdead" },
        batch: null,
      },
    });

    expect(markup).not.toContain(foreignHash);
  });

  test("opens automatically when a poll prefills the delegation scope", () => {
    const markup = renderPanel({ prefillPollScope: { pollId: SCOPED_POLL, requestId: 1 } });

    // "Delegate for this poll" scrolls here, so the form must be open on arrival.
    expect(markup).toContain("Delegate address or lock hash");
    expect(markup).toContain(SCOPED_POLL);
  });

  // One test per lifecycle state, each driven from real poll data rather than
  // from an injected label, so the panel cannot report a state it cannot derive.
  test("labels a delegation scoped to an open poll as usable authority", () => {
    const markup = renderPanel({
      prefillPollScope: { pollId: SCOPED_POLL, requestId: 1 },
      delegations: [delegationFixture()],
    });

    expect(markup).toContain("Usable authority");
    expect(markup).toContain("can create an intent");
    expect(markup).toContain("Revoke");
  });

  test("labels a past-deadline scoped delegation as expired and still revocable", () => {
    const markup = renderPanel({
      prefillPollScope: { pollId: SCOPED_POLL, requestId: 1 },
      delegations: [delegationFixture()],
      currentEpoch: 120n,
    });

    expect(markup).toContain("Past voting deadline");
    expect(markup).not.toContain("Usable authority");
    // Recovering the locked capacity is the delegator's remaining action.
    expect(markup).toContain("Revoke");
  });

  test("labels a closed-poll delegation as closed and still revocable", () => {
    const markup = renderPanel({
      prefillPollScope: { pollId: SCOPED_POLL, requestId: 1 },
      polls: [pollFixture({ isClosed: true })],
      delegations: [delegationFixture()],
    });

    expect(markup).toContain("Scoped poll closed");
    expect(markup).not.toContain("Usable authority");
    expect(markup).toContain("Revoke");
  });

  test("reports an unindexed scoped poll as unknown rather than usable", () => {
    const markup = renderPanel({
      prefillPollScope: { pollId: SCOPED_POLL, requestId: 1 },
      polls: [],
      delegations: [delegationFixture()],
    });

    expect(markup).toContain("Scoped poll not indexed");
    expect(markup).not.toContain("Usable authority");
  });

  test("labels a zero-scope cell as a testnet legacy global delegation", () => {
    const markup = renderPanel({
      prefillPollScope: { pollId: SCOPED_POLL, requestId: 1 },
      delegations: [delegationFixture({ pollId: null })],
    });

    expect(markup).toContain("Testnet legacy global");
    expect(markup).not.toContain("Usable authority");
    expect(markup).toContain("Revoke");
  });

  test("offers no revoke action to a delegate", () => {
    const markup = renderPanel({
      prefillPollScope: { pollId: SCOPED_POLL, requestId: 1 },
      delegations: [
        delegationFixture({ isDelegator: false, delegatorLockHash: OTHER, delegateLockHash: VIEWER }),
      ],
    });

    expect(markup).toContain("only the delegator can revoke");
    expect(markup).not.toContain(">Revoke<");
  });

  test("disables new creation when no indexed poll can accept one, keeping management usable", () => {
    const markup = renderPanel({
      prefillPollScope: { pollId: SCOPED_POLL, requestId: 1 },
      polls: [pollFixture({ isClosed: true })],
      delegations: [delegationFixture()],
    });

    expect(markup).toContain("No indexed poll can accept a new delegation");
    expect(markup).toMatch(/disabled=""[^>]*>Create Delegation/);
    // Revocation must survive the creation lockout.
    expect(markup).toContain("Revoke");
    expect(markup).not.toMatch(/disabled=""[^>]*>Revoke/);
  });
});
