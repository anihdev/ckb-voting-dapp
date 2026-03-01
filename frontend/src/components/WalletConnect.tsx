// /**
//  * WalletConnect Component
//  * ========================
//  * Displays connection status and connect/disconnect button.
//  *
//  * File: frontend/src/components/WalletConnect.tsx
//  */

// import React from "react";
// import { useCKB } from "../hooks/useCKB";
// import { shannonsToCkb } from "../lib/ckb";

// export function WalletConnect() {
//   const { address, balance, isConnected, isLoading, connect, disconnect } = useCKB();

//   if (isLoading) {
//     return (
//       <div className="flex items-center gap-2 text-gray-500">
//         <span className="animate-spin">⟳</span>
//         <span>Connecting...</span>
//       </div>
//     );
//   }

//   if (!isConnected || !address) {
//     return (
//       <button
//         onClick={connect}
//         className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-5 py-2.5 rounded-lg transition-colors"
//       >
//         Connect Wallet
//       </button>
//     );
//   }

//   return (
//     <div className="flex items-center gap-3">
//       {/* Balance */}
//       <div className="text-sm text-gray-600">
//         <span className="font-medium">{shannonsToCkb(balance)}</span>
//         <span className="ml-1 text-gray-400">CKB</span>
//       </div>

//       {/* Address pill */}
//       <div className="flex items-center gap-2 bg-gray-100 rounded-full px-4 py-2">
//         <div className="w-2 h-2 rounded-full bg-green-500" />
//         <span className="text-sm font-mono text-gray-700">
//           {address.slice(0, 10)}...{address.slice(-6)}
//         </span>
//       </div>

//       {/* Disconnect */}
//       <button
//         onClick={disconnect}
//         className="text-sm text-gray-400 hover:text-red-500 transition-colors"
//         title="Disconnect wallet"
//       >
//         ✕
//       </button>
//     </div>
//   );
// }