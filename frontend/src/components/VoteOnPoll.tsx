/**
 * VoteOnPoll Component
 * ====================
 * Renders a single poll card with authority-aware voting, tally, and close
 * actions that match the indexed protocol state.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Poll, TxState } from "../lib/types";
import { TxStatus } from "./TxStatus";
import { ActionConfirmDialog } from "./ActionConfirmDialog";
import {
  FORCE_CLOSE_GRACE_EPOCHS,
  MAX_WEIGHT_UNITS_PER_INTENT,
  SHANNONS_PER_CKB,
  VOTER_DEPOSIT_SHANNONS,
} from "../lib/constants";

interface Props {
  anchorId?: string;
  poll: Poll;
  voterAddress: string | null;
  voterLockHash: string | null;
  txState: TxState;
  onVote: (poll: Poll, optionIndex: number, authorityId?: string, weightUnits?: number) => Promise<string>;
  onAggregate: (poll: Poll) => Promise<string>;
  onClose: (poll: Poll) => Promise<string>;
  onForceClose: (poll: Poll) => Promise<string>;
  currentEpoch: bigint;
}

interface PendingConfirmAction {
  title: string;
  message: string;
  confirmLabel: string;
  execute: () => Promise<void>;
}

const APPROX_MINUTES_PER_EPOCH = 4;

function toErrorMessage(caughtError: unknown, fallback: string): string {
  if (caughtError instanceof Error && caughtError.message) {
    return caughtError.message;
  }
  if (typeof caughtError === "string" && caughtError.trim()) {
    return caughtError;
  }
  return fallback;
}

function mapActionErrorToUserMessage(rawMessage: string): string {
  const normalized = rawMessage.toLowerCase();
  if (
    normalized.includes("no signer auth cell") ||
    normalized.includes("insufficient") ||
    normalized.includes("not enough") ||
    normalized.includes("capacity")
  ) {
    return "Insufficient CKB balance. Fund your wallet at faucet.nervos.org and retry.";
  }
  return rawMessage;
}

function formatEpochDuration(epochSpan: bigint): string {
  if (epochSpan <= 0n) return "0 epochs (~0m)";
  const minutes = Number(epochSpan) * APPROX_MINUTES_PER_EPOCH;
  if (minutes < 60) {
    return `${epochSpan.toString()} epochs (~${minutes}m)`;
  }
  const hours = minutes / 60;
  return `${epochSpan.toString()} epochs (~${hours.toFixed(1)}h)`;
}

export function VoteOnPoll({
  anchorId,
  poll,
  voterAddress,
  voterLockHash,
  txState,
  onVote,
  onAggregate,
  onClose,
  onForceClose,
  currentEpoch,
}: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const [authorityId, setAuthorityId] = useState<string>("self");
  const [weightUnits, setWeightUnits] = useState<number>(1);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [intentSubmitted, setIntentSubmitted] = useState(false);
  const [confirmingForceClose, setConfirmingForceClose] = useState(false);
  const [pendingConfirmAction, setPendingConfirmAction] = useState<PendingConfirmAction | null>(null);
  const perUnitCkb = VOTER_DEPOSIT_SHANNONS / SHANNONS_PER_CKB;
  const maxEffectiveCkb = (VOTER_DEPOSIT_SHANNONS * MAX_WEIGHT_UNITS_PER_INTENT) / SHANNONS_PER_CKB;
  const isCreator =
    Boolean(voterLockHash) &&
    poll.creator.toLowerCase() === (voterLockHash ?? "").toLowerCase();

  const isBusy = submitting;
  const isExpired = currentEpoch > poll.deadline;
  const forceCloseGraceEndEpoch = poll.deadline + FORCE_CLOSE_GRACE_EPOCHS;
  const forceCloseOpen = currentEpoch > forceCloseGraceEndEpoch;
  const hasCreatedEpoch = poll.createdEpoch !== null;
  const createdEpoch = poll.createdEpoch ?? 0n;
  const plannedLiveEpochs =
    hasCreatedEpoch && poll.deadline > createdEpoch ? poll.deadline - createdEpoch : 0n;
  const elapsedSinceCreated =
    hasCreatedEpoch && currentEpoch > createdEpoch ? currentEpoch - createdEpoch : 0n;
  const epochsLeft = !isExpired ? poll.deadline - currentEpoch : 0n;
  const epochsPastDeadline = isExpired ? currentEpoch - poll.deadline : 0n;
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

  useEffect(() => {
    setIntentSubmitted(false);
    setConfirmingForceClose(false);
  }, [poll.id, poll.pendingIntentCount, poll.totalVotes]);

  const handleVote = async () => {
    if (selected === null) return;
    setSubmitting(true);
    setLocalError(null);

    try {
      await onVote(
        poll,
        selected,
        selectedAuthority?.id,
        poll.tokenWeighted ? weightUnits : 1
      );
      setIntentSubmitted(true);
      setSelected(null);
    } catch (caughtError: any) {
      setLocalError(mapActionErrorToUserMessage(toErrorMessage(caughtError, "Vote failed")));
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
      setLocalError(mapActionErrorToUserMessage(toErrorMessage(caughtError, "Close failed")));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAggregate = async () => {
    setSubmitting(true);
    setLocalError(null);
    try {
      await onAggregate(poll);
    } catch (caughtError: any) {
      setLocalError(mapActionErrorToUserMessage(toErrorMessage(caughtError, "Aggregate failed")));
    } finally {
      setSubmitting(false);
    }
  };

  const handleForceClose = async () => {
    setSubmitting(true);
    setLocalError(null);
    try {
      await onForceClose(poll);
      setConfirmingForceClose(false);
    } catch (caughtError: any) {
      setLocalError(mapActionErrorToUserMessage(toErrorMessage(caughtError, "Force-close failed")));
    } finally {
      setSubmitting(false);
    }
  };

  const requestConfirmation = (action: PendingConfirmAction) => {
    if (isBusy) return;
    setPendingConfirmAction(action);
  };

  const cancelConfirmation = () => {
    setPendingConfirmAction(null);
  };

  const confirmPendingAction = async () => {
    if (!pendingConfirmAction) return;
    const execute = pendingConfirmAction.execute;
    setPendingConfirmAction(null);
    await execute();
  };

  const canVote =
    Boolean(voterAddress) &&
    !isCreator &&
    !poll.isClosed &&
    !isExpired &&
    Boolean(selectedAuthority) &&
    !selectedAuthority?.hasIntent;
  const canAggregate = !poll.isClosed && !isExpired && poll.pendingIntentCount > 0n;
  const canClose = Boolean(voterLockHash) && !poll.isClosed && isExpired && isCreator;
  const canForceClose = Boolean(voterAddress) && !poll.isClosed && forceCloseOpen;
  const optionIsActionable = canVote && !isBusy;

  const authorityDescription = isCreator
    ? "You are viewing this poll as its creator. Vote intent submission is disabled in creator view."
    : selectedAuthority
      ? selectedAuthority.mode === "self"
        ? selectedAuthority.hasIntent
          ? selectedAuthority.hasPendingIntent
            ? "You already have a pending intent on this poll. Intent changes are disabled until lifecycle completion."
            : "You already have an aggregated vote intent on this poll."
          : "Your connected wallet can create a direct vote intent."
        : selectedAuthority.hasIntent
          ? selectedAuthority.hasPendingIntent
            ? "This delegated voter already has a pending intent on this poll. Intent changes are disabled."
            : "This delegated voter already has an aggregated vote intent on this poll."
          : "This delegation is valid for the current poll. Delegation grants intent authority, not ownership."
      : "No voting authority is available for this poll.";

  return (
    <div
      id={anchorId}
      className={`card-shell overflow-hidden !p-0 ${poll.isClosed ? "opacity-75" : ""
        }`}
    >
      <div className="px-4 pb-3 pt-5 sm:px-5">
        <div className="mb-1 flex items-start justify-between gap-3">
          <h3 className="text-lg font-semibold leading-tight text-[var(--ink)]">{poll.question}</h3>
          <div className="flex-shrink-0">
            {poll.isClosed ? (
              <span className="status-pill status-closed">
                Closed
              </span>
            ) : isExpired ? (
              <span className="status-pill status-expired">
                Expired
              </span>
            ) : (
              <span className="status-pill status-active">
                Active
              </span>
            )}
          </div>
        </div>

        <div className="space-x-3 text-xs subtle">
          <span>{poll.totalVoters.toString()} voters</span>
          <span>|</span>
          <span>{poll.pendingIntentCount.toString()} indexed pending intents</span>
          <span>|</span>
          <span>{isCreator ? "Creator view" : "Voter view"}</span>
          <span>|</span>
          <span>{poll.tokenWeighted ? "Capped weighted mode" : "1 voter = 1 vote"}</span>
          <span>|</span>
          <span>Deadline: epoch {poll.deadline.toString()}</span>
          <span>|</span>
          <span className="font-mono" style={{ color: "var(--ink-3)" }}>{poll.id.slice(0, 10)}...</span>
        </div>

        <div className="mt-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--line)", background: "var(--surface-2)", color: "var(--ink-2)" }}>
          <div>
            Created:{" "}
            {hasCreatedEpoch ? (
              <>epoch {createdEpoch.toString()}</>
            ) : (
              <>epoch unavailable from indexer</>
            )}
          </div>
          {hasCreatedEpoch && (
            <>
              <div>Planned live window: {formatEpochDuration(plannedLiveEpochs)}</div>
              <div>Time passed since creation: {formatEpochDuration(elapsedSinceCreated)}</div>
            </>
          )}
          {!isExpired ? (
            <div>Time left until close window: {formatEpochDuration(epochsLeft)}</div>
          ) : (
            <div>Time passed since deadline: {formatEpochDuration(epochsPastDeadline)}</div>
          )}
        </div>

        {!poll.isClosed && (
          <div className="mt-3 space-y-2 text-xs">
            <div className="alert alert-info">
              Submitting intent records your choice now; tally updates after aggregation.
            </div>
            <div className="alert alert-warn">
              Intent finality: once your vote intent is recorded on-chain, it cannot be changed for this poll. Review authority, option, and weight before submit.
            </div>
            {isCreator && (
              <div className="alert alert-info">
                Creator controls active. You can aggregate pending intents before deadline, then close after deadline, or force-close after grace if needed.
              </div>
            )}
            {!isExpired && (
              <div className="alert alert-info">
                Close becomes valid after deadline (epoch &gt; {poll.deadline.toString()}). Permissionless force-close opens once epoch &gt; {forceCloseGraceEndEpoch.toString()}.
              </div>
            )}
            {isExpired && !forceCloseOpen && (
              <div className="alert alert-warn">
                Creator-auth close is active now. If creator does not close, anyone can force-close once epoch &gt; {forceCloseGraceEndEpoch.toString()}.
              </div>
            )}
            {isExpired && forceCloseOpen && (
              <div className="alert alert-error">
                Grace period elapsed. Anyone can force-close now so deposits are not locked indefinitely.
              </div>
            )}
            {!isExpired && poll.pendingIntentCount > 0n && (
              <div className="alert" style={{ background: "var(--surface-2)", border: "1px solid var(--line)", color: "var(--ink-2)" }}>
                Pending intents detected. Aggregate before deadline to keep tally state current and reduce close-time backlog.
              </div>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2.5 px-4 pb-4 sm:px-5">
        {!isCreator && poll.tokenWeighted && (
          <div className="alert alert-warn rounded-xl px-3.5 py-3">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--amber)" }}>
              Vote weight units
            </label>
            <input
              type="number"
              min={1}
              max={Number(MAX_WEIGHT_UNITS_PER_INTENT)}
              value={weightUnits}
              onChange={(event) => {
                const parsed = parseInt(event.target.value, 10);
                if (Number.isNaN(parsed)) {
                  setWeightUnits(1);
                  return;
                }
                if (parsed < 1) {
                  setWeightUnits(1);
                  return;
                }
                const max = Number(MAX_WEIGHT_UNITS_PER_INTENT);
                setWeightUnits(parsed > max ? max : parsed);
              }}
              disabled={isBusy}
              className="input"
            />
            <p className="mt-2 text-xs" style={{ color: "var(--amber)" }}>
              1 unit = {perUnitCkb.toString()} CKB, max {MAX_WEIGHT_UNITS_PER_INTENT.toString()} units ({maxEffectiveCkb.toString()} CKB effective). Extra CKB above cap adds no extra weight.
            </p>
          </div>
        )}

        {!isCreator && poll.authorityOptions.length > 0 && (
          <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-soft)] px-3.5 py-3">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide subtle">
              Voting authority
            </label>
            <select
              value={selectedAuthority?.id ?? authorityId}
              onChange={(event) => setAuthorityId(event.target.value)}
              disabled={isBusy || poll.authorityOptions.length === 1}
              className="input"
            >
              {poll.authorityOptions.map((authority) => (
                <option key={authority.id} value={authority.id}>
                  {authority.label}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs subtle">{authorityDescription}</p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
          {poll.options.map((option, index) => {
            const votes = poll.voteCounts[index] ?? 0n;
            const percentage = poll.totalVotes > 0n ? Number((votes * 100n) / poll.totalVotes) : 0;
            const isWinner = poll.isClosed && poll.winnerIndex === index;
            const isSelected = selected === index;

            return (
              <div
                key={index}
                onClick={() => canVote && !isBusy && setSelected(index)}
                className={`poll-option${isSelected ? " selected" : ""}${optionIsActionable ? " is-actionable" : " disabled"}`}
                title={optionIsActionable ? "Select this option to submit vote intent" : "Voting is not available for this poll state/authority"}
              >
                <div
                  className={`poll-option-bar ${isWinner ? "winner" : ""}`}
                  style={{ width: `${percentage}%` }}
                />
                <div className="relative flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    {canVote && (
                      <div className="poll-option-radio" />
                    )}
                    {isWinner && <span className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: "#34d399" }}>Winner</span>}
                    <span className="text-sm font-medium text-[var(--ink)]">{option}</span>
                  </div>
                  <div className="ml-3 flex-shrink-0 text-right text-xs subtle">
                    <span className="font-semibold" style={{ color: "var(--ink)" }}>{votes.toString()}</span>
                    <span className="ml-1" style={{ color: "var(--ink-3)" }}>({percentage}%)</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {intentSubmitted && (
          <div className="alert alert-info">
            Your vote intent is recorded on-chain. The tally shown reflects aggregated votes only - it will update after the next aggregation.
          </div>
        )}
      </div>

      {(canVote || canAggregate || canClose || canForceClose) && (
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:px-5" style={{ borderTop: "1px solid var(--line)" }}>
          {confirmingForceClose ? (
            <div className="w-full">
              <div className="mb-2 text-sm" style={{ color: "var(--ink-2)" }}>
                This will close the poll and return all participant deposits.
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <button
                  onClick={() => {
                    void handleForceClose();
                  }}
                  disabled={isBusy}
                  className="btn-danger w-full sm:w-auto"
                >
                  Confirm Force Close
                </button>
                <button
                  onClick={() => setConfirmingForceClose(false)}
                  disabled={isBusy}
                  className="btn-quiet w-full sm:w-auto"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {canVote && (
                <button
                  onClick={() => {
                    if (selected === null) return;
                    const weightSummary = poll.tokenWeighted
                      ? ` Weight: ${weightUnits} unit(s).`
                      : "";
                    requestConfirmation({
                      title: "Confirm Vote Intent Submission",
                      message: `You are about to record a vote intent for "${poll.options[selected]}". Once recorded on-chain, this intent cannot be changed for this poll.${weightSummary}`,
                      confirmLabel: "Confirm Intent",
                      execute: handleVote,
                    });
                  }}
                  disabled={selected === null || isBusy}
                  className="btn-primary w-full sm:min-w-[220px] sm:flex-1"
                >
                  {isBusy
                    ? "Sending..."
                    : selected !== null
                      ? `Submit intent for "${poll.options[selected]}"`
                      : "Select an option"}
                </button>
              )}

              {canAggregate && (
                <button
                  onClick={() => {
                    requestConfirmation({
                      title: "Confirm Aggregation",
                      message: "This will consume pending intents and update poll tally state on-chain.",
                      confirmLabel: "Run Aggregate",
                      execute: handleAggregate,
                    });
                  }}
                  disabled={isBusy}
                  className={`${isCreator ? "btn-primary" : "btn-quiet"} w-full sm:w-auto`}
                >
                  Aggregate Votes
                </button>
              )}

              {canClose && (
                <button
                  onClick={() => {
                    requestConfirmation({
                      title: "Confirm Close Poll",
                      message: "This will close the poll and execute close-time refund paths according to protocol rules.",
                      confirmLabel: "Close Poll",
                      execute: handleClose,
                    });
                  }}
                  disabled={isBusy}
                  className="btn-quiet w-full sm:w-auto"
                >
                  Close Poll (creator auth)
                </button>
              )}

              {canForceClose && (
                <button
                  onClick={() => setConfirmingForceClose(true)}
                  disabled={isBusy}
                  className="btn-danger w-full sm:w-auto"
                >
                  Force Close (permissionless)
                </button>
              )}
            </>
          )}
        </div>
      )}

      {txState.status !== "idle" && (
        <div className="px-4 pb-4 sm:px-5">
          <TxStatus txState={txState} />
        </div>
      )}

      {localError && (
        <div className="px-4 pb-4 text-sm sm:px-5" style={{ color: "var(--red)" }}>
          <div>{localError}</div>
          {localError.toLowerCase().includes("insufficient ckb balance") && (
            <a
              href="https://faucet.nervos.org/"
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginTop: 4, display: "inline-block", color: "var(--teal)", textDecoration: "underline" }}
            >
              Open Nervos testnet faucet
            </a>
          )}
        </div>
      )}

      <ActionConfirmDialog
        open={Boolean(pendingConfirmAction)}
        title={pendingConfirmAction?.title ?? ""}
        message={pendingConfirmAction?.message ?? ""}
        confirmLabel={pendingConfirmAction?.confirmLabel ?? "Confirm"}
        countdownSeconds={10}
        busy={isBusy}
        onCancel={cancelConfirmation}
        onConfirm={() => {
          void confirmPendingAction();
        }}
      />
    </div>
  );
}
