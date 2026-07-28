/**
 * Seed Script
 * ===========
 * Creates a small set of live demo polls on CKB testnet so the hosted app has
 * meaningful data immediately after deployment.
 */

import { ccc } from "@ckb-ccc/core";
import { decodePollData, encodePollData, encodeTallyShardData } from "../../frontend/src/lib/molecule";
import {
  RPC_URL,
  assertRpcUrl,
  requireGovernanceHashes,
  requirePrivateKey,
} from "./config";
import { epochNumber } from "./epoch";
import { waitForCommittedTransaction } from "./tx-lifecycle";

const PRIVATE_KEY = requirePrivateKey();
const { codeHash: GOVERNANCE_CODE_HASH, scriptTxHash: GOVERNANCE_SCRIPT_TX_HASH } = requireGovernanceHashes();
const CREATOR_DEPOSIT_SHANNONS = 500n * 100_000_000n;
const SHANNONS_PER_CKB = 100_000_000n;
const TALLY_SHARD_MIN_SHANNONS = 61n * SHANNONS_PER_CKB;
const SCRIPT_HASH_TYPE = "data1";
const DEFAULT_SHARD_COUNT = 8;

const DEMO_POLLS = [
  {
    question: "Should CKB Governance adopt on-chain uniqueness for counted voters?",
    options: ["Ship it", "Audit first", "Keep off-chain only"],
    durationEpochs: 180,
  },
  {
    question: "Which roadmap item should be prioritized next?",
    options: ["xUDT-weighted voting", "Force-close recovery", "Spore proposal metadata"],
    durationEpochs: 220,
  },
];

assertRpcUrl(RPC_URL, "CKB RPC URL");

/** @notice Computes the script hash used for poll and shard identity binding. */
function scriptHash(script: any): string {
  return ccc.hexFrom((ccc as any).hashCkb((ccc as any).Script.from(script).toBytes()));
}

/** @notice Estimates occupied capacity from explicit lock/type/data sizes. */
function estimateOutputCapacity(lockScript: any, typeScript: any | undefined, dataBytes: number): bigint {
  const lockBytes = (ccc as any).Script.from(lockScript).toBytes().length;
  const typeBytes = typeScript ? (ccc as any).Script.from(typeScript).toBytes().length : 0;
  const occupiedBytes = 8 + lockBytes + typeBytes + dataBytes + 32;
  return BigInt(occupiedBytes) * SHANNONS_PER_CKB;
}

/** @notice Encodes operation args as `<op-byte><scope-bytes>`. */
function encodeOpArgs(op: number, scopeHex = "0x"): string {
  return `0x${op.toString(16).padStart(2, "0")}${scopeHex.replace(/^0x/, "")}`;
}

/** @notice Builds governance scripts for seeded poll and shard cells. */
function governanceScript(op: number, scopeHex = "0x"): any {
  return ccc.Script.from({
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
  return governanceScript(0x07, `${pollTypeHash}${ccc.hexFrom(shardIdBytes).slice(2)}`);
}

function pollLockScript(pollTypeHash: string): any {
  return governanceScript(0x04, pollTypeHash);
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

async function findSignerAuthCell(signer: any, excludedOutPoints: string[] = []): Promise<any> {
  for await (const cell of signer.client.findCells({
    script: (await signer.getAddressObjSecp256k1()).script,
    scriptType: "lock",
    scriptSearchMode: "exact",
  })) {
    const key = outPointKey(cell);
    if (excludedOutPoints.includes(key)) continue;

    const type = cell.cellOutput?.type ?? cell.output?.type;
    const outputData = (cell.outputData ?? "0x") as string;
    if (!type && (outputData === "0x" || outputData === "0x0" || outputData.length <= 2)) {
      return cell;
    }
  }

  throw new Error("No plain CKB cell is available for signer auth. Fund this wallet with a plain CKB cell and retry.");
}

/** @notice Resolves chain tip epoch in bigint format across client variants. */
async function getTipEpoch(client: any): Promise<bigint> {
  if (typeof client.getTipEpoch === "function") {
    return epochNumber(await client.getTipEpoch());
  }

  const tipHeader = await client.getTipHeader();
  return epochNumber(tipHeader.epoch);
}

/** @notice Seeds demo polls for hosted frontend smoke and UX validation. */
async function main(): Promise<void> {
  console.log("=== CKB Governance Seeder ===");
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Governance code hash: ${GOVERNANCE_CODE_HASH}`);

  const client = new ccc.ClientPublicTestnet({ url: RPC_URL, fallbacks: [RPC_URL] as any });
  const signer = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY);
  const signerAddress = await signer.getAddressObjSecp256k1();
  const currentEpoch = await getTipEpoch(client);
  const creatorLockHash = (ccc as any).bytesFrom(ccc.hashCkb(signerAddress.script.toBytes()));
  const pollScript = ccc.Script.from({
    codeHash: GOVERNANCE_CODE_HASH,
    hashType: SCRIPT_HASH_TYPE,
    args: "0x01",
  });

  console.log(`Seeder address: ${signerAddress.toString()}`);

  const existingPolls = new Set<string>();
  for await (const cell of client.findCells({
    script: pollScript,
    scriptType: "type",
    scriptSearchMode: "prefix",
  })) {
    try {
      const poll = decodePollData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
      const key = `${poll.question}::${poll.options.join("||")}`;
      existingPolls.add(key);
    } catch {
      // Ignore malformed or non-matching cells while scanning for known demos.
    }
  }

  for (const [index, poll] of DEMO_POLLS.entries()) {
    const pollKey = `${poll.question}::${poll.options.join("||")}`;
    if (existingPolls.has(pollKey)) {
      console.log(`Skipped poll ${index + 1}/${DEMO_POLLS.length}: already indexed on this deployment`);
      continue;
    }

    const shardCount = DEFAULT_SHARD_COUNT;
    const typeIdSeedCell = await findSignerAuthCell(signer);
    const typeIdSeedKey = outPointKey(typeIdSeedCell);
    const pollTypeId = derivePollTypeIdFromSeedInput(typeIdSeedCell, 0);
    const pollType = governanceScript(0x01, pollTypeId);
    const pollTypeHash = scriptHash(pollType);
    const pollLock = pollLockScript(pollTypeHash);
    const pollData = encodePollData({
      question: poll.question,
      options: poll.options,
      vote_counts: poll.options.map(() => 0n),
      deadline: currentEpoch + BigInt(poll.durationEpochs),
      creator: creatorLockHash,
      creator_lock: {
        code_hash: signerAddress.script.codeHash,
        hash_type: signerAddress.script.hashType,
        args: signerAddress.script.args,
      },
      is_closed: false,
      total_voters: 0n,
      creator_deposit: CREATOR_DEPOSIT_SHANNONS,
      pending_intent_count: 0n,
      counted_voter_lock_hashes: [],
      token_weighted: false,
      udt_type_hash: new Uint8Array(32),
      shard_count: shardCount,
    });
    const shardOutputs = Array.from({ length: shardCount }, (_, shardId) => {
      const shardScript = tallyShardScript(pollTypeHash, shardId);
      const shardData = encodeTallyShardData({
        poll_type_hash: (ccc as any).bytesFrom(pollTypeHash),
        shard_id: shardId,
        shard_count: shardCount,
        vote_counts: poll.options.map(() => 0n),
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

    const tx = ccc.Transaction.from({
      cellDeps: [
        {
          outPoint: {
            txHash: GOVERNANCE_SCRIPT_TX_HASH,
            index: 0,
          },
          depType: "code",
        },
      ],
      inputs: [{ previousOutput: getOutPoint(typeIdSeedCell), since: 0 }],
      outputs: [
        {
          lock: pollLock,
          type: pollType,
          capacity: CREATOR_DEPOSIT_SHANNONS + estimateOutputCapacity(pollLock, pollType, pollData.length),
        },
        ...shardOutputs.map((item) => item.output),
      ],
      outputsData: [ccc.hexFrom(pollData), ...shardOutputs.map((item) => item.data)],
    });

    await tx.completeInputsByCapacity(signer);
    assertPinnedInput0(tx, typeIdSeedKey);
    await tx.completeFeeBy(signer, 1000);
    assertPinnedInput0(tx, typeIdSeedKey);
    await signer.signTransaction(tx);
    const txHash = await client.sendTransaction(tx);
    await waitForCommittedTransaction(client, txHash);

    console.log(`Seeded poll ${index + 1}/${DEMO_POLLS.length}: ${txHash}`);
    existingPolls.add(pollKey);
  }

  console.log("=== Seeding complete ===");
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
