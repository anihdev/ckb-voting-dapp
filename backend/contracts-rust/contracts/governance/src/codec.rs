// Simple, hand-written Molecule-style decoders used by the governance contract.
// Functions below parse byte slices with a cursor (`offset`) and return
// structured data or `Error::Encoding` when the layout is invalid.

use alloc::vec::Vec;

use crate::{
    constants::{MAX_TALLY_SHARDS, MERGE_COVERAGE_BYTES},
    error::Error,
};

#[derive(Clone, Debug, PartialEq, Eq)]
/// A serialized script used for locks/refunds: `(code_hash, hash_type, args)`.
pub struct EncodedScript {
    pub code_hash: [u8; 32],
    pub hash_type: u8,
    pub args: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Decoded poll metadata and tally stored in the poll cell.
pub struct PollData {
    pub question: Vec<u8>,
    pub options: Vec<Vec<u8>>,
    pub vote_counts: Vec<u64>,
    pub deadline: u64,
    pub creator: [u8; 32],
    pub creator_lock: EncodedScript,
    pub is_closed: bool,
    pub total_voters: u64,
    pub creator_deposit: u64,
    pub pending_intent_count: u64,
    pub counted_voter_lock_hashes: Vec<[u8; 32]>,
    pub token_weighted: bool,
    pub udt_type_hash: [u8; 32],
    pub shard_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Structured vote intent stored in an intent cell.
pub struct VoteIntentData {
    pub poll_type_hash: [u8; 32],
    pub voter_lock_hash: [u8; 32],
    pub option_index: u8,
    // Legacy caller-selected field retained to avoid a silent codec change.
    // Consensus cutoff uses the authenticated input creation header instead.
    pub voted_at_epoch: u64,
    pub aggregated: bool,
    pub refund_lock: EncodedScript,
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Delegation record linking a delegator -> delegate for a poll type.
pub struct DelegationData {
    pub delegator_lock_hash: [u8; 32],
    pub delegate_lock_hash: [u8; 32],
    pub poll_type_hash: [u8; 32],
    // Reserved for codec compatibility. v1 requires zero and uses revocation.
    pub expires_epoch: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Mutable tally state for one deterministic voter shard of a poll.
///
/// Shards move counted voters and vote totals out of the poll cell so
/// independent aggregators can update different shard cells in parallel.
pub struct TallyShardData {
    pub poll_type_hash: [u8; 32],
    pub shard_id: u32,
    pub shard_count: u32,
    pub vote_counts: Vec<u64>,
    pub total_voters: u64,
    pub counted_voter_lock_hashes: Vec<[u8; 32]>,
    pub finalized: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Bounded merge result for large sharded polls.
///
/// Coverage is a 256-bit bitmap where bit `shard_id` means the result includes
/// that finalized shard. Merge steps combine disjoint coverage sets.
pub struct TallyMergeResultData {
    pub poll_type_hash: [u8; 32],
    pub coverage: [u8; MERGE_COVERAGE_BYTES],
    pub vote_counts: Vec<u64>,
    pub total_voters: u64,
    pub merge_level: u32,
    pub version: u32,
}

/// Read a little-endian `u32` from `data` at `offset` and advance the cursor.
/// Returns `Error::Encoding` when there aren't enough bytes.
fn read_u32_le(data: &[u8], offset: &mut usize) -> Result<u32, Error> {
    // Make sure the data buffer contains 4 bytes at the cursor.
    if data.len() < *offset + 4 {
        return Err(Error::Encoding);
    }
    let value = u32::from_le_bytes(
        data[*offset..*offset + 4]
            .try_into()
            .map_err(|_| Error::Encoding)?,
    );
    *offset += 4;
    Ok(value)
}

/// Read a little-endian `u64` from `data` at `offset` and advance the cursor.
fn read_u64_le(data: &[u8], offset: &mut usize) -> Result<u64, Error> {
    if data.len() < *offset + 8 {
        return Err(Error::Encoding);
    }
    let value = u64::from_le_bytes(
        data[*offset..*offset + 8]
            .try_into()
            .map_err(|_| Error::Encoding)?,
    );
    *offset += 8;
    Ok(value)
}

/// Read a fixed-length array `[u8; N]` from `data` starting at `offset`.
fn read_bytes<const N: usize>(data: &[u8], offset: &mut usize) -> Result<[u8; N], Error> {
    if data.len() < *offset + N {
        return Err(Error::Encoding);
    }
    let value = data[*offset..*offset + N]
        .try_into()
        .map_err(|_| Error::Encoding)?;
    *offset += N;
    Ok(value)
}

/// Read a canonical boolean byte. Only 0 and 1 are valid encodings.
fn read_bool(data: &[u8], offset: &mut usize) -> Result<bool, Error> {
    if data.len() <= *offset {
        return Err(Error::Encoding);
    }
    let value = match data[*offset] {
        0 => false,
        1 => true,
        _ => return Err(Error::Encoding),
    };
    *offset += 1;
    Ok(value)
}

/// Reject non-canonical payloads with bytes after the expected layout.
fn ensure_consumed(data: &[u8], offset: usize) -> Result<(), Error> {
    if offset == data.len() {
        Ok(())
    } else {
        Err(Error::Encoding)
    }
}

/// Read a length-prefixed `Vec<u8>`. The length is a little-endian `u32`.
fn read_vec(data: &[u8], offset: &mut usize) -> Result<Vec<u8>, Error> {
    let len = read_u32_le(data, offset)? as usize;
    if data.len() < *offset + len {
        return Err(Error::Encoding);
    }
    let value = data[*offset..*offset + len].to_vec();
    *offset += len;
    Ok(value)
}

/// Decode an `EncodedScript` from the byte stream using the cursor.
/// Fields: code_hash (32 bytes), hash_type (1 byte), args (len-prefixed).
pub fn decode_script(data: &[u8], offset: &mut usize) -> Result<EncodedScript, Error> {
    let code_hash = read_bytes::<32>(data, offset)?;
    // hash_type is a single byte following the code_hash
    if data.len() <= *offset {
        return Err(Error::Encoding);
    }
    let hash_type = data[*offset];
    *offset += 1;
    let args = read_vec(data, offset)?;
    Ok(EncodedScript {
        code_hash,
        hash_type,
        args,
    })
}

/// Parse a vote intent from raw bytes (Molecule-like layout).
/// Field order: poll_type_hash(32) | voter_lock_hash(32) | option_index(1)
/// | voted_at_epoch(8 LE) | aggregated(1) | refund_lock(var)
pub fn decode_vote_intent(data: &[u8]) -> Result<VoteIntentData, Error> {
    let mut offset = 0;
    let poll_type_hash = read_bytes::<32>(data, &mut offset)?;
    let voter_lock_hash = read_bytes::<32>(data, &mut offset)?;
    if data.len() <= offset {
        return Err(Error::Encoding);
    }
    let option_index = data[offset];
    offset += 1;
    let voted_at_epoch = read_u64_le(data, &mut offset)?;
    let aggregated = read_bool(data, &mut offset)?;
    let refund_lock = decode_script(data, &mut offset)?;
    ensure_consumed(data, offset)?;
    Ok(VoteIntentData {
        poll_type_hash,
        voter_lock_hash,
        option_index,
        voted_at_epoch,
        aggregated,
        refund_lock,
    })
}

/// Parse a delegation record. Layout: delegator(32) | delegate(32) | poll(32) | expires(8)
pub fn decode_delegation(data: &[u8]) -> Result<DelegationData, Error> {
    let mut offset = 0;
    let delegation = DelegationData {
        delegator_lock_hash: read_bytes::<32>(data, &mut offset)?,
        delegate_lock_hash: read_bytes::<32>(data, &mut offset)?,
        poll_type_hash: read_bytes::<32>(data, &mut offset)?,
        expires_epoch: read_u64_le(data, &mut offset)?,
    };
    ensure_consumed(data, offset)?;
    Ok(delegation)
}

/// Parse a tally shard. Layout: poll(32) | shard_id(u32) | shard_count(u32) |
/// vote_counts(vec<u64>) | total_voters(u64) | counted_voters(vec<[32]>) |
/// finalized(1).
pub fn decode_tally_shard(data: &[u8]) -> Result<TallyShardData, Error> {
    let mut offset = 0;
    let poll_type_hash = read_bytes::<32>(data, &mut offset)?;
    let shard_id = read_u32_le(data, &mut offset)?;
    let shard_count = read_u32_le(data, &mut offset)?;
    if shard_count == 0 || shard_count > MAX_TALLY_SHARDS || shard_id >= shard_count {
        return Err(Error::Encoding);
    }

    let vote_count_len = read_u32_le(data, &mut offset)? as usize;
    let mut vote_counts = Vec::with_capacity(vote_count_len);
    for _ in 0..vote_count_len {
        vote_counts.push(read_u64_le(data, &mut offset)?);
    }

    let total_voters = read_u64_le(data, &mut offset)?;

    let counted_len = read_u32_le(data, &mut offset)? as usize;
    let mut counted_voter_lock_hashes = Vec::with_capacity(counted_len);
    for _ in 0..counted_len {
        counted_voter_lock_hashes.push(read_bytes::<32>(data, &mut offset)?);
    }

    let finalized = read_bool(data, &mut offset)?;
    ensure_consumed(data, offset)?;

    Ok(TallyShardData {
        poll_type_hash,
        shard_id,
        shard_count,
        vote_counts,
        total_voters,
        counted_voter_lock_hashes,
        finalized,
    })
}

/// Parse a tally merge result. Layout: poll(32) | coverage(32 bitmap) |
/// vote_counts(vec<u64>) | total_voters(u64) | merge_level(u32) | version(u32).
pub fn decode_tally_merge_result(data: &[u8]) -> Result<TallyMergeResultData, Error> {
    let mut offset = 0;
    let poll_type_hash = read_bytes::<32>(data, &mut offset)?;
    let coverage = read_bytes::<MERGE_COVERAGE_BYTES>(data, &mut offset)?;

    let vote_count_len = read_u32_le(data, &mut offset)? as usize;
    let mut vote_counts = Vec::with_capacity(vote_count_len);
    for _ in 0..vote_count_len {
        vote_counts.push(read_u64_le(data, &mut offset)?);
    }

    let total_voters = read_u64_le(data, &mut offset)?;
    let merge_level = read_u32_le(data, &mut offset)?;
    let version = read_u32_le(data, &mut offset)?;
    ensure_consumed(data, offset)?;

    Ok(TallyMergeResultData {
        poll_type_hash,
        coverage,
        vote_counts,
        total_voters,
        merge_level,
        version,
    })
}

/// Parse a poll's serialized payload into `PollData`.
///
/// Layout (roughly): question(vec) | options(vec of vec) | vote_counts(vec<u64>) |
/// deadline(u64) | creator(32) | creator_lock(script) | is_closed(1) | total_voters(u64) |
/// creator_deposit(u64) | pending_intent_count(u64) | counted_voter_lock_hashes(vec<[32]>) |
/// token_weighted(1) | udt_type_hash(32) | shard_count(u32)
pub fn decode_poll(data: &[u8]) -> Result<PollData, Error> {
    let mut offset = 0;
    let question = read_vec(data, &mut offset)?;

    // options: length-prefixed list of byte vectors
    let option_count = read_u32_le(data, &mut offset)? as usize;
    let mut options = Vec::with_capacity(option_count);
    for _ in 0..option_count {
        options.push(read_vec(data, &mut offset)?);
    }

    // vote_counts: list of u64 values matching options length
    let vote_count_len = read_u32_le(data, &mut offset)? as usize;
    let mut vote_counts = Vec::with_capacity(vote_count_len);
    for _ in 0..vote_count_len {
        vote_counts.push(read_u64_le(data, &mut offset)?);
    }

    let deadline = read_u64_le(data, &mut offset)?;
    let creator = read_bytes::<32>(data, &mut offset)?;
    let creator_lock = decode_script(data, &mut offset)?;
    let is_closed = read_bool(data, &mut offset)?;
    let total_voters = read_u64_le(data, &mut offset)?;
    let creator_deposit = read_u64_le(data, &mut offset)?;
    let pending_intent_count = read_u64_le(data, &mut offset)?;

    // counted voter lock hashes: vector of fixed 32-byte items
    let counted_len = read_u32_le(data, &mut offset)? as usize;
    let mut counted_voter_lock_hashes = Vec::with_capacity(counted_len);
    for _ in 0..counted_len {
        counted_voter_lock_hashes.push(read_bytes::<32>(data, &mut offset)?);
    }

    let token_weighted = read_bool(data, &mut offset)?;
    let udt_type_hash = read_bytes::<32>(data, &mut offset)?;
    let shard_count = read_u32_le(data, &mut offset)?;
    ensure_consumed(data, offset)?;

    Ok(PollData {
        question,
        options,
        vote_counts,
        deadline,
        creator,
        creator_lock,
        is_closed,
        total_voters,
        creator_deposit,
        pending_intent_count,
        counted_voter_lock_hashes,
        token_weighted,
        udt_type_hash,
        shard_count,
    })
}
