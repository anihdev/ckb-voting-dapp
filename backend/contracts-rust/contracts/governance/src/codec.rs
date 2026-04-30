//! Reference codec port from the TypeScript contract.
//! This first pass focuses on keeping byte layout parity obvious before
//! replacing the TypeScript reference as the execution source of truth.

use alloc::vec::Vec;

use crate::error::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodedScript {
    pub code_hash: [u8; 32],
    pub hash_type: u8,
    pub args: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PollData {
    pub question: Vec<u8>,
    pub options: Vec<Vec<u8>>,
    pub vote_counts: Vec<u64>,
    pub deadline: u64,
    pub creator: [u8; 32],
    pub is_closed: bool,
    pub total_voters: u64,
    pub creator_deposit: u64,
    pub pending_intent_count: u64,
    pub counted_voter_lock_hashes: Vec<[u8; 32]>,
    pub token_weighted: bool,
    pub udt_type_hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoteIntentData {
    pub poll_type_hash: [u8; 32],
    pub voter_lock_hash: [u8; 32],
    pub option_index: u8,
    pub voted_at_epoch: u64,
    pub aggregated: bool,
    pub refund_lock: EncodedScript,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DelegationData {
    pub delegator_lock_hash: [u8; 32],
    pub delegate_lock_hash: [u8; 32],
    pub poll_type_hash: [u8; 32],
    pub expires_epoch: u64,
}

/// @notice Reads a little-endian u32 and advances the cursor.
fn read_u32_le(data: &[u8], offset: &mut usize) -> Result<u32, Error> {
    if data.len() < *offset + 4 {
        return Err(Error::Encoding);
    }
    let value = u32::from_le_bytes(data[*offset..*offset + 4].try_into().map_err(|_| Error::Encoding)?);
    *offset += 4;
    Ok(value)
}

/// @notice Reads a little-endian u64 and advances the cursor.
fn read_u64_le(data: &[u8], offset: &mut usize) -> Result<u64, Error> {
    if data.len() < *offset + 8 {
        return Err(Error::Encoding);
    }
    let value = u64::from_le_bytes(data[*offset..*offset + 8].try_into().map_err(|_| Error::Encoding)?);
    *offset += 8;
    Ok(value)
}

/// @notice Reads a fixed-length byte array and advances the cursor.
fn read_bytes<const N: usize>(data: &[u8], offset: &mut usize) -> Result<[u8; N], Error> {
    if data.len() < *offset + N {
        return Err(Error::Encoding);
    }
    let value = data[*offset..*offset + N].try_into().map_err(|_| Error::Encoding)?;
    *offset += N;
    Ok(value)
}

/// @notice Reads a length-prefixed byte vector and advances the cursor.
fn read_vec(data: &[u8], offset: &mut usize) -> Result<Vec<u8>, Error> {
    let len = read_u32_le(data, offset)? as usize;
    if data.len() < *offset + len {
        return Err(Error::Encoding);
    }
    let value = data[*offset..*offset + len].to_vec();
    *offset += len;
    Ok(value)
}

/// @notice Decodes an encoded script from the current cursor.
pub fn decode_script(data: &[u8], offset: &mut usize) -> Result<EncodedScript, Error> {
    let code_hash = read_bytes::<32>(data, offset)?;
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

/// @notice Decodes VoteIntentData from molecule-compatible bytes.
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
    if data.len() <= offset {
        return Err(Error::Encoding);
    }
    let aggregated = data[offset] == 1;
    offset += 1;
    let refund_lock = decode_script(data, &mut offset)?;
    Ok(VoteIntentData {
        poll_type_hash,
        voter_lock_hash,
        option_index,
        voted_at_epoch,
        aggregated,
        refund_lock,
    })
}

/// @notice Decodes DelegationData from molecule-compatible bytes.
pub fn decode_delegation(data: &[u8]) -> Result<DelegationData, Error> {
    let mut offset = 0;
    Ok(DelegationData {
        delegator_lock_hash: read_bytes::<32>(data, &mut offset)?,
        delegate_lock_hash: read_bytes::<32>(data, &mut offset)?,
        poll_type_hash: read_bytes::<32>(data, &mut offset)?,
        expires_epoch: read_u64_le(data, &mut offset)?,
    })
}

/// @notice Decodes PollData from molecule-compatible bytes.
pub fn decode_poll(data: &[u8]) -> Result<PollData, Error> {
    let mut offset = 0;
    let question = read_vec(data, &mut offset)?;

    let option_count = read_u32_le(data, &mut offset)? as usize;
    let mut options = Vec::with_capacity(option_count);
    for _ in 0..option_count {
        options.push(read_vec(data, &mut offset)?);
    }

    let vote_count_len = read_u32_le(data, &mut offset)? as usize;
    let mut vote_counts = Vec::with_capacity(vote_count_len);
    for _ in 0..vote_count_len {
        vote_counts.push(read_u64_le(data, &mut offset)?);
    }

    let deadline = read_u64_le(data, &mut offset)?;
    let creator = read_bytes::<32>(data, &mut offset)?;
    if data.len() <= offset {
        return Err(Error::Encoding);
    }
    let is_closed = data[offset] == 1;
    offset += 1;
    let total_voters = read_u64_le(data, &mut offset)?;
    let creator_deposit = read_u64_le(data, &mut offset)?;
    let pending_intent_count = read_u64_le(data, &mut offset)?;

    let counted_len = read_u32_le(data, &mut offset)? as usize;
    let mut counted_voter_lock_hashes = Vec::with_capacity(counted_len);
    for _ in 0..counted_len {
        counted_voter_lock_hashes.push(read_bytes::<32>(data, &mut offset)?);
    }

    if data.len() <= offset {
        return Err(Error::Encoding);
    }
    let token_weighted = data[offset] == 1;
    offset += 1;
    let udt_type_hash = read_bytes::<32>(data, &mut offset)?;

    Ok(PollData {
        question,
        options,
        vote_counts,
        deadline,
        creator,
        is_closed,
        total_voters,
        creator_deposit,
        pending_intent_count,
        counted_voter_lock_hashes,
        token_weighted,
        udt_type_hash,
    })
}
