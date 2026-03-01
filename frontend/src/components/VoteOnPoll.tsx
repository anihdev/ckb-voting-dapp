// /**
//  * VoteOnPoll Component
//  * ====================
//  * Displays a single poll card with voting UI and results bar.
//  *
//  * File: frontend/src/components/VoteOnPoll.tsx
//  */

// import React, { useState } from "react";
// import { Poll, TxState } from "../lib/types";
// import { TxStatus } from "./TxStatus";

// interface Props {
//   poll:           Poll;
//   voterAddress:   string | null;
//   txState:        TxState;
//   onVote:         (poll: Poll, optionIndex: number) => Promise<string>;
//   onClose:        (poll: Poll) => Promise<string>;
//   currentEpoch:   bigint;
// }

// export function VoteOnPoll({
//   poll,
//   voterAddress,
//   txState,
//   onVote,
//   onClose,
//   currentEpoch,
// }: Props) {
//   const [selected, setSelected]   = useState<number | null>(null);
//   const [submitting, setSubmitting] = useState(false);
//   const [localError, setLocalError] = useState<string | null>(null);

//   const isBusy = submitting;
//   const isExpired = currentEpoch > poll.deadline;
//   const isCreator = voterAddress !== null &&
//     poll.creator.toLowerCase().includes(voterAddress.toLowerCase().slice(0, 10));
//   // Note: full creator match would compare lock hash; simplified here for UI

//   const handleVote = async () => {
//     if (selected === null) return;
//     setSubmitting(true);
//     setLocalError(null);
//     try {
//       await onVote(poll, selected);
//       setSelected(null);
//     } catch (e: any) {
//       setLocalError(e.message ?? "Vote failed");
//     } finally {
//       setSubmitting(false);
//     }
//   };

//   const handleClose = async () => {
//     setSubmitting(true);
//     setLocalError(null);
//     try {
//       await onClose(poll);
//     } catch (e: any) {
//       setLocalError(e.message ?? "Close failed");
//     } finally {
//       setSubmitting(false);
//     }
//   };

//   const maxVotes = poll.voteCounts.length > 0
//     ? poll.voteCounts.reduce((m, v) => (v > m ? v : m), 0n)
//     : 0n;

//   const canVote = voterAddress && !poll.isClosed && !isExpired;
//   const canClose = voterAddress && !poll.isClosed;

//   return (
//     <div className={`bg-white rounded-xl border shadow-sm overflow-hidden ${
//       poll.isClosed ? "opacity-75 border-gray-200" : "border-blue-100"
//     }`}>
//       {/* Header */}
//       <div className="px-5 pt-5 pb-3">
//         <div className="flex items-start justify-between gap-3 mb-1">
//           <h3 className="text-lg font-semibold text-gray-800 leading-tight">
//             {poll.question}
//           </h3>
//           <div className="flex-shrink-0">
//             {poll.isClosed ? (
//               <span className="bg-gray-100 text-gray-500 text-xs px-2.5 py-1 rounded-full font-medium">
//                 Closed
//               </span>
//             ) : isExpired ? (
//               <span className="bg-orange-100 text-orange-600 text-xs px-2.5 py-1 rounded-full font-medium">
//                 Expired
//               </span>
//             ) : (
//               <span className="bg-green-100 text-green-600 text-xs px-2.5 py-1 rounded-full font-medium">
//                 Active
//               </span>
//             )}
//           </div>
//         </div>

//         <div className="text-xs text-gray-400 space-x-3">
//           <span>{poll.totalVoters.toString()} voters</span>
//           <span>·</span>
//           <span>Deadline: epoch {poll.deadline.toString()}</span>
//           <span>·</span>
//           <span className="font-mono text-gray-300">{poll.id.slice(0, 10)}...</span>
//         </div>
//       </div>

//       {/* Options */}
//       <div className="px-5 pb-4 space-y-2.5">
//         {poll.options.map((opt, i) => {
//           const votes = poll.voteCounts[i] ?? 0n;
//           const pct = poll.totalVotes > 0n
//             ? Number((votes * 100n) / poll.totalVotes)
//             : 0;
//           const isWinner = !poll.isClosed
//             ? false
//             : poll.winnerIndex === i;
//           const isSelected = selected === i;

//           return (
//             <div
//               key={i}
//               onClick={() => canVote && !isBusy && setSelected(i)}
//               className={`relative rounded-lg border-2 overflow-hidden cursor-pointer transition-all ${
//                 isSelected
//                   ? "border-blue-500"
//                   : isWinner
//                   ? "border-green-400"
//                   : "border-gray-100 hover:border-gray-300"
//               } ${!canVote ? "cursor-default" : ""}`}
//             >
//               {/* Progress bar */}
//               <div
//                 className={`absolute inset-0 opacity-10 transition-all ${
//                   isWinner ? "bg-green-500" : isSelected ? "bg-blue-500" : "bg-gray-400"
//                 }`}
//                 style={{ width: `${pct}%` }}
//               />
//               <div className="relative px-3.5 py-2.5 flex items-center justify-between">
//                 <div className="flex items-center gap-2.5">
//                   {/* Selection indicator */}
//                   {canVote && (
//                     <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 transition-all ${
//                       isSelected ? "border-blue-500 bg-blue-500" : "border-gray-300"
//                     }`}>
//                       {isSelected && (
//                         <div className="w-2 h-2 rounded-full bg-white m-auto mt-0.5" />
//                       )}
//                     </div>
//                   )}
//                   {isWinner && <span>🏆</span>}
//                   <span className="text-sm font-medium text-gray-800">{opt}</span>
//                 </div>
//                 <div className="text-right text-xs text-gray-500 flex-shrink-0 ml-3">
//                   <span className="font-semibold text-gray-700">{votes.toString()}</span>
//                   <span className="ml-1 text-gray-400">({pct}%)</span>
//                 </div>
//               </div>
//             </div>
//           );
//         })}
//       </div>

//       {/* Actions */}
//       {(canVote || canClose) && (
//         <div className="border-t border-gray-100 px-5 py-3 flex items-center gap-3">
//           {canVote && (
//             <button
//               onClick={handleVote}
//               disabled={selected === null || isBusy}
//               className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 text-white font-semibold py-2.5 rounded-lg text-sm transition-colors"
//             >
//               {isBusy ? "Sending..." : selected !== null ? `Vote for "${poll.options[selected]}"` : "Select an option"}
//             </button>
//           )}

//           {canClose && (
//             <button
//               onClick={handleClose}
//               disabled={isBusy}
//               className="border border-gray-300 hover:border-red-300 hover:text-red-500 text-gray-500 text-sm px-4 py-2.5 rounded-lg transition-colors"
//             >
//               Close Poll
//             </button>
//           )}
//         </div>
//       )}

//       {/* TX Status */}
//       {txState.status !== "idle" && (
//         <div className="px-5 pb-4">
//           <TxStatus txState={txState} />
//         </div>
//       )}

//       {/* Local error */}
//       {localError && (
//         <div className="px-5 pb-4 text-sm text-red-500">{localError}</div>
//       )}
//     </div>
//   );
// }