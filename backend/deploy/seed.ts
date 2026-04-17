/**
 * Seed Script
 * ===========
 * Creates a small set of live demo polls on CKB testnet so the hosted app has
 * meaningful data immediately after deployment.
 */

import { ccc } from "@ckb-ccc/core";
import { encodePollData } from "../contract/src/molecule";
import { RPC_URL } from "./config";

const PRIVATE_KEY = process.env.CKB_PRIVATE_KEY;
const GOVERNANCE_CODE_HASH = process.env.GOVERNANCE_CODE_HASH ?? process.env.VITE_GOVERNANCE_CODE_HASH;
const GOVERNANCE_SCRIPT_TX_HASH = process.env.GOVERNANCE_SCRIPT_TX_HASH ?? process.env.VITE_GOVERNANCE_SCRIPT_TX_HASH;
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

if (!PRIVATE_KEY) {
  console.error("Set CKB_PRIVATE_KEY before running the seed script.");
  process.exit(1);
}

if (!GOVERNANCE_CODE_HASH || !/^0x[0-9a-fA-F]{64}$/.test(GOVERNANCE_CODE_HASH)) {
  console.error("Set GOVERNANCE_CODE_HASH or VITE_GOVERNANCE_CODE_HASH to the deployed governance code hash.");
  process.exit(1);
}

if (!GOVERNANCE_SCRIPT_TX_HASH || !/^0x[0-9a-fA-F]{64}$/.test(GOVERNANCE_SCRIPT_TX_HASH)) {
  console.error("Set GOVERNANCE_SCRIPT_TX_HASH or VITE_GOVERNANCE_SCRIPT_TX_HASH to the deployment transaction hash.");
  process.exit(1);
}

function estimateCellCapacity(dataBytes: number, extraScriptBytes = 61): bigint {
  return BigInt(dataBytes + extraScriptBytes) * SHANNONS_PER_CKB;
}

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

async function main(): Promise<void> {
  console.log("=== CKB Governance Seeder ===");
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Governance code hash: ${GOVERNANCE_CODE_HASH}`);

  const client = new ccc.ClientPublicTestnet({ url: RPC_URL });
  const signer = new ccc.SignerCkbPrivateKey(client, PRIVATE_KEY);
  const signerAddress = await signer.getAddressObjSecp256k1();
  const currentEpoch = await getTipEpoch(client);
  const creatorLockHash = (ccc as any).bytesFrom(ccc.hashCkb(signerAddress.script.toBytes()));

  console.log(`Seeder address: ${signerAddress.toString()}`);

  for (const [index, poll] of DEMO_POLLS.entries()) {
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
      outputs: [
        {
          lock: signerAddress.script,
          type: ccc.Script.from({
            codeHash: GOVERNANCE_CODE_HASH,
            hashType: SCRIPT_HASH_TYPE,
            args: "0x01",
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
  }

  console.log("=== Seeding complete ===");
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
