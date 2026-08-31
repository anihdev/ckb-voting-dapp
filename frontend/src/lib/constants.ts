/**
 * Governance Constants
 * ====================
 * Shared protocol constants mirrored from the contract so the frontend can
 * build cells and present deposit requirements consistently.
 */

export const SHANNONS_PER_CKB = 100_000_000n;

export const OP = {
  CREATE_POLL: 0x01,
  CREATE_VOTE_INTENT: 0x02,
  RETIRED_AGGREGATE_VOTES: 0x03,
  CLOSE_POLL: 0x04,
  DELEGATE: 0x05,
  RETIRED_REVOKE_DELEGATION: 0x06,
  CREATE_TALLY_SHARD: 0x07,
  MERGE_TALLY_SHARDS: 0x08,
} as const;

export const CREATOR_DEPOSIT_SHANNONS = 500n * SHANNONS_PER_CKB;
export const VOTER_DEPOSIT_SHANNONS = 61n * SHANNONS_PER_CKB;
export const DELEGATION_MIN_SHANNONS = 61n * SHANNONS_PER_CKB;
export const TALLY_SHARD_MIN_SHANNONS = 61n * SHANNONS_PER_CKB;
export const TALLY_MERGE_RESULT_MIN_SHANNONS = 61n * SHANNONS_PER_CKB;
export const MAX_INTENTS_PER_AGG = 50;
export const MAX_TALLY_SHARDS = 256;
// Current-code polls are capped below the historical codec ceiling.
export const MAX_ACTIVE_TALLY_SHARDS = 16;
export const MAX_SHARDS_PER_FINALIZE = 16;
export const MAX_DIRECT_CLOSE_SHARDS = 8;
export const MAX_SHARDS_PER_MERGE = 8;
export const MERGE_COVERAGE_BYTES = 32;
export const TALLY_SHARD_CODEC_VERSION = 2;
export const TALLY_AGGREGATION_PROOF_VERSION = 1;
export const MAX_TALLY_AGGREGATION_PROOF_BYTES = 64 * 1024;
export const COUNTED_VOTER_PRESENT_VALUE = new Uint8Array(32).fill(1);
export const MAX_CLOSE_INTENT_REFUNDS = 32;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;
export const MAX_QUESTION_BYTES = 256;
export const MAX_OPTION_BYTES = 64;
export const MIN_DURATION_EPOCHS = 1n;
export const MAX_DURATION_EPOCHS = 1000n;
export const ZERO_HASH_HEX = `0x${"00".repeat(32)}`;
export const FINALIZATION_GRACE_EPOCHS = 1n;
export const FORCE_CLOSE_GRACE_EPOCHS = 10n;
export const MAX_DEADLINE_EPOCH = (1n << 24n) - FORCE_CLOSE_GRACE_EPOCHS - 2n;
