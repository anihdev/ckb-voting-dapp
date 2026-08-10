/**
 * VoteOnPoll Component
 * ====================
 * Renders a single poll card with authority-aware voting, tally, and close
 * actions that match the indexed protocol state.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { FinalizationReadinessCheck, Poll, TxState } from "../lib/types";
import { TxStatus } from "./TxStatus";
import { ActionConfirmDialog } from "./ActionConfirmDialog";
import {
  FORCE_CLOSE_GRACE_EPOCHS,
  MAX_CLOSE_INTENT_REFUNDS,
  MAX_DIRECT_CLOSE_SHARDS,
  MAX_INTENTS_PER_AGG,
  MAX_SHARDS_PER_FINALIZE,
} from "../lib/constants";
import {
  canDelegateForPoll,
  canFinalizeTallyShardFromUi,
  CREATOR_VOTING_DISABLED_MESSAGE,
  derivePollOutcome,
  EpochPosition,
  estimatePollCloseHours,
  finalizationReadinessNeedsCaution,
  formatApproxEpochDuration,
  formatApproxWallClockDuration,
  getFinalizeShardConfirmationMessage,
  getPollTallyProgress,
  isLeadingOption,
  isPollVotingSupported,
  UNSUPPORTED_WEIGHTED_POLL_LABEL,
  UNSUPPORTED_WEIGHTED_POLL_MESSAGE,
} from "../lib/protocolUi";
import { areTransactionControlsLocked } from "../lib/txLifecycle";

interface Props {
  anchorId?: string;
  poll: Poll;
  voterAddress: string | null;
  voterLockHash: string | null;
  txState: TxState;
  actionInFlight: boolean;
  /** Optional initial-state override; poll cards are collapsed by default. */
  defaultExpanded?: boolean;
  onVote: (poll: Poll, optionIndex: number, authorityId?: string) => Promise<string>;
  onAggregate: (poll: Poll) => Promise<string>;
  onCheckFinalizationReadiness: (poll: Poll) => Promise<FinalizationReadinessCheck>;
  onFinalizeShards: (poll: Poll) => Promise<string>;
  onFinalizeAllShards: (poll: Poll) => Promise<string>;
  onMergeShards: (poll: Poll) => Promise<string>;
  onClose: (poll: Poll) => Promise<string>;
  onForceClose: (poll: Poll) => Promise<string>;
  onRefundClosedIntent: (poll: Poll) => Promise<string>;
  onRefundLateIntent: (poll: Poll) => Promise<string>;
  /** Prefills the delegation form with this poll's scope; omitted when disconnected. */
  onDelegateForPoll?: (pollId: string) => void;
  currentEpoch: bigint;
  currentEpochPosition?: EpochPosition;
}

interface PendingConfirmAction {
  title: string;
  message: string;
  confirmLabel: string;
  execute: () => Promise<void>;
}

type ActivePollAction =
  | "vote"
  | "aggregate"
  | "finalize"
  | "merge"
  | "close"
  | "forceClose"
  | "refundClosed"
  | "refundLate";

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

function tallySourceLabel(source: Poll["tallyFrontier"]["source"]): string {
  switch (source) {
    case "live-shards":
      return "Current tally: live tally lanes";
    case "merge-frontier":
      return "Current tally: partial merged tally";
    case "complete-merge":
      return "Current tally: complete merged tally";
    case "closed-poll":
      return "Final tally: closed poll result";
    default:
      return "Current tally: live tally lanes";
  }
}

export function VoteOnPoll({
  anchorId,
  poll,
  voterAddress,
  voterLockHash,
  txState,
  actionInFlight,
  defaultExpanded,
  onVote,
  onAggregate,
  onCheckFinalizationReadiness,
  onFinalizeShards,
  onFinalizeAllShards,
  onMergeShards,
  onClose,
  onForceClose,
  onRefundClosedIntent,
  onRefundLateIntent,
  onDelegateForPoll,
  currentEpoch,
  currentEpochPosition,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const [copiedPollId, setCopiedPollId] = useState(false);
  const [authorityId, setAuthorityId] = useState<string>("self");
  const [submitting, setSubmitting] = useState(false);
  const [activeAction, setActiveAction] = useState<ActivePollAction | null>(null);
  const [lastCompletedAction, setLastCompletedAction] = useState<ActivePollAction | null>(null);
  const [finalizationCheckInFlight, setFinalizationCheckInFlight] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [submittedChoice, setSubmittedChoice] = useState<{
    authorityId: string;
    optionIndex: number;
  } | null>(null);
  const [confirmingForceClose, setConfirmingForceClose] = useState(false);
  const [pendingConfirmAction, setPendingConfirmAction] = useState<PendingConfirmAction | null>(null);
  const isCreator =
    Boolean(voterLockHash) &&
    poll.creator.toLowerCase() === (voterLockHash ?? "").toLowerCase();

  // Status renders only for this card's own transactions, but controls lock
  // globally: the hook allows one state-changing action at a time, so a foreign
  // transaction must disable this card's actions even though its status is
  // hidden here.
  const ownsTxState = txState.scope?.kind === "poll" && txState.scope.pollId === poll.id;
  const scopedTxState = ownsTxState ? txState : null;
  const isBusy =
    submitting ||
    finalizationCheckInFlight ||
    areTransactionControlsLocked(txState, actionInFlight);
  const votingSupported = isPollVotingSupported(poll);
  const isExpired = currentEpoch > poll.deadline;
  // Offered only where the hook would accept a new delegation: connected
  // wallet, poll open before its deadline, and the viewer is not the creator.
  // Shown on neither a needs-close nor a closed poll, and never while
  // disconnected, so the button cannot advertise a rejected action.
  const canDelegate = canDelegateForPoll(poll, voterLockHash, currentEpoch);
  const forceCloseGraceEndEpoch = poll.deadline + FORCE_CLOSE_GRACE_EPOCHS;
  const forceCloseOpen = currentEpoch > forceCloseGraceEndEpoch;
  const indexedShardCount = poll.tallyShards.length;
  const finalizedShardCount = poll.tallyShards.filter((shard) => shard.finalized).length;
  const missingShardCount = poll.shardCount > indexedShardCount ? poll.shardCount - indexedShardCount : 0;
  const mergeResultCount = poll.tallyMergeResults.length;
  const tallyProgress = getPollTallyProgress(poll);
  const directCloseTooLarge = tallyProgress.requiresMerge;
  const allShardsFinalized = tallyProgress.allShardsFinalized;
  const hasCompleteMergeResult = tallyProgress.hasCompleteMergeResult;
  const closeStateReady = tallyProgress.closeStateReady;
  const remainingShardCount = tallyProgress.unfinalizedShardCount;
  const finalizeTransactionCount = Math.ceil(remainingShardCount / MAX_SHARDS_PER_FINALIZE);
  const tallyCoverageComplete = poll.tallyFrontier.coverageComplete;
  const canDescribeTallyAsFinal = poll.isClosed || closeStateReady;
  const tallyCoverageText =
    poll.tallyFrontier.shardCount > 0
      ? `${poll.tallyFrontier.coveredShardCount.toString()}/${poll.tallyFrontier.shardCount.toString()} lanes indexed`
      : "no tally-lane coverage indexed";
  const uncoveredPreview = poll.tallyFrontier.uncoveredShardIds.slice(0, 8).join(", ");
  const uncoveredSuffix =
    poll.tallyFrontier.uncoveredShardIds.length > 8
      ? `, +${(poll.tallyFrontier.uncoveredShardIds.length - 8).toString()} more`
      : "";
  const hasCreatedEpoch = poll.createdEpoch !== null;
  const createdEpoch = poll.createdEpoch ?? 0n;
  const elapsedSinceCreated =
    hasCreatedEpoch && currentEpoch > createdEpoch ? currentEpoch - createdEpoch : 0n;
  const estimatedCloseHours = estimatePollCloseHours(
    poll.deadline,
    currentEpochPosition ?? { epoch: currentEpoch, index: 0n, length: 1n }
  );
  const epochsPastDeadline = isExpired ? currentEpoch - poll.deadline : 0n;
  const selectedAuthority = useMemo(
    () =>
      poll.authorityOptions.find((authority) => authority.id === authorityId) ??
      poll.authorityOptions[0] ??
      null,
    [authorityId, poll.authorityOptions]
  );
  const selectedAuthorityRepresentsCreator =
    Boolean(selectedAuthority) &&
    selectedAuthority?.voterLockHash.toLowerCase() === poll.creator.toLowerCase();

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
    setSubmittedChoice(null);
    setConfirmingForceClose(false);
  }, [poll.id, voterLockHash]);

  useEffect(() => {
    if (!expanded || pendingConfirmAction || isBusy) return;

    // Expanded cards behave as disclosures: a pointer action elsewhere folds
    // this card, while all selections remain intact for a later reopen.
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || cardRef.current?.contains(target)) return;
      setExpanded(false);
    };

    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    };
  }, [expanded, isBusy, pendingConfirmAction]);

  const handleCopyPollId = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(poll.id);
      } else {
        throw new Error("Clipboard not available");
      }
      setCopiedPollId(true);
      setTimeout(() => setCopiedPollId(false), 1800);
    } catch {
      setCopiedPollId(false);
    }
  };

  const executeAction = async (
    action: ActivePollAction,
    operation: () => Promise<unknown>,
    fallbackError: string
  ): Promise<boolean> => {
    setSubmitting(true);
    setActiveAction(action);
    setLastCompletedAction(null);
    setLocalError(null);
    try {
      await operation();
      setLastCompletedAction(action);
      return true;
    } catch (caughtError: unknown) {
      setLocalError(mapActionErrorToUserMessage(toErrorMessage(caughtError, fallbackError)));
      return false;
    } finally {
      setActiveAction(null);
      setSubmitting(false);
    }
  };

  const handleVote = async () => {
    if (selected === null || !selectedAuthority) return;
    const submittedOptionIndex = selected;
    const submittedAuthorityId = selectedAuthority.id;
    const succeeded = await executeAction(
      "vote",
      () => onVote(poll, submittedOptionIndex, submittedAuthorityId),
      "Vote failed"
    );
    if (succeeded) {
      setSubmittedChoice({
        authorityId: submittedAuthorityId,
        optionIndex: submittedOptionIndex,
      });
      setSelected(null);
    }
  };

  const handleClose = async () => {
    await executeAction("close", () => onClose(poll), "Close failed");
  };

  const handleAggregate = async () => {
    await executeAction("aggregate", () => onAggregate(poll), "Aggregate failed");
  };

  const handleFinalizeShards = async () => {
    await executeAction("finalize", () => onFinalizeShards(poll), "Finalize shard failed");
  };

  const handleFinalizeAllShards = async () => {
    await executeAction("finalize", () => onFinalizeAllShards(poll), "Finalize lanes failed");
  };

  const handleMergeShards = async () => {
    await executeAction("merge", () => onMergeShards(poll), "Merge shards failed");
  };

  const handleForceClose = async () => {
    const succeeded = await executeAction(
      "forceClose",
      () => onForceClose(poll),
      "Force-close failed"
    );
    if (succeeded) {
      setConfirmingForceClose(false);
    }
  };

  const handleRefundClosedIntent = async () => {
    await executeAction(
      "refundClosed",
      () => onRefundClosedIntent(poll),
      "Intent refund failed"
    );
  };

  const handleRefundLateIntent = async () => {
    await executeAction(
      "refundLate",
      () => onRefundLateIntent(poll),
      "Late intent refund failed"
    );
  };

  const requestConfirmation = (action: PendingConfirmAction) => {
    if (isBusy) return;
    setPendingConfirmAction(action);
  };

  const prepareFinalizationConfirmation = async (mode: "single" | "remaining") => {
    if (isBusy) return;

    setFinalizationCheckInFlight(true);
    setLocalError(null);
    let readinessCheck: FinalizationReadinessCheck | null = null;

    try {
      readinessCheck = await onCheckFinalizationReadiness(poll);
    } catch {
      readinessCheck = null;
    } finally {
      setFinalizationCheckInFlight(false);
    }

    // Flow: the preflight informs the signer but never becomes a consensus
    // gate. A failed or cautionary indexer result requires an explicit
    // "Finalize Anyway" handshake; the Rust contract remains authoritative.
    const needsCaution =
      readinessCheck === null || finalizationReadinessNeedsCaution(readinessCheck);
    const message = readinessCheck
      ? getFinalizeShardConfirmationMessage(poll, readinessCheck)
      : "The indexed intent check could not complete. Finalizing now can leave timely intents permanently uncounted.";

    if (mode === "single") {
      requestConfirmation({
        title: "Confirm Shard Finalization",
        message,
        confirmLabel: needsCaution ? "Finalize Anyway" : "Finalize Last Lane",
        execute: handleFinalizeShards,
      });
      return;
    }

    requestConfirmation({
      title: "Confirm Lane Finalization",
      message,
      confirmLabel: needsCaution
        ? "Finalize Anyway"
        : "Finalize Lanes",
      execute: handleFinalizeAllShards,
    });
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

  const hasWallet = Boolean(voterAddress);
  const canVote =
    hasWallet &&
    votingSupported &&
    !isCreator &&
    !selectedAuthorityRepresentsCreator &&
    !poll.isClosed &&
    !isExpired &&
    Boolean(selectedAuthority) &&
    !selectedAuthority?.hasIntent;
  const canAggregate =
    hasWallet &&
    votingSupported &&
    !poll.isClosed &&
    poll.aggregationBatchCount > 0;
  const canFinalizeShards =
    hasWallet &&
    canFinalizeTallyShardFromUi(poll, currentEpoch) &&
    !allShardsFinalized;
  const canMergeShards =
    hasWallet &&
    !poll.isClosed &&
    isExpired &&
    directCloseTooLarge &&
    !hasCompleteMergeResult &&
    (finalizedShardCount > 0 || mergeResultCount > 1);
  const canClose =
    Boolean(voterLockHash) &&
    !poll.isClosed &&
    isExpired &&
    isCreator &&
    closeStateReady;
  const canForceClose =
    hasWallet &&
    !poll.isClosed &&
    forceCloseOpen &&
    closeStateReady;
  const canRefundClosedIntent =
    hasWallet &&
    poll.isClosed &&
    poll.refundableIntentCount > 0;
  const canRefundLateIntent =
    hasWallet &&
    !poll.isClosed &&
    poll.lateIntentCount > 0;
  const shortcutVotingAuthority = poll.authorityOptions.find(
    (authority) =>
      !authority.hasIntent &&
      authority.voterLockHash.toLowerCase() !== poll.creator.toLowerCase()
  );
  const canOpenVotingDetails =
    hasWallet &&
    votingSupported &&
    !isCreator &&
    !poll.isClosed &&
    !isExpired &&
    Boolean(shortcutVotingAuthority);
  const optionIsActionable = canVote && !isBusy;
  const locallySubmittedOptionIndex =
    submittedChoice !== null && submittedChoice.authorityId === selectedAuthority?.id
      ? submittedChoice.optionIndex
      : null;
  const recordedChoiceIndex = selectedAuthority?.hasConflictingIntentChoices
    ? null
    : selectedAuthority?.recordedOptionIndex ?? locallySubmittedOptionIndex;
  // Flow: show the initial operation as Aggregate even when several lanes need
  // work. Once tally state has advanced, any remaining work is a next batch.
  const aggregationHasStarted = poll.totalVotes > 0n || lastCompletedAction === "aggregate";
  const aggregationActionLabel = aggregationHasStarted ? "Aggregate Next Batch" : "Aggregate";
  const aggregationActionTitle = aggregationHasStarted
    ? `Process the next lane-bound batch. About ${poll.aggregationBatchCount.toString()} aggregation ${poll.aggregationBatchCount === 1 ? "transaction remains" : "transactions remain"} from indexed data.`
    : `Start aggregation with one lane-bound batch. About ${poll.aggregationBatchCount.toString()} aggregation transaction${poll.aggregationBatchCount === 1 ? " is" : "s are"} currently required from indexed data.`;
  const voteUnavailableMessage = isCreator
    ? CREATOR_VOTING_DISABLED_MESSAGE
    : selectedAuthorityRepresentsCreator
      ? "Voting is not allowed because this delegated authority represents the poll creator."
      : !selectedAuthority
        ? "No voting authority is available for this poll."
        : isExpired
          ? "Voting has ended for this poll."
          : selectedAuthority.hasIntent
            ? "This voter already has a vote intent for this poll."
            : "Voting is not available for the current poll state.";
  const tallySourceDescription = !poll.isClosed
    ? "Tally-lane state is indexed, but option totals remain hidden here until the poll closes. Pending intents are not included until aggregation."
    : poll.tallyFrontier.source === "live-shards"
      ? "The displayed results come from totals stored in the live tally lanes."
      : poll.tallyFrontier.source === "merge-frontier"
        ? "The displayed results combine non-overlapping merge results with uncovered live tally lanes."
        : poll.tallyFrontier.source === "complete-merge"
          ? "The displayed results come from one complete merge result covering every tally lane."
          : "The displayed results come from the tally preserved when this poll closed.";

  const authorityDescription = !votingSupported
    ? "Weighted voting is disabled for this indexed poll. Only lifecycle recovery actions remain available."
    : isCreator
    ? CREATOR_VOTING_DISABLED_MESSAGE
    : selectedAuthorityRepresentsCreator
      ? "This delegated authority represents the poll creator. Consensus does not allow the creator to vote through a delegate."
    : selectedAuthority?.hasConflictingIntentChoices
      ? "Multiple indexed intents for this represented voter encode different choices. The UI cannot identify one recorded choice; aggregation still prevents double counting."
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
          : "This delegate can create an intent for the delegator using the live delegation cell as a read-only cell dep. In testnet v1, the delegate funds the intent capacity and the exact refund returns to the delegator."
      : "No voting authority is available for this poll.";

  // Derived from raw counts rather than stored on the poll, so the card cannot
  // present an outcome the tally does not support. The contract defines no
  // winner or tie-break, so a tie is reported as a tie.
  const outcome = useMemo(() => derivePollOutcome(poll.voteCounts), [poll.voteCounts]);
  const outcomeLabel =
    outcome.kind === "tie" ? "Tied finalized tally" : "Finalized tally leader";
  const outcomeOptions =
    outcome.kind === "leader"
      ? [poll.options[outcome.optionIndex] ?? `Option ${(outcome.optionIndex + 1).toString()}`]
      : outcome.kind === "tie"
        ? outcome.optionIndices.map(
            (index) => poll.options[index] ?? `Option ${(index + 1).toString()}`
          )
        : [];
  const outcomeVotes =
    outcome.kind === "leader"
      ? outcome.votes
      : outcome.kind === "tie"
        ? outcome.votesEach
        : 0n;
  const pollDetailsId = `${anchorId ?? poll.id}-details`;

  const openVotingDetails = () => {
    if (!shortcutVotingAuthority) return;
    setAuthorityId(shortcutVotingAuthority.id);
    setExpanded(true);

    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        document.getElementById(pollDetailsId)?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      });
    }
  };

  return (
    <div
      ref={cardRef}
      id={anchorId}
      className={`poll-card card-shell overflow-hidden !p-0 ${poll.isClosed ? "opacity-75" : ""
        }`}
    >
      <div className="poll-card-header">
        <div className="poll-title-row">
          <div className="poll-question-wrap">
            <div className="poll-question-label">Proposal question</div>
            <h3 className="poll-question">{poll.question}</h3>
          </div>
          <div className="poll-title-actions flex flex-shrink-0 items-center gap-2">
            {poll.isClosed ? (
              <span className="status-pill status-closed">
                Closed
              </span>
            ) : isExpired ? (
              <span className="status-pill status-expired">
                Expired
              </span>
            ) : (
              <span className="status-pill status-active status-poll-live">
                Active
              </span>
            )}
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded}
              aria-controls={pollDetailsId}
              title={expanded ? "Collapse this poll's details" : "Show voting and lifecycle details"}
              className="btn-quiet px-3 py-1.5 text-xs uppercase"
            >
              {expanded ? "Hide details" : "View details"}
            </button>
          </div>
        </div>

        <div className="poll-meta" aria-label="Poll summary">
          <span>{poll.totalVoters.toString()} voters</span>
          <span>{poll.pendingIntentCount.toString()} indexed pending intents</span>
          {poll.isClosed && poll.refundableIntentCount > 0 && (
            <span>{poll.refundableIntentCount.toString()} omitted intent refunds indexed</span>
          )}
          <span>{isCreator ? "Creator view" : "Voter view"}</span>
          <span>{poll.tokenWeighted ? UNSUPPORTED_WEIGHTED_POLL_LABEL : "1 voter = 1 vote"}</span>
          <span>{poll.shardCount.toString()} tally lanes</span>
          <span>Deadline: epoch {poll.deadline.toString()}</span>
          <span className="font-mono" style={{ color: "var(--ink-3)" }}>{poll.id.slice(0, 10)}...</span>
        </div>

        <div className="poll-quick-actions">
          <button
            type="button"
            onClick={() => {
              void handleCopyPollId();
            }}
            title="Copy this poll's on-chain identifier"
            className="btn-quiet px-3 py-1.5 text-xs"
          >
            {copiedPollId ? "Poll ID copied" : "Copy Poll ID"}
          </button>
          {onDelegateForPoll && canDelegate && (
            <button
              type="button"
              onClick={() => onDelegateForPoll(poll.id)}
              title="Open delegation with this poll already selected"
              className="btn-quiet px-3 py-1.5 text-xs"
            >
              Delegate for this poll
            </button>
          )}
          {canOpenVotingDetails && (
            <button
              type="button"
              onClick={openVotingDetails}
              aria-expanded={expanded}
              aria-controls={pollDetailsId}
              title="Open this poll and choose an option"
              className="btn-primary px-3 py-1.5 text-xs"
            >
              Vote now
            </button>
          )}
        </div>

        {poll.isClosed && (
          <div className="poll-result-summary" aria-label="Final result">
            {outcome.kind === "no-votes" ? (
              <span className="poll-result-empty">
                No counted votes.
              </span>
            ) : (
              <>
                <span className="poll-result-label">{outcomeLabel}</span>
                <span className="poll-result-value">{outcomeOptions.join(" / ")}</span>
                <span className="poll-result-votes">
                  {outcome.kind === "tie"
                    ? `${outcomeVotes.toString()} votes each of ${poll.totalVotes.toString()} counted`
                    : `${outcomeVotes.toString()} of ${poll.totalVotes.toString()} counted votes`}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {expanded && (
      <div id={pollDetailsId}>
      <div className="poll-card-body space-y-2.5">
        {!poll.isClosed && poll.tokenWeighted && (
          <div className="alert alert-error">
            {UNSUPPORTED_WEIGHTED_POLL_MESSAGE}
          </div>
        )}

        {!poll.isClosed && votingSupported && isCreator && (
          <div className="alert alert-warn">
            {CREATOR_VOTING_DISABLED_MESSAGE}
          </div>
        )}

        {!poll.isClosed && votingSupported && !isCreator && (
          <div className="alert alert-warn">
            Intent finality: once your vote intent is recorded on-chain, it cannot be changed for this poll. Review authority and option before submit.
          </div>
        )}

        {!isCreator && votingSupported && poll.authorityOptions.length > 0 && (
          <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-soft)] px-3.5 py-3">
            <label className="mb-1.5 block text-xs font-semibold uppercase subtle">
              Voting authority
            </label>
            <select
              value={selectedAuthority?.id ?? authorityId}
              onChange={(event) => setAuthorityId(event.target.value)}
              disabled={isBusy || poll.authorityOptions.length === 1}
              title="Choose which represented voter authority will submit or display an intent"
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

        <div className="poll-options-grid" aria-label="Voting options">
          {poll.options.map((option, index) => {
            const votes = poll.voteCounts[index] ?? 0n;
            const percentage = poll.totalVotes > 0n ? Number((votes * 100n) / poll.totalVotes) : 0;
            const isLeading = poll.isClosed && isLeadingOption(outcome, index);
            const isSelected = canVote && selected === index;
            const isRecordedChoice = recordedChoiceIndex === index;
            const optionTitle = isRecordedChoice
              ? "Your indexed choice on this poll"
              : optionIsActionable
                ? "Select this option to submit a vote intent"
                : voteUnavailableMessage;

            return (
              <button
                type="button"
                key={index}
                onClick={() => setSelected(index)}
                disabled={!optionIsActionable}
                aria-pressed={isSelected || isRecordedChoice}
                className={`poll-option${isSelected ? " selected" : ""}${isRecordedChoice ? " recorded-choice" : ""}${optionIsActionable ? " is-actionable" : " disabled"}`}
                title={optionTitle}
              >
                {poll.isClosed && (
                  <div
                    className={`poll-option-bar ${isLeading ? "winner" : ""}`}
                    style={{ width: `${percentage}%` }}
                  />
                )}
                <div className="poll-option-content">
                  <div className="poll-option-label">
                    {canVote && (
                      <div className="poll-option-radio" />
                    )}
                    {isLeading && (
                      <span className="text-xs font-semibold uppercase" style={{ color: "#34d399" }}>
                        {outcome.kind === "tie" ? "Tied lead" : "Leader"}
                      </span>
                    )}
                    <span className="poll-option-label-text">{option}</span>
                    {isRecordedChoice && (
                      <span className="recorded-choice-badge">Your recorded choice</span>
                    )}
                  </div>
                  {poll.isClosed && (
                    <div className="poll-option-tally">
                      <span className="font-semibold" style={{ color: "var(--ink)" }}>{votes.toString()}</span>
                      <span className="ml-1" style={{ color: "var(--ink-3)" }}>({percentage}%)</span>
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {submittedChoice && submittedChoice.authorityId === selectedAuthority?.id && (
          <div className="alert alert-info">
            Your vote intent for "{poll.options[submittedChoice.optionIndex] ?? `Option ${(submittedChoice.optionIndex + 1).toString()}`}" is recorded on-chain. Live option totals remain hidden until this poll closes.
          </div>
        )}
      </div>

      {(canVote || canAggregate || canFinalizeShards || canMergeShards || canClose || canForceClose || canRefundClosedIntent || canRefundLateIntent) && (
        <div className="poll-action-row flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          {confirmingForceClose ? (
            <div className="w-full">
              <div className="mb-2 text-sm" style={{ color: "var(--ink-2)" }}>
                This will close the poll and return included close-time deposits only. Extra live intent deposits stay recoverable through post-close omitted-intent refund.
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <button
                  onClick={() => {
                    void handleForceClose();
                  }}
                  disabled={isBusy}
                  title="Confirm the permissionless force-close transaction"
                  className="btn-danger w-full sm:w-auto"
                >
                  {activeAction === "forceClose" && <span className="button-spinner" aria-hidden="true" />}
                  {activeAction === "forceClose" ? "Force-closing..." : "Confirm Force Close"}
                </button>
                <button
                  onClick={() => setConfirmingForceClose(false)}
                  disabled={isBusy}
                  title="Return without force-closing this poll"
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
                    requestConfirmation({
                      title: "Confirm Vote Intent Submission",
                      message: `You are about to record a vote intent for "${poll.options[selected]}". Once recorded on-chain, this intent cannot be changed for this poll.${selectedAuthority?.mode === "delegation" ? " Testnet v1 uses your wallet to fund the intent capacity and refunds that capacity to the represented delegator." : ""}`,
                      confirmLabel: "Confirm Intent",
                      execute: handleVote,
                    });
                  }}
                  disabled={selected === null || isBusy}
                  title={selected === null ? "Choose an option before submitting" : "Review and submit this immutable vote intent"}
                  className="btn-primary w-full sm:min-w-[220px] sm:flex-1"
                >
                  {activeAction === "vote" && <span className="button-spinner" aria-hidden="true" />}
                  {activeAction === "vote"
                    ? "Submitting intent..."
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
                      message: `This transaction processes up to ${MAX_INTENTS_PER_AGG.toString()} authenticated timely intents from one deterministic tally lane. Different lanes cannot be combined in the same aggregation transaction. It remains valid after the deadline until that lane is finalized.`,
                      confirmLabel: aggregationActionLabel,
                      execute: handleAggregate,
                    });
                  }}
                  disabled={isBusy}
                  title={aggregationActionTitle}
                  className={`${isCreator ? "btn-primary" : "btn-quiet"} w-full sm:w-auto`}
                >
                  {activeAction === "aggregate" && <span className="button-spinner" aria-hidden="true" />}
                  {activeAction === "aggregate" ? "Aggregating..." : aggregationActionLabel}
                </button>
              )}

              {/* Flow: one remaining lane uses the single-lane builder; larger
                  sets use explicitly signed batches of at most eight lanes. */}
              {canFinalizeShards && remainingShardCount === 1 && (
                <button
                  onClick={() => {
                    void prepareFinalizationConfirmation("single");
                  }}
                  disabled={isBusy}
                  title="Check indexed intents, then prepare the last tally lane for finalization"
                  className="btn-quiet w-full sm:w-auto"
                >
                  {(activeAction === "finalize" || finalizationCheckInFlight) && (
                    <span className="button-spinner" aria-hidden="true" />
                  )}
                  {finalizationCheckInFlight
                    ? "Checking intents..."
                    : activeAction === "finalize"
                      ? "Finalizing..."
                      : "Finalize Last Lane"}
                </button>
              )}

              {canFinalizeShards && remainingShardCount > 1 && (
                <button
                  onClick={() => {
                    void prepareFinalizationConfirmation("remaining");
                  }}
                  disabled={isBusy}
                  title={`Check indexed intents, then prepare ${remainingShardCount.toString()} ordered lanes for ${finalizeTransactionCount.toString()} finalization transaction${finalizeTransactionCount === 1 ? "" : "s"}`}
                  className="btn-primary w-full sm:w-auto"
                >
                  {(activeAction === "finalize" || finalizationCheckInFlight) && (
                    <span className="button-spinner" aria-hidden="true" />
                  )}
                  {finalizationCheckInFlight
                    ? "Checking intents..."
                    : activeAction === "finalize"
                      ? `Finalizing ${remainingShardCount.toString()} lanes...`
                      : "Finalize Lanes"}
                </button>
              )}

              {canMergeShards && (
                <button
                  onClick={() => {
                    requestConfirmation({
                      title: "Confirm Shard Merge",
                      message: "This creates or advances a bounded tally merge result for a large sharded poll. Final close requires one complete merge result. Any connected wallet with enough CKB can run merge maintenance.",
                      confirmLabel: "Merge Shards",
                      execute: handleMergeShards,
                    });
                  }}
                  disabled={isBusy}
                  title="Merge finalized tally coverage toward a closeable result"
                  className="btn-quiet w-full sm:w-auto"
                >
                  {activeAction === "merge" && <span className="button-spinner" aria-hidden="true" />}
                  {activeAction === "merge" ? "Merging..." : "Merge Shards"}
                </button>
              )}

              {canClose && (
                <button
                  onClick={() => {
                    requestConfirmation({
                      title: "Confirm Close Poll",
                      message: `This will close the poll and return only the included close-time deposits, capped by the frontend at ${MAX_CLOSE_INTENT_REFUNDS.toString()} intent refunds. Omitted live intent deposits can be recovered afterward through post-close omitted-intent refund.`,
                      confirmLabel: "Close Poll",
                      execute: handleClose,
                    });
                  }}
                  disabled={isBusy}
                  title="Close this ready poll using creator authorization"
                  className="btn-quiet w-full sm:w-auto"
                >
                  {activeAction === "close" && <span className="button-spinner" aria-hidden="true" />}
                  {activeAction === "close" ? "Closing..." : "Close Poll (creator auth)"}
                </button>
              )}

              {canForceClose && (
                <button
                  onClick={() => setConfirmingForceClose(true)}
                  disabled={isBusy}
                  title="Prepare a permissionless close after the grace period"
                  className="btn-danger w-full sm:w-auto"
                >
                  Force Close (permissionless)
                </button>
              )}

              {canRefundClosedIntent && (
                <button
                  onClick={() => {
                    requestConfirmation({
                      title: "Refund Closed-Poll Intent",
                      message: "This consumes one omitted intent after poll close and returns its capacity to the encoded refund lock. It does not change the final tally.",
                      confirmLabel: "Refund Intent",
                      execute: handleRefundClosedIntent,
                    });
                  }}
                  disabled={isBusy}
                  title="Return one omitted closed-poll intent deposit"
                  className="btn-quiet w-full sm:w-auto"
                >
                  {activeAction === "refundClosed" && <span className="button-spinner" aria-hidden="true" />}
                  {activeAction === "refundClosed" ? "Refunding..." : "Refund Omitted Intent"}
                </button>
              )}

              {canRefundLateIntent && (
                <button
                  onClick={() => {
                    requestConfirmation({
                      title: "Refund Late Intent",
                      message: "This consumes one intent whose authenticated creation epoch is after the deadline and returns its exact full capacity to the encoded refund lock.",
                      confirmLabel: "Refund Late Intent",
                      execute: handleRefundLateIntent,
                    });
                  }}
                  disabled={isBusy}
                  title="Return one intent committed after the poll deadline"
                  className="btn-quiet w-full sm:w-auto"
                >
                  {activeAction === "refundLate" && <span className="button-spinner" aria-hidden="true" />}
                  {activeAction === "refundLate" ? "Refunding..." : "Refund Late Intent"}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {(scopedTxState && scopedTxState.status !== "idle") || localError ? (
        <div className="poll-transaction-feedback">
          {scopedTxState?.batch && (
            <div className="mb-2 text-xs subtle">
              {scopedTxState.batch.label}: {scopedTxState.batch.completed.toString()} of{" "}
              {scopedTxState.batch.total.toString()} lanes confirmed. Each batch of up to {MAX_SHARDS_PER_FINALIZE.toString()} lanes is signed once.
            </div>
          )}
          {lastCompletedAction === "aggregate" && scopedTxState?.status === "success" && (
            <div className="mb-2 text-xs" style={{ color: "var(--teal)" }}>
              {poll.aggregationBatchCount > 0
                ? `Aggregation batch confirmed. About ${poll.aggregationBatchCount.toString()} indexed batch${poll.aggregationBatchCount === 1 ? "" : "es"} remain.`
                : "Aggregation batch confirmed. No further indexed aggregation batches remain."}
            </div>
          )}
          {scopedTxState && scopedTxState.status !== "idle" && (
            <TxStatus txState={scopedTxState} />
          )}
          {localError && (
            <div className="mt-2 text-sm" style={{ color: "var(--red)" }}>
              <div>{localError}</div>
              {localError.toLowerCase().includes("insufficient ckb balance") && (
                <a
                  href="https://faucet.nervos.org/"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open the Nervos CKB testnet faucet"
                  style={{ marginTop: 4, display: "inline-block", color: "var(--teal)", textDecoration: "underline" }}
                >
                  Open Nervos testnet faucet
                </a>
              )}
            </div>
          )}
        </div>
      ) : null}

      <div className="poll-lifecycle-details">
        <div className="poll-details-heading">Lifecycle and tally details</div>
        <div className="poll-detail-list">
          <div className="poll-detail-row">
            <div className="poll-detail-label">Timing</div>
            <div>
              Created {hasCreatedEpoch ? `in epoch ${createdEpoch.toString()}` : "at an epoch unavailable from the indexer"}.
              {hasCreatedEpoch ? ` Time passed: ${formatApproxEpochDuration(elapsedSinceCreated)}.` : ""}
              {!isExpired
                ? ` Estimated time until close can begin: ${formatApproxWallClockDuration(estimatedCloseHours)}.`
                : ` Time passed since deadline: ${formatApproxEpochDuration(epochsPastDeadline)}.`}
            </div>
          </div>

          {!poll.isClosed && votingSupported && (
            <div className="poll-detail-row">
              <div className="poll-detail-label">Vote recording</div>
              <div>Submitting intent records your choice now; tally updates after aggregation.</div>
            </div>
          )}

          {!poll.isClosed && isCreator && (
            <div className="poll-detail-row">
              <div className="poll-detail-label">Creator lifecycle</div>
              <div>
                {votingSupported
                  ? "Creator close is available after the deadline when tally state is ready. Tally-lane aggregation, finalization, merge, force-close after grace, and omitted-intent refunds are maintenance actions any connected wallet can run with enough CKB."
                  : "Creator close remains available after the deadline when recovery state is ready. Finalization, merge, force-close after grace, and omitted-intent refunds remain recovery actions; aggregation is disabled."}
              </div>
            </div>
          )}

          {!poll.isClosed && (
            <div className="poll-detail-row">
              <div className="poll-detail-label">Close window</div>
              <div>
                {!isExpired
                  ? `Close becomes valid after deadline (epoch > ${poll.deadline.toString()}). Permissionless force-close opens once epoch > ${forceCloseGraceEndEpoch.toString()}.`
                  : !forceCloseOpen
                    ? `Creator-auth close is active now. Permissionless force-close opens once epoch > ${forceCloseGraceEndEpoch.toString()}.`
                    : "The grace period has elapsed. Anyone can force-close now so deposits are not locked indefinitely."}
              </div>
            </div>
          )}

          {poll.shardCount > 0 && (
            <div className="poll-detail-row">
              <div className="poll-detail-label">Tally lanes</div>
              <div>
                {poll.isClosed ? (
                  <>
                    Closed over {poll.shardCount.toString()} lanes. The close transaction consumed the
                    lane cells, so none remain indexed.
                  </>
                ) : (
                  <>
                    Indexed: {indexedShardCount.toString()}/{poll.shardCount.toString()}; finalized: {finalizedShardCount.toString()}/{poll.shardCount.toString()}.
                    {missingShardCount > 0 ? ` Missing lanes: ${missingShardCount.toString()}.` : ""}
                    {mergeResultCount > 0 ? ` Merge results indexed: ${mergeResultCount.toString()}.` : ""}
                  </>
                )}
              </div>
            </div>
          )}

          <div className="poll-detail-row">
            <div className="poll-detail-label">Displayed tally</div>
            <div>
              <div className="poll-tally-summary">
                <strong>{tallySourceLabel(poll.tallyFrontier.source)}</strong>
                <span>{tallyCoverageText}</span>
              </div>
              <div className="mt-1">{tallySourceDescription}</div>
              {poll.tallyFrontier.source === "merge-frontier" && (
                <div className="mt-1">
                  Merge results used: {poll.tallyFrontier.selectedMergeResultIds.length.toString()}; live tally lanes used: {poll.tallyFrontier.selectedShardIds.length.toString()}.
                </div>
              )}
              {poll.shardCount > 0 && !tallyCoverageComplete && (
                <div className="mt-1" style={{ color: "var(--amber)" }}>
                  This display is partial: {poll.tallyFrontier.coveredShardCount.toString()}/{poll.tallyFrontier.shardCount.toString()} tally lanes are covered by indexed lane or merge cells.
                  {uncoveredPreview ? ` Uncovered lane ids: ${uncoveredPreview}${uncoveredSuffix}.` : ""}
                </div>
              )}
              {!canDescribeTallyAsFinal && tallyCoverageComplete && (
                <div className="mt-1 subtle">
                  Indexed tally coverage is complete, but the result is not final until lifecycle close readiness or poll closure.
                </div>
              )}
            </div>
          </div>

          {poll.pendingIntentCount > 0n && (
            <div className="poll-detail-row poll-detail-warning">
              <div className="poll-detail-label">Pending intents</div>
              <div>
                {votingSupported
                  ? "Timely pending intents may be aggregated after the deadline until their tally lane is finalized."
                  : "Pending weighted intents cannot be aggregated by this deployment. Finalize and close the poll to make omitted intent capacity recoverable."}
              </div>
            </div>
          )}

          {!poll.isClosed && poll.lateIntentCount > 0 && (
            <div className="poll-detail-row poll-detail-warning">
              <div className="poll-detail-label">Late intents</div>
              <div>{poll.lateIntentCount.toString()} intent(s) were committed after the deadline. They cannot count and are eligible for full-capacity refund.</div>
            </div>
          )}

          {isExpired && poll.shardCount > 0 && !directCloseTooLarge && !allShardsFinalized && (
            <div className="poll-detail-row poll-detail-warning">
              <div className="poll-detail-label">Close readiness</div>
              <div>Close is disabled until every indexed tally lane is finalized. Finalization freezes its tally state for close.</div>
            </div>
          )}

          {isExpired && poll.shardCount > 0 && poll.pendingIntentCount > 0n && (
            <div className="poll-detail-row poll-detail-warning">
              <div className="poll-detail-label">Completeness warning</div>
              <div>Pending intents are still indexed. Finalizing can leave them uncounted; they remain refundable after close.</div>
            </div>
          )}

          {isExpired && directCloseTooLarge && (
            <div className={`poll-detail-row ${hasCompleteMergeResult ? "" : "poll-detail-warning"}`}>
              <div className="poll-detail-label">Merge requirement</div>
              <div>
                Direct close is limited to {MAX_DIRECT_CLOSE_SHARDS.toString()} tally lanes.
                {hasCompleteMergeResult
                  ? " A complete merge result is indexed, so close can use the merge-result path."
                  : " This poll requires a complete merge result before close."}
              </div>
            </div>
          )}

          {poll.isClosed && poll.refundableIntentCount > 0 && (
            <div className="poll-detail-row poll-detail-warning">
              <div className="poll-detail-label">Omitted refunds</div>
              <div>Omitted live intent cells remain indexed. Post-close refund returns capacity to each encoded refund lock and does not change the final tally.</div>
            </div>
          )}
        </div>
      </div>
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
