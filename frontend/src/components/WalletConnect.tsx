/**
 * WalletConnect.tsx
 * =================
 * Wallet controls for connection state, balance, and lock hash preview.
 */

import React, { useState } from "react";
import { useCKB } from "../hooks/useCKB";
import { shannonsToCkb } from "../lib/ckb";

export function WalletConnect() {
  const { address, lockScriptHash, balance, isConnected, isLoading, connect, disconnect, error } = useCKB();
  const [copyFeedback, setCopyFeedback] = useState<"idle" | "copied" | "failed">("idle");

  const handleCopyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopyFeedback("copied");
      setTimeout(() => setCopyFeedback("idle"), 1500);
    } catch {
      setCopyFeedback("failed");
      setTimeout(() => setCopyFeedback("idle"), 1500);
    }
  };

  if (isLoading) {
    return (
      <div className="wallet-address-pill">
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--teal)",
            animation: "pulse 1.5s infinite",
            display: "inline-block",
          }}
        />
        <span style={{ fontSize: 12, color: "var(--ink-2)" }}>Connecting...</span>
      </div>
    );
  }

  if (!isConnected || !address) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
        <button
          onClick={connect}
          className="btn-primary"
          style={{ borderRadius: 9999, padding: "9px 20px", fontSize: 12, letterSpacing: "0.06em" }}
        >
          Connect Wallet
        </button>
        {error && <div style={{ fontSize: 11, color: "var(--red)", maxWidth: 260, textAlign: "right" }}>{error}</div>}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
      <div className="wallet-address-pill">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.3 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Available Balance
          </span>
          <span style={{ fontWeight: 600, color: "var(--teal)", fontSize: 13 }}>
            {shannonsToCkb(balance)} CKB
          </span>
        </div>
      </div>

      <div
        className="wallet-address-pill"
        style={{ flexDirection: "column", alignItems: "flex-end", gap: 2, borderRadius: 10, padding: "8px 14px" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--teal)", display: "inline-block" }} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink)" }}>
            {address.slice(0, 10)}...{address.slice(-6)}
          </span>
          <button
            onClick={handleCopyAddress}
            className="btn-quiet"
            style={{ padding: "4px 8px", fontSize: 10, borderRadius: 9999, lineHeight: 1 }}
            title="Copy full wallet address"
          >
            {copyFeedback === "copied" ? "Copied" : copyFeedback === "failed" ? "Retry" : "Copy"}
          </button>
        </div>
        {lockScriptHash && (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>
            lock {lockScriptHash.slice(0, 12)}...{lockScriptHash.slice(-8)}
          </div>
        )}
      </div>

      <button
        onClick={disconnect}
        className="btn-danger"
        style={{ borderRadius: 9999, padding: "8px 16px", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase" }}
      >
        Disconnect
      </button>
    </div>
  );
}
