import { ccc } from "@ckb-ccc/core";
  
  const RPC_URL = process.env.NEXT_PUBLIC_CKB_RPC_URL || "http://127.0.0.1:8114";
  
  export const cccClient = new ccc.ClientPublicTestnet({
    url: RPC_URL
  });
  
  export async function getBalance(address: string): Promise<bigint> {
    const addr = await ccc.Address.fromString(address, cccClient);
    return await cccClient.getBalance([addr.script]);
  }
  
  export async function getCurrentTip(): Promise<bigint> {
    const tip = await cccClient.getTip();
    return tip.blockNumber;
  }