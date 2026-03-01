// /**
//  * Frontend Types
//  * ==============
//  * File: frontend/src/lib/types.ts
//  */

// export interface Poll {
//   // Derived / display fields
//   id: string;           // type script hash of the poll cell (unique identifier)
//   outPoint: {           // current out_point of the poll cell (changes each vote)
//     txHash: string;
//     index: number;
//   };

//   // On-chain data (decoded from cell data via molecule)
//   question:     string;
//   options:      string[];
//   voteCounts:   bigint[];
//   deadline:     bigint;  // epoch number
//   creator:      string;  // 0x-prefixed hex (32 bytes = lock script hash)
//   isClosed:     boolean;
//   totalVoters:  bigint;

//   // Computed
//   totalVotes:   bigint;
//   winnerIndex:  number | null;  // index with most votes, null if tied or 0 votes
// }

// export interface VoteReceipt {
//   pollId:       string;
//   voterAddress: string;
//   optionIndex:  number;
//   epochCast:    bigint;
// }

// export type TxStatus = "idle" | "building" | "signing" | "sending" | "confirming" | "success" | "error";

// export interface TxState {
//   status:  TxStatus;
//   txHash:  string | null;
//   error:   string | null;
// }