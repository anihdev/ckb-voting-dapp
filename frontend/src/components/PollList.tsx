// /**
//  * PollList Component
//  * ==================
//  * Renders all polls with filtering tabs.
//  *
//  * File: frontend/src/components/PollList.tsx
//  */

// import React, { useState } from "react";
// import { Poll, TxState } from "../lib/types";
// import { VoteOnPoll } from "./VoteOnPoll";

// type Filter = "all" | "active" | "closed";

// interface Props {
//   polls:         Poll[];
//   loading:       boolean;
//   voterAddress:  string | null;
//   txState:       TxState;
//   currentEpoch:  bigint;
//   onVote:        (poll: Poll, optionIndex: number) => Promise<string>;
//   onClose:       (poll: Poll) => Promise<string>;
//   onRefresh:     () => void;
// }

// export function PollList({
//   polls,
//   loading,
//   voterAddress,
//   txState,
//   currentEpoch,
//   onVote,
//   onClose,
//   onRefresh,
// }: Props) {
//   const [filter, setFilter] = useState<Filter>("all");

//   const filtered = polls.filter((p) => {
//     if (filter === "active") return !p.isClosed && currentEpoch <= p.deadline;
//     if (filter === "closed") return p.isClosed || currentEpoch > p.deadline;
//     return true;
//   });

//   const tabs: Array<{ key: Filter; label: string; count: number }> = [
//     { key: "all",    label: "All",    count: polls.length },
//     { key: "active", label: "Active", count: polls.filter((p) => !p.isClosed && currentEpoch <= p.deadline).length },
//     { key: "closed", label: "Closed", count: polls.filter((p) => p.isClosed || currentEpoch > p.deadline).length },
//   ];

//   return (
//     <div>
//       {/* Tab bar + refresh */}
//       <div className="flex items-center justify-between mb-4">
//         <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
//           {tabs.map((tab) => (
//             <button
//               key={tab.key}
//               onClick={() => setFilter(tab.key)}
//               className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
//                 filter === tab.key
//                   ? "bg-white shadow-sm text-gray-800"
//                   : "text-gray-500 hover:text-gray-700"
//               }`}
//             >
//               {tab.label}
//               <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
//                 filter === tab.key ? "bg-blue-100 text-blue-600" : "bg-gray-200 text-gray-500"
//               }`}>
//                 {tab.count}
//               </span>
//             </button>
//           ))}
//         </div>

//         <button
//           onClick={onRefresh}
//           disabled={loading}
//           className="text-sm text-gray-400 hover:text-gray-600 flex items-center gap-1"
//         >
//           <span className={loading ? "animate-spin" : ""}>⟳</span>
//           {loading ? "Loading..." : "Refresh"}
//         </button>
//       </div>

//       {/* Poll cards */}
//       {filtered.length === 0 ? (
//         <div className="text-center py-16 text-gray-400">
//           {loading ? (
//             <div className="space-y-2">
//               <div className="animate-spin text-3xl">⟳</div>
//               <div>Loading polls from CKB...</div>
//             </div>
//           ) : (
//             <div>
//               <div className="text-4xl mb-3">🗳️</div>
//               <div className="font-medium text-gray-500">No polls found</div>
//               <div className="text-sm mt-1">Create the first poll above!</div>
//             </div>
//           )}
//         </div>
//       ) : (
//         <div className="space-y-4">
//           {filtered.map((poll) => (
//             <VoteOnPoll
//               key={poll.id}
//               poll={poll}
//               voterAddress={voterAddress}
//               txState={txState}
//               onVote={onVote}
//               onClose={onClose}
//               currentEpoch={currentEpoch}
//             />
//           ))}
//         </div>
//       )}
//     </div>
//   );
// }