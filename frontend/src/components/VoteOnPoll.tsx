/**
 * VoteOnPoll Component
 * ====================
 * Renders a single poll card with authority-aware voting, tally, and close
 * actions that match the indexed protocol state.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Poll, TxState } from "../lib/types";
import { TxStatus } from "./TxStatus";

interface Props {
  poll: Poll;
  voterAddress: string | null;
  txState: TxState;
  onVote: (poll: Poll, optionIndex: number, authorityId?: string) => Promise<string>;
  onAggregate: (poll: Poll) => Promise<string>;
  onClose: (poll: Poll) => Promise<string>;
  currentEpoch: bigint;
}

export function VoteOnPoll({
  poll,
  voterAddress,
  txState,
  onVote,
  onAggregate,
  onClose,
  currentEpoch,
}: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const [authorityId, setAuthorityId] = useState<string>("self");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const isBusy = submitting;
  const isExpired = currentEpoch > poll.deadline;
  const selectedAuthority = useMemo(
    () =>
      poll.authorityOptions.find((authority) => authority.id === authorityId) ??
      poll.authorityOptions[0] ??
      null,
    [authorityId, poll.authorityOptions]
  );

  useEffect(() => {
    if (!selectedAuthority && poll.authorityOptions[0]) {
      setAuthorityId(poll.authorityOptions[0].id);
      return;
    }

    if (
      selectedAuthority &&
      !poll.authorityOptions.some((authority) => authority.id === selectedAuthority.id)
    ) {
      setAuthorityId(poll.authorityOptions[0]?.id ?? "self");
    }
  }, [poll.authorityOptions, selectedAuthority]);

  const handleVote = async () => {
    if (selected === null) return;
    setSubmitting(true);
    setLocalError(null);

    try {
      await onVote(poll, selected, selectedAuthority?.id);
      setSelected(null);
    } catch (caughtError: any) {
      setLocalError(caughtError.message ?? "Vote failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = async () => {
    setSubmitting(true);
    setLocalError(null);

    try {
      await onClose(poll);
    } catch (caughtError: any) {
      setLocalError(caughtError.message ?? "Close failed");
    } finally {
      setSubmitting(false);
    }
  };

  const canVote =
    Boolean(voterAddress) &&
    !poll.isClosed &&
    !isExpired &&
    Boolean(selectedAuthority) &&
    !selectedAuthority?.hasIntent;
  const canAggregate = !poll.isClosed && !isExpired && poll.pendingIntentCount > 0n;
  const canClose = Boolean(voterAddress) && !poll.isClosed;

  const authorityDescription = selectedAuthority
    ? selectedAuthority.mode === "self"
      ? selectedAuthority.hasIntent
        ? selectedAuthority.hasPendingIntent
          ? "You already have a pending intent on this poll."
          : "You already have an aggregated vote intent on this poll."
        : "Your connected wallet can create a direct vote intent."
      : selectedAuthority.hasIntent
        ? selectedAuthority.hasPendingIntent
          ? "This delegated voter already has a pending intent on this poll."
          : "This delegated voter already has an aggregated vote intent on this poll."
        : "This delegation is valid for the current poll and can create an intent."
    : "No voting authority is available for this poll.";

  return (
    <div
      className={`overflow-hidden rounded-xl border bg-white shadow-sm ${
        poll.isClosed ? "border-gray-200 opacity-75" : "border-blue-100"
      }`}
    >
      <div className="px-5 pb-3 pt-5">
        <div className="mb-1 flex items-start justify-between gap-3">
          <h3 className="text-lg font-semibold leading-tight text-gray-800">{poll.question}</h3>
          <div className="flex-shrink-0">
            {poll.isClosed ? (
              <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-500">
                Closed
              </span>
            ) : isExpired ? (
              <span className="rounded-full bg-orange-100 px-2.5 py-1 text-xs font-medium text-orange-600">
                Expired
              </span>
            ) : (
              <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-medium text-green-600">
                Active
              </span>
            )}
          </div>
        </div>

        <div className="space-x-3 text-xs text-gray-400">
          <span>{poll.totalVoters.toString()} voters</span>
          <span>|</span>
          <span>{poll.pendingIntentCount.toString()} pending intents</span>
          <span>|</span>
          <span>Deadline: epoch {poll.deadline.toString()}</span>
          <span>|</span>
          <span className="font-mono text-gray-300">{poll.id.slice(0, 10)}...</span>
        </div>
      </div>

      <div className="space-y-2.5 px-5 pb-4">
        {poll.authorityOptions.length > 0 && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-3">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Voting authority
            </label>
            <select
              value={selectedAuthority?.id ?? authorityId}
              onChange={(event) => setAuthorityId(event.target.value)}
              disabled={isBusy || poll.authorityOptions.length === 1}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
            >
              {poll.authorityOptions.map((authority) => (
                <option key={authority.id} value={authority.id}>
                  {authority.label}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-slate-500">{authorityDescription}</p>
          </div>
        )}

        {poll.options.map((option, index) => {
          const votes = poll.voteCounts[index] ?? 0n;
          const percentage = poll.totalVotes > 0n ? Number((votes * 100n) / poll.totalVotes) : 0;
          const isWinner = poll.isClosed && poll.winnerIndex === index;
          const isSelected = selected === index;

          return (
            <div
              key={index}
              onClick={() => canVote && !isBusy && setSelected(index)}
              className={`relative overflow-hidden rounded-lg border-2 transition-all ${
                isSelected
                  ? "border-blue-500"
                  : isWinner
                    ? "border-green-400"
                    : "border-gray-100 hover:border-gray-300"
              } ${canVote ? "cursor-pointer" : "cursor-default"}`}
            >
              <div
                className={`absolute inset-0 opacity-10 ${
                  isWinner ? "bg-green-500" : isSelected ? "bg-blue-500" : "bg-gray-400"
                }`}
                style={{ width: `${percentage}%` }}
              />
              <div className="relative flex items-center justify-between px-3.5 py-2.5">
                <div className="flex items-center gap-2.5">
                  {canVote && (
                    <div
                      className={`h-4 w-4 flex-shrink-0 rounded-full border-2 ${
                        isSelected ? "border-blue-500 bg-blue-500" : "border-gray-300"
                      }`}
                    >
                      {isSelected && <div className="m-auto mt-0.5 h-2 w-2 rounded-full bg-white" />}
                    </div>
                  )}
                  {isWinner && <span>Winner</span>}
                  <span className="text-sm font-medium text-gray-800">{option}</span>
                </div>
                <div className="ml-3 flex-shrink-0 text-right text-xs text-gray-500">
                  <span className="font-semibold text-gray-700">{votes.toString()}</span>
                  <span className="ml-1 text-gray-400">({percentage}%)</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {(canVote || canAggregate || canClose) && (
        <div className="flex items-center gap-3 border-t border-gray-100 px-5 py-3">
          {canVote && (
            <button
              onClick={handleVote}
              disabled={selected === null || isBusy}
              className="flex-1 rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400"
            >
              {isBusy
                ? "Sending..."
                : selected !== null
                  ? `Create intent for "${poll.options[selected]}"`
                  : "Select an option"}
            </button>
          )}

          {canAggregate && (
            <button
              onClick={async () => {
                setSubmitting(true);
                setLocalError(null);
                try {
                  await onAggregate(poll);
                } catch (caughtError: any) {
                  setLocalError(caughtError.message ?? "Aggregate failed");
                } finally {
                  setSubmitting(false);
                }
              }}
              disabled={isBusy}
              className="rounded-lg border border-blue-200 px-4 py-2.5 text-sm text-blue-600 transition-colors hover:border-blue-400"
            >
              Aggregate
            </button>
          )}

          {canClose && (
            <button
              onClick={handleClose}
              disabled={isBusy}
              className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-500 transition-colors hover:border-red-300 hover:text-red-500"
            >
              Close Poll
            </button>
          )}
        </div>
      )}

      {txState.status !== "idle" && (
        <div className="px-5 pb-4">
          <TxStatus txState={txState} />
        </div>
      )}

      {localError && <div className="px-5 pb-4 text-sm text-red-500">{localError}</div>}
    </div>
  );
}
