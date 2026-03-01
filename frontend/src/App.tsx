// /**
//  * App.tsx
//  * =======
//  * Root component. Sets up CCC wallet provider and renders the dApp layout.
//  *
//  * File: frontend/src/App.tsx
//  */

// import React, { useEffect, useState } from "react";
// import { CccProvider } from "@ckb-ccc/connector-react";
// import { useCKB } from "./hooks/useCKB";
// import { usePolls } from "./hooks/usePolls";
// import { WalletConnect } from "./components/WalletConnect";
// import { CreatePoll } from "./components/CreatePoll";
// import { PollList } from "./components/PollList";

// // ─── Inner App (needs CCC context) ───────────────────────────────────────────

// function InnerApp() {
//   const { signer, address, isConnected } = useCKB();
//   const { polls, loading, txState, fetchPolls, createPoll, castVote, closePoll } =
//     usePolls(signer);

//   const [currentEpoch, setCurrentEpoch] = useState<bigint>(0n);

//   // Fetch polls and current epoch on mount and when connected
//   useEffect(() => {
//     if (signer) {
//       fetchPolls();
//       signer.client
//         .getTipHeader()
//         .then((h) => setCurrentEpoch(BigInt(h.epoch)))
//         .catch(console.error);
//     }
//   }, [signer, fetchPolls]);

//   return (
//     <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
//       {/* Navbar */}
//       <nav className="bg-white border-b border-gray-200 sticky top-0 z-50">
//         <div className="max-w-2xl mx-auto px-4 h-16 flex items-center justify-between">
//           <div className="flex items-center gap-2.5">
//             <span className="text-2xl">🗳️</span>
//             <div>
//               <div className="font-bold text-gray-800 leading-tight">CKB Voting</div>
//               <div className="text-xs text-gray-400">Decentralised polls on Nervos</div>
//             </div>
//           </div>
//           <WalletConnect />
//         </div>
//       </nav>

//       {/* Main content */}
//       <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
//         {/* Network badge */}
//         <div className="flex justify-center">
//           <span className="inline-flex items-center gap-1.5 text-xs bg-amber-100 text-amber-700 px-3 py-1 rounded-full font-medium">
//             <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
//             Testnet — Epoch {currentEpoch.toString()}
//           </span>
//         </div>

//         {/* Wallet prompt */}
//         {!isConnected && (
//           <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
//             <div className="text-4xl mb-4">🔐</div>
//             <h2 className="text-xl font-bold text-gray-800 mb-2">Connect your wallet</h2>
//             <p className="text-gray-500 mb-5 text-sm">
//               Connect a CKB wallet to create polls and vote. <br />
//               Need testnet CKB?{" "}
//               <a
//                 href="https://faucet.nervos.org/"
//                 target="_blank"
//                 rel="noopener noreferrer"
//                 className="text-blue-500 underline"
//               >
//                 Get some from the faucet
//               </a>
//               .
//             </p>
//             <WalletConnect />
//           </div>
//         )}

//         {/* Create Poll (only when connected) */}
//         {isConnected && (
//           <CreatePoll onSubmit={createPoll} txState={txState} />
//         )}

//         {/* Polls list */}
//         <PollList
//           polls={polls}
//           loading={loading}
//           voterAddress={address}
//           txState={txState}
//           currentEpoch={currentEpoch}
//           onVote={castVote}
//           onClose={closePoll}
//           onRefresh={fetchPolls}
//         />
//       </main>

//       {/* Footer */}
//       <footer className="text-center py-8 text-xs text-gray-400">
//         Built on{" "}
//         <a href="https://www.nervos.org" target="_blank" rel="noopener noreferrer" className="hover:underline">
//           Nervos CKB
//         </a>{" "}
//         · Source on{" "}
//         <a href="https://github.com/your-org/ckb-voting-dapp" target="_blank" rel="noopener noreferrer" className="hover:underline">
//           GitHub
//         </a>
//       </footer>
//     </div>
//   );
// }

// // ─── Root (wraps with CCC provider) ──────────────────────────────────────────

// export default function App() {
//   return (
//     <CccProvider>
//       <InnerApp />
//     </CccProvider>
//   );
// }