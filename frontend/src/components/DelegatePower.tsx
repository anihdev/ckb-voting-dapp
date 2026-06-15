/**
 * DelegatePower Component
 * =======================
 * Creates and revokes delegation cells for the connected wallet.
 */

import React, { useEffect, useState } from "react";
import { DelegateParams, DelegationRecord, TxState } from "../lib/types";
import { TxStatus } from "./TxStatus";

interface Props {
  delegations: DelegationRecord[];
  txState: TxState;
  onDelegate: (params: DelegateParams) => Promise<string>;
  onRevoke: (delegationId: string) => Promise<string>;
  prefillPollScope?: { pollId: string; requestId: number } | null;
}

export function DelegatePower({ delegations, txState, onDelegate, onRevoke, prefillPollScope = null }: Props) {
  const [delegateLockHash, setDelegateLockHash] = useState("");
  const [pollId, setPollId] = useState("");
  const [expiresEpoch, setExpiresEpoch] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!prefillPollScope?.pollId) return;
    setPollId(prefillPollScope.pollId);
    setError(null);
  }, [prefillPollScope?.pollId, prefillPollScope?.requestId]);

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
    <section className="card-shell">
      <div className="mb-4">
        <h2 className="section-title">Delegation</h2>
        <p className="subtle mt-1 text-sm">
          Delegation authorizes another address to create intents for you (globally or per poll). Delegated voting uses the live delegation cell as a read-only cell dep; only the delegator can revoke by consuming the delegation cell.
        </p>
        <p className="subtle mt-2 text-sm">
          Delegation cells lock at least 61 CKB and may require more occupied capacity depending on script size.
        </p>
        <p className="subtle mt-2 text-sm">
          Tip: use <strong>Copy Poll ID</strong> or <strong>Delegate for this poll</strong> from Poll Registry to prefill poll scope quickly.
        </p>
      </div>

      <form onSubmit={submitDelegation} className="space-y-4">
        <div>
          <label className="label">Delegate address or lock hash</label>
          <input
            value={delegateLockHash}
            onChange={(event) => setDelegateLockHash(event.target.value)}
            placeholder="ckt1... or 0x..."
            className="input"
          />
          <div className="hint">
            Paste a normal CKB address and the app will derive the required lock hash automatically.
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="label">Poll scope</label>
            <input
              value={pollId}
              onChange={(event) => setPollId(event.target.value)}
              placeholder="Leave empty for global delegation"
              className="input"
            />
          </div>

          <div>
            <label className="label">Expiry epoch</label>
            <input
              value={expiresEpoch}
              onChange={(event) => setExpiresEpoch(event.target.value)}
              placeholder="0 for no expiry"
              className="input"
            />
          </div>
        </div>

        {error && (
          <div className="alert alert-error">
            {error}
          </div>
        )}

        {txState.status !== "idle" && <TxStatus txState={txState} />}

        <button
          type="submit"
          className="btn-primary"
        >
          Create Delegation
        </button>
      </form>

      <div className="mt-6">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.16em] subtle">Active delegations</h3>
        {delegations.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--line)] px-4 py-6 text-sm subtle">
            No active delegations indexed for this wallet.
          </div>
        ) : (
          <div className="space-y-3">
            {delegations.map((delegation) => (
              <div key={delegation.id} className="rounded-xl border border-[var(--line)] bg-[var(--surface-soft)] px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-[var(--ink)]">
                      {delegation.isDelegator
                        ? `Delegate: ${delegation.delegateLockHash.slice(0, 14)}...`
                        : `Delegator: ${delegation.delegatorLockHash.slice(0, 14)}...`}
                    </div>
                    <div className="mt-1 text-xs subtle">
                      Scope: {delegation.pollId ?? "Global"} | Expiry: {delegation.expiresEpoch.toString()}
                    </div>
                  </div>
                  {delegation.isDelegator ? (
                    <button
                      onClick={() => onRevoke(delegation.id)}
                      className="btn-danger"
                    >
                      Revoke
                    </button>
                  ) : (
                    <span className="status-pill status-active">Authority only</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
