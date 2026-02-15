export interface PollData {
    poll_id: Uint8Array;
    question: string;
    created_at: bigint;
    deadline: bigint;
    status: number; // 0=active, 1=closed
    yes_count: number;
    no_count: number;
    creator: string;
    version: number;
  }
  
  export interface VoteData {
    poll_id: Uint8Array;
    voter: string;
    vote: number; // 0=no, 1=yes
    timestamp: bigint;
    version: number;
  }
  
  export enum VotingOperation {
    CREATE_POLL = 0,
    CAST_VOTE = 1,
    CLOSE_POLL = 2
  }
  
export enum VotingError {
  // Success
  SUCCESS = 0,
  UNKNOWN_ERROR = 1,
  
  // Create poll errors (2-9)
  DEADLINE_NOT_IN_FUTURE = 2,
  INITIAL_COUNTS_NOT_ZERO = 3,
  INITIAL_STATUS_NOT_ACTIVE = 4,
  POLL_ID_ALL_ZEROS = 5,
  QUESTION_EMPTY = 6,
  
  // Cast vote errors (10-19)
  POLL_NOT_ACTIVE = 10,
  DEADLINE_PASSED = 11,
  INVALID_VOTE = 12,
  POLL_ID_MISMATCH = 13,
  VOTE_COUNT_INCORRECT = 14,
  
  // Close poll errors (20-29)
  POLL_ALREADY_CLOSED = 20,
  DEADLINE_NOT_PASSED = 21,
  STATUS_NOT_CLOSED = 22,
  VOTE_COUNTS_CHANGED = 23,
}

/**
 * Cell structure for a Poll Cell
 */
export interface PollCell {
  /** Cell capacity in shannons */
  capacity: bigint;
  
  /** Lock script (creator's lock) */
  lock: {
    codeHash: string;
    hashType: "type" | "data";
    args: string;
  };
  
  /** Type script (voting script) */
  type: {
    codeHash: string;
    hashType: "type" | "data";
    args: string; // poll_id
  };
  
  /** Molecule-encoded PollData */
  data: Uint8Array;
}

/**
 * Cell structure for a Vote Cell
 */
export interface VoteCell {
  /** Cell capacity in shannons */
  capacity: bigint;
  
  /** Lock script (voter's lock) */
  lock: {
    codeHash: string;
    hashType: "type" | "data";
    args: string;
  };
  
  /** Type script (voting script, same as poll) */
  type: {
    codeHash: string;
    hashType: "type" | "data";
    args: string; // same poll_id as poll
  };
  
  /** Molecule-encoded VoteData */
  data: Uint8Array;
}