/**
 * Governance Smoke Script
 * =======================
 * Exercises the immediate Rust lifecycle on testnet with a private-key signer:
 * create poll, create vote intent, shard aggregate, and delegation
 * create/revoke. Post-deadline shard finalization, MERGE_TALLY_SHARDS, and
 * close need a controlled epoch wait/local harness and are not sent here.
 */

import { randomBytes } from "crypto";
import { ccc } from "@ckb-ccc/core";
import {
  EncodedScript,
  PollData,
  VoteIntentData,
  decodeVoteIntentData,
  encodeDelegationData,
  encodePollData,
  encodeTallyShardData,
  encodeVoteIntentData,
  decodeTallyShardData,
} from "../../frontend/src/lib/molecule";
import {
  RPC_URL,
  assertRpcUrl,
  requireGovernanceHashes,
  requirePrivateKey,
} from "./config";
import { epochNumber } from "./epoch";

const PRIVATE_KEY = requirePrivateKey();
const { codeHash: GOVERNANCE_CODE_HASH, scriptTxHash: GOVERNANCE_SCRIPT_TX_HASH } = requireGovernanceHashes();
const SCRIPT_HASH_TYPE = "data1";
const CREATOR_DEPOSIT_SHANNONS = 500n * 100_000_000n;
const VOTER_DEPOSIT_SHANNONS = 61n * 100_000_000n;
const DELEGATION_MIN_SHANNONS = 61n * 100_000_000n;
const SHANNONS_PER_CKB = 100_000_000n;
const TALLY_SHARD_MIN_SHANNONS = 61n * SHANNONS_PER_CKB;
const DEFAULT_SHARD_COUNT = 1;
assertRpcUrl(RPC_URL, "CKB RPC URL");

type CellRef = {
  outPoint: { txHash: string; index: number };
  cellOutput: { lock: any; type?: any; capacity: bigint };
  outputData: string;
  creationBlockHash?: string;
  creationEpoch?: bigint;
};

/** @notice Computes the script hash used for poll id and type binding checks. */
function scriptHash(script: any): string {
  return ccc.hexFrom((ccc as any).hashCkb((ccc as any).Script.from(script).toBytes()));
}

function getOutPoint(cell: any): any {
  return {
    txHash: cell.outPoint.txHash,
    index: Number(cell.outPoint.index),
  };
}

function outPointKeyFromOutPoint(outPoint: any): string {
  return `${outPoint.txHash}:${Number(outPoint.index)}`;
}

function outPointKey(cell: any): string {
  return outPointKeyFromOutPoint(cell.outPoint ?? cell.previousOutput);
}

function derivePollTypeIdFromSeedInput(seedCell: any, outputIndex = 0): string {
  return (ccc as any).hashTypeId(
    { previousOutput: getOutPoint(seedCell), since: 0 },
    outputIndex
  );
}

function assertPinnedInput0(tx: any, expectedOutPointKey: string): void {
  const firstInput = tx.inputs?.[0];
  const previousOutput = firstInput?.previousOutput ?? firstInput?.previous_output;
  if (!previousOutput || outPointKeyFromOutPoint(previousOutput) !== expectedOutPointKey) {
    throw new Error("CREATE_POLL Type ID seed input was reordered or replaced");
  }
}

/** @notice Computes lock hash bytes for signer and ownership assertions. */
function lockHashBytes(script: any): Uint8Array {
  return (ccc as any).bytesFrom((ccc as any).hashCkb(script.toBytes()));
}

/** @notice Encodes operation args as `<op-byte><scope-bytes>`. */
function encodeOpArgs(op: number, scopeHex = "0x"): string {
  return `0x${op.toString(16).padStart(2, "0")}${scopeHex.replace(/^0x/, "")}`;
}

/** @notice Builds governance type scripts for lifecycle smoke transactions. */
function governanceTypeScript(op: number, scopeHex = "0x"): any {
  return (ccc as any).Script.from({
    codeHash: GOVERNANCE_CODE_HASH,
    hashType: SCRIPT_HASH_TYPE,
    args: encodeOpArgs(op, scopeHex),
  });
}

/** @notice Builds the governance shard script bound to a poll and shard id. */
function tallyShardScript(pollTypeHash: string, shardId: number): any {
  const shardIdBytes = new Uint8Array(4);
  shardIdBytes[0] = shardId & 0xff;
  shardIdBytes[1] = (shardId >> 8) & 0xff;
  shardIdBytes[2] = (shardId >> 16) & 0xff;
  shardIdBytes[3] = (shardId >> 24) & 0xff;
  return governanceTypeScript(0x07, `${pollTypeHash}${ccc.hexFrom(shardIdBytes).slice(2)}`);
}

/** @notice Poll cells are protocol-locked so force-close can be permissionless after grace. */
function pollLockScript(pollTypeHash: string): any {
  return governanceTypeScript(0x04, pollTypeHash);
}

/** @notice Builds governance code cell dep. */
function governanceCellDep() {
  return {
    outPoint: {
      txHash: GOVERNANCE_SCRIPT_TX_HASH,
      index: 0,
    },
    depType: "code",
  };
}

/** @notice Estimates output capacity from serialized script and data size. */
function estimateOutputCapacity(lockScript: any, typeScript: any | undefined, dataBytes: number): bigint {
  const lockBytes = (ccc as any).Script.from(lockScript).toBytes().length;
  const typeBytes = typeScript ? (ccc as any).Script.from(typeScript).toBytes().length : 0;
  const occupiedBytes = 8 + lockBytes + typeBytes + dataBytes + 32;
  return BigInt(occupiedBytes) * SHANNONS_PER_CKB;
}

/** @notice Resolves chain tip epoch in bigint format across client variants. */
async function getTipEpoch(client: any): Promise<bigint> {
  if (typeof client.getTipEpoch === "function") {
    return epochNumber(await client.getTipEpoch());
  }

  const tipHeader = await client.getTipHeader();
  return epochNumber(tipHeader.epoch);
}

/** @notice Waits until a transaction is committed on chain. */
async function waitForTx(client: any, txHash: string): Promise<void> {
  const committed = await client.waitTransaction(txHash, 0, 90_000, 3000);
  if (!committed) {
    throw new Error(`Timed out waiting for committed transaction ${txHash}`);
  }
}

async function attachCommittedOrigin(client: any, cell: CellRef): Promise<CellRef> {
  const resolved = await client.getCellWithHeader(cell.outPoint);
  const header = resolved?.header;
  if (!header?.hash || header.epoch == null) {
    throw new Error(`Cell ${outPointKey(cell)} is not committed with a resolvable creation header`);
  }
  return {
    ...cell,
    creationBlockHash: String(header.hash),
    creationEpoch: epochNumber(header.epoch),
  };
}

/** @notice Finds a signer-owned auth cell suitable for fee/change handling. */
async function findSignerAuthCell(signer: any, excludedOutPoints: string[] = []): Promise<any> {
  const signerAddress = await signer.getAddressObjSecp256k1();
  for await (const cell of signer.client.findCells({
    script: signerAddress.script,
    scriptType: "lock",
    scriptSearchMode: "exact",
  })) {
    const outPointKey = `${cell.outPoint.txHash}:${Number(cell.outPoint.index)}`;
    if (excludedOutPoints.includes(outPointKey)) {
      continue;
    }

    const type = cell.cellOutput?.type ?? cell.output?.type;
    const outputData = (cell.outputData ?? "0x") as string;
    if (!type && (outputData === "0x" || outputData === "0x0" || outputData.length <= 2)) {
      return cell;
    }
  }

  throw new Error("No plain CKB cell is available for signer auth. Fund this wallet with a plain CKB cell and retry.");
}

/** @notice Normalizes script field casing into molecule encoded-script shape. */
function normalizeScript(script: any): EncodedScript {
  return {
    code_hash: script.code_hash ?? script.codeHash,
    hash_type: script.hash_type ?? script.hashType,
    args: script.args,
  };
}

/**
 * @notice Runs a full governance lifecycle smoke flow on testnet.
 * @dev Covers create poll, create intent, shard aggregation, delegation, and revoke.
 */
async function main(): Promise<void> {
  console.log("=== Governance Smoke Test ===");
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Governance code hash: ${GOVERNANCE_CODE_HASH}`);
  console.log(`Governance script tx: ${GOVERNANCE_SCRIPT_TX_HASH}`);

  const client = new ccc.ClientPublicTestnet({ url: RPC_URL, fallbacks: [RPC_URL] as any });
  const signer = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY);
  const signerAddress = await signer.getAddressObjSecp256k1();
  const currentEpoch = await getTipEpoch(client);
  const signerLockHash = lockHashBytes(signerAddress.script);
  const smokeLabel = randomBytes(4).toString("hex");
  const typeIdSeedCell = await findSignerAuthCell(signer);
  const typeIdSeedKey = outPointKey(typeIdSeedCell);
  const pollTypeId = derivePollTypeIdFromSeedInput(typeIdSeedCell, 0);
  const pollType = governanceTypeScript(0x01, pollTypeId);
  const pollTypeHash = scriptHash(pollType);
  const pollLock = pollLockScript(pollTypeHash);
  const shardCount = DEFAULT_SHARD_COUNT;

  console.log(`Signer: ${signerAddress.toString()}`);
  console.log(`Smoke label: ${smokeLabel}`);

  const pollData: PollData = {
    question: `Smoke poll ${smokeLabel}`,
    options: ["Yes", "No"],
    vote_counts: [0n, 0n],
    deadline: currentEpoch + 5n,
    creator: signerLockHash,
    creator_lock: normalizeScript(signerAddress.script),
    is_closed: false,
    total_voters: 0n,
    creator_deposit: CREATOR_DEPOSIT_SHANNONS,
    pending_intent_count: 0n,
    counted_voter_lock_hashes: [],
    token_weighted: false,
    udt_type_hash: new Uint8Array(32),
    shard_count: shardCount,
  };
  const pollBytes = encodePollData(pollData);
  const pollCapacity =
    CREATOR_DEPOSIT_SHANNONS +
    estimateOutputCapacity(pollLock, pollType, pollBytes.length);
  const shardOutputs = Array.from({ length: shardCount }, (_, shardId) => {
    const shardScript = tallyShardScript(pollTypeHash, shardId);
    const shardData = encodeTallyShardData({
      poll_type_hash: (ccc as any).bytesFrom(pollTypeHash),
      shard_id: shardId,
      shard_count: shardCount,
      vote_counts: pollData.options.map(() => 0n),
      total_voters: 0n,
      counted_voter_lock_hashes: [],
      finalized: false,
    });
    const capacity = [
      TALLY_SHARD_MIN_SHANNONS,
      estimateOutputCapacity(shardScript, shardScript, shardData.length),
    ].reduce((max, current) => (current > max ? current : max), 0n);
    return {
      output: {
        lock: shardScript,
        type: shardScript,
        capacity,
      },
      data: ccc.hexFrom(shardData),
    };
  });

  const createPollTx = ccc.Transaction.from({
    cellDeps: [governanceCellDep()],
    inputs: [{ previousOutput: getOutPoint(typeIdSeedCell), since: 0 }],
    outputs: [
      {
        lock: pollLock,
        type: pollType,
        capacity: pollCapacity,
      },
      ...shardOutputs.map((item) => item.output),
    ],
    outputsData: [ccc.hexFrom(pollBytes), ...shardOutputs.map((item) => item.data)],
  });
  await createPollTx.completeInputsByCapacity(signer);
  assertPinnedInput0(createPollTx, typeIdSeedKey);
  await createPollTx.completeFeeBy(signer, 1000);
  assertPinnedInput0(createPollTx, typeIdSeedKey);
  await signer.signTransaction(createPollTx);
  const createPollHash = await client.sendTransaction(createPollTx);
  await waitForTx(client, createPollHash);
  console.log(`CREATE_POLL: ${createPollHash}`);

  const pollCell: CellRef = {
    outPoint: { txHash: createPollHash, index: 0 },
    cellOutput: {
      lock: pollLock,
      type: pollType,
      capacity: pollCapacity,
    },
    outputData: ccc.hexFrom(pollBytes),
  };

  const intentType = governanceTypeScript(0x02, pollTypeHash);
  const intentData: VoteIntentData = {
    poll_type_hash: (ccc as any).bytesFrom(pollTypeHash),
    voter_lock_hash: signerLockHash,
    option_index: 0,
    voted_at_epoch: 0n,
    aggregated: false,
    refund_lock: normalizeScript(signerAddress.script),
  };
  const intentBytes = encodeVoteIntentData(intentData);
  const intentCapacity = estimateOutputCapacity(intentType, intentType, intentBytes.length);
  const intentAuthCell = await findSignerAuthCell(signer, [
    `${pollCell.outPoint.txHash}:${pollCell.outPoint.index}`,
  ]);
  const intentAuthCapacity = BigInt((intentAuthCell.cellOutput ?? intentAuthCell.output).capacity);
  const intentFeeReserve = 1_000_000n;
  const intentChangeCapacity = intentAuthCapacity - intentCapacity - intentFeeReserve;
  if (intentChangeCapacity <= 0n) {
    throw new Error("Intent auth cell does not have enough capacity for change");
  }

  const createIntentTx = ccc.Transaction.from({
    cellDeps: [
      governanceCellDep(),
      {
        outPoint: pollCell.outPoint,
        depType: "code",
      },
    ],
    inputs: [
      {
        previousOutput: {
          txHash: intentAuthCell.outPoint.txHash,
          index: Number(intentAuthCell.outPoint.index),
        },
      },
    ],
    outputs: [
      {
        lock: intentType,
        type: intentType,
        capacity: intentCapacity > VOTER_DEPOSIT_SHANNONS ? intentCapacity : VOTER_DEPOSIT_SHANNONS,
      },
      {
        lock: signerAddress.script,
        capacity: intentChangeCapacity,
      },
    ],
    outputsData: [ccc.hexFrom(intentBytes), "0x"],
    witnesses: [
      (ccc as any).WitnessArgs.from({
        inputType: new Uint8Array([0]),
      }).toBytes(),
    ],
  });
  await signer.signTransaction(createIntentTx);
  const createIntentHash = await client.sendTransaction(createIntentTx);
  await waitForTx(client, createIntentHash);
  console.log(`CREATE_VOTE_INTENT: ${createIntentHash}`);

  const intentCell = await attachCommittedOrigin(client, {
    outPoint: { txHash: createIntentHash, index: 0 },
    cellOutput: {
      lock: intentType,
      type: intentType,
      capacity: intentCapacity > VOTER_DEPOSIT_SHANNONS ? intentCapacity : VOTER_DEPOSIT_SHANNONS,
    },
    outputData: ccc.hexFrom(intentBytes),
  });
  if ((intentCell.creationEpoch ?? pollData.deadline + 1n) > pollData.deadline) {
    throw new Error("Smoke intent was committed after the poll deadline and cannot aggregate");
  }

  const shardCell: CellRef = {
    outPoint: { txHash: createPollHash, index: 1 },
    cellOutput: shardOutputs[0].output,
    outputData: shardOutputs[0].data,
  };
  const beforeShard = decodeTallyShardData((ccc as any).bytesFrom(shardCell.outputData));
  const updatedShardBytes = encodeTallyShardData({
    ...beforeShard,
    vote_counts: [1n, 0n],
    total_voters: 1n,
    counted_voter_lock_hashes: [signerLockHash],
    finalized: false,
  });
  const aggregatedIntentBytes = encodeVoteIntentData({ ...intentData, aggregated: true });
  const aggregateFeeCell = await findSignerAuthCell(signer, [
    `${pollCell.outPoint.txHash}:${pollCell.outPoint.index}`,
    `${shardCell.outPoint.txHash}:${shardCell.outPoint.index}`,
    `${intentCell.outPoint.txHash}:${intentCell.outPoint.index}`,
  ]);

  const aggregateTx = ccc.Transaction.from({
    cellDeps: [
      governanceCellDep(),
      {
        outPoint: pollCell.outPoint,
        depType: "code",
      },
    ],
    headerDeps: [intentCell.creationBlockHash!],
    inputs: [
      { previousOutput: shardCell.outPoint },
      { previousOutput: intentCell.outPoint },
      {
        previousOutput: {
          txHash: aggregateFeeCell.outPoint.txHash,
          index: Number(aggregateFeeCell.outPoint.index),
        },
      },
    ],
    outputs: [
      {
        lock: shardCell.cellOutput.lock,
        type: shardCell.cellOutput.type,
        capacity: shardCell.cellOutput.capacity,
      },
      {
        lock: intentType,
        type: intentType,
        capacity: intentCell.cellOutput.capacity,
      },
    ],
    outputsData: [ccc.hexFrom(updatedShardBytes), ccc.hexFrom(aggregatedIntentBytes)],
    witnesses: ["0x", "0x", "0x"],
  });
  await aggregateTx.completeFeeBy(signer, 1000);
  await signer.signTransaction(aggregateTx);
  const aggregateHash = await client.sendTransaction(aggregateTx);
  await waitForTx(client, aggregateHash);
  console.log(`CREATE_TALLY_SHARD aggregate: ${aggregateHash}`);

  const aggregatedShardCell: CellRef = {
    outPoint: { txHash: aggregateHash, index: 0 },
    cellOutput: {
      lock: shardCell.cellOutput.lock,
      type: shardCell.cellOutput.type,
      capacity: shardCell.cellOutput.capacity,
    },
    outputData: ccc.hexFrom(updatedShardBytes),
  };
  console.log("Shard aggregation complete; final close requires post-deadline shard finalization.");
  console.log(`Aggregated shard outpoint: ${aggregatedShardCell.outPoint.txHash}:${aggregatedShardCell.outPoint.index}`);

  console.log("CLOSE_POLL is not sent in this immediate smoke run: sharded close requires post-deadline shard finalization.");
  console.log("Large sharded polls additionally require MERGE_TALLY_SHARDS and final merge-result close coverage, which this smoke does not automate yet.");

  const delegateTarget = randomBytes(32);
  delegateTarget[0] ^= 0xff;
  const delegationBytes = encodeDelegationData({
    delegator_lock_hash: signerLockHash,
    delegate_lock_hash: delegateTarget,
    poll_type_hash: new Uint8Array(32),
    expires_epoch: 0n,
  });
  const delegationType = governanceTypeScript(0x05, `0x${"00".repeat(32)}`);
  const delegationCapacity = estimateOutputCapacity(signerAddress.script, delegationType, delegationBytes.length);
  const delegateTx = ccc.Transaction.from({
    cellDeps: [governanceCellDep()],
    outputs: [
      {
        lock: signerAddress.script,
        type: delegationType,
        capacity: delegationCapacity > DELEGATION_MIN_SHANNONS ? delegationCapacity : DELEGATION_MIN_SHANNONS,
      },
    ],
    outputsData: [ccc.hexFrom(delegationBytes)],
  });
  await delegateTx.completeInputsByCapacity(signer);
  await delegateTx.completeFeeBy(signer, 1000);
  await signer.signTransaction(delegateTx);
  const delegateHash = await client.sendTransaction(delegateTx);
  await waitForTx(client, delegateHash);
  console.log(`DELEGATE: ${delegateHash}`);

  const revokeTx = ccc.Transaction.from({
    cellDeps: [governanceCellDep()],
    inputs: [{ previousOutput: { txHash: delegateHash, index: 0 } }],
    outputs: [
      {
        lock: signerAddress.script,
        capacity: delegationCapacity > DELEGATION_MIN_SHANNONS ? delegationCapacity : DELEGATION_MIN_SHANNONS,
      },
    ],
    outputsData: ["0x"],
    witnesses: ["0x"],
  });
  await revokeTx.completeInputsByCapacity(signer);
  await revokeTx.completeFeeBy(signer, 1000);
  await signer.signTransaction(revokeTx);
  const revokeHash = await client.sendTransaction(revokeTx);
  await waitForTx(client, revokeHash);
  console.log(`Delegation revocation (0x05 lifecycle): ${revokeHash}`);

  const decodedAggregatedIntent = decodeVoteIntentData(aggregatedIntentBytes);
  if (!decodedAggregatedIntent.aggregated) {
    throw new Error("Aggregated intent should decode as aggregated");
  }

  console.log("=== Smoke test complete ===");
}

main().catch((error) => {
  console.error("Smoke failed:", error);
  process.exit(1);
});
