/**
 * TxStatus Component
 * ==================
 * Shows transaction progress, error state, and explorer link.
 */

import React from "react";
import { TxState } from "../lib/types";

interface Props {
  txState: TxState;
}

const EXPLORER_BASE = "https://pudge.explorer.nervos.org/transaction";

export function TxStatus({ txState }: Props) {
  const { status, txHash, error } = txState;

  const steps: Array<{ key: typeof status; label: string }> = [
    { key: "building", label: "Building TX" },
    { key: "signing", label: "Signing" },
    { key: "sending", label: "Broadcasting" },
    { key: "confirming", label: "Confirming" },
    { key: "success", label: "Confirmed" },
  ];

  const currentStep = steps.findIndex((step) => step.key === status);

  if (status === "idle") return null;

  if (status === "error") {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm">
        <span className="text-base text-red-500">x</span>
        <div>
          <div className="font-medium text-red-700">Transaction failed</div>
          {error && <div className="mt-0.5 text-xs text-red-500">{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-blue-100 bg-blue-50 px-3.5 py-3">
      <div className="mb-2.5 flex items-center gap-1">
        {steps.map((step, index) => {
          const done = index < currentStep;
          const current = index === currentStep;

          return (
            <React.Fragment key={step.key}>
              <div
                className={`flex items-center gap-1 ${
                  current ? "text-blue-600" : done ? "text-green-600" : "text-gray-300"
                }`}
              >
                <div
                  className={`h-2 w-2 rounded-full ${
                    done ? "bg-green-500" : current ? "animate-pulse bg-blue-500" : "bg-gray-300"
                  }`}
                />
                <span className="hidden text-xs font-medium sm:inline">{step.label}</span>
              </div>
              {index < steps.length - 1 && (
                <div className={`h-px flex-1 ${index < currentStep ? "bg-green-400" : "bg-gray-200"}`} />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {txHash && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">TX:</span>
          <span className="font-mono text-gray-600">{txHash.slice(0, 18)}...</span>
          <a
            href={`${EXPLORER_BASE}/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-blue-500 hover:underline"
          >
            View on Explorer
          </a>
        </div>
      )}

      {status === "success" && (
        <div className="mt-1 text-xs font-medium text-green-600">
          Transaction confirmed on CKB.
        </div>
      )}
    </div>
  );
}
