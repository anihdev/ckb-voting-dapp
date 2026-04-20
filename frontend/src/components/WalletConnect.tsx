/**
 * WalletConnect Component
 * =======================
 * Shows wallet connection state, address, and balance in the upgraded header.
 */

import React from "react";
import { useCKB } from "../hooks/useCKB";
import { shannonsToCkb } from "../lib/ckb";

export function WalletConnect() {
  const { address, lockScriptHash, balance, isConnected, isLoading, connect, disconnect, error } = useCKB();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-stone-300/70 bg-white/70 px-4 py-2 text-sm text-stone-600">
        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
        <span>Connecting...</span>
      </div>
    );
  }

  if (!isConnected || !address) {
    return (
      <div className="flex flex-col items-end gap-2">
        <button
          onClick={connect}
          className="rounded-full border border-stone-900 bg-stone-900 px-5 py-2.5 text-sm font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-stone-700"
        >
          Connect Wallet
        </button>
        {error && <div className="max-w-xs text-right text-xs text-rose-700">{error}</div>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      <div className="rounded-full border border-stone-300/70 bg-white/75 px-4 py-2 text-sm text-stone-700">
        <span className="font-semibold">{shannonsToCkb(balance)}</span>
        <span className="ml-1 text-stone-500">CKB</span>
      </div>

      <div className="rounded-full border border-stone-300/70 bg-white/75 px-4 py-2 text-right">
        <div className="flex items-center justify-end gap-2">
          <div className="h-2 w-2 rounded-full bg-emerald-500" />
          <span className="font-mono text-sm text-stone-700">
            {address.slice(0, 10)}...{address.slice(-6)}
          </span>
        </div>
        {lockScriptHash && (
          <div className="mt-1 font-mono text-[10px] text-stone-500">
            lock {lockScriptHash.slice(0, 14)}...{lockScriptHash.slice(-8)}
          </div>
        )}
      </div>

      <button
        onClick={disconnect}
        className="rounded-full border border-stone-300/70 bg-white/75 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500 transition hover:border-rose-300 hover:text-rose-600"
        title="Disconnect wallet"
      >
        Disconnect
      </button>
    </div>
  );
}
