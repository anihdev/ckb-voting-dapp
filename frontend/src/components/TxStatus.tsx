// /**
//  * TxStatus Component
//  * ==================
//  * Shows live transaction progress and explorer link.
//  *
//  * File: frontend/src/components/TxStatus.tsx
//  */

// import React from "react";
// import { TxState } from "../lib/types";

// interface Props {
//   txState: TxState;
// }

// const EXPLORER_BASE = "https://pudge.explorer.nervos.org/transaction";

// export function TxStatus({ txState }: Props) {
//   const { status, txHash, error } = txState;

//   const steps: Array<{ key: typeof status; label: string }> = [
//     { key: "building",    label: "Building TX" },
//     { key: "signing",     label: "Signing" },
//     { key: "sending",     label: "Broadcasting" },
//     { key: "confirming",  label: "Confirming" },
//     { key: "success",     label: "Confirmed" },
//   ];

//   const currentStep = steps.findIndex((s) => s.key === status);

//   if (status === "idle") return null;

//   if (status === "error") {
//     return (
//       <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-lg px-3.5 py-3 text-sm">
//         <span className="text-red-500 text-base">✕</span>
//         <div>
//           <div className="font-medium text-red-700">Transaction failed</div>
//           {error && <div className="text-red-500 mt-0.5 text-xs">{error}</div>}
//         </div>
//       </div>
//     );
//   }

//   return (
//     <div className="bg-blue-50 border border-blue-100 rounded-lg px-3.5 py-3">
//       {/* Step indicators */}
//       <div className="flex items-center gap-1 mb-2.5">
//         {steps.map((step, i) => {
//           const done    = i < currentStep;
//           const current = i === currentStep;
//           return (
//             <React.Fragment key={step.key}>
//               <div className={`flex items-center gap-1 ${current ? "text-blue-600" : done ? "text-green-600" : "text-gray-300"}`}>
//                 <div className={`w-2 h-2 rounded-full ${
//                   done ? "bg-green-500" : current ? "bg-blue-500 animate-pulse" : "bg-gray-300"
//                 }`} />
//                 <span className="text-xs font-medium hidden sm:inline">{step.label}</span>
//               </div>
//               {i < steps.length - 1 && (
//                 <div className={`flex-1 h-px ${i < currentStep ? "bg-green-400" : "bg-gray-200"}`} />
//               )}
//             </React.Fragment>
//           );
//         })}
//       </div>

//       {/* TX hash + explorer link */}
//       {txHash && (
//         <div className="flex items-center gap-2 text-xs">
//           <span className="text-gray-500">TX:</span>
//           <span className="font-mono text-gray-600">{txHash.slice(0, 18)}...</span>
//           <a
//             href={`${EXPLORER_BASE}/${txHash}`}
//             target="_blank"
//             rel="noopener noreferrer"
//             className="text-blue-500 hover:underline ml-auto"
//           >
//             View on Explorer ↗
//           </a>
//         </div>
//       )}

//       {status === "success" && (
//         <div className="text-xs text-green-600 font-medium mt-1">
//           Transaction confirmed on CKB!
//         </div>
//       )}
//     </div>
//   );
// }