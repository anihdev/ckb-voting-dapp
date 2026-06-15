//! Governance protocol constants used by the Rust contract.

pub const OP_CREATE_POLL: u8 = 0x01;
pub const OP_CREATE_VOTE_INTENT: u8 = 0x02;
pub const OP_AGGREGATE_VOTES: u8 = 0x03;
pub const OP_CLOSE_POLL: u8 = 0x04;
pub const OP_DELEGATE: u8 = 0x05;
pub const OP_REVOKE_DELEGATION: u8 = 0x06;
// Sharded aggregation MVP extension. This op identifies tally shard cells;
// create, aggregate, and finalize are lifecycle transitions under this cell
// family, mirroring the existing poll-cell lifecycle dispatch style.
pub const OP_CREATE_TALLY_SHARD: u8 = 0x07;
// Reserved for a bounded merge/result step if final close cannot consume every
// finalized shard in one transaction.
pub const OP_MERGE_TALLY_SHARDS: u8 = 0x08;

pub const MAX_OPTIONS: usize = 10;
pub const MAX_QUESTION_LEN: usize = 256;
pub const MAX_OPTION_LEN: usize = 64;
pub const MAX_INTENTS_PER_AGG: usize = 50;
pub const MAX_TALLY_SHARDS: u32 = 256;
pub const MERGE_COVERAGE_BYTES: usize = 32;
pub const MAX_SHARDS_PER_MERGE: usize = 8;
// Direct close consumes every finalized shard in one transaction and is only
// acceptable for small polls. Larger shard sets must use MERGE_TALLY_SHARDS.
pub const MAX_DIRECT_CLOSE_SHARDS: u32 = 8;
pub const TALLY_MERGE_RESULT_MIN_SHANNONS: u64 = 61 * SHANNONS_PER_CKB;

pub const MIN_DURATION_EPOCHS: u64 = 1;
pub const MAX_DURATION_EPOCHS: u64 = 1000;

pub const SHANNONS_PER_CKB: u64 = 100_000_000;
pub const CREATOR_DEPOSIT_SHANNONS: u64 = 500 * SHANNONS_PER_CKB;
pub const VOTER_DEPOSIT_SHANNONS: u64 = 61 * SHANNONS_PER_CKB;
pub const DELEGATION_MIN_SHANNONS: u64 = 61 * SHANNONS_PER_CKB;
pub const TALLY_SHARD_MIN_SHANNONS: u64 = 61 * SHANNONS_PER_CKB;
pub const MAX_WEIGHT_UNITS_PER_INTENT: u64 = 20;

// Number of epochs to wait after poll.deadline before a force-close is allowed.
// This exists to ensure creators have a reasonable window to close their own
// polls while still guaranteeing eventual recovery for voters if the creator
// disappears or goes rogue.
pub const FORCE_CLOSE_GRACE_EPOCHS: u64 = 10;
