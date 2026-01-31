// export interface PollData {
//     poll_id: Uint8Array;
//     question: string;
//     created_at: bigint;
//     deadline: bigint;
//     status: number; // 0=active, 1=closed
//     yes_count: number;
//     no_count: number;
//     creator: string;
//     version: number;
//   }
  
//   export interface VoteData {
//     poll_id: Uint8Array;
//     voter: string;
//     vote: number; // 0=no, 1=yes
//     timestamp: bigint;
//     version: number;
//   }
  
//   export enum VotingOperation {
//     CREATE_POLL = 0,
//     CAST_VOTE = 1,
//     CLOSE_POLL = 2
//   }