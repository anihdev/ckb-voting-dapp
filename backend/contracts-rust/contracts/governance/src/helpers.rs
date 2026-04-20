//! Shared CKB helpers for the Rust governance contract.
//! These mirror the TypeScript contract's cell/script access patterns so the
//! operation ports can focus on protocol rules instead of syscall details.

use alloc::vec::Vec;

use ckb_std::{
    ckb_constants::Source,
    ckb_types::{bytes::Bytes, packed::Script, prelude::*},
    high_level::{load_cell_capacity, load_cell_lock, load_cell_lock_hash, load_header_epoch_number, load_witness_args},
};

use crate::{
    codec::{EncodedScript, PollData},
    constants::{MAX_DURATION_EPOCHS, MIN_DURATION_EPOCHS},
    error::Error,
};

pub fn assert_condition(condition: bool, err: Error) -> Result<(), Error> {
    if condition {
        Ok(())
    } else {
        Err(err)
    }
}

pub fn current_epoch() -> Result<u64, Error> {
    // Match the TypeScript reference: read the latest epoch from header deps.
    Ok(load_header_epoch_number(0, Source::HeaderDep)?)
}

pub fn validate_duration(deadline: u64, epoch: u64) -> Result<(), Error> {
    assert_condition(deadline > epoch, Error::Validation)?;
    let duration = deadline - epoch;
    assert_condition(duration >= MIN_DURATION_EPOCHS, Error::Validation)?;
    assert_condition(duration <= MAX_DURATION_EPOCHS, Error::Validation)
}

pub fn load_output_capacity(index: usize) -> Result<u64, Error> {
    Ok(load_cell_capacity(index, Source::Output)?)
}

pub fn load_input_capacity(index: usize) -> Result<u64, Error> {
    Ok(load_cell_capacity(index, Source::Input)?)
}

pub fn load_input_lock_hash_bytes(index: usize) -> Result<[u8; 32], Error> {
    let bytes = load_cell_lock_hash(index, Source::Input)?;
    bytes.as_ref().try_into().map_err(|_| Error::Encoding)
}

pub fn load_input_script(index: usize) -> Result<EncodedScript, Error> {
    decode_loaded_script(load_cell_lock(index, Source::Input)?)
}

pub fn load_output_script(index: usize) -> Result<EncodedScript, Error> {
    decode_loaded_script(load_cell_lock(index, Source::Output)?)
}

pub fn first_input_type_byte(index: usize) -> Result<u8, Error> {
    let witness = load_witness_args(index, Source::Input)?;
    let input_type = witness.input_type().to_opt().ok_or(Error::Validation)?;
    let bytes = input_type.raw_data();
    bytes.first().copied().ok_or(Error::Validation)
}

pub fn compare_arrays<const N: usize>(left: &[u8; N], right: &[u8; N]) -> bool {
    left == right
}

pub fn compare_vec_bytes(left: &[u8], right: &[u8]) -> bool {
    left == right
}

pub fn compare_slice_items<T: PartialEq>(left: &[T], right: &[T]) -> bool {
    left == right
}

pub fn compare_scripts(left: &EncodedScript, right: &EncodedScript) -> bool {
    left.code_hash == right.code_hash && left.hash_type == right.hash_type && left.args == right.args
}

pub fn min_poll_capacity(data_len: usize, creator_deposit: u64) -> Result<u64, Error> {
    let bytes = u64::try_from(data_len).map_err(|_| Error::Validation)?;
    let occupied = bytes.checked_add(61).ok_or(Error::Validation)?;
    let occupied_capacity = occupied
        .checked_mul(100_000_000)
        .ok_or(Error::Validation)?;
    creator_deposit
        .checked_add(occupied_capacity)
        .ok_or(Error::Validation)
}

pub fn count_unique_counted_voters(poll: &PollData) -> bool {
    let mut seen: Vec<[u8; 32]> = Vec::with_capacity(poll.counted_voter_lock_hashes.len());
    for voter in &poll.counted_voter_lock_hashes {
        if seen.iter().any(|existing| existing == voter) {
            return false;
        }
        seen.push(*voter);
    }
    true
}

pub fn saturating_pending_after(before: u64, processed: usize) -> Result<u64, Error> {
    let processed = u64::try_from(processed).map_err(|_| Error::Validation)?;
    Ok(before.saturating_sub(processed))
}

fn decode_loaded_script(script: Script) -> Result<EncodedScript, Error> {
    let code_hash: [u8; 32] = script
        .code_hash()
        .as_slice()
        .try_into()
        .map_err(|_| Error::Encoding)?;
    let hash_type = script.hash_type().as_slice().first().copied().ok_or(Error::Encoding)?;
    let args: Bytes = script.args().raw_data();
    Ok(EncodedScript {
        code_hash,
        hash_type,
        args: args.to_vec(),
    })
}
