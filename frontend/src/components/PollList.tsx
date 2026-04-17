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
  voterAddress: string | null;
  txState: TxState;
  currentEpoch: bigint;
  onVote: (poll: Poll, optionIndex: number, authorityId?: string) => Promise<string>;
  onAggregate: (poll: Poll) => Promise<string>;
  onClose: (poll: Poll) => Promise<string>;
  onRefresh: () => void;
}

export function PollList({
  polls,
  loading,
  voterAddress,
  txState,
  currentEpoch,
  onVote,
  onAggregate,
  onClose,
  onRefresh,
}: Props) {
  const [filter, setFilter] = useState<Filter>("all");

  const filteredPolls = polls.filter((poll) => {
    if (filter === "active") return !poll.isClosed && currentEpoch <= poll.deadline;
    if (filter === "closed") return poll.isClosed || currentEpoch > poll.deadline;
    return true;
  });

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
        <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setFilter(tab.key)}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition-all ${
                filter === tab.key
                  ? "bg-white text-gray-800 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {tab.label}
              <span
                className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs ${
                  filter === tab.key
                    ? "bg-blue-100 text-blue-600"
                    : "bg-gray-200 text-gray-500"
                }`}
              >
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        <button
          onClick={onRefresh}
          disabled={loading}
          className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600"
        >
          <span className={loading ? "animate-spin" : ""}>o</span>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {filteredPolls.length === 0 ? (
        <div className="py-16 text-center text-gray-400">
          {loading ? (
            <div className="space-y-2">
              <div className="text-3xl animate-spin">o</div>
              <div>Loading polls from CKB...</div>
            </div>
          ) : (
            <div>
              <div className="mb-3 text-4xl">Polls</div>
              <div className="font-medium text-gray-500">No polls found</div>
              <div className="mt-1 text-sm">Create the first poll above.</div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredPolls.map((poll) => (
            <VoteOnPoll
              key={poll.id}
              poll={poll}
              voterAddress={voterAddress}
              txState={txState}
              onVote={onVote}
              onAggregate={onAggregate}
              onClose={onClose}
              currentEpoch={currentEpoch}
            />
          ))}
        </div>
      )}
    </div>
  );
}
