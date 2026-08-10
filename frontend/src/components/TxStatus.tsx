/**
 * TxStatus.tsx
 * ============
 * Displays operation-state progress and explorer traceability for transactions.
 */

import React from "react";
import { TxState } from "../lib/types";

interface Props {
  txState: TxState;
}

const EXPLORER_BASE = "https://pudge.explorer.nervos.org/transaction";

const STEPS: Array<{ key: TxState["status"]; label: string }> = [
  { key: "building", label: "Building" },
  { key: "signing", label: "Signing" },
  { key: "sending", label: "Broadcasting" },
  { key: "confirming", label: "Confirming" },
  { key: "success", label: "Confirmed" },
];

function mapTxErrorToUserMessage(rawError: string | null): { message: string; faucetRecommended: boolean } {
  if (!rawError) {
    return { message: "Check capacity, authority, and lifecycle constraints, then retry.", faucetRecommended: false };
  }
  const normalized = rawError.toLowerCase();
  if (
    normalized.includes("no signer auth cell") ||
    normalized.includes("insufficient") ||
    normalized.includes("not enough") ||
    normalized.includes("capacity")
  ) {
    return { message: "Insufficient CKB balance. Fund your wallet and retry.", faucetRecommended: true };
  }
  return { message: "Check capacity, authority, and lifecycle constraints, then retry.", faucetRecommended: false };
}

export function TxStatus({ txState }: Props) {
  const { status, txHash, error } = txState;
  if (status === "idle") return null;

  if (status === "error") {
    const { message, faucetRecommended } = mapTxErrorToUserMessage(error);
    return (
      <div className="alert alert-error" style={{ display: "flex", gap: 12 }}>
        <span style={{ fontSize: 16, color: "var(--red)", lineHeight: 1 }}>x</span>
        <div>
          <div style={{ fontWeight: 600, color: "var(--red)" }}>Transaction failed</div>
          <div style={{ fontSize: 11, marginTop: 3 }}>{message}</div>
          {faucetRecommended && (
            <a
              href="https://faucet.nervos.org/"
              target="_blank"
              rel="noopener noreferrer"
              title="Open the Nervos CKB testnet faucet"
              style={{ display: "inline-block", marginTop: 4, fontSize: 11, color: "var(--teal)", textDecoration: "underline" }}
            >
              Get CKB testnet tokens (Nervos Faucet)
            </a>
          )}
          {error && message !== error && (
            <div style={{ fontSize: 11, marginTop: 2, fontFamily: "var(--font-mono)" }}>{error}</div>
          )}
        </div>
      </div>
    );
  }

  if (status === "unconfirmed") {
    return (
      <div
        className="alert"
        style={{
          display: "flex",
          gap: 12,
          borderColor: "var(--amber)",
          background: "var(--amber-dim)",
        }}
      >
        <span style={{ fontSize: 16, color: "var(--amber)", lineHeight: 1 }}>!</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, color: "var(--amber)" }}>Confirmation not verified</div>
          <div style={{ fontSize: 11, marginTop: 3 }}>
            The transaction was broadcast, but the app did not observe it committed before the confirmation timeout.
          </div>
          {error && (
            <div style={{ fontSize: 11, marginTop: 3, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
              {error}
            </div>
          )}
          {txHash && (
            <a
              href={`${EXPLORER_BASE}/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Inspect this unconfirmed transaction on the CKB testnet explorer"
              style={{ display: "inline-block", marginTop: 5, color: "var(--teal)", fontSize: 11 }}
            >
              Check transaction on Explorer -&gt;
            </a>
          )}
        </div>
      </div>
    );
  }

  const currentStep = STEPS.findIndex((step) => step.key === status);

  return (
    <div
      style={{
        background: "var(--surface-2)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-md)",
        padding: "14px 16px",
      }}
    >
      <div className="tx-track">
        {STEPS.map((step, index) => {
          const done = index < currentStep;
          const current = index === currentStep;

          return (
            <React.Fragment key={step.key}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  color: current ? "var(--teal)" : done ? "rgba(0,200,151,0.6)" : "var(--ink-3)",
                }}
              >
                <div
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: done || current ? "var(--teal)" : "var(--surface-3)",
                    border: done || current ? "none" : "1px solid var(--line-2)",
                    animation: current ? "pulse 1.5s infinite" : "none",
                  }}
                />
                <span className="tx-step-label">{step.label}</span>
              </div>

              {index < STEPS.length - 1 && (
                <div
                  style={{
                    flex: 1,
                    height: 1,
                    background: index < currentStep ? "rgba(0,200,151,0.4)" : "var(--line)",
                  }}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {txHash && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--ink-3)",
          }}
        >
          <span>TX:</span>
          <span style={{ color: "var(--ink-2)" }}>{txHash.slice(0, 20)}...</span>
          <a
            href={`${EXPLORER_BASE}/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Inspect this transaction on the CKB testnet explorer"
            style={{ marginLeft: "auto", color: "var(--teal)", textDecoration: "none", fontSize: 11 }}
          >
            View on Explorer -&gt;
          </a>
        </div>
      )}

      {status === "success" && (
        <div style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--teal)" }}>
          Transaction committed on CKB.
        </div>
      )}
    </div>
  );
}
