/**
 * DelegatePower Component
 * =======================
 * Creates and revokes delegation cells for the connected wallet.
 */

import React, { useState } from "react";
import { DelegateParams, DelegationRecord, TxState } from "../lib/types";
import { TxStatus } from "./TxStatus";

interface Props {
  delegations: DelegationRecord[];
  txState: TxState;
  onDelegate: (params: DelegateParams) => Promise<string>;
  onRevoke: (delegationId: string) => Promise<string>;
}

export function DelegatePower({ delegations, txState, onDelegate, onRevoke }: Props) {
  const [delegateLockHash, setDelegateLockHash] = useState("");
  const [pollId, setPollId] = useState("");
  const [expiresEpoch, setExpiresEpoch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submitDelegation = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    try {
      await onDelegate({
        delegateLockHash: delegateLockHash.trim(),
        pollId: pollId.trim() || undefined,
        expiresEpoch: expiresEpoch.trim() ? BigInt(expiresEpoch.trim()) : undefined,
      });
      setDelegateLockHash("");
      setPollId("");
      setExpiresEpoch("");
    } catch (caughtError: any) {
      setError(caughtError.message ?? "Delegation failed");
    }
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-gray-800">Delegation</h2>
        <p className="mt-1 text-sm text-gray-500">
          Delegate voting power globally or to a specific poll. Delegation cells lock at least 61 CKB and may require more occupied capacity depending on script size.
        </p>
      </div>

      <form onSubmit={submitDelegation} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Delegate address or lock hash</label>
          <input
            value={delegateLockHash}
            onChange={(event) => setDelegateLockHash(event.target.value)}
            placeholder="ckt1... or 0x..."
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="mt-1 text-xs text-gray-500">
            Paste a normal CKB address and the app will derive the required lock hash automatically.
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Poll scope</label>
            <input
              value={pollId}
              onChange={(event) => setPollId(event.target.value)}
              placeholder="Leave empty for global delegation"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Expiry epoch</label>
            <input
              value={expiresEpoch}
              onChange={(event) => setExpiresEpoch(event.target.value)}
              placeholder="0 for no expiry"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </div>
        )}

        {txState.status !== "idle" && <TxStatus txState={txState} />}

        <button
          type="submit"
          className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-700"
        >
          Create Delegation
        </button>
      </form>

      <div className="mt-6">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Active delegations</h3>
        {delegations.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 px-4 py-6 text-sm text-gray-400">
            No active delegations indexed for this wallet.
          </div>
        ) : (
          <div className="space-y-3">
            {delegations.map((delegation) => (
              <div key={delegation.id} className="rounded-lg border border-gray-200 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-gray-800">
                      Delegate: {delegation.delegateLockHash.slice(0, 14)}...
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      Scope: {delegation.pollId ?? "Global"} | Expiry: {delegation.expiresEpoch.toString()}
                    </div>
                  </div>
                  <button
                    onClick={() => onRevoke(delegation.id)}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600 transition-colors hover:border-red-300 hover:text-red-500"
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
