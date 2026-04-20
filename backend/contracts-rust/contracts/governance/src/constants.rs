//! Protocol constants mirrored from the TypeScript reference contract.

pub const OP_CREATE_POLL: u8 = 0x01;
pub const OP_CREATE_VOTE_INTENT: u8 = 0x02;
pub const OP_AGGREGATE_VOTES: u8 = 0x03;
pub const OP_CLOSE_POLL: u8 = 0x04;
pub const OP_DELEGATE: u8 = 0x05;
pub const OP_REVOKE_DELEGATION: u8 = 0x06;

pub const MAX_OPTIONS: usize = 10;
pub const MAX_QUESTION_LEN: usize = 256;
pub const MAX_OPTION_LEN: usize = 64;
pub const MAX_INTENTS_PER_AGG: usize = 50;

pub const MIN_DURATION_EPOCHS: u64 = 1;
pub const MAX_DURATION_EPOCHS: u64 = 1000;

pub const SHANNONS_PER_CKB: u64 = 100_000_000;
pub const CREATOR_DEPOSIT_SHANNONS: u64 = 500 * SHANNONS_PER_CKB;
pub const VOTER_DEPOSIT_SHANNONS: u64 = 61 * SHANNONS_PER_CKB;
pub const DELEGATION_MIN_SHANNONS: u64 = 61 * SHANNONS_PER_CKB;
