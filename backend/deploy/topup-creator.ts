import { ccc } from '@ckb-ccc/core';
import { config as load } from 'dotenv';
import * as path from 'path';
load({ path: path.resolve(__dirname, '../../.env') });

const rpc = process.env.CKB_RPC_URL || process.env.VITE_CKB_RPC_URL || 'https://testnet.ckb.dev/rpc';
const client = new ccc.ClientPublicTestnet({ url: rpc, fallbacks: [rpc] as any });

const creatorKey = (process.env.CREATOR_PRIVATE_KEY || '').trim();
const voterKeys = (process.env.VOTER_PRIVATE_KEYS || '').split(',').map((v) => v.trim()).filter(Boolean);
if (!creatorKey || voterKeys.length < 2) throw new Error('Missing keys in .env');

const from = new ccc.SignerCkbPrivateKey(client, voterKeys[1]);
const to = new ccc.SignerCkbPrivateKey(client, creatorKey);

async function waitForTx(txHash: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const tx = await client.getTransaction(txHash);
    if (tx) return;
  }
  throw new Error(`Timed out waiting for ${txHash}`);
}

async function withRpcRetry<T>(label: string, task: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const message = String((error as any)?.message ?? error).toLowerCase();
      const retryable =
        message.includes("fetch failed") ||
        message.includes("timeout") ||
        message.includes("eai_again");
      if (!retryable || attempt === 5) break;
      console.log(`[topup-rpc-retry] ${label} attempt ${attempt}/5 failed`);
      await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
    }
  }
  throw lastError;
}

(async () => {
  const toAddr = await withRpcRetry("to.getAddress", () => to.getAddressObjSecp256k1());
  const amount = 1200n * 100_000_000n;
  const tx = ccc.Transaction.from({ outputs: [{ lock: toAddr.script, capacity: amount }], outputsData: ['0x'] });
  await withRpcRetry("completeInputsByCapacity", () => tx.completeInputsByCapacity(from));
  await withRpcRetry("completeFeeBy", () => tx.completeFeeBy(from, 1000));
  await withRpcRetry("signTransaction", () => from.signTransaction(tx));
  const txHash = await withRpcRetry("sendTransaction", () => client.sendTransaction(tx));
  console.log(`TOPUP_TX=${txHash}`);
  console.log(`TOPUP_AMOUNT_SHANNONS=${amount}`);
  await waitForTx(txHash);
  console.log(`TOPUP_CONFIRMED=${txHash}`);
})();
