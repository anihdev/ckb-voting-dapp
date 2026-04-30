/**
 * PollList Component
 * ==================
 * Lists polls and exposes simple active/closed filtering.
 */

import React, { useState } from "react";
import { Poll, TxState } from "../lib/types";
import { VoteOnPoll } from "./VoteOnPoll";

type Filter = "all" | "active" | "closed";

interface Props {
  polls: Poll[];
  loading: boolean;
  isConnected: boolean;
  voterAddress: string | null;
  voterLockHash: string | null;
  txState: TxState;
  currentEpoch: bigint;
  onVote: (poll: Poll, optionIndex: number, authorityId?: string, weightUnits?: number) => Promise<string>;
  onAggregate: (poll: Poll) => Promise<string>;
  onClose: (poll: Poll) => Promise<string>;
  onForceClose: (poll: Poll) => Promise<string>;
  onRefresh: () => void;
  onConnectWallet: () => void;
}

export function PollList({
  polls,
  loading,
  isConnected,
  voterAddress,
  voterLockHash,
  txState,
  currentEpoch,
  onVote,
  onAggregate,
  onClose,
  onForceClose,
  onRefresh,
  onConnectWallet,
}: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const isInitialLoading = loading && polls.length === 0;
  const hasNoPolls = polls.length === 0;

  const filteredPolls = polls.filter((poll) => {
    if (filter === "active") return !poll.isClosed && currentEpoch <= poll.deadline;
    if (filter === "closed") return poll.isClosed || currentEpoch > poll.deadline;
    return true;
  });

  const pollStatus = (poll: Poll): "active" | "expired" | "closed" => {
    if (poll.isClosed) return "closed";
    if (currentEpoch > poll.deadline) return "expired";
    return "active";
  };

  const pollAnchorId = (poll: Poll) =>
    `poll-${poll.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}-${poll.outPoint.index}`;

  const tabs: Array<{ key: Filter; label: string; count: number }> = [
    { key: "all", label: "All", count: polls.length },
    {
      key: "active",
      label: "Active",
      count: polls.filter((poll) => !poll.isClosed && currentEpoch <= poll.deadline).length,
    },
    {
      key: "closed",
      label: "Closed",
      count: polls.filter((poll) => poll.isClosed || currentEpoch > poll.deadline).length,
    },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex gap-1 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-1">
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
          className="btn-quiet flex items-center gap-2 text-xs uppercase tracking-[0.12em]"
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
          <div className="font-medium" style={{ color: "var(--ink)" }}>No polls in this filter.</div>
          <div className="mt-1 text-sm">Switch tabs to view active or closed proposals.</div>
        </div>
      ) : !isInitialLoading ? (
        <div className="space-y-4">
          <div className="alert alert-info">
            Aggregation processes pending vote intents and updates poll tally state on-chain.
          </div>
          <div className="table-shell">
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
                  return (
                    <tr key={`row-${poll.id}`}>
                      <td>
                        <div className="max-w-[340px] truncate font-semibold" style={{ color: "var(--ink)" }}>{poll.question}</div>
                        <div className="mt-1 font-mono text-[10px] subtle">{poll.id.slice(0, 16)}...</div>
                      </td>
                      <td>
                        {status === "closed" && <span className="status-pill status-closed">Closed</span>}
                        {status === "expired" && <span className="status-pill status-expired">Expired</span>}
                        {status === "active" && <span className="status-pill status-active">Active</span>}
                      </td>
                      <td className="text-xs subtle">
                        <div>Now: {currentEpoch.toString()}</div>
                        <div>Deadline: {poll.deadline.toString()}</div>
                      </td>
                      <td>
                        <div className="font-semibold" style={{ color: "var(--ink)" }}>{poll.totalVotes.toString()}</div>
                        <div className="text-[11px] subtle">{poll.totalVoters.toString()} voters</div>
                      </td>
                      <td className="font-semibold" style={{ color: "var(--ink)" }}>{poll.pendingIntentCount.toString()}</td>
                      <td className="text-xs font-semibold uppercase tracking-[0.09em] subtle">
                        {poll.tokenWeighted ? "Capped weighted" : "1p1v"}
                      </td>
                      <td>
                        <button
                          onClick={() =>
                            document.getElementById(anchorId)?.scrollIntoView({ behavior: "smooth", block: "start" })
                          }
                          className="btn-quiet px-3 py-1.5 text-xs"
                        >
                          Inspect
                        </button>
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
              onClose={onClose}
              onForceClose={onForceClose}
              currentEpoch={currentEpoch}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
