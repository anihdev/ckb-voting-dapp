/// This script is used to check the balances of all roles' accounts with CKB for testing purposes.

import { ccc } from '@ckb-ccc/core';
import { config as load } from 'dotenv';
import * as path from 'path';
load({ path: path.resolve(__dirname, '../../.env') });

const rpc = process.env.CKB_RPC_URL || process.env.VITE_CKB_RPC_URL || 'https://testnet.ckb.dev/';
const client = new ccc.ClientPublicTestnet({ url: rpc, fallbacks: [rpc] as any });

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

const roles: Array<[string, string]> = [
  ['CKB_PRIVATE_KEY', req('CKB_PRIVATE_KEY')],
  ['CREATOR_PRIVATE_KEY', req('CREATOR_PRIVATE_KEY')],
  ...req('VOTER_PRIVATE_KEYS').split(',').map((v, i) => [`VOTER_${i+1}`, v.trim()] as [string,string]),
  ['AGGREGATOR_PRIVATE_KEY', req('AGGREGATOR_PRIVATE_KEY')],
  ['FORCE_CLOSER_PRIVATE_KEY', req('FORCE_CLOSER_PRIVATE_KEY')],
];

(async () => {
  for (const [name, key] of roles) {
    const signer = new ccc.SignerCkbPrivateKey(client, key);
    const addr = await signer.getAddressObjSecp256k1();
    const bal = BigInt(await signer.getBalance());
    console.log(`${name}\t${addr.toString()}\t${bal}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
