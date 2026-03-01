// /**
//  * CreatePoll Component
//  * ====================
//  * Form to create a new poll on CKB.
//  *
//  * File: frontend/src/components/CreatePoll.tsx
//  */

// import React, { useState } from "react";
// import { CreatePollParams } from "../hooks/usePolls";
// import { TxState } from "../lib/types";
// import { TxStatus } from "./TxStatus";

// interface Props {
//   onSubmit: (params: CreatePollParams) => Promise<string>;
//   txState:  TxState;
// }

// const DEFAULT_DURATION = 100; // epochs (~10 hours on mainnet, faster on testnet)

// export function CreatePoll({ onSubmit, txState }: Props) {
//   const [question, setQuestion]     = useState("");
//   const [options,  setOptions]      = useState(["", ""]);
//   const [duration, setDuration]     = useState(DEFAULT_DURATION);
//   const [error,    setError]        = useState<string | null>(null);
//   const [expanded, setExpanded]     = useState(false);

//   const isBusy = txState.status !== "idle" && txState.status !== "success" && txState.status !== "error";

//   const addOption = () => {
//     if (options.length < 10) setOptions([...options, ""]);
//   };

//   const removeOption = (i: number) => {
//     if (options.length <= 2) return;
//     setOptions(options.filter((_, idx) => idx !== i));
//   };

//   const updateOption = (i: number, value: string) => {
//     const next = [...options];
//     next[i] = value;
//     setOptions(next);
//   };

//   const validate = (): string | null => {
//     if (!question.trim()) return "Question is required";
//     if (question.length > 256) return "Question exceeds 256 characters";
//     const filled = options.filter((o) => o.trim());
//     if (filled.length < 2) return "At least 2 non-empty options required";
//     for (const opt of filled) {
//       if (opt.length > 64) return `Option "${opt.slice(0, 20)}..." exceeds 64 characters`;
//     }
//     if (duration < 1 || duration > 1000) return "Duration must be 1–1000 epochs";
//     return null;
//   };

//   const handleSubmit = async (e: React.FormEvent) => {
//     e.preventDefault();
//     const err = validate();
//     if (err) { setError(err); return; }
//     setError(null);

//     const filledOptions = options.filter((o) => o.trim());
//     try {
//       await onSubmit({
//         question:       question.trim(),
//         options:        filledOptions,
//         durationEpochs: duration,
//       });
//       // Reset on success
//       setQuestion("");
//       setOptions(["", ""]);
//       setDuration(DEFAULT_DURATION);
//       setExpanded(false);
//     } catch (e: any) {
//       setError(e.message ?? "Transaction failed");
//     }
//   };

//   if (!expanded) {
//     return (
//       <button
//         onClick={() => setExpanded(true)}
//         className="w-full border-2 border-dashed border-blue-300 rounded-xl p-6 text-blue-500 hover:border-blue-500 hover:bg-blue-50 transition-all font-medium text-lg"
//       >
//         + Create New Poll
//       </button>
//     );
//   }

//   return (
//     <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
//       <div className="flex items-center justify-between mb-5">
//         <h2 className="text-xl font-bold text-gray-800">Create New Poll</h2>
//         <button
//           onClick={() => setExpanded(false)}
//           className="text-gray-400 hover:text-gray-600 text-xl"
//         >
//           ✕
//         </button>
//       </div>

//       <form onSubmit={handleSubmit} className="space-y-5">
//         {/* Question */}
//         <div>
//           <label className="block text-sm font-semibold text-gray-700 mb-1.5">
//             Question
//           </label>
//           <textarea
//             value={question}
//             onChange={(e) => setQuestion(e.target.value)}
//             placeholder="What should we vote on?"
//             rows={2}
//             maxLength={256}
//             className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
//             disabled={isBusy}
//           />
//           <div className="text-xs text-gray-400 mt-0.5 text-right">
//             {question.length}/256
//           </div>
//         </div>

//         {/* Options */}
//         <div>
//           <label className="block text-sm font-semibold text-gray-700 mb-1.5">
//             Options
//             <span className="font-normal text-gray-400 ml-1">(2–10)</span>
//           </label>
//           <div className="space-y-2">
//             {options.map((opt, i) => (
//               <div key={i} className="flex items-center gap-2">
//                 <span className="text-gray-400 text-sm w-6 text-right">{i + 1}.</span>
//                 <input
//                   value={opt}
//                   onChange={(e) => updateOption(i, e.target.value)}
//                   placeholder={`Option ${i + 1}`}
//                   maxLength={64}
//                   className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
//                   disabled={isBusy}
//                 />
//                 {options.length > 2 && (
//                   <button
//                     type="button"
//                     onClick={() => removeOption(i)}
//                     className="text-gray-300 hover:text-red-400 text-lg leading-none"
//                     disabled={isBusy}
//                   >
//                     ✕
//                   </button>
//                 )}
//               </div>
//             ))}
//           </div>
//           {options.length < 10 && (
//             <button
//               type="button"
//               onClick={addOption}
//               disabled={isBusy}
//               className="mt-2 text-sm text-blue-500 hover:text-blue-700 font-medium"
//             >
//               + Add option
//             </button>
//           )}
//         </div>

//         {/* Duration */}
//         <div>
//           <label className="block text-sm font-semibold text-gray-700 mb-1.5">
//             Duration
//             <span className="font-normal text-gray-400 ml-1">(epochs)</span>
//           </label>
//           <div className="flex items-center gap-3">
//             <input
//               type="number"
//               value={duration}
//               onChange={(e) => setDuration(parseInt(e.target.value) || 0)}
//               min={1}
//               max={1000}
//               className="w-28 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
//               disabled={isBusy}
//             />
//             <span className="text-sm text-gray-500">
//               ≈ {Math.round((duration * 4) / 60)} hours
//               <span className="text-gray-400 ml-1">(1 epoch ≈ 4 min)</span>
//             </span>
//           </div>
//         </div>

//         {/* Error */}
//         {error && (
//           <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-600">
//             {error}
//           </div>
//         )}

//         {/* TX status */}
//         {txState.status !== "idle" && <TxStatus txState={txState} />}

//         {/* Submit */}
//         <button
//           type="submit"
//           disabled={isBusy}
//           className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-semibold py-3 rounded-lg transition-colors"
//         >
//           {isBusy ? "Processing..." : "Create Poll on CKB"}
//         </button>
//       </form>
//     </div>
//   );
// }