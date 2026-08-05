/**
 * usePolls Hook
 * =============
 * Indexes governance poll and intent cells and exposes transaction flows that
 * follow the contract's sharded lifecycle, including off-chain duplicate
 * intent checks and delegated voting authority discovery.
 */

import { startTransition, useCallback, useMemo, useRef, useState } from "react";
import { ccc } from "@ckb-ccc/core";
import {
  buildAggregateTallyShardTx,
  buildClosePollTx,
  buildForceCloseTx,
  buildFinalizeTallyShardTx,
  buildFinalizeTallyShardsTx,
  buildMergeTallyShardsTx,
  buildCreatePollTx,
  buildCreateVoteIntentTx,
  buildDelegateTx,
  buildGovernanceTypeScript,
  buildRefundClosedIntentTx,
  buildRefundLateIntentTx,
  buildRevokeDelegationTx,
  deriveTallyShardId,
  epochNumber,
  getTipEpoch,
  getSignerLockHashHex,
  hashScript,
  MAX_DIRECT_CLOSE_SHARDS,
  MAX_INTENTS_PER_AGG,
  MAX_SHARDS_PER_FINALIZE,
  MAX_SHARDS_PER_MERGE,
  OP,
  signAndSendTx,
  validateCreatePollInput,
} from "../lib/ckb";
import {
  bytesToHex,
  decodeDelegationData,
  decodePollData,
  decodeTallyMergeResultData,
  decodeTallyShardData,
  decodeVoteIntentData,
} from "../lib/molecule";
import {
  DelegateParams,
  DelegationRecord,
  Poll,
  TallyMergeResult,
  TallyShard,
  TxScope,
  TxState,
  VoteIntent,
} from "../lib/types";
import {
  computeCanonicalTallyFrontier,
  deriveVoteAuthorityOptions,
  selectCloseTimeIntentRefunds,
  tallyMergeCoverageComplete,
} from "../lib/protocolUi";
import {
  createContextAwareRequestGate,
  createTransactionExclusionGuard,
  monitorSubmittedTransaction,
  TransactionUnconfirmedError,
} from "../lib/txLifecycle";

export interface CreatePollParams {
  question: string;
  options: string[];
  durationEpochs: number;
}

export interface CastVoteParams {
  poll: Poll;
  optionIndex: number;
  authorityId?: string;
}

async function resolveCellCreatedEpoch(
  client: any,
  cell: any
): Promise<bigint | null> {
  try {
    const resolved = await client.getCellWithHeader(cell.outPoint);
    const header = resolved?.header;
    return header?.epoch == null ? null : epochNumber(header.epoch);
  } catch {
    return null;
  }
}

function coverageDisjoint(a: Uint8Array, b: Uint8Array): boolean {
  for (let index = 0; index < a.length; index += 1) {
    if ((a[index] & b[index]) !== 0) return false;
  }
  return true;
}

function coverageSetShard(coverage: Uint8Array, shardId: number): void {
  coverage[Math.floor(shardId / 8)] |= 1 << (shardId % 8);
}

function coverageCount(coverage: Uint8Array): number {
  return coverage.reduce((sum, byte) => sum + byte.toString(2).replace(/0/g, "").length, 0);
}

function coverageAddsMissing(selected: Uint8Array, candidate: Uint8Array, shardCount: number): boolean {
  for (let shardId = 0; shardId < shardCount; shardId += 1) {
    const mask = 1 << (shardId % 8);
    const byteIndex = Math.floor(shardId / 8);
    if ((selected[byteIndex] & mask) === 0 && (candidate[byteIndex] & mask) !== 0) {
      return true;
    }
  }
  return false;
}

function buildCloseIntentRefundSelection(input: {
  cells: any[];
  pollId: string;
  trackedPendingLowerBound: bigint;
}) {
  const candidates = input.cells.map((cell) => {
    const decoded = decodeVoteIntentData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
    return {
      cell,
      pollTypeHash: bytesToHex(decoded.poll_type_hash),
      aggregated: decoded.aggregated,
      sortKey: `${cell.outPoint.txHash}:${Number(cell.outPoint.index)}`,
    };
  });

  return selectCloseTimeIntentRefunds(candidates, {
    pollTypeHash: input.pollId,
    trackedPendingLowerBound: input.trackedPendingLowerBound,
  });
}

interface PollFetchContext {
  client: any;
  signer: any | null;
  viewerLockHash: string | null;
}

export function usePolls(
  signer: any | null,
  readClient: any | null = signer?.client ?? null,
  viewerLockHash: string | null = null
) {
  const [polls, setPolls] = useState<Poll[]>([]);
  const [intents, setIntents] = useState<Record<string, VoteIntent[]>>({});
  const [delegations, setDelegations] = useState<DelegationRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [txState, setTxState] = useState<TxState>({
    status: "idle",
    txHash: null,
    error: null,
    scope: null,
    batch: null,
  });
  const [actionInFlight, setActionInFlight] = useState(false);
  const trackedTxHashRef = useRef<string | null>(null);
  // Hook-level mutual exclusion for every state-changing action.
  //
  // Scoping the *rendered* transaction status per surface removed the
  // accidental global lock that a single shared busy flag used to provide, so
  // this restores it explicitly. Held for the whole of a multi-transaction run
  // (batch lane finalization) so no other action can spend the wallet change
  // cell or overwrite `trackedTxHashRef` mid-sequence.
  const [exclusionGuard] = useState(createTransactionExclusionGuard);
  const [fetchGate] = useState(() =>
    createContextAwareRequestGate<PollFetchContext>(
      (left, right) =>
        left.client === right.client &&
        left.signer === right.signer &&
        left.viewerLockHash === right.viewerLockHash
    )
  );
  const hasLoadedRef = useRef(false);
  const [pollCells, setPollCells] = useState<Record<string, any>>({});
  const [intentCells, setIntentCells] = useState<Record<string, any[]>>({});
  const [tallyShardCells, setTallyShardCells] = useState<Record<string, any[]>>({});
  const [tallyMergeResultCells, setTallyMergeResultCells] = useState<Record<string, any[]>>({});
  const [delegationCells, setDelegationCells] = useState<Record<string, any>>({});

  const fetchPolls = useCallback((): Promise<void> => {
    const client = signer?.client ?? readClient;
    if (!client) return Promise.resolve();

    return fetchGate.run({ client, signer, viewerLockHash }, async () => {
      const isInitialLoad = !hasLoadedRef.current;
      if (isInitialLoad) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      setLoadError(null);

      try {
      const pollScript = buildGovernanceTypeScript(OP.CREATE_POLL);
      const nextPolls: Poll[] = [];
      const nextIntents: Record<string, VoteIntent[]> = {};
      const nextIntentCells: Record<string, any[]> = {};
      const nextPollCells: Record<string, any> = {};
      const nextTallyShardCells: Record<string, any[]> = {};
      const nextTallyShards: Record<string, TallyShard[]> = {};
      const nextTallyMergeResultCells: Record<string, any[]> = {};
      const nextTallyMergeResults: Record<string, TallyMergeResult[]> = {};
      const currentLockHashHex = signer
        ? viewerLockHash ?? await getSignerLockHashHex(signer)
        : null;

      for await (const cell of client.findCells({
        script: pollScript,
        scriptType: "type",
        scriptSearchMode: "prefix",
      })) {
        try {
          const pollBytes = (ccc as any).bytesFrom(cell.outputData ?? "0x");
          const pollData = decodePollData(pollBytes);
          if (pollData.shard_count <= 0) {
            console.warn("Ignoring retired non-sharded poll cell", cell.outPoint);
            continue;
          }
          const pollId = hashScript(cell.cellOutput?.type ?? cell.output?.type);
          const voteCounts = pollData.vote_counts;
          const totalVotes = voteCounts.reduce((sum, count) => sum + count, 0n);
          const createdEpoch = await resolveCellCreatedEpoch(
            client,
            cell
          );
          nextPollCells[pollId] = cell;

          nextPolls.push({
            id: pollId,
            outPoint: {
              txHash: cell.outPoint.txHash,
              index: Number(cell.outPoint.index),
            },
            question: pollData.question,
            options: pollData.options,
            voteCounts,
            createdEpoch,
            deadline: pollData.deadline,
            creator: bytesToHex(pollData.creator),
            isClosed: pollData.is_closed,
            totalVoters: pollData.total_voters,
            creatorDeposit: pollData.creator_deposit,
            pendingIntentCount: pollData.pending_intent_count,
            protocolPendingIntentCount: pollData.pending_intent_count,
            tokenWeighted: pollData.token_weighted,
            udtTypeHash: bytesToHex(pollData.udt_type_hash),
            shardCount: pollData.shard_count,
            tallyShards: [],
            tallyMergeResults: [],
            tallyFrontier: {
              source: pollData.is_closed ? "closed-poll" : "live-shards",
              coveredShardCount: 0,
              shardCount: pollData.shard_count,
              coverageComplete: false,
              selectedMergeResultIds: [],
              selectedShardIds: [],
              uncoveredShardIds: pollData.shard_count > 0
                ? Array.from({ length: pollData.shard_count }, (_, shardId) => shardId)
                : [],
            },
            totalVotes,
            authorityOptions: [],
            outstandingIntentCount: 0,
            lateIntentCount: 0,
            refundableIntentCount: 0,
          });

          nextIntents[pollId] = [];
          nextTallyShardCells[pollId] = [];
          nextTallyShards[pollId] = [];
          nextTallyMergeResultCells[pollId] = [];
          nextTallyMergeResults[pollId] = [];
        } catch (error) {
          console.warn("Failed to decode poll cell", error);
        }
      }

      for (const poll of nextPolls) {
        const tallyShardScript = buildGovernanceTypeScript(OP.CREATE_TALLY_SHARD, poll.id);
        for await (const cell of client.findCells({
          script: tallyShardScript,
          scriptType: "type",
          scriptSearchMode: "prefix",
        })) {
          try {
            const shardBytes = (ccc as any).bytesFrom(cell.outputData ?? "0x");
            const shardData = decodeTallyShardData(shardBytes);
            if (bytesToHex(shardData.poll_type_hash).toLowerCase() !== poll.id.toLowerCase()) {
              continue;
            }

            nextTallyShardCells[poll.id].push(cell);
            nextTallyShards[poll.id].push({
              id: `${cell.outPoint.txHash}:${cell.outPoint.index}`,
              pollId: poll.id,
              outPoint: {
                txHash: cell.outPoint.txHash,
                index: Number(cell.outPoint.index),
              },
              shardId: shardData.shard_id,
              shardCount: shardData.shard_count,
              voteCounts: shardData.vote_counts,
              totalVoters: shardData.total_voters,
              countedVoterRoot: bytesToHex(shardData.counted_voter_root),
              finalized: shardData.finalized,
              capacity: BigInt(cell.cellOutput?.capacity ?? cell.output?.capacity ?? 0),
            });
          } catch (error) {
            console.warn("Failed to decode tally shard cell", error);
          }
        }

        const pollShards = nextTallyShards[poll.id] ?? [];
        poll.tallyShards = pollShards;

        const mergeScript = buildGovernanceTypeScript(OP.MERGE_TALLY_SHARDS, poll.id);
        for await (const cell of client.findCells({
          script: mergeScript,
          scriptType: "type",
          scriptSearchMode: "exact",
        })) {
          try {
            const resultBytes = (ccc as any).bytesFrom(cell.outputData ?? "0x");
            const resultData = decodeTallyMergeResultData(resultBytes);
            if (bytesToHex(resultData.poll_type_hash).toLowerCase() !== poll.id.toLowerCase()) {
              continue;
            }
            nextTallyMergeResultCells[poll.id].push(cell);
            nextTallyMergeResults[poll.id].push({
              id: `${cell.outPoint.txHash}:${cell.outPoint.index}`,
              pollId: poll.id,
              outPoint: {
                txHash: cell.outPoint.txHash,
                index: Number(cell.outPoint.index),
              },
              coverage: bytesToHex(resultData.coverage),
              voteCounts: resultData.vote_counts,
              totalVoters: resultData.total_voters,
              mergeLevel: resultData.merge_level,
              version: resultData.version,
              capacity: BigInt(cell.cellOutput?.capacity ?? cell.output?.capacity ?? 0),
            });
          } catch (error) {
            console.warn("Failed to decode tally merge result cell", error);
          }
        }
        poll.tallyMergeResults = nextTallyMergeResults[poll.id] ?? [];

        const tallyFrontier = computeCanonicalTallyFrontier({
          optionCount: poll.options.length,
          shardCount: poll.shardCount,
          pollVoteCounts: poll.voteCounts,
          pollTotalVoters: poll.totalVoters,
          pollIsClosed: poll.isClosed,
          shards: poll.tallyShards,
          mergeResults: poll.tallyMergeResults,
        });
        poll.voteCounts = tallyFrontier.voteCounts;
        poll.totalVoters = tallyFrontier.totalVoters;
        poll.totalVotes = tallyFrontier.totalVotes;
        poll.tallyFrontier = {
          source: tallyFrontier.source,
          coveredShardCount: tallyFrontier.coveredShardCount,
          shardCount: tallyFrontier.shardCount,
          coverageComplete: tallyFrontier.coverageComplete,
          selectedMergeResultIds: tallyFrontier.selectedMergeResultIds,
          selectedShardIds: tallyFrontier.selectedShardIds,
          uncoveredShardIds: tallyFrontier.uncoveredShardIds,
        };

        const intentScript = buildGovernanceTypeScript(OP.CREATE_VOTE_INTENT, poll.id);
        const nextIntentCellsForPoll: any[] = [];
        for await (const cell of client.findCells({
          script: intentScript,
          scriptType: "type",
          scriptSearchMode: "exact",
        })) {
          try {
            const intentBytes = (ccc as any).bytesFrom(cell.outputData ?? "0x");
            if (intentBytes.length < 74) continue;

            const intentData = decodeVoteIntentData(intentBytes);
            const createdEpoch = await resolveCellCreatedEpoch(client, cell);
            nextIntentCellsForPoll.push(cell);
            nextIntents[poll.id].push({
              id: `${cell.outPoint.txHash}:${cell.outPoint.index}`,
              pollId: poll.id,
              outPoint: {
                txHash: cell.outPoint.txHash,
                index: Number(cell.outPoint.index),
              },
              voterLockHash: bytesToHex(intentData.voter_lock_hash),
              optionIndex: intentData.option_index,
              votedAtEpoch: intentData.voted_at_epoch,
              createdEpoch,
              aggregated: intentData.aggregated,
              capacity: BigInt(cell.cellOutput?.capacity ?? cell.output?.capacity ?? 0),
            });
          } catch (error) {
            console.warn("Failed to decode intent cell", error);
          }
        }

        nextIntentCells[poll.id] = nextIntentCellsForPoll;
      }

      const nextDelegations: DelegationRecord[] = [];
      const nextDelegationCells: Record<string, any> = {};
      const delegationScript = buildGovernanceTypeScript(OP.DELEGATE);

      if (currentLockHashHex) {
        for await (const cell of client.findCells({
          script: delegationScript,
          scriptType: "type",
          scriptSearchMode: "prefix",
        })) {
          try {
            const delegationBytes = (ccc as any).bytesFrom(cell.outputData ?? "0x");
            if (delegationBytes.length !== 104) continue;

            const delegation = decodeDelegationData(delegationBytes);
            const delegatorLockHash = bytesToHex(delegation.delegator_lock_hash);
            const delegateLockHash = bytesToHex(delegation.delegate_lock_hash);

            if (
              delegatorLockHash !== currentLockHashHex &&
              delegateLockHash !== currentLockHashHex
            ) {
              continue;
            }

            const id = `${cell.outPoint.txHash}:${cell.outPoint.index}`;
            nextDelegationCells[id] = cell;
            nextDelegations.push({
              id,
              outPoint: {
                txHash: cell.outPoint.txHash,
                index: Number(cell.outPoint.index),
              },
              delegatorLockHash,
              delegateLockHash,
              pollId:
                bytesToHex(delegation.poll_type_hash) === `0x${"00".repeat(32)}`
                  ? null
                  : bytesToHex(delegation.poll_type_hash),
              expiresEpoch: delegation.expires_epoch,
              capacity: BigInt((cell.cellOutput ?? cell.output).capacity),
              isDelegator: delegatorLockHash === currentLockHashHex,
            });
          } catch (error) {
            console.warn("Failed to decode delegation cell", error);
          }
        }
      }

      for (const poll of nextPolls) {
        const pollIntents = nextIntents[poll.id] ?? [];
        const pendingPollIntents = pollIntents.filter((intent) => !intent.aggregated);
        const timelyPendingIntents = pendingPollIntents.filter(
          (intent) => intent.createdEpoch !== null && intent.createdEpoch <= poll.deadline
        );
        const latePendingIntents = pendingPollIntents.filter(
          (intent) => intent.createdEpoch !== null && intent.createdEpoch > poll.deadline
        );
        poll.authorityOptions = deriveVoteAuthorityOptions({
          poll,
          intents: pollIntents,
          delegations: nextDelegations,
          viewerLockHash: currentLockHashHex,
        });
        // UI action gates should follow indexer-observed pending intents until
        // poll.pending_intent_count is promoted to strict on-chain accounting.
        poll.pendingIntentCount = BigInt(timelyPendingIntents.length);
        poll.outstandingIntentCount = timelyPendingIntents.length;
        poll.lateIntentCount = latePendingIntents.length;
        poll.refundableIntentCount = pollIntents.length;
      }

        startTransition(() => {
          setPolls(nextPolls);
          setIntents(nextIntents);
          setPollCells(nextPollCells);
          setIntentCells(nextIntentCells);
          setTallyShardCells(nextTallyShardCells);
          setTallyMergeResultCells(nextTallyMergeResultCells);
          setDelegations(nextDelegations);
          setDelegationCells(nextDelegationCells);
        });
      } catch (error: any) {
        setLoadError(error?.message ?? String(error));
      } finally {
        hasLoadedRef.current = true;
        setLoading(false);
        setRefreshing(false);
      }
    });
  }, [fetchGate, readClient, signer, viewerLockHash]);

  /**
   * Wraps one state-changing action in the hook-level exclusion guard.
   *
   * Applied once, at the hook boundary, so every exported action is covered by
   * construction rather than by each action remembering to take the lock. A
   * second invocation while any action is active — including one started from a
   * different surface — rejects with `ConcurrentTransactionError` before the
   * builder runs.
   */
  const guardExclusive = useCallback(
    <A extends unknown[], R>(action: (...args: A) => Promise<R>) =>
      exclusionGuard.guard(async (...args: A): Promise<R> => {
        setActionInFlight(true);
        try {
          return await action(...args);
        } finally {
          setActionInFlight(false);
        }
      }),
    [exclusionGuard]
  );

  const trackSubmittedTransaction = useCallback(
    async (txHash: string): Promise<void> => {
      if (!signer) return;
      // `trackedTxHashRef` decides which transaction may write terminal status.
      // Only one guarded action runs at a time, so nothing can overwrite it
      // while an earlier transaction is still being monitored; assert that
      // invariant rather than trusting call sites to preserve it.
      if (!exclusionGuard.isHeld()) {
        throw new Error(
          "Transaction tracking must run inside the hook's exclusion guard"
        );
      }

      trackedTxHashRef.current = txHash;
      setTxState((prev) => ({ ...prev, status: "confirming", txHash, error: null }));
      const outcome = await monitorSubmittedTransaction({
        client: signer.client,
        txHash,
        onCommitted: async () => {
          if (trackedTxHashRef.current === txHash) {
            setTxState((prev) => ({ ...prev, status: "success", txHash, error: null }));
          }
          await fetchPolls();
        },
        onUnconfirmed: (error) => {
          if (trackedTxHashRef.current === txHash) {
            setTxState((prev) => ({ ...prev, status: "unconfirmed", txHash, error: error.message }));
          }
        },
      });
      if (outcome === "unconfirmed") {
        throw new TransactionUnconfirmedError(txHash);
      }
    },
    [exclusionGuard, fetchPolls, signer]
  );

  const createPoll = useCallback(
    async (params: CreatePollParams) => {
      if (!signer) throw new Error("Wallet not connected");

      const validationError = validateCreatePollInput(params);
      if (validationError) throw new Error(validationError);

      setTxState({ status: "building", txHash: null, error: null, scope: { kind: "createPoll" }, batch: null });
      try {
        // Duration is a builder/UI policy. The transaction commits the exact
        // absolute epoch chosen from this observed tip; the VM cannot prove an
        // output transaction's eventual inclusion epoch.
        const observedEpoch = await getTipEpoch(signer.client);
        const tx = await buildCreatePollTx(signer, {
          ...params,
          deadlineEpoch: observedEpoch + BigInt(params.durationEpochs),
        });
        setTxState((prev) => ({ ...prev, status: "signing", txHash: null, error: null }));
        const txHash = await signAndSendTx(signer, tx);
        await trackSubmittedTransaction(txHash);

        return txHash;
      } catch (error: any) {
        if (!(error instanceof TransactionUnconfirmedError)) {
          setTxState((prev) => ({ ...prev, status: "error", txHash: null, error: error.message ?? String(error) }));
        }
        throw error;
      }
    },
    [signer, trackSubmittedTransaction]
  );

  const castVote = useCallback(
    async ({ poll, optionIndex, authorityId }: CastVoteParams) => {
      if (!signer) throw new Error("Wallet not connected");
      if (poll.tokenWeighted) {
        throw new Error("Weighted polls are unsupported; only recovery actions are available");
      }

      const selectedAuthority =
        poll.authorityOptions.find((authority) => authority.id === (authorityId ?? "self")) ??
        poll.authorityOptions[0];

      if (!selectedAuthority) throw new Error("No voting authority is available for this poll");
      if (selectedAuthority.hasAggregatedIntent) {
        throw new Error("This voting authority already has an aggregated vote intent for the poll");
      }
      if (selectedAuthority.hasIntent) {
        throw new Error("This voting authority already has an indexed intent for the poll");
      }

      const delegationCell =
        selectedAuthority.delegationId !== null
          ? delegationCells[selectedAuthority.delegationId]
          : undefined;
      const pollCell = pollCells[poll.id];
      if (!pollCell) throw new Error("Poll cell is not currently indexed");

      setTxState({ status: "building", txHash: null, error: null, scope: { kind: "poll", pollId: poll.id }, batch: null });
      try {
        const tx = await buildCreateVoteIntentTx(signer, {
          pollTypeHash: poll.id,
          optionIndex,
          pollCell,
          delegationCell,
        });
        setTxState((prev) => ({ ...prev, status: "signing", txHash: null, error: null }));
        const txHash = await signAndSendTx(signer, tx);
        await trackSubmittedTransaction(txHash);

        return txHash;
      } catch (error: any) {
        if (!(error instanceof TransactionUnconfirmedError)) {
          setTxState((prev) => ({ ...prev, status: "error", txHash: null, error: error.message ?? String(error) }));
        }
        throw error;
      }
    },
    [delegationCells, pollCells, signer, trackSubmittedTransaction]
  );

  const closePoll = useCallback(
    async (poll: Poll) => {
      if (!signer) throw new Error("Wallet not connected");

      const pollCell = pollCells[poll.id];
      if (!pollCell) throw new Error("Poll cell is not currently indexed");

      const indexedShardCells = tallyShardCells[poll.id] ?? [];
      const finalMergeResultCell = (tallyMergeResultCells[poll.id] ?? []).find((cell) => {
        const result = decodeTallyMergeResultData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
        return tallyMergeCoverageComplete(result.coverage, poll.shardCount);
      });

      setTxState({ status: "building", txHash: null, error: null, scope: { kind: "poll", pollId: poll.id }, batch: null });
      try {
        const closeIntentSelection = buildCloseIntentRefundSelection({
          cells: intentCells[poll.id] ?? [],
          pollId: poll.id,
          trackedPendingLowerBound: poll.protocolPendingIntentCount,
        });
        const tx = await buildClosePollTx(signer, {
          pollCell,
          intentCells: closeIntentSelection.included.map((candidate) => candidate.cell),
          shardCells: poll.shardCount > MAX_DIRECT_CLOSE_SHARDS ? [] : indexedShardCells,
          mergeResultCell: finalMergeResultCell,
        });
        setTxState((prev) => ({ ...prev, status: "signing", txHash: null, error: null }));
        const txHash = await signAndSendTx(signer, tx);
        await trackSubmittedTransaction(txHash);

        return txHash;
      } catch (error: any) {
        if (!(error instanceof TransactionUnconfirmedError)) {
          setTxState((prev) => ({ ...prev, status: "error", txHash: null, error: error.message ?? String(error) }));
        }
        throw error;
      }
    },
    [intentCells, pollCells, signer, tallyMergeResultCells, tallyShardCells, trackSubmittedTransaction]
  );

  const forceClose = useCallback(
    async (poll: Poll) => {
      if (!signer) throw new Error("Wallet not connected");

      const pollCell = pollCells[poll.id];
      if (!pollCell) throw new Error("Poll cell is not currently indexed");

      const indexedShardCells = tallyShardCells[poll.id] ?? [];
      const finalMergeResultCell = (tallyMergeResultCells[poll.id] ?? []).find((cell) => {
        const result = decodeTallyMergeResultData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
        return tallyMergeCoverageComplete(result.coverage, poll.shardCount);
      });

      setTxState({ status: "building", txHash: null, error: null, scope: { kind: "poll", pollId: poll.id }, batch: null });
      try {
        const closeIntentSelection = buildCloseIntentRefundSelection({
          cells: intentCells[poll.id] ?? [],
          pollId: poll.id,
          trackedPendingLowerBound: poll.protocolPendingIntentCount,
        });
        const tx = await buildForceCloseTx(signer, {
          pollCell,
          intentCells: closeIntentSelection.included.map((candidate) => candidate.cell),
          shardCells: poll.shardCount > MAX_DIRECT_CLOSE_SHARDS ? [] : indexedShardCells,
          mergeResultCell: finalMergeResultCell,
        });
        setTxState((prev) => ({ ...prev, status: "signing", txHash: null, error: null }));
        const txHash = await signAndSendTx(signer, tx);
        await trackSubmittedTransaction(txHash);

        return txHash;
      } catch (error: any) {
        if (!(error instanceof TransactionUnconfirmedError)) {
          setTxState((prev) => ({ ...prev, status: "error", txHash: null, error: error.message ?? String(error) }));
        }
        throw error;
      }
    },
    [intentCells, pollCells, signer, tallyMergeResultCells, tallyShardCells, trackSubmittedTransaction]
  );

  const refundClosedIntent = useCallback(
    async (poll: Poll) => {
      if (!signer) throw new Error("Wallet not connected");
      if (!poll.isClosed) throw new Error("Standalone intent refund requires a closed poll");

      const pollCell = pollCells[poll.id];
      if (!pollCell) throw new Error("Poll cell is not currently indexed");

      const refundableIntentCandidates = (intentCells[poll.id] ?? [])
        .map((cell) => {
          try {
            const decoded = decodeVoteIntentData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
            return { cell, decoded };
          } catch {
            return null;
          }
        })
        .filter((candidate): candidate is { cell: any; decoded: ReturnType<typeof decodeVoteIntentData> } => {
          if (!candidate) return false;
          return bytesToHex(candidate.decoded.poll_type_hash).toLowerCase() === poll.id.toLowerCase();
        })
        .sort((left, right) => {
          const aggregateOrder = Number(left.decoded.aggregated) - Number(right.decoded.aggregated);
          if (aggregateOrder !== 0) return aggregateOrder;
          return `${left.cell.outPoint.txHash}:${Number(left.cell.outPoint.index)}`.localeCompare(
            `${right.cell.outPoint.txHash}:${Number(right.cell.outPoint.index)}`
          );
        });

      const intentCell = refundableIntentCandidates[0]?.cell;
      if (!intentCell) throw new Error("No live omitted intent cell is indexed for refund");

      setTxState({ status: "building", txHash: null, error: null, scope: { kind: "poll", pollId: poll.id }, batch: null });
      try {
        const tx = await buildRefundClosedIntentTx(signer, {
          pollCell,
          intentCell,
        });
        setTxState((prev) => ({ ...prev, status: "signing", txHash: null, error: null }));
        const txHash = await signAndSendTx(signer, tx);
        await trackSubmittedTransaction(txHash);

        return txHash;
      } catch (error: any) {
        if (!(error instanceof TransactionUnconfirmedError)) {
          setTxState((prev) => ({ ...prev, status: "error", txHash: null, error: error.message ?? String(error) }));
        }
        throw error;
      }
    },
    [intentCells, pollCells, signer, trackSubmittedTransaction]
  );

  const refundLateIntent = useCallback(
    async (poll: Poll) => {
      if (!signer) throw new Error("Wallet not connected");
      if (poll.isClosed) throw new Error("Use the post-close refund path for a closed poll");

      const pollCell = pollCells[poll.id];
      if (!pollCell) throw new Error("Poll cell is not currently indexed");
      const lateIntent = (intents[poll.id] ?? []).find(
        (intent) => !intent.aggregated &&
          intent.createdEpoch !== null &&
          intent.createdEpoch > poll.deadline
      );
      if (!lateIntent) throw new Error("No authenticated late intent is indexed for refund");
      const intentCell = (intentCells[poll.id] ?? []).find(
        (cell) => `${cell.outPoint.txHash}:${cell.outPoint.index}` === lateIntent.id
      );
      if (!intentCell) throw new Error("Late intent cell is no longer live");

      setTxState({ status: "building", txHash: null, error: null, scope: { kind: "poll", pollId: poll.id }, batch: null });
      try {
        const tx = await buildRefundLateIntentTx(signer, { pollCell, intentCell });
        setTxState((prev) => ({ ...prev, status: "signing", txHash: null, error: null }));
        const txHash = await signAndSendTx(signer, tx);
        await trackSubmittedTransaction(txHash);
        return txHash;
      } catch (error: any) {
        if (!(error instanceof TransactionUnconfirmedError)) {
          setTxState((prev) => ({ ...prev, status: "error", txHash: null, error: error.message ?? String(error) }));
        }
        throw error;
      }
    },
    [intentCells, intents, pollCells, signer, trackSubmittedTransaction]
  );

  const aggregatePoll = useCallback(
    async (poll: Poll) => {
      if (!signer) throw new Error("Wallet not connected");
      if (poll.tokenWeighted) {
        throw new Error("Weighted polls are unsupported; only recovery actions are available");
      }

      const pollCell = pollCells[poll.id];
      const indexedIntents = new Map(
        (intents[poll.id] ?? []).map((intent) => [intent.id, intent])
      );
      const pendingIntentCells = (intentCells[poll.id] ?? []).filter((cell) => {
        try {
          const decoded = decodeVoteIntentData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
          const id = `${cell.outPoint.txHash}:${cell.outPoint.index}`;
          const indexed = indexedIntents.get(id);
          return !decoded.aggregated &&
            indexed?.createdEpoch !== null &&
            indexed?.createdEpoch !== undefined &&
            indexed.createdEpoch <= poll.deadline;
        } catch {
          return false;
        }
      });

      if (!pollCell) throw new Error("Poll cell is not currently indexed");
      if (pendingIntentCells.length === 0) throw new Error("No pending intent cells to aggregate");
      const shardCells = tallyShardCells[poll.id] ?? [];
      if (shardCells.length === 0) throw new Error("No tally shard cells are currently indexed for this poll");

      const pendingByShard = new Map<number, any[]>();
      for (const cell of pendingIntentCells) {
        const decoded = decodeVoteIntentData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
        const shardId = deriveTallyShardId(decoded.poll_type_hash, decoded.voter_lock_hash, poll.shardCount);
        const group = pendingByShard.get(shardId) ?? [];
        group.push(cell);
        pendingByShard.set(shardId, group);
      }

      let selectedShardCell: any | null = null;
      let selectedIntentCells: any[] = [];
      for (const cell of shardCells) {
        const shardData = decodeTallyShardData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
        const group = pendingByShard.get(shardData.shard_id) ?? [];
        if (group.length > 0) {
          selectedShardCell = cell;
          selectedIntentCells = group.slice(0, MAX_INTENTS_PER_AGG);
          break;
        }
      }
      if (!selectedShardCell) {
        throw new Error("No indexed tally shard matches the pending intent cells");
      }
      const selectedShard = decodeTallyShardData(
        (ccc as any).bytesFrom(selectedShardCell.outputData ?? "0x")
      );
      const aggregatedMarkerCells = (intentCells[poll.id] ?? []).filter((cell) => {
        try {
          const marker = decodeVoteIntentData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
          return marker.aggregated &&
            deriveTallyShardId(marker.poll_type_hash, marker.voter_lock_hash, poll.shardCount) ===
              selectedShard.shard_id;
        } catch {
          return false;
        }
      });

      setTxState({ status: "building", txHash: null, error: null, scope: { kind: "poll", pollId: poll.id }, batch: null });
      try {
        const tx = await buildAggregateTallyShardTx(signer, {
          pollCell,
          shardCell: selectedShardCell,
          intentCells: selectedIntentCells,
          aggregatedMarkerCells,
        });
        setTxState((prev) => ({ ...prev, status: "signing", txHash: null, error: null }));
        const txHash = await signAndSendTx(signer, tx);
        await trackSubmittedTransaction(txHash);

        return txHash;
      } catch (error: any) {
        if (!(error instanceof TransactionUnconfirmedError)) {
          setTxState((prev) => ({ ...prev, status: "error", txHash: null, error: error.message ?? String(error) }));
        }
        throw error;
      }
    },
    [intentCells, intents, pollCells, signer, tallyShardCells, trackSubmittedTransaction]
  );

  const finalizeShards = useCallback(
    async (poll: Poll) => {
      if (!signer) throw new Error("Wallet not connected");

      const pollCell = pollCells[poll.id];
      if (!pollCell) throw new Error("Poll cell is not currently indexed");

      const shardCells = tallyShardCells[poll.id] ?? [];
      if (poll.shardCount <= 0) throw new Error("Poll is not configured for tally shards");
      if (shardCells.length !== poll.shardCount) {
        throw new Error("Finalize requires the complete indexed shard set");
      }

      const nextShardCell = shardCells.find((cell) => {
        const shardData = decodeTallyShardData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
        return !shardData.finalized;
      });
      if (!nextShardCell) throw new Error("All indexed shards are already finalized");

      setTxState({ status: "building", txHash: null, error: null, scope: { kind: "poll", pollId: poll.id }, batch: null });
      try {
        const tx = await buildFinalizeTallyShardTx(signer, {
          pollCell,
          shardCell: nextShardCell,
        });
        setTxState((prev) => ({ ...prev, status: "signing", txHash: null, error: null }));
        const txHash = await signAndSendTx(signer, tx);
        await trackSubmittedTransaction(txHash);

        return txHash;
      } catch (error: any) {
        if (!(error instanceof TransactionUnconfirmedError)) {
          setTxState((prev) => ({ ...prev, status: "error", txHash: null, error: error.message ?? String(error) }));
        }
        throw error;
      }
    },
    [pollCells, signer, tallyShardCells, trackSubmittedTransaction]
  );

  /** Finalize ordered lane batches; each batch is one transaction/signature. */
  const finalizeAllShards = useCallback(
    async (poll: Poll) => {
      if (!signer) throw new Error("Wallet not connected");

      const pollCell = pollCells[poll.id];
      if (!pollCell) throw new Error("Poll cell is not currently indexed");

      const shardCells = tallyShardCells[poll.id] ?? [];
      if (poll.shardCount <= 0) throw new Error("Poll is not configured for tally shards");
      if (shardCells.length !== poll.shardCount) {
        throw new Error("Finalize requires the complete indexed shard set");
      }

      const pendingShardCells = shardCells.filter((cell) => {
        const shardData = decodeTallyShardData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
        return !shardData.finalized;
      });
      if (pendingShardCells.length === 0) throw new Error("All indexed shards are already finalized");

      const scope: TxScope = { kind: "poll", pollId: poll.id };
      const total = pendingShardCells.length;
      const submitted: string[] = [];

      for (let offset = 0; offset < pendingShardCells.length; offset += MAX_SHARDS_PER_FINALIZE) {
        const shardBatch = pendingShardCells.slice(offset, offset + MAX_SHARDS_PER_FINALIZE);
        const batch = { label: "Finalizing tally lanes", completed: offset, total };
        setTxState({ status: "building", txHash: null, error: null, scope, batch });
        try {
          // Flow: one bounded transaction freezes up to eight lanes. A poll
          // with more lanes proceeds through later explicitly signed batches.
          const tx = await buildFinalizeTallyShardsTx(signer, {
            pollCell,
            shardCells: shardBatch,
          });
          setTxState((prev) => ({ ...prev, status: "signing", txHash: null, error: null }));
          const txHash = await signAndSendTx(signer, tx);
          submitted.push(txHash);
          await trackSubmittedTransaction(txHash);
        } catch (error: any) {
          if (!(error instanceof TransactionUnconfirmedError)) {
            setTxState((prev) => ({
              ...prev,
              status: "error",
              txHash: null,
              error: `${error.message ?? String(error)} (finalized ${offset.toString()} of ${total.toString()} lanes; rerun to continue)`,
            }));
          }
          throw error;
        }
      }

      setTxState((prev) => ({
        ...prev,
        batch: { label: "Finalizing tally lanes", completed: total, total },
      }));
      return submitted[submitted.length - 1] ?? "";
    },
    [pollCells, signer, tallyShardCells, trackSubmittedTransaction]
  );

  const mergeShards = useCallback(
    async (poll: Poll) => {
      if (!signer) throw new Error("Wallet not connected");

      const pollCell = pollCells[poll.id];
      if (!pollCell) throw new Error("Poll cell is not currently indexed");

      const shardCells = (tallyShardCells[poll.id] ?? []).filter((cell) => {
        const shard = decodeTallyShardData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
        return shard.finalized;
      });
      const resultCells = tallyMergeResultCells[poll.id] ?? [];
      if (poll.shardCount <= MAX_DIRECT_CLOSE_SHARDS) throw new Error("Merge is only required for large shard-count polls");
      if (shardCells.length === 0 && resultCells.length === 0) {
        throw new Error("No finalized shard or merge result cells are indexed");
      }

      setTxState({ status: "building", txHash: null, error: null, scope: { kind: "poll", pollId: poll.id }, batch: null });
      try {
        const selectedShardCells: any[] = [];
        const selectedResultCells: any[] = [];
        const selectedCoverage = new Uint8Array(32);

        const resultCandidates = resultCells
          .map((cell) => ({
            cell,
            result: decodeTallyMergeResultData((ccc as any).bytesFrom(cell.outputData ?? "0x")),
          }))
          .sort((left, right) => coverageCount(right.result.coverage) - coverageCount(left.result.coverage));

        for (const { cell, result } of resultCandidates) {
          if (selectedShardCells.length + selectedResultCells.length >= MAX_SHARDS_PER_MERGE) break;
          if (!coverageDisjoint(selectedCoverage, result.coverage)) continue;
          if (!coverageAddsMissing(selectedCoverage, result.coverage, poll.shardCount)) continue;
          selectedResultCells.push(cell);
          for (let index = 0; index < selectedCoverage.length; index += 1) {
            selectedCoverage[index] |= result.coverage[index];
          }
        }

        const shardCandidates = shardCells
          .map((cell) => ({
            cell,
            shard: decodeTallyShardData((ccc as any).bytesFrom(cell.outputData ?? "0x")),
          }))
          .sort((left, right) => left.shard.shard_id - right.shard.shard_id);

        for (const { cell, shard } of shardCandidates) {
          if (selectedShardCells.length + selectedResultCells.length >= MAX_SHARDS_PER_MERGE) break;
          if (shard.shard_id >= poll.shardCount) continue;
          if ((selectedCoverage[Math.floor(shard.shard_id / 8)] & (1 << (shard.shard_id % 8))) !== 0) {
            continue;
          }
          selectedShardCells.push(cell);
          coverageSetShard(selectedCoverage, shard.shard_id);
        }
        if (selectedShardCells.length + selectedResultCells.length === 0) {
          throw new Error("No disjoint shard or merge result inputs are available");
        }

        const tx = await buildMergeTallyShardsTx(signer, {
          pollCell,
          shardCells: selectedShardCells,
          mergeResultCells: selectedResultCells,
        });
        setTxState((prev) => ({ ...prev, status: "signing", txHash: null, error: null }));
        const txHash = await signAndSendTx(signer, tx);
        await trackSubmittedTransaction(txHash);

        return txHash;
      } catch (error: any) {
        if (!(error instanceof TransactionUnconfirmedError)) {
          setTxState((prev) => ({ ...prev, status: "error", txHash: null, error: error.message ?? String(error) }));
        }
        throw error;
      }
    },
    [pollCells, signer, tallyMergeResultCells, tallyShardCells, trackSubmittedTransaction]
  );

  const createDelegation = useCallback(
    async (params: DelegateParams) => {
      if (!signer) throw new Error("Wallet not connected");

      const normalizedPollId = params.pollId.toLowerCase();
      const targetPoll = polls.find((poll) => poll.id.toLowerCase() === normalizedPollId);
      if (!targetPoll) {
        throw new Error("Delegation scope must reference an indexed poll");
      }
      const signerLockHash = await getSignerLockHashHex(signer);
      if (targetPoll.creator.toLowerCase() === signerLockHash.toLowerCase()) {
        throw new Error("Poll creators cannot delegate voting authority for their own poll");
      }
      const tipEpoch = await getTipEpoch(signer.client);
      if (targetPoll.isClosed || tipEpoch > targetPoll.deadline) {
        throw new Error("Delegation can only be created for an open poll before its deadline");
      }

      setTxState({ status: "building", txHash: null, error: null, scope: { kind: "delegation" }, batch: null });
      try {
        const tx = await buildDelegateTx(signer, {
          delegateLockHash: params.delegateLockHash,
          pollTypeHash: targetPoll.id,
          forbiddenDelegateLockHash: targetPoll.creator,
        });
        setTxState((prev) => ({ ...prev, status: "signing", txHash: null, error: null }));
        const txHash = await signAndSendTx(signer, tx);
        await trackSubmittedTransaction(txHash);

        return txHash;
      } catch (error: any) {
        if (!(error instanceof TransactionUnconfirmedError)) {
          setTxState((prev) => ({ ...prev, status: "error", txHash: null, error: error.message ?? String(error) }));
        }
        throw error;
      }
    },
    [polls, signer, trackSubmittedTransaction]
  );

  const revokeDelegation = useCallback(
    async (delegationId: string) => {
      if (!signer) throw new Error("Wallet not connected");

      const delegationCell = delegationCells[delegationId];
      if (!delegationCell) throw new Error("Delegation cell is not currently indexed");

      setTxState({ status: "building", txHash: null, error: null, scope: { kind: "delegation" }, batch: null });
      try {
        const tx = await buildRevokeDelegationTx(signer, {
          delegationCell,
        });
        setTxState((prev) => ({ ...prev, status: "signing", txHash: null, error: null }));
        const txHash = await signAndSendTx(signer, tx);
        await trackSubmittedTransaction(txHash);

        return txHash;
      } catch (error: any) {
        if (!(error instanceof TransactionUnconfirmedError)) {
          setTxState((prev) => ({ ...prev, status: "error", txHash: null, error: error.message ?? String(error) }));
        }
        throw error;
      }
    },
    [delegationCells, signer, trackSubmittedTransaction]
  );

  const currentEpoch = useCallback(async (): Promise<bigint> => {
    if (!signer) return 0n;
    return getTipEpoch(signer.client);
  }, [signer]);

  // Poll and intent scans are wallet-neutral. Re-derive role options from the
  // cached index as soon as the connected lock hash changes, so a valid voter
  // does not wait for the next 30-second refresh before `Vote now` appears.
  const viewerPolls = useMemo(
    () =>
      polls.map((poll) => ({
        ...poll,
        authorityOptions: deriveVoteAuthorityOptions({
          poll,
          intents: intents[poll.id] ?? [],
          delegations,
          viewerLockHash,
        }),
      })),
    [delegations, intents, polls, viewerLockHash]
  );

  /**
   * Only guarded actions leave the hook, so no surface can reach an unguarded
   * one. `fetchPolls` and `currentEpoch` are deliberately excluded: they are
   * read-only and must stay usable while a transaction is in flight.
   */
  const guardedActions = useMemo(
    () => ({
      createPoll: guardExclusive(createPoll),
      castVote: guardExclusive(castVote),
      aggregatePoll: guardExclusive(aggregatePoll),
      finalizeShards: guardExclusive(finalizeShards),
      finalizeAllShards: guardExclusive(finalizeAllShards),
      mergeShards: guardExclusive(mergeShards),
      closePoll: guardExclusive(closePoll),
      createDelegation: guardExclusive(createDelegation),
      revokeDelegation: guardExclusive(revokeDelegation),
      forceClose: guardExclusive(forceClose),
      refundClosedIntent: guardExclusive(refundClosedIntent),
      refundLateIntent: guardExclusive(refundLateIntent),
    }),
    [
      aggregatePoll,
      castVote,
      closePoll,
      createDelegation,
      createPoll,
      finalizeAllShards,
      finalizeShards,
      forceClose,
      guardExclusive,
      mergeShards,
      refundClosedIntent,
      refundLateIntent,
      revokeDelegation,
    ]
  );

  return {
    polls: viewerPolls,
    intents,
    delegations,
    loading,
    refreshing,
    loadError,
    txState,
    actionInFlight,
    fetchPolls,
    currentEpoch,
    ...guardedActions,
  };
}
