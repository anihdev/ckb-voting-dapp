/**
 * Seed Script
 * ===========
 * Creates a small set of live demo polls on CKB testnet so the hosted app has
 * meaningful data immediately after deployment.
 */

import { ccc } from "@ckb-ccc/core";
import { randomBytes } from "crypto";
import { decodePollData, encodePollData } from "../../frontend/src/lib/molecule";
import {
  RPC_URL,
  assertRpcUrl,
  requireGovernanceHashes,
  requirePrivateKey,
} from "./config";

const PRIVATE_KEY = requirePrivateKey();
const { codeHash: GOVERNANCE_CODE_HASH, scriptTxHash: GOVERNANCE_SCRIPT_TX_HASH } = requireGovernanceHashes();
const CREATOR_DEPOSIT_SHANNONS = 500n * 100_000_000n;
const SHANNONS_PER_CKB = 100_000_000n;
const SCRIPT_HASH_TYPE = "data1";

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

/** @notice Estimates minimum occupied capacity from data size. */
function estimateCellCapacity(dataBytes: number, extraScriptBytes = 61): bigint {
  return BigInt(dataBytes + extraScriptBytes) * SHANNONS_PER_CKB;
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

/** @notice Seeds demo polls for hosted frontend smoke and UX validation. */
async function main(): Promise<void> {
  console.log("=== CKB Governance Seeder ===");
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Governance code hash: ${GOVERNANCE_CODE_HASH}`);

  const client = new ccc.ClientPublicTestnet({ url: RPC_URL });
  const signer = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY);
  const signerAddress = await signer.getAddressObjSecp256k1();
  const tipHeader = await client.getTipHeader();
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

    const pollData = encodePollData({
      question: poll.question,
      options: poll.options,
      vote_counts: poll.options.map(() => 0n),
      deadline: currentEpoch + BigInt(poll.durationEpochs),
      creator: creatorLockHash,
      is_closed: false,
      total_voters: 0n,
      creator_deposit: CREATOR_DEPOSIT_SHANNONS,
      pending_intent_count: 0n,
      counted_voter_lock_hashes: [],
      token_weighted: false,
      udt_type_hash: new Uint8Array(32),
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
      // The governance script reads the current epoch from header deps.
      headerDeps: [tipHeader.hash],
      outputs: [
        {
          lock: signerAddress.script,
          type: ccc.Script.from({
            codeHash: GOVERNANCE_CODE_HASH,
            hashType: SCRIPT_HASH_TYPE,
            args: `0x01${randomBytes(32).toString("hex")}`,
          }),
          capacity: CREATOR_DEPOSIT_SHANNONS + estimateCellCapacity(pollData.length),
        },
      ],
      outputsData: [ccc.hexFrom(pollData)],
    });

    await tx.completeInputsByCapacity(signer);
    await tx.completeFeeBy(signer, 1000);
    await signer.signTransaction(tx);
    const txHash = await client.sendTransaction(tx);

    console.log(`Seeded poll ${index + 1}/${DEMO_POLLS.length}: ${txHash}`);
    existingPolls.add(pollKey);
  }

  console.log("=== Seeding complete ===");
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
