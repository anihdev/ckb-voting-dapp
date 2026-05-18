/**
 * Multi-Actor Setup Script
 * ========================
 * Prepares funded signer roles for multi-party smoke testing:
 * creator (from CKB_PRIVATE_KEY), multiple voters, aggregator, and force-closer.
 *
 * Writes role keys back into repo-root .env:
 * - CREATOR_PRIVATE_KEY (if missing, from CKB_PRIVATE_KEY)
 * - VOTER_PRIVATE_KEYS (comma-separated)
 * - AGGREGATOR_PRIVATE_KEY
 * - FORCE_CLOSER_PRIVATE_KEY
 *
 * Existing non-empty role keys are preserved.
 */

import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ccc } from "@ckb-ccc/core";
import {
  RPC_URL,
  assertHex32,
  assertRpcUrl,
  requirePrivateKey,
} from "./config";

const SHANNONS_PER_CKB = 100_000_000n;
const MIN_SECP_CELL_SHANNONS = 61n * SHANNONS_PER_CKB;
const DEFAULT_VOTER_COUNT = 4;
const DEFAULT_VOTER_FUND_CKB = 520n;
const DEFAULT_AGGREGATOR_FUND_CKB = 420n;
const DEFAULT_FORCE_CLOSER_FUND_CKB = 220n;
const DEFAULT_EXTRA_FEE_BUFFER_CKB = 40n;
const ROLE_LABEL = "[multi-actor-setup]";

type RoleKeyBundle = {
  creator: string;
  voters: string[];
  aggregator: string;
  forceCloser: string;
};

assertRpcUrl(RPC_URL, "CKB RPC URL");

function envPath(): string {
  return path.resolve(__dirname, "../../.env");
}

function normalizeHex32(key: string, label: string): string {
  return assertHex32(key.trim(), label).toLowerCase();
}

function generatePrivateKey(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

function parseEnv(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    result.set(key, value);
  }
  return result;
}

function upsertEnvValue(original: string, key: string, value: string): string {
  const lines = original.split(/\r?\n/);
  let replaced = false;
  const updated = lines.map((line) => {
    if (!line.trim().startsWith(`${key}=`)) return line;
    replaced = true;
    return `${key}=${value}`;
  });
  if (!replaced) updated.push(`${key}=${value}`);
  return `${updated.join("\n").replace(/\n*$/, "\n")}`;
}

function parseExistingRoleKeys(envMap: Map<string, string>, creatorFallback: string): RoleKeyBundle {
  const creator = normalizeHex32(
    envMap.get("CREATOR_PRIVATE_KEY") || creatorFallback,
    envMap.get("CREATOR_PRIVATE_KEY") ? "CREATOR_PRIVATE_KEY" : "CKB_PRIVATE_KEY"
  );

  const existingVotersRaw = envMap.get("VOTER_PRIVATE_KEYS") || "";
  const voters = existingVotersRaw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item, index) => normalizeHex32(item, `VOTER_PRIVATE_KEYS[${index}]`));

  const aggregator = envMap.get("AGGREGATOR_PRIVATE_KEY")
    ? normalizeHex32(envMap.get("AGGREGATOR_PRIVATE_KEY") as string, "AGGREGATOR_PRIVATE_KEY")
    : "";
  const forceCloser = envMap.get("FORCE_CLOSER_PRIVATE_KEY")
    ? normalizeHex32(envMap.get("FORCE_CLOSER_PRIVATE_KEY") as string, "FORCE_CLOSER_PRIVATE_KEY")
    : "";

  return { creator, voters, aggregator, forceCloser };
}

function shouldForceRotateRoleKeys(): boolean {
  const raw = process.env.MULTI_ACTOR_FORCE_NEW_KEYS?.trim();
  return raw === "1" || raw?.toLowerCase() === "true";
}

function ensureDistinctOrThrow(keys: string[]): void {
  const lowered = keys.map((key) => key.toLowerCase());
  if (new Set(lowered).size !== lowered.length) {
    throw new Error("Role key collision detected. Ensure each role uses a unique private key.");
  }
}

async function waitForTx(client: any, txHash: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const tx = await client.getTransaction(txHash);
    if (tx) return;
  }
  throw new Error(`Timed out waiting for ${txHash}`);
}

function ckbToShannons(ckb: bigint): bigint {
  return ckb * SHANNONS_PER_CKB;
}

function readPositiveBigintEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  try {
    const value = BigInt(raw);
    if (value <= 0n) throw new Error("must be > 0");
    return value;
  } catch {
    throw new Error(`${name} must be a positive integer CKB amount`);
  }
}

async function ensureMinimumBalance(
  fundingSigner: any,
  targetSigner: any,
  targetLabel: string,
  minBalanceShannons: bigint
): Promise<void> {
  const targetBalance = BigInt(await targetSigner.getBalance());
  if (targetBalance >= minBalanceShannons) {
    console.log(`${ROLE_LABEL} ${targetLabel} already funded: ${targetBalance} shannons`);
    return;
  }

  const topUp = minBalanceShannons - targetBalance;
  // A plain secp256k1 lock-only output still needs >= 61 CKB occupied capacity.
  const transferCapacity = topUp >= MIN_SECP_CELL_SHANNONS ? topUp : MIN_SECP_CELL_SHANNONS;
  const targetAddress = await targetSigner.getAddressObjSecp256k1();
  const tx = ccc.Transaction.from({
    outputs: [{
      lock: targetAddress.script,
      capacity: transferCapacity,
    }],
    outputsData: ["0x"],
  });
  await tx.completeInputsByCapacity(fundingSigner);
  await tx.completeFeeBy(fundingSigner, 1000);
  await fundingSigner.signTransaction(tx);
  const txHash = await fundingSigner.client.sendTransaction(tx);
  console.log(`${ROLE_LABEL} funded ${targetLabel}: +${transferCapacity} shannons (${txHash})`);
  await waitForTx(fundingSigner.client, txHash);
}

async function main(): Promise<void> {
  const creatorFallback = normalizeHex32(requirePrivateKey(), "CKB_PRIVATE_KEY");
  const file = envPath();
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const envMap = parseEnv(existing);
  const requestedVoterCountRaw = process.env.MULTI_ACTOR_VOTER_COUNT?.trim();
  const requestedVoterCount = requestedVoterCountRaw ? Number(requestedVoterCountRaw) : DEFAULT_VOTER_COUNT;
  const voterCount = Number.isFinite(requestedVoterCount) && requestedVoterCount >= 3
    ? Math.floor(requestedVoterCount)
    : DEFAULT_VOTER_COUNT;
  const rotateKeys = shouldForceRotateRoleKeys();
  const voterFundCkb = readPositiveBigintEnv("MULTI_ACTOR_VOTER_FUND_CKB", DEFAULT_VOTER_FUND_CKB);
  const aggregatorFundCkb = readPositiveBigintEnv(
    "MULTI_ACTOR_AGGREGATOR_FUND_CKB",
    DEFAULT_AGGREGATOR_FUND_CKB
  );
  const forceCloserFundCkb = readPositiveBigintEnv(
    "MULTI_ACTOR_FORCE_CLOSER_FUND_CKB",
    DEFAULT_FORCE_CLOSER_FUND_CKB
  );
  const extraFeeBufferCkb = readPositiveBigintEnv(
    "MULTI_ACTOR_EXTRA_FEE_BUFFER_CKB",
    DEFAULT_EXTRA_FEE_BUFFER_CKB
  );

  const bundle = parseExistingRoleKeys(envMap, creatorFallback);
  if (rotateKeys) {
    bundle.voters = [];
    bundle.aggregator = "";
    bundle.forceCloser = "";
  }

  while (bundle.voters.length < voterCount) {
    bundle.voters.push(generatePrivateKey());
  }
  if (bundle.voters.length > voterCount) {
    bundle.voters = bundle.voters.slice(0, voterCount);
  }
  if (!bundle.aggregator) bundle.aggregator = generatePrivateKey();
  if (!bundle.forceCloser) bundle.forceCloser = generatePrivateKey();

  ensureDistinctOrThrow([bundle.creator, bundle.aggregator, bundle.forceCloser, ...bundle.voters]);

  let updatedEnv = existing;
  updatedEnv = upsertEnvValue(updatedEnv, "CREATOR_PRIVATE_KEY", bundle.creator);
  updatedEnv = upsertEnvValue(updatedEnv, "VOTER_PRIVATE_KEYS", bundle.voters.join(","));
  updatedEnv = upsertEnvValue(updatedEnv, "AGGREGATOR_PRIVATE_KEY", bundle.aggregator);
  updatedEnv = upsertEnvValue(updatedEnv, "FORCE_CLOSER_PRIVATE_KEY", bundle.forceCloser);
  fs.writeFileSync(file, updatedEnv, "utf8");
  console.log(`${ROLE_LABEL} role keys written to ${file}${rotateKeys ? " (rotated)" : ""}`);

  const client = new ccc.ClientPublicTestnet({ url: RPC_URL });
  const creatorSigner = new ccc.SignerCkbPrivateKey(client, bundle.creator);
  const creatorBalance = BigInt(await creatorSigner.getBalance());
  const requiredForRoles =
    ckbToShannons(voterFundCkb) * BigInt(bundle.voters.length) +
    ckbToShannons(aggregatorFundCkb) +
    ckbToShannons(forceCloserFundCkb) +
    ckbToShannons(extraFeeBufferCkb);

  if (creatorBalance < requiredForRoles) {
    throw new Error(
      `Creator balance too low for role setup. Need at least ${requiredForRoles} shannons, have ${creatorBalance}.`
    );
  }

  for (let index = 0; index < bundle.voters.length; index += 1) {
    const voterSigner = new ccc.SignerCkbPrivateKey(client, bundle.voters[index]);
    await ensureMinimumBalance(
      creatorSigner,
      voterSigner,
      `voter[${index}]`,
      ckbToShannons(voterFundCkb)
    );
  }

  const aggregatorSigner = new ccc.SignerCkbPrivateKey(client, bundle.aggregator);
  await ensureMinimumBalance(
    creatorSigner,
    aggregatorSigner,
    "aggregator",
    ckbToShannons(aggregatorFundCkb)
  );

  const forceCloserSigner = new ccc.SignerCkbPrivateKey(client, bundle.forceCloser);
  await ensureMinimumBalance(
    creatorSigner,
    forceCloserSigner,
    "force-closer",
    ckbToShannons(forceCloserFundCkb)
  );

  console.log(
    `${ROLE_LABEL} setup complete. Voters=${bundle.voters.length}, voterFund=${voterFundCkb} CKB, aggregatorFund=${aggregatorFundCkb} CKB, forceCloserFund=${forceCloserFundCkb} CKB`
  );
}

main().catch((error) => {
  console.error(`${ROLE_LABEL} failed:`, error);
  process.exit(1);
});
