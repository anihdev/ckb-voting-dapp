/**
 * Governance Smoke Script
 * =======================
 * Exercises the full Rust lifecycle on testnet with a private-key signer:
 * create poll, create vote intent, aggregate, close, and delegation
 * create/revoke. This validates the deployed contract without a browser wallet.
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
  encodeVoteIntentData,
} from "../../frontend/src/lib/molecule";
import {
  RPC_URL,
  assertRpcUrl,
  requireGovernanceHashes,
  requirePrivateKey,
} from "./config";

const PRIVATE_KEY = requirePrivateKey();
const { codeHash: GOVERNANCE_CODE_HASH, scriptTxHash: GOVERNANCE_SCRIPT_TX_HASH } = requireGovernanceHashes();
const SCRIPT_HASH_TYPE = "data1";
const CREATOR_DEPOSIT_SHANNONS = 500n * 100_000_000n;
const VOTER_DEPOSIT_SHANNONS = 61n * 100_000_000n;
const DELEGATION_MIN_SHANNONS = 61n * 100_000_000n;
const SHANNONS_PER_CKB = 100_000_000n;
const AGGREGATE_FEE_RESERVE_SHANNONS = 1_000_000n;
assertRpcUrl(RPC_URL, "CKB RPC URL");

type CellRef = {
  outPoint: { txHash: string; index: number };
  cellOutput: { lock: any; type?: any; capacity: bigint };
  outputData: string;
};

/** @notice Computes the script hash used for poll id and type binding checks. */
function scriptHash(script: any): string {
  return ccc.hexFrom((ccc as any).hashCkb((ccc as any).Script.from(script).toBytes()));
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
    const rawEpoch = await client.getTipEpoch();
    if (typeof rawEpoch === "bigint") return rawEpoch;
    if (typeof rawEpoch === "number") return BigInt(rawEpoch);
    if (typeof rawEpoch === "string") return BigInt(rawEpoch.split(",")[0]);
  }

  const tipHeader = await client.getTipHeader();
  return BigInt(String(tipHeader.epoch).split(",")[0]);
}

/** @notice Polls RPC until a transaction is indexed or times out. */
async function waitForTx(client: any, txHash: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const tx = await client.getTransaction(txHash);
    if (tx) return;
  }

  throw new Error(`Timed out waiting for ${txHash}`);
}

/** @notice Finds a signer-owned auth cell suitable for fee/change handling. */
async function findSignerAuthCell(signer: any, excludedOutPoints: string[] = []): Promise<any> {
  const signerAddress = await signer.getAddressObjSecp256k1();
  let fallbackCell: any | null = null;
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

    fallbackCell = fallbackCell ?? cell;
  }

  if (fallbackCell) {
    return fallbackCell;
  }

  throw new Error("No signer auth cell available");
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
 * @dev Covers create poll, create intent, pending replacement, aggregate, close, delegate, and revoke.
 */
async function main(): Promise<void> {
  console.log("=== Governance Smoke Test ===");
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Governance code hash: ${GOVERNANCE_CODE_HASH}`);
  console.log(`Governance script tx: ${GOVERNANCE_SCRIPT_TX_HASH}`);

  const client = new ccc.ClientPublicTestnet({ url: RPC_URL });
  const signer = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY);
  const signerAddress = await signer.getAddressObjSecp256k1();
  const tipHeader = await client.getTipHeader();
  const currentEpoch = await getTipEpoch(client);
  const signerLockHash = lockHashBytes(signerAddress.script);
  const smokeLabel = randomBytes(4).toString("hex");
  const pollScopeHex = `0x${randomBytes(32).toString("hex")}`;
  const pollType = governanceTypeScript(0x01, pollScopeHex);
  const pollTypeHash = scriptHash(pollType);

  console.log(`Signer: ${signerAddress.toString()}`);
  console.log(`Smoke label: ${smokeLabel}`);

  const pollData: PollData = {
    question: `Smoke poll ${smokeLabel}`,
    options: ["Yes", "No"],
    vote_counts: [0n, 0n],
    deadline: currentEpoch + 5n,
    creator: signerLockHash,
    is_closed: false,
    total_voters: 0n,
    creator_deposit: CREATOR_DEPOSIT_SHANNONS,
    pending_intent_count: 0n,
    counted_voter_lock_hashes: [],
    token_weighted: false,
    udt_type_hash: new Uint8Array(32),
  };
  const pollBytes = encodePollData(pollData);
  const pollCapacity =
    CREATOR_DEPOSIT_SHANNONS +
    estimateOutputCapacity(signerAddress.script, pollType, pollBytes.length);

  const createPollTx = ccc.Transaction.from({
    cellDeps: [governanceCellDep()],
    headerDeps: [tipHeader.hash],
    outputs: [
      {
        lock: signerAddress.script,
        type: pollType,
        capacity: pollCapacity,
      },
    ],
    outputsData: [ccc.hexFrom(pollBytes)],
  });
  await createPollTx.completeInputsByCapacity(signer);
  await createPollTx.completeFeeBy(signer, 1000);
  await signer.signTransaction(createPollTx);
  const createPollHash = await client.sendTransaction(createPollTx);
  await waitForTx(client, createPollHash);
  console.log(`CREATE_POLL: ${createPollHash}`);

  const pollCell: CellRef = {
    outPoint: { txHash: createPollHash, index: 0 },
    cellOutput: {
      lock: signerAddress.script,
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
    voted_at_epoch: currentEpoch,
    aggregated: false,
    refund_lock: normalizeScript(signerAddress.script),
  };
  const intentBytes = encodeVoteIntentData(intentData);
  const intentCapacity = estimateOutputCapacity(signerAddress.script, intentType, intentBytes.length);
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
    cellDeps: [governanceCellDep()],
    headerDeps: [tipHeader.hash],
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
        lock: signerAddress.script,
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

  const intentCell: CellRef = {
    outPoint: { txHash: createIntentHash, index: 0 },
    cellOutput: {
      lock: signerAddress.script,
      type: intentType,
      capacity: intentCapacity > VOTER_DEPOSIT_SHANNONS ? intentCapacity : VOTER_DEPOSIT_SHANNONS,
    },
    outputData: ccc.hexFrom(intentBytes),
  };

  // Replace the pending intent before aggregation to exercise direct-voter override.
  const replacementAuthCell = await findSignerAuthCell(signer, [
    `${pollCell.outPoint.txHash}:${pollCell.outPoint.index}`,
    `${intentCell.outPoint.txHash}:${intentCell.outPoint.index}`,
  ]);
  const replacementAuthCapacity = BigInt((replacementAuthCell.cellOutput ?? replacementAuthCell.output).capacity);
  const replacementFeeReserve = 1_000_000n;
  const replacementChangeCapacity = replacementAuthCapacity - replacementFeeReserve;
  if (replacementChangeCapacity <= 0n) {
    throw new Error("Replacement auth cell does not have enough capacity for change");
  }
  const replacedIntentData: VoteIntentData = {
    ...intentData,
    option_index: 1,
    voted_at_epoch: currentEpoch + 1n,
    aggregated: false,
  };
  const replacedIntentBytes = encodeVoteIntentData(replacedIntentData);

  const replaceIntentTx = ccc.Transaction.from({
    cellDeps: [
      governanceCellDep(),
      {
        outPoint: pollCell.outPoint,
        depType: "code",
      },
    ],
    headerDeps: [tipHeader.hash],
    inputs: [
      { previousOutput: intentCell.outPoint },
      {
        previousOutput: {
          txHash: replacementAuthCell.outPoint.txHash,
          index: Number(replacementAuthCell.outPoint.index),
        },
      },
    ],
    outputs: [
      {
        lock: signerAddress.script,
        type: intentType,
        capacity: intentCell.cellOutput.capacity,
      },
      {
        lock: signerAddress.script,
        capacity: replacementChangeCapacity,
      },
    ],
    outputsData: [ccc.hexFrom(replacedIntentBytes), "0x"],
    witnesses: [
      (ccc as any).WitnessArgs.from({
        inputType: new Uint8Array([1]),
      }).toBytes(),
      "0x",
    ],
  });
  await signer.signTransaction(replaceIntentTx);
  const replaceIntentHash = await client.sendTransaction(replaceIntentTx);
  await waitForTx(client, replaceIntentHash);
  console.log(`CREATE_VOTE_INTENT (override): ${replaceIntentHash}`);

  const replacedIntentCell: CellRef = {
    outPoint: { txHash: replaceIntentHash, index: 0 },
    cellOutput: {
      lock: signerAddress.script,
      type: intentType,
      capacity: intentCell.cellOutput.capacity,
    },
    outputData: ccc.hexFrom(replacedIntentBytes),
  };

  const aggregatedPollData: PollData = {
    ...pollData,
    vote_counts: [0n, 1n],
    total_voters: 1n,
    counted_voter_lock_hashes: [signerLockHash],
  };
  const aggregatedPollBytes = encodePollData(aggregatedPollData);
  const aggregatedIntentBytes = encodeVoteIntentData({ ...replacedIntentData, aggregated: true });
  const aggregatedPollMinCapacity = estimateOutputCapacity(
    signerAddress.script,
    pollType,
    aggregatedPollBytes.length
  );
  const aggregatedPollCandidateCapacity = pollCell.cellOutput.capacity - AGGREGATE_FEE_RESERVE_SHANNONS;
  const aggregatedPollCapacity = aggregatedPollCandidateCapacity > aggregatedPollMinCapacity
    ? aggregatedPollCandidateCapacity
    : aggregatedPollMinCapacity;

  const aggregateTx = ccc.Transaction.from({
    cellDeps: [governanceCellDep()],
    headerDeps: [tipHeader.hash],
    inputs: [
      { previousOutput: pollCell.outPoint },
      { previousOutput: replacedIntentCell.outPoint },
    ],
    outputs: [
      {
        lock: signerAddress.script,
        type: pollType,
        capacity: aggregatedPollCapacity,
      },
      {
        lock: signerAddress.script,
        type: intentType,
        capacity: intentCapacity > VOTER_DEPOSIT_SHANNONS ? intentCapacity : VOTER_DEPOSIT_SHANNONS,
      },
    ],
    outputsData: [ccc.hexFrom(aggregatedPollBytes), ccc.hexFrom(aggregatedIntentBytes)],
    witnesses: ["0x", "0x"],
  });
  await signer.signTransaction(aggregateTx);
  const aggregateHash = await client.sendTransaction(aggregateTx);
  await waitForTx(client, aggregateHash);
  console.log(`AGGREGATE_VOTES: ${aggregateHash}`);

  const aggregatedPollCell: CellRef = {
    outPoint: { txHash: aggregateHash, index: 0 },
    cellOutput: {
      lock: signerAddress.script,
      type: pollType,
      capacity: aggregatedPollCapacity,
    },
    outputData: ccc.hexFrom(aggregatedPollBytes),
  };
  const aggregatedIntentCell: CellRef = {
    outPoint: { txHash: aggregateHash, index: 1 },
    cellOutput: {
      lock: signerAddress.script,
      type: intentType,
      capacity: replacedIntentCell.cellOutput.capacity,
    },
    outputData: ccc.hexFrom(aggregatedIntentBytes),
  };

  const creatorAuthCell = await findSignerAuthCell(signer, [
    `${aggregatedPollCell.outPoint.txHash}:${aggregatedPollCell.outPoint.index}`,
    `${aggregatedIntentCell.outPoint.txHash}:${aggregatedIntentCell.outPoint.index}`,
  ]);

  const closedPollBytes = encodePollData({
    ...aggregatedPollData,
    is_closed: true,
  });
  const closedPollMinCapacity = estimateOutputCapacity(
    signerAddress.script,
    pollType,
    closedPollBytes.length
  );
  const closedPollCandidateCapacity = aggregatedPollCell.cellOutput.capacity - CREATOR_DEPOSIT_SHANNONS;
  const closedPollCapacity = closedPollCandidateCapacity > closedPollMinCapacity
    ? closedPollCandidateCapacity
    : closedPollMinCapacity;
  const closeTx = ccc.Transaction.from({
    cellDeps: [governanceCellDep()],
    inputs: [
      { previousOutput: aggregatedPollCell.outPoint },
      { previousOutput: { txHash: creatorAuthCell.outPoint.txHash, index: Number(creatorAuthCell.outPoint.index) } },
      { previousOutput: aggregatedIntentCell.outPoint },
    ],
    outputs: [
      {
        lock: signerAddress.script,
        type: pollType,
        capacity: closedPollCapacity,
      },
      {
        lock: signerAddress.script,
        capacity: CREATOR_DEPOSIT_SHANNONS,
      },
      {
        lock: signerAddress.script,
        capacity: aggregatedIntentCell.cellOutput.capacity,
      },
    ],
    outputsData: [ccc.hexFrom(closedPollBytes), "0x", "0x"],
    witnesses: ["0x", "0x", "0x"],
  });
  await closeTx.completeInputsByCapacity(signer);
  await closeTx.completeFeeBy(signer, 1000);
  await signer.signTransaction(closeTx);
  const closeHash = await client.sendTransaction(closeTx);
  await waitForTx(client, closeHash);
  console.log(`CLOSE_POLL: ${closeHash}`);

  const delegateTarget = randomBytes(32);
  delegateTarget[0] ^= 0xff;
  const delegationBytes = encodeDelegationData({
    delegator_lock_hash: signerLockHash,
    delegate_lock_hash: delegateTarget,
    poll_type_hash: new Uint8Array(32),
    expires_epoch: 0n,
  });
  const delegationType = governanceTypeScript(0x05, "0x");
  const delegationCapacity = estimateOutputCapacity(signerAddress.script, delegationType, delegationBytes.length);
  const delegateTx = ccc.Transaction.from({
    cellDeps: [governanceCellDep()],
    headerDeps: [tipHeader.hash],
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
  console.log(`REVOKE_DELEGATION: ${revokeHash}`);

  // --- Permissionless close example (not executed by default) ---
  // The Rust contract now treats force-close as a strict CLOSE_POLL mode:
  // any caller can close after `deadline + FORCE_CLOSE_GRACE_EPOCHS` as long
  // as all pending intent refunds are included. The tx below demonstrates that
  // recovery flow and is not sent by default. To send it from this script, set
  // `FORCE_CLOSE_NOW=1` (not recommended on public testnet unless you
  // understand the epoch timing and refund requirements).
  async function buildForceCloseTxExample() {
    const closedPollBytes = encodePollData({
      ...aggregatedPollData,
      is_closed: true,
      pending_intent_count: 0n,
    });

    const closedPollMinCapacity = estimateOutputCapacity(
      signerAddress.script,
      pollType,
      closedPollBytes.length
    );
    const closedPollCandidateCapacity = aggregatedPollCell.cellOutput.capacity - CREATOR_DEPOSIT_SHANNONS;
    const closedPollCapacity = closedPollCandidateCapacity > closedPollMinCapacity
      ? closedPollCandidateCapacity
      : closedPollMinCapacity;

    const forceCloseTx = ccc.Transaction.from({
      cellDeps: [governanceCellDep()],
      headerDeps: [tipHeader.hash],
      inputs: [
        { previousOutput: aggregatedPollCell.outPoint },
        { previousOutput: aggregatedIntentCell.outPoint },
      ],
      outputs: [
        {
          lock: pollCell.cellOutput.lock, // return closed poll to the original creator lock
          type: pollType,
          capacity: closedPollCapacity,
        },
        {
          lock: pollCell.cellOutput.lock, // creator deposit return goes to the creator lock
          capacity: CREATOR_DEPOSIT_SHANNONS,
        },
        {
          lock: signerAddress.script, // placeholder for voter deposit return(s)
          capacity: aggregatedIntentCell.cellOutput.capacity,
        },
      ],
      outputsData: [ccc.hexFrom(closedPollBytes), "0x", "0x"],
      witnesses: ["0x", "0x", "0x"],
    });

    await forceCloseTx.completeInputsByCapacity(signer);
    await forceCloseTx.completeFeeBy(signer, 1000);
    return forceCloseTx;
  }

  if (process.env.FORCE_CLOSE_NOW === "1") {
    console.log("Building and sending force-close transaction (FORCE_CLOSE_NOW=1)...");
    buildForceCloseTxExample().then(async (tx) => {
      await signer.signTransaction(tx);
      const hash = await client.sendTransaction(tx);
      await waitForTx(client, hash);
      console.log(`FORCE_CLOSE: ${hash}`);
    }).catch((err) => {
      console.error("Force-close failed:", err);
    });
  }

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
