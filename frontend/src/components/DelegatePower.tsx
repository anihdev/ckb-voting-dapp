/**
 * DelegatePower Component
 * =======================
 * Creates and revokes delegation cells for the connected wallet.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { DelegateParams, DelegationRecord, Poll, TxState } from "../lib/types";
import {
  canDelegateForPoll,
  getDelegationLifecycle,
  summarizeDelegations,
} from "../lib/protocolUi";
import { areTransactionControlsLocked } from "../lib/txLifecycle";
import { TxStatus } from "./TxStatus";

interface Props {
  delegations: DelegationRecord[];
  /** Indexed polls, used to resolve each delegation's scope to a lifecycle. */
  polls: Poll[];
  currentEpoch: bigint;
  viewerLockHash: string | null;
  txState: TxState;
  actionInFlight: boolean;
  onDelegate: (params: DelegateParams) => Promise<string>;
  onRevoke: (delegationId: string) => Promise<string>;
  prefillPollScope?: { pollId: string; requestId: number } | null;
}

export function DelegatePower({
  delegations,
  polls,
  currentEpoch,
  viewerLockHash,
  txState,
  actionInFlight,
  onDelegate,
  onRevoke,
  prefillPollScope = null,
}: Props) {
  // Derived from the prefill so an arriving "Delegate for this poll" request
  // renders open immediately instead of flashing the collapsed panel first.
  const [expanded, setExpanded] = useState(Boolean(prefillPollScope?.pollId));
  const [delegateLockHash, setDelegateLockHash] = useState("");
  const [pollId, setPollId] = useState(prefillPollScope?.pollId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  // Only render lifecycle status for transactions this panel started, but lock
  // controls on any in-flight transaction: the hook permits one at a time.
  const ownsTxState = txState.scope?.kind === "delegation";
  const isBusy = submitting || areTransactionControlsLocked(txState, actionInFlight);

  // A live delegation cell is not usable authority. Resolve every cell against
  // the indexed polls so the panel can separate authorities that can still
  // create an intent from cells that are recovery/revocation-only.
  const summary = useMemo(
    () => summarizeDelegations(delegations, polls, currentEpoch),
    [currentEpoch, delegations, polls]
  );
  const lifecycles = useMemo(
    () =>
      delegations.map((delegation) => ({
        delegation,
        lifecycle: getDelegationLifecycle(delegation, polls, currentEpoch),
      })),
    [currentEpoch, delegations, polls]
  );
  // New delegations need a poll that would actually accept one. Without a
  // delegatable poll, creation is disabled while management stays available.
  const hasDelegatablePoll = useMemo(
    () => polls.some((poll) => canDelegateForPoll(poll, viewerLockHash, currentEpoch)),
    [currentEpoch, polls, viewerLockHash]
  );
  const canSubmitNew = hasDelegatablePoll && !isBusy;

  useEffect(() => {
    if (!expanded || isBusy) return;

    // The panel may fold without resetting its draft. Keep it open while any
    // transaction is in flight so wallet and confirmation status stay visible.
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || panelRef.current?.contains(target)) return;
      setExpanded(false);
    };

    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
  }, [expanded, isBusy]);

  useEffect(() => {
    if (!prefillPollScope?.pollId) return;
    setPollId(prefillPollScope.pollId);
    setError(null);
    // "Delegate for this poll" scrolls here, so the form has to be open on arrival.
    setExpanded(true);
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

  const summaryText = (
    <>
      <p className="subtle mt-1 text-sm">
        Delegation authorizes another address to create an intent for you on one poll. The live delegation cell is used as a read-only cell dep; only the delegator can revoke it.
      </p>
      <p className="subtle mt-2 text-sm">
        Delegation cells lock at least 61 CKB and may require more occupied capacity depending on script size.
      </p>
    </>
  );

  if (!expanded) {
    return (
      <section className="card-shell">
        <h2 className="section-title">Delegation</h2>
        {summaryText}
        {delegations.length > 0 && (
          <p className="mt-3 text-sm" style={{ color: "var(--ink)" }}>
            {summary.total.toString()} delegation cell{summary.total === 1 ? "" : "s"} indexed:{" "}
            {summary.usable.toString()} usable{" "}
            {summary.usable === 1 ? "authority" : "authorities"},{" "}
            {summary.recoveryOnly.toString()} recovery or revocation only
            {summary.revocableByViewer > 0
              ? `, ${summary.revocableByViewer.toString()} revocable by you`
              : ""}
            .
          </p>
        )}
        {!hasDelegatablePoll && (
          <p className="subtle mt-2 text-sm">
            No indexed poll can accept a new delegation right now. Existing cells stay listed and
            revocable.
          </p>
        )}
        {ownsTxState && txState.status !== "idle" && (
          <div className="mt-3">
            <TxStatus txState={txState} />
          </div>
        )}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="btn-primary mt-4"
        >
          Create Delegation
        </button>
      </section>
    );
  }

  return (
    <section ref={panelRef} className="card-shell">
      <div className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="section-title">Delegation</h2>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            disabled={isBusy}
            className="btn-quiet px-3 py-1.5 text-xs uppercase"
          >
            Close
          </button>
        </div>
        {summaryText}
        <div className="alert alert-warn mt-3 text-sm">
          Governance Testnet v1 funding policy: the delegate funds a delegated intent, while its exact capacity refund returns to the delegator. A grant deliverable is scoped to address this.
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

        {!hasDelegatablePoll && (
          <div className="alert alert-warn text-sm">
            No indexed poll can accept a new delegation right now. A poll must be open, before its
            deadline, and not created by this wallet. Existing cells below stay manageable.
          </div>
        )}

        {ownsTxState && txState.status !== "idle" && <TxStatus txState={txState} />}

        <button
          type="submit"
          disabled={!canSubmitNew}
          className="btn-primary"
        >
          {isBusy ? "Processing..." : "Create Delegation"}
        </button>
      </form>

      <div className="mt-6">
        <h3 className="mb-3 text-sm font-semibold uppercase subtle">Indexed delegation cells</h3>
        {lifecycles.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--line)] px-4 py-6 text-sm subtle">
            No delegation cells indexed for this wallet.
          </div>
        ) : (
          <div className="space-y-3">
            {lifecycles.map(({ delegation, lifecycle }) => (
              <div key={delegation.id} className="rounded-xl border border-[var(--line)] bg-[var(--surface-soft)] px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-[var(--ink)]">
                      {delegation.isDelegator
                        ? `Delegate: ${delegation.delegateLockHash.slice(0, 14)}...`
                        : `Delegator: ${delegation.delegatorLockHash.slice(0, 14)}...`}
                    </div>
                    <div className="mt-1 text-xs subtle">
                      Scope:{" "}
                      {lifecycle.state === "legacy-global"
                        ? "Testnet legacy global (no poll scope)"
                        : delegation.pollId}{" "}
                      | Revocation-based
                    </div>
                    <div className="mt-1 text-xs subtle">{lifecycle.detail}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`status-pill ${lifecycle.usable ? "status-active" : "status-pill-warn"}`}
                    >
                      {lifecycle.label}
                    </span>
                    {lifecycle.revocableByViewer ? (
                      // Revocation stays available on expired and closed scoped
                      // cells: recovering the locked capacity is the delegator's
                      // only remaining action once authority is unusable.
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
                      // Delegates hold authority, not ownership, so no revoke
                      // action is offered to them at all.
                      <span className="text-xs subtle">Delegated to you; only the delegator can revoke</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
