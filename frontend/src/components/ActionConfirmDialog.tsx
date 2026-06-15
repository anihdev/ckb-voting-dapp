/**
 * ActionConfirmDialog.tsx
 * =======================
 * Countdown confirmation modal for sensitive state-changing actions.
 */

import React, { useEffect, useRef, useState } from "react";

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  countdownSeconds?: number;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ActionConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  countdownSeconds = 10,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const [remaining, setRemaining] = useState(countdownSeconds);
  const cancelRef = useRef(onCancel);

  useEffect(() => {
    cancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    if (!open) {
      setRemaining(countdownSeconds);
      return;
    }

    setRemaining(countdownSeconds);
    const endAtMs = Date.now() + countdownSeconds * 1000;
    const updateRemaining = () => {
      const leftMs = endAtMs - Date.now();
      if (leftMs <= 0) {
        setRemaining(0);
        cancelRef.current();
        return;
      }
      setRemaining(Math.ceil(leftMs / 1000));
    };

    updateRemaining();
    const timer = setInterval(updateRemaining, 200);

    return () => clearInterval(timer);
  }, [countdownSeconds, open]);

  if (!open) return null;

  const percentLeft = Math.max(0, Math.min(100, Math.round((remaining / countdownSeconds) * 100)));

  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true" aria-live="polite">
      <div className="confirm-modal">
        <div className="confirm-title">{title}</div>
        <div className="confirm-body whitespace-pre-line">{message}</div>
        <div className="confirm-countdown">Auto-cancel in {remaining}s</div>
        <div className="confirm-progress" aria-hidden="true">
          <div
            className="confirm-progress-bar"
            style={{ width: `${percentLeft}%` }}
          />
        </div>

        <div className="confirm-actions">
          <button type="button" className="btn-quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={onConfirm} disabled={busy}>
            {busy ? "Processing..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
