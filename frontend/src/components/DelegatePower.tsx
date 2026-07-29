/**
 * DelegatePower Component
 * =======================
 * Creates and revokes delegation cells for the connected wallet.
 */

import React, { useEffect, useState } from "react";
import { DelegateParams, DelegationRecord, TxState } from "../lib/types";
import { isTransactionInFlight } from "../lib/txLifecycle";
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
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const isBusy = submitting || isTransactionInFlight(txState.status);

  useEffect(() => {
    if (!prefillPollScope?.pollId) return;
    setPollId(prefillPollScope.pollId);
    setError(null);
  }, [prefillPollScope?.pollId, prefillPollScope?.requestId]);

  const submitDelegation = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!pollId.trim()) {
      setError("Poll scope is required for new delegations");
      return;
    }
    setSubmitting(true);

    try {
      await onDelegate({
        delegateLockHash: delegateLockHash.trim(),
        pollId: pollId.trim(),
      });
      setDelegateLockHash("");
      setPollId("");
    } catch (caughtError: any) {
      setError(caughtError.message ?? "Delegation failed");
    } finally {
      setSubmitting(false);
    }
  };

  const revokeDelegation = async (delegationId: string) => {
    setError(null);
    setSubmitting(true);
    try {
      await onRevoke(delegationId);
    } catch (caughtError: any) {
      setError(caughtError.message ?? "Delegation revocation failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card-shell">
      <div className="mb-4">
        <h2 className="section-title">Delegation</h2>
        <p className="subtle mt-1 text-sm">
          Delegation authorizes another address to create an intent for you on one poll. The live delegation cell is used as a read-only cell dep; only the delegator can revoke it.
        </p>
        <p className="subtle mt-2 text-sm">
          Delegation cells lock at least 61 CKB and may require more occupied capacity depending on script size.
        </p>
        <div className="alert alert-warn mt-3 text-sm">
          Governance Testnet v1 funding policy: the delegate funds a delegated intent, while its exact capacity refund returns to the delegator. Grant deliverables is scoped to adress this.
        </div>
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
            disabled={isBusy}
          />
          <div className="hint">
            Paste a normal CKB address and the app will derive the required lock hash automatically.
          </div>
        </div>

        <div>
          <div>
            <label className="label">Poll scope</label>
            <input
              value={pollId}
              onChange={(event) => setPollId(event.target.value)}
              placeholder="Paste the poll ID"
              className="input"
              required
              disabled={isBusy}
            />
            <div className="hint">
              New global delegations are disabled in the UI. Existing testnet v1 global cells remain visible and revocable.
            </div>
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
          disabled={isBusy}
          className="btn-primary"
        >
          {isBusy ? "Processing..." : "Create Delegation"}
        </button>
      </form>

      <div className="mt-6">
        <h3 className="mb-3 text-sm font-semibold uppercase subtle">Active delegations</h3>
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
                      Scope: {delegation.pollId ?? "Legacy testnet global"} | Revocation-based
                    </div>
                  </div>
                  {delegation.isDelegator ? (
                    <button
                      type="button"
                      onClick={() => {
                        void revokeDelegation(delegation.id);
                      }}
                      disabled={isBusy}
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
