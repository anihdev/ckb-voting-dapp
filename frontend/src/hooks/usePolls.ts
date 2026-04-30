/**
 * usePolls Hook
 * =============
 * Indexes governance poll and intent cells and exposes transaction flows that
 * follow the contract's six-operation model, including off-chain duplicate
 * intent checks and delegated voting authority discovery.
 */

import { useCallback, useState } from "react";
import { ccc } from "@ckb-ccc/core";
import {
  buildAggregateVotesTx,
  buildClosePollTx,
  buildForceCloseTx,
  buildCreatePollTx,
  buildCreateVoteIntentTx,
  buildDelegateTx,
  buildGovernanceTypeScript,
  buildRevokeDelegationTx,
  getTipEpoch,
  getSignerLockHashHex,
  hashScript,
  OP,
  signAndSendTx,
  validateCreatePollInput,
} from "../lib/ckb";
import {
  bytesToHex,
  decodeDelegationData,
  decodePollData,
  decodeVoteIntentData,
} from "../lib/molecule";
import {
  DelegateParams,
  DelegationRecord,
  Poll,
  TxState,
  VoteAuthorityOption,
  VoteIntent,
} from "../lib/types";

export interface CreatePollParams {
  question: string;
  options: string[];
  durationEpochs: number;
  tokenWeighted?: boolean;
}

export interface CastVoteParams {
  poll: Poll;
  optionIndex: number;
  authorityId?: string;
  weightUnits?: number;
}

function deriveWinnerIndex(voteCounts: bigint[]): number | null {
  if (voteCounts.length === 0) return null;

  let maxVotes = 0n;
  let maxIndex = -1;
  let isTie = false;

  voteCounts.forEach((count, index) => {
    if (count > maxVotes) {
      maxVotes = count;
      maxIndex = index;
      isTie = false;
    } else if (count > 0n && count === maxVotes) {
      isTie = true;
    }
  });

  if (maxVotes === 0n || isTie) return null;
  return maxIndex;
}

async function resolveCellCreatedEpoch(
  client: any,
  txHash: string,
  headerEpochCache: Map<string, bigint | null>
): Promise<bigint | null> {
  try {
    const txView = await client.getTransaction(txHash);
    const blockHash =
      txView?.txStatus?.blockHash ??
      txView?.tx_status?.block_hash ??
      txView?.txStatus?.block_hash ??
      txView?.tx_status?.blockHash ??
      null;

    if (!blockHash) return null;
    if (headerEpochCache.has(blockHash)) {
      return headerEpochCache.get(blockHash) ?? null;
    }

    const header = await client.getHeader(blockHash);
    const rawEpoch =
      header?.epoch ??
      header?.header?.epoch ??
      header?.inner?.epoch ??
      null;

    if (rawEpoch === null || rawEpoch === undefined) {
      headerEpochCache.set(blockHash, null);
      return null;
    }

    const parsed = BigInt(String(rawEpoch).split(",")[0]);
    headerEpochCache.set(blockHash, parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function waitForTx(client: any, txHash: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const tx = await client.getTransaction(txHash);
      if (tx) return;
    } catch {
      // Keep polling while the network indexes the transaction.
    }
  }
}

export function usePolls(signer: any | null) {
  const [polls, setPolls] = useState<Poll[]>([]);
  const [intents, setIntents] = useState<Record<string, VoteIntent[]>>({});
  const [delegations, setDelegations] = useState<DelegationRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [txState, setTxState] = useState<TxState>({ status: "idle", txHash: null, error: null });
  const [pollCells, setPollCells] = useState<Record<string, any>>({});
  const [intentCells, setIntentCells] = useState<Record<string, any[]>>({});
  const [delegationCells, setDelegationCells] = useState<Record<string, any>>({});

  const fetchPolls = useCallback(async () => {
    if (!signer) return;

    setLoading(true);
    setLoadError(null);
    try {
      const client = signer.client;
      const pollScript = buildGovernanceTypeScript(OP.CREATE_POLL);
      const nextPolls: Poll[] = [];
      const nextIntents: Record<string, VoteIntent[]> = {};
      const nextIntentCells: Record<string, any[]> = {};
      const nextPollCells: Record<string, any> = {};
      const headerEpochCache = new Map<string, bigint | null>();
      const currentLockHashHex = await getSignerLockHashHex(signer);
      const tipEpoch = await getTipEpoch(client);

      for await (const cell of client.findCells({
        script: pollScript,
        scriptType: "type",
        scriptSearchMode: "prefix",
      })) {
        try {
          const pollBytes = (ccc as any).bytesFrom(cell.outputData ?? "0x");
          const pollData = decodePollData(pollBytes);
          const pollId = hashScript(cell.cellOutput?.type ?? cell.output?.type);
          const voteCounts = pollData.vote_counts;
          const totalVotes = voteCounts.reduce((sum, count) => sum + count, 0n);
          const createdEpoch = await resolveCellCreatedEpoch(
            client,
            cell.outPoint.txHash,
            headerEpochCache
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
            tokenWeighted: pollData.token_weighted,
            udtTypeHash: bytesToHex(pollData.udt_type_hash),
            totalVotes,
            winnerIndex: deriveWinnerIndex(voteCounts),
            authorityOptions: [],
            outstandingIntentCount: 0,
          });

          nextIntents[pollId] = [];
        } catch (error) {
          console.warn("Failed to decode poll cell", error);
        }
      }

      for (const poll of nextPolls) {
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
          });
        } catch (error) {
          console.warn("Failed to decode delegation cell", error);
        }
      }

      for (const poll of nextPolls) {
        const pollIntents = nextIntents[poll.id] ?? [];
        const pendingPollIntents = pollIntents.filter((intent) => !intent.aggregated);
        const authorityOptions: VoteAuthorityOption[] = [];

        const directIntents = pollIntents.filter(
          (intent) => intent.voterLockHash === currentLockHashHex
        );

        authorityOptions.push({
          id: "self",
          mode: "self",
          label: "Vote as connected wallet",
          voterLockHash: currentLockHashHex,
          delegationId: null,
          hasIntent: directIntents.length > 0,
          hasPendingIntent: directIntents.some((intent) => !intent.aggregated),
          hasAggregatedIntent: directIntents.some((intent) => intent.aggregated),
        });

        const applicableDelegations = nextDelegations
          .filter((delegation) => delegation.delegateLockHash === currentLockHashHex)
          .filter((delegation) => delegation.pollId === null || delegation.pollId === poll.id)
          .filter((delegation) => delegation.expiresEpoch === 0n || delegation.expiresEpoch >= tipEpoch);

        for (const delegation of applicableDelegations) {
          const delegatedIntents = pollIntents.filter(
            (intent) => intent.voterLockHash === delegation.delegatorLockHash
          );

          authorityOptions.push({
            id: delegation.id,
            mode: "delegation",
            label: `Vote for ${delegation.delegatorLockHash.slice(0, 14)}...`,
            voterLockHash: delegation.delegatorLockHash,
            delegationId: delegation.id,
            hasIntent: delegatedIntents.length > 0,
            hasPendingIntent: delegatedIntents.some((intent) => !intent.aggregated),
            hasAggregatedIntent: delegatedIntents.some((intent) => intent.aggregated),
          });
        }

        poll.authorityOptions = authorityOptions;
        // UI action gates should follow indexer-observed pending intents until
        // poll.pending_intent_count is promoted to strict on-chain accounting.
        poll.pendingIntentCount = BigInt(pendingPollIntents.length);
        poll.outstandingIntentCount = pendingPollIntents.length;
      }

      setPolls(nextPolls);
      setIntents(nextIntents);
      setPollCells(nextPollCells);
      setIntentCells(nextIntentCells);
      setDelegations(nextDelegations);
      setDelegationCells(nextDelegationCells);
    } catch (error: any) {
      setLoadError(error?.message ?? String(error));
    } finally {
      setLoading(false);
    }
  }, [signer]);

  const createPoll = useCallback(
    async (params: CreatePollParams) => {
      if (!signer) throw new Error("Wallet not connected");

      const validationError = validateCreatePollInput(params);
      if (validationError) throw new Error(validationError);

      setTxState({ status: "building", txHash: null, error: null });
      try {
        const tx = await buildCreatePollTx(signer, params);
        setTxState({ status: "signing", txHash: null, error: null });
        const txHash = await signAndSendTx(signer, tx);
        setTxState({ status: "confirming", txHash, error: null });

        waitForTx(signer.client, txHash).then(async () => {
          setTxState({ status: "success", txHash, error: null });
          await fetchPolls();
        });

        return txHash;
      } catch (error: any) {
        setTxState({ status: "error", txHash: null, error: error.message ?? String(error) });
        throw error;
      }
    },
    [fetchPolls, signer]
  );

  const castVote = useCallback(
    async ({ poll, optionIndex, authorityId, weightUnits }: CastVoteParams) => {
      if (!signer) throw new Error("Wallet not connected");

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

      setTxState({ status: "building", txHash: null, error: null });
      try {
        const tx = await buildCreateVoteIntentTx(signer, {
          pollTypeHash: poll.id,
          optionIndex,
          pollCell,
          delegationCell,
          weightUnits,
        });
        setTxState({ status: "signing", txHash: null, error: null });
        const txHash = await signAndSendTx(signer, tx);
        setTxState({ status: "confirming", txHash, error: null });

        waitForTx(signer.client, txHash).then(async () => {
          setTxState({ status: "success", txHash, error: null });
          await fetchPolls();
        });

        return txHash;
      } catch (error: any) {
        setTxState({ status: "error", txHash: null, error: error.message ?? String(error) });
        throw error;
      }
    },
    [delegationCells, fetchPolls, pollCells, signer]
  );

  const closePoll = useCallback(
    async (poll: Poll) => {
      if (!signer) throw new Error("Wallet not connected");

      const pollCell = pollCells[poll.id];
      if (!pollCell) throw new Error("Poll cell is not currently indexed");

      const outstandingIntentCells = intentCells[poll.id] ?? [];

      setTxState({ status: "building", txHash: null, error: null });
      try {
        const tx = await buildClosePollTx(signer, {
          pollCell,
          intentCells: outstandingIntentCells,
        });
        setTxState({ status: "signing", txHash: null, error: null });
        const txHash = await signAndSendTx(signer, tx);
        setTxState({ status: "confirming", txHash, error: null });

        waitForTx(signer.client, txHash).then(async () => {
          setTxState({ status: "success", txHash, error: null });
          await fetchPolls();
        });

        return txHash;
      } catch (error: any) {
        setTxState({ status: "error", txHash: null, error: error.message ?? String(error) });
        throw error;
      }
    },
    [fetchPolls, intentCells, pollCells, signer]
  );

  const forceClose = useCallback(
    async (poll: Poll) => {
      if (!signer) throw new Error("Wallet not connected");

      const pollCell = pollCells[poll.id];
      if (!pollCell) throw new Error("Poll cell is not currently indexed");

      const outstandingIntentCells = intentCells[poll.id] ?? [];

      setTxState({ status: "building", txHash: null, error: null });
      try {
        const tx = await buildForceCloseTx(signer, {
          pollCell,
          intentCells: outstandingIntentCells,
        });
        setTxState({ status: "signing", txHash: null, error: null });
        const txHash = await signAndSendTx(signer, tx);
        setTxState({ status: "confirming", txHash, error: null });

        waitForTx(signer.client, txHash).then(async () => {
          setTxState({ status: "success", txHash, error: null });
          await fetchPolls();
        });

        return txHash;
      } catch (error: any) {
        setTxState({ status: "error", txHash: null, error: error.message ?? String(error) });
        throw error;
      }
    },
    [fetchPolls, intentCells, pollCells, signer]
  );

  const aggregatePoll = useCallback(
    async (poll: Poll) => {
      if (!signer) throw new Error("Wallet not connected");

      const pollCell = pollCells[poll.id];
      const pendingIntentCells = (intentCells[poll.id] ?? []).filter((cell) => {
        try {
          const decoded = decodeVoteIntentData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
          return !decoded.aggregated;
        } catch {
          return false;
        }
      });

      if (!pollCell) throw new Error("Poll cell is not currently indexed");
      if (pendingIntentCells.length === 0) throw new Error("No pending intent cells to aggregate");

      setTxState({ status: "building", txHash: null, error: null });
      try {
        const tx = await buildAggregateVotesTx(signer, {
          pollCell,
          intentCells: pendingIntentCells.slice(0, 50),
        });
        setTxState({ status: "signing", txHash: null, error: null });
        const txHash = await signAndSendTx(signer, tx);
        setTxState({ status: "confirming", txHash, error: null });

        waitForTx(signer.client, txHash).then(async () => {
          setTxState({ status: "success", txHash, error: null });
          await fetchPolls();
        });

        return txHash;
      } catch (error: any) {
        setTxState({ status: "error", txHash: null, error: error.message ?? String(error) });
        throw error;
      }
    },
    [fetchPolls, intentCells, pollCells, signer]
  );

  const createDelegation = useCallback(
    async (params: DelegateParams) => {
      if (!signer) throw new Error("Wallet not connected");

      setTxState({ status: "building", txHash: null, error: null });
      try {
        const tx = await buildDelegateTx(signer, {
          delegateLockHash: params.delegateLockHash,
          pollTypeHash: params.pollId,
          expiresEpoch: params.expiresEpoch,
        });
        setTxState({ status: "signing", txHash: null, error: null });
        const txHash = await signAndSendTx(signer, tx);
        setTxState({ status: "confirming", txHash, error: null });

        waitForTx(signer.client, txHash).then(async () => {
          setTxState({ status: "success", txHash, error: null });
          await fetchPolls();
        });

        return txHash;
      } catch (error: any) {
        setTxState({ status: "error", txHash: null, error: error.message ?? String(error) });
        throw error;
      }
    },
    [fetchPolls, signer]
  );

  const revokeDelegation = useCallback(
    async (delegationId: string) => {
      if (!signer) throw new Error("Wallet not connected");

      const delegationCell = delegationCells[delegationId];
      if (!delegationCell) throw new Error("Delegation cell is not currently indexed");

      setTxState({ status: "building", txHash: null, error: null });
      try {
        const tx = await buildRevokeDelegationTx(signer, {
          delegationCell,
        });
        setTxState({ status: "signing", txHash: null, error: null });
        const txHash = await signAndSendTx(signer, tx);
        setTxState({ status: "confirming", txHash, error: null });

        waitForTx(signer.client, txHash).then(async () => {
          setTxState({ status: "success", txHash, error: null });
          await fetchPolls();
        });

        return txHash;
      } catch (error: any) {
        setTxState({ status: "error", txHash: null, error: error.message ?? String(error) });
        throw error;
      }
    },
    [delegationCells, fetchPolls, signer]
  );

  const currentEpoch = useCallback(async (): Promise<bigint> => {
    if (!signer) return 0n;
    return getTipEpoch(signer.client);
  }, [signer]);

  return {
    polls,
    intents,
    delegations,
    loading,
    loadError,
    txState,
    fetchPolls,
    createPoll,
    castVote,
    aggregatePoll,
    closePoll,
    createDelegation,
    revokeDelegation,
    forceClose,
    currentEpoch,
  };
}
