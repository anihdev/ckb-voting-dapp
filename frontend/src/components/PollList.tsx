/**
 * PollList Component
 * ==================
 * Lists polls with lifecycle-aware filtering and archive access.
 */

import React, { useState } from "react";
import { Poll, TxState } from "../lib/types";
import { VoteOnPoll } from "./VoteOnPoll";
import {
  filterPollsByLifecycle,
  EpochPosition,
  estimatePollCloseHours,
  formatApproxWallClockDuration,
  getPollFilterCounts,
  getPollLifecycleStatus,
  isPollVotingSupported,
  PollLifecycleFilter,
  UNSUPPORTED_WEIGHTED_POLL_LABEL,
} from "../lib/protocolUi";

interface Props {
  polls: Poll[];
  loading: boolean;
  isConnected: boolean;
  voterAddress: string | null;
  voterLockHash: string | null;
  txState: TxState;
  currentEpoch: bigint;
  currentEpochPosition?: EpochPosition;
  onVote: (poll: Poll, optionIndex: number, authorityId?: string) => Promise<string>;
  onAggregate: (poll: Poll) => Promise<string>;
  onFinalizeShards: (poll: Poll) => Promise<string>;
  onMergeShards: (poll: Poll) => Promise<string>;
  onClose: (poll: Poll) => Promise<string>;
  onForceClose: (poll: Poll) => Promise<string>;
  onRefundClosedIntent: (poll: Poll) => Promise<string>;
  onRefundLateIntent: (poll: Poll) => Promise<string>;
  onRefresh: () => void;
  onConnectWallet: () => void;
  onDelegateForPoll: (pollId: string) => void;
}

export function PollList({
  polls,
  loading,
  isConnected,
  voterAddress,
  voterLockHash,
  txState,
  currentEpoch,
  currentEpochPosition,
  onVote,
  onAggregate,
  onFinalizeShards,
  onMergeShards,
  onClose,
  onForceClose,
  onRefundClosedIntent,
  onRefundLateIntent,
  onRefresh,
  onConnectWallet,
  onDelegateForPoll,
}: Props) {
  const [filter, setFilter] = useState<PollLifecycleFilter>("open");
  const [copiedPollId, setCopiedPollId] = useState<string | null>(null);
  const isInitialLoading = loading && polls.length === 0;
  const hasNoPolls = polls.length === 0;

  const copyPollId = async (pollId: string) => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(pollId);
      } else if (typeof document !== "undefined") {
        const tempInput = document.createElement("textarea");
        tempInput.value = pollId;
        tempInput.style.position = "fixed";
        tempInput.style.opacity = "0";
        document.body.appendChild(tempInput);
        tempInput.focus();
        tempInput.select();
        document.execCommand("copy");
        document.body.removeChild(tempInput);
      } else {
        throw new Error("Clipboard not available");
      }
      setCopiedPollId(pollId);
      setTimeout(() => {
        setCopiedPollId((active) => (active === pollId ? null : active));
      }, 1800);
    } catch {
      setCopiedPollId(null);
    }
  };

  const filteredPolls = filterPollsByLifecycle(polls, filter, currentEpoch);
  const filterCounts = getPollFilterCounts(polls, currentEpoch);

  const pollStatus = (poll: Poll): "open" | "needsClose" | "archived" => {
    return getPollLifecycleStatus(poll, currentEpoch);
  };

  const pollAnchorId = (poll: Poll) =>
    `poll-${poll.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}-${poll.outPoint.index}`;

  const tabs: Array<{ key: PollLifecycleFilter; label: string; count: number }> = [
    { key: "open", label: "Open", count: filterCounts.open },
    { key: "needsClose", label: "Needs Close", count: filterCounts.needsClose },
    { key: "archived", label: "Archived", count: filterCounts.archived },
    { key: "all", label: "All", count: filterCounts.all },
  ];

  const emptyFilterMessage =
    filter === "open"
      ? "No open polls in the current registry view."
      : filter === "needsClose"
        ? "No expired polls currently need close or force-close."
        : filter === "archived"
          ? "No archived closed polls are indexed."
          : "No polls in this filter.";

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex w-full gap-1 overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface)] p-1 sm:w-auto">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setFilter(tab.key)}
              className="inline-flex min-w-[96px] items-center justify-between rounded-lg px-4 py-1.5 text-sm font-medium transition-all"
              style={
                filter === tab.key
                  ? { background: "var(--teal-dim)", color: "var(--teal)", boxShadow: "inset 0 0 0 1px rgba(0,200,151,0.2)" }
                  : { color: "var(--ink-2)" }
              }
            >
              <span style={{ paddingRight: 8 }}>{tab.label}</span>
              <span
                className="rounded-full px-1.5 py-0.5 text-xs"
                style={
                  filter === tab.key
                    ? { background: "rgba(0,200,151,0.15)", color: "var(--teal)" }
                    : { background: "var(--surface-2)", color: "var(--ink-2)" }
                }
              >
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        <button
          onClick={onRefresh}
          disabled={loading}
          className="btn-quiet flex items-center gap-2 self-end text-xs uppercase sm:self-auto"
        >
          <span className={loading ? "animate-spin" : ""}>*</span>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {isInitialLoading && (
        <div className="space-y-4">
          <div className="table-shell">
            <div className="p-4">
              <div className="skeleton h-5 w-40 rounded-md" />
              <div className="mt-3 space-y-2">
                {[...Array.from({ length: 4 })].map((_, index) => (
                  <div key={index} className="skeleton h-11 w-full rounded-lg" />
                ))}
              </div>
            </div>
          </div>

          {[...Array.from({ length: 2 })].map((_, index) => (
            <div key={index} className="card-shell !p-5">
              <div className="skeleton h-6 w-2/3 rounded-md" />
              <div className="mt-3 space-y-2">
                <div className="skeleton h-10 w-full rounded-lg" />
                <div className="skeleton h-10 w-full rounded-lg" />
                <div className="skeleton h-10 w-11/12 rounded-lg" />
              </div>
              <div className="mt-4 flex gap-2">
                <div className="skeleton h-9 w-32 rounded-lg" />
                <div className="skeleton h-9 w-28 rounded-lg" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!isInitialLoading && hasNoPolls ? (
        <div className="card-shell py-16 text-center subtle">
          <div>
            <div className="mb-3 text-4xl" style={{ color: "var(--ink)" }}>Poll Registry</div>
            <div className="font-medium" style={{ color: "var(--ink)" }}>No governance proposals yet.</div>
            <div className="mt-1 text-sm">Once a poll is created, vote intents and tally state will appear here.</div>
            {!isConnected ? (
              <div className="mt-5">
                <button
                  onClick={onConnectWallet}
                  className="btn-quiet"
                >
                  Connect wallet to create the first proposal
                </button>
                <div className="mt-2">
                  <a
                    href="https://faucet.nervos.org/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="subtle"
                    style={{ fontSize: 12, textDecoration: "underline" }}
                  >
                    Need testnet CKB? Open faucet.nervos.org
                  </a>
                </div>
              </div>
            ) : (
              <div className="mt-5">
                <button
                  onClick={() => {
                    document.getElementById("creator-tools")?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  className="btn-quiet"
                >
                  Create the first proposal
                </button>
              </div>
            )}
          </div>
        </div>
      ) : !isInitialLoading && filteredPolls.length === 0 ? (
        <div className="card-shell py-14 text-center subtle">
          <div className="font-medium" style={{ color: "var(--ink)" }}>{emptyFilterMessage}</div>
          <div className="mt-1 text-sm">Archived and needs-close polls remain available from the lifecycle tabs.</div>
        </div>
      ) : !isInitialLoading ? (
        <div className="space-y-4">
          <div className="alert alert-info">
            Shard aggregation processes timely vote intents before or after the deadline, until each shard is finalized.
            Closed polls are archived by default but remain accessible from the Archived or All tabs.
          </div>
          <div className="table-shell">
            <div className="table-mobile-hint">Swipe horizontally to copy Poll ID.</div>
            <table className="table-grid">
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Status</th>
                  <th>Window</th>
                  <th>Tally</th>
                  <th>Pending Intents</th>
                  <th>Mode</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredPolls.map((poll) => {
                  const status = pollStatus(poll);
                  const anchorId = pollAnchorId(poll);
                  const estimatedTimeToClose = formatApproxWallClockDuration(
                    estimatePollCloseHours(
                      poll.deadline,
                      currentEpochPosition ?? { epoch: currentEpoch, index: 0n, length: 1n }
                    )
                  );
                  return (
                    <tr key={`row-${poll.id}`}>
                      <td>
                        <div className="max-w-[340px] truncate font-semibold" style={{ color: "var(--ink)" }}>{poll.question}</div>
                        <div className="mt-1 font-mono text-[10px] subtle">{poll.id.slice(0, 16)}...</div>
                      </td>
                      <td>
                        {status === "archived" && <span className="status-pill status-closed">Archived</span>}
                        {status === "needsClose" && <span className="status-pill status-expired">Needs Close</span>}
                        {status === "open" && <span className="status-pill status-active">Open</span>}
                      </td>
                      <td className="text-xs subtle">
                        <div>Now: {currentEpoch.toString()}</div>
                        <div>Deadline: {poll.deadline.toString()}</div>
                        {status === "open" && <div>{estimatedTimeToClose} to close window</div>}
                      </td>
                      <td>
                        <div className="font-semibold" style={{ color: "var(--ink)" }}>{poll.totalVotes.toString()}</div>
                        <div className="text-[11px] subtle">{poll.totalVoters.toString()} voters</div>
                      </td>
                      <td className="font-semibold" style={{ color: "var(--ink)" }}>{poll.pendingIntentCount.toString()}</td>
                      <td className="text-xs font-semibold uppercase subtle">
                        {poll.tokenWeighted ? UNSUPPORTED_WEIGHTED_POLL_LABEL : "1p1v"}
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() =>
                              document.getElementById(anchorId)?.scrollIntoView({ behavior: "smooth", block: "start" })
                            }
                            className="btn-quiet px-3 py-1.5 text-xs"
                          >
                            Inspect
                          </button>
                          <button
                            onClick={() => {
                              void copyPollId(poll.id);
                            }}
                            className="btn-quiet px-3 py-1.5 text-xs"
                          >
                            {copiedPollId === poll.id ? "Copied" : "Copy Poll ID"}
                          </button>
                          {isConnected && isPollVotingSupported(poll) && (
                            <button
                              onClick={() => onDelegateForPoll(poll.id)}
                              className="btn-quiet px-3 py-1.5 text-xs"
                            >
                              Delegate for this poll
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {filteredPolls.map((poll) => (
            <VoteOnPoll
              key={poll.id}
              anchorId={pollAnchorId(poll)}
              poll={poll}
              voterAddress={voterAddress}
              voterLockHash={voterLockHash}
              txState={txState}
              onVote={onVote}
              onAggregate={onAggregate}
              onFinalizeShards={onFinalizeShards}
              onMergeShards={onMergeShards}
              onClose={onClose}
              onForceClose={onForceClose}
              onRefundClosedIntent={onRefundClosedIntent}
              onRefundLateIntent={onRefundLateIntent}
              currentEpoch={currentEpoch}
              currentEpochPosition={currentEpochPosition}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
