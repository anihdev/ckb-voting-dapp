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
  AGGREGATE_VOTES: 0x03,
  CLOSE_POLL: 0x04,
  DELEGATE: 0x05,
  REVOKE_DELEGATION: 0x06,
  CREATE_TALLY_SHARD: 0x07,
  MERGE_TALLY_SHARDS: 0x08,
} as const;

export const CREATOR_DEPOSIT_SHANNONS = 500n * SHANNONS_PER_CKB;
export const VOTER_DEPOSIT_SHANNONS = 61n * SHANNONS_PER_CKB;
export const DELEGATION_MIN_SHANNONS = 61n * SHANNONS_PER_CKB;
export const TALLY_SHARD_MIN_SHANNONS = 61n * SHANNONS_PER_CKB;
export const TALLY_MERGE_RESULT_MIN_SHANNONS = 61n * SHANNONS_PER_CKB;
export const MAX_WEIGHT_UNITS_PER_INTENT = 20n;
export const MAX_INTENTS_PER_AGG = 50;
export const MAX_TALLY_SHARDS = 256;
export const MAX_DIRECT_CLOSE_SHARDS = 8;
export const MAX_SHARDS_PER_MERGE = 8;
export const MERGE_COVERAGE_BYTES = 32;
export const MAX_CLOSE_INTENT_REFUNDS = 32;
export const MAX_OPTIONS = 10;
export const MIN_DURATION_EPOCHS = 1n;
export const MAX_DURATION_EPOCHS = 1000n;
export const ZERO_HASH_HEX = `0x${"00".repeat(32)}`;
export const FORCE_CLOSE_GRACE_EPOCHS = 10n;
