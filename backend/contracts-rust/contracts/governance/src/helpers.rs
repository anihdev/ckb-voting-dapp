//! Shared CKB helpers for the Rust governance contract.
//! These mirror the TypeScript contract's cell/script access patterns so the
//! operation ports can focus on protocol rules instead of syscall details.

use alloc::vec::Vec;

use ckb_hash::blake2b_256;
use ckb_std::{
    ckb_constants::Source,
    ckb_types::{bytes::Bytes, packed::Script, prelude::*},
    high_level::{
        load_cell_capacity, load_cell_lock, load_cell_lock_hash, load_cell_type,
        load_cell_type_hash, load_header_epoch_number, load_script, load_witness_args,
    },
};

use crate::{
    codec::{EncodedScript, PollData, TallyShardData},
    constants::{MAX_DURATION_EPOCHS, MIN_DURATION_EPOCHS},
    error::Error,
};

/// @notice Converts boolean checks into contract validation results.
/// @dev Keeps call sites compact while preserving explicit error mapping.
pub fn assert_condition(condition: bool, err: Error) -> Result<(), Error> {
    if condition {
        Ok(())
    } else {
        Err(err)
    }
}

/// @notice Reads the current epoch number from header deps.
/// @dev Header dep `0` is treated as the chain tip reference for governance timing.
pub fn current_epoch() -> Result<u64, Error> {
    // Match the TypeScript reference: read the latest epoch from header deps.
    Ok(load_header_epoch_number(0, Source::HeaderDep)?)
}

/// @notice Validates poll duration bounds against the current epoch.
/// @dev Duration is `deadline - epoch` and must stay within configured min/max.
pub fn validate_duration(deadline: u64, epoch: u64) -> Result<(), Error> {
    assert_condition(deadline > epoch, Error::Validation)?;
    let duration = deadline - epoch;
    assert_condition(duration >= MIN_DURATION_EPOCHS, Error::Validation)?;
    assert_condition(duration <= MAX_DURATION_EPOCHS, Error::Validation)
}

/// @notice Loads output capacity from a given output index.
pub fn load_output_capacity(index: usize) -> Result<u64, Error> {
    Ok(load_cell_capacity(index, Source::Output)?)
}

/// @notice Loads input capacity from a given input index.
pub fn load_input_capacity(index: usize) -> Result<u64, Error> {
    Ok(load_cell_capacity(index, Source::Input)?)
}

/// @notice Loads an input lock hash as a fixed 32-byte value.
pub fn load_input_lock_hash_bytes(index: usize) -> Result<[u8; 32], Error> {
    let bytes = load_cell_lock_hash(index, Source::Input)?;
    bytes.as_ref().try_into().map_err(|_| Error::Encoding)
}

/// @notice Decodes an input lock script into the internal encoded representation.
pub fn load_input_script(index: usize) -> Result<EncodedScript, Error> {
    decode_loaded_script(load_cell_lock(index, Source::Input)?)
}

/// @notice Loads an input type hash as a fixed 32-byte value.
/// @dev Fails validation when the input has no type script.
pub fn load_input_type_hash_bytes(index: usize) -> Result<[u8; 32], Error> {
    load_cell_type_hash(index, Source::Input)?.ok_or(Error::Validation)
}

/// @notice Decodes an input type script into the internal encoded representation.
/// @dev Fails validation when the input has no type script.
pub fn load_input_type_script(index: usize) -> Result<EncodedScript, Error> {
    let script = load_cell_type(index, Source::Input)?.ok_or(Error::Validation)?;
    decode_loaded_script(script)
}

/// @notice Decodes an output lock script into the internal encoded representation.
pub fn load_output_script(index: usize) -> Result<EncodedScript, Error> {
    decode_loaded_script(load_cell_lock(index, Source::Output)?)
}

/// @notice Decodes an output type script into the internal encoded representation.
/// @dev Fails validation when the output has no type script.
pub fn load_output_type_script(index: usize) -> Result<EncodedScript, Error> {
    let script = load_cell_type(index, Source::Output)?.ok_or(Error::Validation)?;
    decode_loaded_script(script)
}

/// @notice Loads an output type hash as a fixed 32-byte value.
/// @dev Fails validation when the output has no type script.
pub fn load_output_type_hash_bytes(index: usize) -> Result<[u8; 32], Error> {
    load_cell_type_hash(index, Source::Output)?.ok_or(Error::Validation)
}

/// @notice Decodes a group-output lock script into internal encoded representation.
pub fn load_group_output_script(index: usize) -> Result<EncodedScript, Error> {
    decode_loaded_script(load_cell_lock(index, Source::GroupOutput)?)
}

/// @notice Decodes a group-input lock script into internal encoded representation.
pub fn load_group_input_script(index: usize) -> Result<EncodedScript, Error> {
    decode_loaded_script(load_cell_lock(index, Source::GroupInput)?)
}

/// @notice Decodes a cell-dep lock script into the internal encoded representation.
pub fn load_cell_dep_script(index: usize) -> Result<EncodedScript, Error> {
    decode_loaded_script(load_cell_lock(index, Source::CellDep)?)
}

/// @notice Decodes a cell-dep type script into the internal encoded representation.
pub fn load_cell_dep_type_script(index: usize) -> Result<EncodedScript, Error> {
    let script = load_cell_type(index, Source::CellDep)?.ok_or(Error::Validation)?;
    decode_loaded_script(script)
}

/// @notice Decodes the currently executing script into the internal format.
/// @dev Used to mirror governance lock/type scripts across lifecycle transitions.
pub fn load_current_script() -> Result<EncodedScript, Error> {
    decode_loaded_script(load_script()?)
}

/// @notice Loads an output lock hash as a fixed 32-byte value.
pub fn load_output_lock_hash_bytes(index: usize) -> Result<[u8; 32], Error> {
    let bytes = load_cell_lock_hash(index, Source::Output)?;
    bytes.as_ref().try_into().map_err(|_| Error::Encoding)
}

/// @notice Reads the first byte of the input-type witness payload.
/// @dev Governance encodes vote option selection in this witness byte.
pub fn first_input_type_byte(index: usize) -> Result<u8, Error> {
    let witness = load_witness_args(index, Source::Input)?;
    let input_type = witness.input_type().to_opt().ok_or(Error::Validation)?;
    let bytes = input_type.raw_data();
    bytes.first().copied().ok_or(Error::Validation)
}

/// @notice Compares two fixed-size byte arrays.
pub fn compare_arrays<const N: usize>(left: &[u8; N], right: &[u8; N]) -> bool {
    left == right
}

/// @notice Compares two byte slices.
pub fn compare_vec_bytes(left: &[u8], right: &[u8]) -> bool {
    left == right
}

/// @notice Compares two generic slices by value equality.
pub fn compare_slice_items<T: PartialEq>(left: &[T], right: &[T]) -> bool {
    left == right
}

/// @notice Compares two encoded scripts for full structural equality.
pub fn compare_scripts(left: &EncodedScript, right: &EncodedScript) -> bool {
    left.code_hash == right.code_hash
        && left.hash_type == right.hash_type
        && left.args == right.args
}

/// @notice Computes the minimum capacity needed for a poll output.
/// @dev Includes creator deposit plus occupied-bytes conversion to shannons.
pub fn min_poll_capacity(data_len: usize, creator_deposit: u64) -> Result<u64, Error> {
    let bytes = u64::try_from(data_len).map_err(|_| Error::Validation)?;
    let occupied = bytes.checked_add(61).ok_or(Error::Validation)?;
    let occupied_capacity = occupied.checked_mul(100_000_000).ok_or(Error::Validation)?;
    creator_deposit
        .checked_add(occupied_capacity)
        .ok_or(Error::Validation)
}

/// @notice Ensures counted voter registry has no duplicate lock hashes.
/// @dev Used to protect tally correctness during aggregation transitions.
pub fn count_unique_counted_voters(poll: &PollData) -> bool {
    count_unique_lock_hashes(&poll.counted_voter_lock_hashes)
}

/// @notice Ensures shard counted voter registry has no duplicate lock hashes.
/// @dev Sharded aggregation uses this bounded registry instead of poll growth.
pub fn count_unique_shard_voters(shard: &TallyShardData) -> bool {
    count_unique_lock_hashes(&shard.counted_voter_lock_hashes)
}

/// @notice Ensures a list of 32-byte lock hashes contains no duplicates.
pub fn count_unique_lock_hashes(values: &[[u8; 32]]) -> bool {
    let mut seen: Vec<[u8; 32]> = Vec::with_capacity(values.len());
    for voter in values {
        if seen.iter().any(|existing| existing == voter) {
            return false;
        }
        seen.push(*voter);
    }
    true
}

/// @notice Derives the canonical shard id for a voter in a poll.
/// @dev Hash input is `poll_type_hash || voter_lock_hash`; first 8 digest
/// bytes are interpreted as little-endian u64 and reduced modulo shard_count.
pub fn derive_tally_shard_id(
    poll_type_hash: &[u8; 32],
    voter_lock_hash: &[u8; 32],
    shard_count: u32,
) -> Result<u32, Error> {
    assert_condition(shard_count > 0, Error::Validation)?;
    let mut input = [0u8; 64];
    input[..32].copy_from_slice(poll_type_hash);
    input[32..].copy_from_slice(voter_lock_hash);
    let digest = blake2b_256(input);
    let bucket = u64::from_le_bytes(digest[..8].try_into().map_err(|_| Error::Encoding)?);
    Ok((bucket % u64::from(shard_count)) as u32)
}

/// @notice Converts a loaded CKB script into the encoded script layout used by the codec.
fn decode_loaded_script(script: Script) -> Result<EncodedScript, Error> {
    let code_hash: [u8; 32] = script
        .code_hash()
        .as_slice()
        .try_into()
        .map_err(|_| Error::Encoding)?;
    let hash_type = script
        .hash_type()
        .as_slice()
        .first()
        .copied()
        .ok_or(Error::Encoding)?;
    let args: Bytes = script.args().raw_data();
    Ok(EncodedScript {
        code_hash,
        hash_type,
        args: args.to_vec(),
    })
}
