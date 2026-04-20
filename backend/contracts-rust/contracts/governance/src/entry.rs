//! First Rust entry port for the governance script.
//! This stage validates dispatch and decoding boundaries before porting the
//! complete TypeScript validation logic operation by operation.

use alloc::vec::Vec;

use ckb_std::{
    ckb_constants::Source,
    error::SysError,
    high_level::{load_cell_capacity, load_cell_data},
};

use crate::{
    codec::{decode_delegation, decode_poll, decode_vote_intent},
    constants::*,
    error::Error,
    helpers::{
        assert_condition, compare_arrays, compare_scripts, compare_slice_items, compare_vec_bytes,
        count_unique_counted_voters, current_epoch, first_input_type_byte, load_input_capacity,
        load_input_lock_hash_bytes, load_input_script, load_output_capacity, load_output_script,
        min_poll_capacity, saturating_pending_after, validate_duration,
    },
};

pub fn main() -> Result<(), Error> {
    // Full dispatch mode.
    // All six protocol operations now route through their Rust validation
    // implementations instead of mixed stubs.
    let script = ckb_std::high_level::load_script()?;
    let args: Vec<u8> = script.args().raw_data().to_vec();
    let op = *args.first().ok_or(Error::UnknownOp)?;

    match op {
        OP_CREATE_POLL => validate_poll_lifecycle(),
        OP_CREATE_VOTE_INTENT => validate_intent_lifecycle(),
        OP_AGGREGATE_VOTES => validate_aggregate_votes(),
        OP_CLOSE_POLL => validate_close_poll(),
        OP_DELEGATE => validate_delegation_lifecycle(),
        OP_REVOKE_DELEGATION => validate_revoke_delegation(),
        _ => Err(Error::UnknownOp),
    }
}

fn maybe_group_cell_data(source: Source) -> Result<Option<Vec<u8>>, Error> {
    match load_cell_data(0, source) {
        Ok(data) => Ok(Some(data)),
        Err(SysError::IndexOutOfBound) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn validate_poll_lifecycle() -> Result<(), Error> {
    let group_input = maybe_group_cell_data(Source::GroupInput)?;
    let group_output = maybe_group_cell_data(Source::GroupOutput)?;

    match (group_input, group_output) {
        (None, Some(output)) => {
            decode_poll(&output)?;
            validate_create_poll()
        }
        (Some(input), Some(output)) => {
            let before = decode_poll(&input)?;
            let after = decode_poll(&output)?;

            if !before.is_closed && after.is_closed {
                validate_close_poll()
            } else {
                validate_aggregate_votes()
            }
        }
        _ => Err(Error::Validation),
    }
}

fn validate_intent_lifecycle() -> Result<(), Error> {
    let group_input = maybe_group_cell_data(Source::GroupInput)?;
    let group_output = maybe_group_cell_data(Source::GroupOutput)?;

    match (group_input, group_output) {
        (None, Some(output)) => {
            decode_vote_intent(&output)?;
            validate_create_vote_intent()
        }
        (Some(input), Some(output)) => validate_intent_aggregation_transition(&input, &output),
        (Some(input), None) => {
            decode_vote_intent(&input)?;
            Ok(())
        }
        _ => Err(Error::Validation),
    }
}

fn validate_delegation_lifecycle() -> Result<(), Error> {
    let group_input = maybe_group_cell_data(Source::GroupInput)?;
    let group_output = maybe_group_cell_data(Source::GroupOutput)?;

    match (group_input, group_output) {
        (None, Some(output)) => {
            decode_delegation(&output)?;
            validate_delegate()
        }
        (Some(input), None) => {
            decode_delegation(&input)?;
            validate_revoke_delegation()
        }
        _ => Err(Error::Validation),
    }
}

fn validate_intent_aggregation_transition(input: &[u8], output: &[u8]) -> Result<(), Error> {
    let before = decode_vote_intent(input)?;
    let after = decode_vote_intent(output)?;
    let input_capacity = load_cell_capacity(0, Source::GroupInput)?;
    let output_capacity = load_cell_capacity(0, Source::GroupOutput)?;

    assert_condition(!before.aggregated, Error::Validation)?;
    assert_condition(after.aggregated, Error::Validation)?;
    assert_condition(compare_arrays(&after.voter_lock_hash, &before.voter_lock_hash), Error::Validation)?;
    assert_condition(compare_arrays(&after.poll_type_hash, &before.poll_type_hash), Error::Validation)?;
    assert_condition(after.option_index == before.option_index, Error::Validation)?;
    assert_condition(after.voted_at_epoch == before.voted_at_epoch, Error::Validation)?;
    assert_condition(compare_scripts(&after.refund_lock, &before.refund_lock), Error::Validation)?;
    assert_condition(output_capacity >= input_capacity, Error::Validation)
}

fn validate_create_poll() -> Result<(), Error> {
    let output = load_cell_data(0, Source::Output)?;
    let poll = decode_poll(&output)?;
    let capacity = load_output_capacity(0)?;
    let epoch = current_epoch()?;

    assert_condition(!poll.question.is_empty(), Error::Validation)?;
    assert_condition(poll.question.len() <= MAX_QUESTION_LEN, Error::Validation)?;
    assert_condition(poll.options.len() >= 2, Error::Validation)?;
    assert_condition(poll.options.len() <= MAX_OPTIONS, Error::Validation)?;
    assert_condition(poll.vote_counts.len() == poll.options.len(), Error::Validation)?;
    assert_condition(!poll.is_closed, Error::Validation)?;
    assert_condition(poll.total_voters == 0, Error::Validation)?;
    assert_condition(poll.pending_intent_count == 0, Error::Validation)?;
    assert_condition(poll.counted_voter_lock_hashes.is_empty(), Error::Validation)?;
    assert_condition(poll.creator_deposit >= CREATOR_DEPOSIT_SHANNONS, Error::Validation)?;
    assert_condition(count_unique_counted_voters(&poll), Error::Validation)?;
    validate_duration(poll.deadline, epoch)?;

    for option in &poll.options {
        assert_condition(!option.is_empty(), Error::Validation)?;
        assert_condition(option.len() <= MAX_OPTION_LEN, Error::Validation)?;
    }
    for count in &poll.vote_counts {
        assert_condition(*count == 0, Error::Validation)?;
    }

    let min_capacity = min_poll_capacity(output.len(), poll.creator_deposit)?;
    assert_condition(capacity >= min_capacity, Error::Validation)
}

fn validate_create_vote_intent() -> Result<(), Error> {
    let output = load_cell_data(0, Source::Output)?;
    let intent = decode_vote_intent(&output)?;
    let witness_option = first_input_type_byte(0)?;
    let intent_capacity = load_output_capacity(0)?;

    assert_condition(!intent.aggregated, Error::Validation)?;
    assert_condition(intent.option_index == witness_option, Error::Validation)?;
    assert_condition(intent_capacity >= VOTER_DEPOSIT_SHANNONS, Error::Validation)?;

    let delegation_input = load_cell_data(1, Source::Input);
    if let Ok(data) = delegation_input {
        if let Ok(delegation) = decode_delegation(&data) {
            let signer_lock_hash = load_input_lock_hash_bytes(0)?;
            let delegation_lock_hash = load_input_lock_hash_bytes(1)?;
            let refund_lock = load_input_script(1)?;

            assert_condition(compare_arrays(&delegation.delegate_lock_hash, &signer_lock_hash), Error::Validation)?;
            if delegation.expires_epoch > 0 {
                assert_condition(current_epoch()? <= delegation.expires_epoch, Error::Validation)?;
            }
            assert_condition(
                compare_arrays(&delegation.delegator_lock_hash, &delegation_lock_hash),
                Error::Validation,
            )?;
            assert_condition(compare_arrays(&intent.voter_lock_hash, &delegation.delegator_lock_hash), Error::Validation)?;
            return assert_condition(compare_scripts(&intent.refund_lock, &refund_lock), Error::Validation);
        }
    }

    let voter_lock_hash = load_input_lock_hash_bytes(0)?;
    let refund_lock = load_input_script(0)?;
    assert_condition(compare_arrays(&intent.voter_lock_hash, &voter_lock_hash), Error::Validation)?;
    assert_condition(compare_scripts(&intent.refund_lock, &refund_lock), Error::Validation)
}

fn validate_aggregate_votes() -> Result<(), Error> {
    let input_poll = load_cell_data(0, Source::Input)?;
    let output_poll = load_cell_data(0, Source::Output)?;
    let before = decode_poll(&input_poll)?;
    let after = decode_poll(&output_poll)?;
    let epoch = current_epoch()?;

    assert_condition(!before.is_closed, Error::Validation)?;
    assert_condition(epoch <= before.deadline, Error::Validation)?;
    assert_condition(compare_vec_bytes(&after.question, &before.question), Error::Validation)?;
    assert_condition(compare_slice_items(&after.options, &before.options), Error::Validation)?;
    assert_condition(after.deadline == before.deadline, Error::Validation)?;
    assert_condition(compare_arrays(&after.creator, &before.creator), Error::Validation)?;
    assert_condition(after.creator_deposit == before.creator_deposit, Error::Validation)?;
    assert_condition(!after.is_closed, Error::Validation)?;
    assert_condition(after.token_weighted == before.token_weighted, Error::Validation)?;
    assert_condition(compare_arrays(&after.udt_type_hash, &before.udt_type_hash), Error::Validation)?;
    assert_condition(after.vote_counts.len() == before.vote_counts.len(), Error::Validation)?;
    assert_condition(count_unique_counted_voters(&after), Error::Validation)?;

    let mut seen_voters = before.counted_voter_lock_hashes.clone();
    let mut batch_voters: Vec<[u8; 32]> = Vec::new();
    let mut deltas = alloc::vec![0u64; before.options.len()];
    let mut intent_count = 0usize;

    for index in 1..=MAX_INTENTS_PER_AGG {
        let input = match load_cell_data(index, Source::Input) {
            Ok(data) => data,
            Err(SysError::IndexOutOfBound) => break,
            Err(err) => return Err(err.into()),
        };
        let output = load_cell_data(index, Source::Output)?;
        let before_intent = decode_vote_intent(&input)?;
        let after_intent = decode_vote_intent(&output)?;
        let input_capacity = load_input_capacity(index)?;
        let output_capacity = load_output_capacity(index)?;

        assert_condition(!before_intent.aggregated, Error::Validation)?;
        assert_condition(after_intent.aggregated, Error::Validation)?;
        assert_condition(compare_arrays(&after_intent.voter_lock_hash, &before_intent.voter_lock_hash), Error::Validation)?;
        assert_condition(compare_arrays(&after_intent.poll_type_hash, &before_intent.poll_type_hash), Error::Validation)?;
        assert_condition(after_intent.option_index == before_intent.option_index, Error::Validation)?;
        assert_condition(after_intent.voted_at_epoch == before_intent.voted_at_epoch, Error::Validation)?;
        assert_condition(compare_scripts(&after_intent.refund_lock, &before_intent.refund_lock), Error::Validation)?;
        assert_condition(output_capacity >= input_capacity, Error::Validation)?;
        assert_condition((before_intent.option_index as usize) < before.options.len(), Error::Validation)?;
        assert_condition(
            !seen_voters.iter().any(|existing| existing == &before_intent.voter_lock_hash),
            Error::Validation,
        )?;

        deltas[before_intent.option_index as usize] += 1;
        seen_voters.push(before_intent.voter_lock_hash);
        batch_voters.push(before_intent.voter_lock_hash);
        intent_count += 1;
    }

    assert_condition(intent_count > 0, Error::Validation)?;
    assert_condition(
        after.counted_voter_lock_hashes.len() == before.counted_voter_lock_hashes.len() + batch_voters.len(),
        Error::Validation,
    )?;

    for (index, voter) in before.counted_voter_lock_hashes.iter().enumerate() {
        assert_condition(compare_arrays(&after.counted_voter_lock_hashes[index], voter), Error::Validation)?;
    }
    for (offset, voter) in batch_voters.iter().enumerate() {
        let next_index = before.counted_voter_lock_hashes.len() + offset;
        assert_condition(compare_arrays(&after.counted_voter_lock_hashes[next_index], voter), Error::Validation)?;
    }
    for (index, previous_count) in before.vote_counts.iter().enumerate() {
        let expected = previous_count.checked_add(deltas[index]).ok_or(Error::Validation)?;
        assert_condition(after.vote_counts[index] == expected, Error::Validation)?;
    }

    let expected_total = before
        .total_voters
        .checked_add(u64::try_from(intent_count).map_err(|_| Error::Validation)?)
        .ok_or(Error::Validation)?;
    assert_condition(after.total_voters == expected_total, Error::Validation)?;
    assert_condition(after.total_voters == after.counted_voter_lock_hashes.len() as u64, Error::Validation)?;
    assert_condition(
        after.pending_intent_count == saturating_pending_after(before.pending_intent_count, intent_count)?,
        Error::Validation,
    )
}

fn validate_close_poll() -> Result<(), Error> {
    let input_poll = load_cell_data(0, Source::Input)?;
    let output_poll = load_cell_data(0, Source::Output)?;
    let before = decode_poll(&input_poll)?;
    let after = decode_poll(&output_poll)?;
    let creator_lock_hash = load_input_lock_hash_bytes(1)?;
    let creator_lock = load_input_script(1)?;
    let creator_return_lock = load_output_script(1)?;
    let creator_return_capacity = load_output_capacity(1)?;

    assert_condition(!before.is_closed, Error::Validation)?;
    assert_condition(after.is_closed, Error::Validation)?;
    assert_condition(compare_vec_bytes(&after.question, &before.question), Error::Validation)?;
    assert_condition(compare_slice_items(&after.options, &before.options), Error::Validation)?;
    assert_condition(compare_slice_items(&after.counted_voter_lock_hashes, &before.counted_voter_lock_hashes), Error::Validation)?;
    assert_condition(after.deadline == before.deadline, Error::Validation)?;
    assert_condition(compare_arrays(&after.creator, &before.creator), Error::Validation)?;
    assert_condition(after.total_voters == before.total_voters, Error::Validation)?;
    assert_condition(after.creator_deposit == before.creator_deposit, Error::Validation)?;
    assert_condition(after.pending_intent_count == before.pending_intent_count, Error::Validation)?;
    assert_condition(after.token_weighted == before.token_weighted, Error::Validation)?;
    assert_condition(compare_arrays(&after.udt_type_hash, &before.udt_type_hash), Error::Validation)?;
    assert_condition(after.vote_counts == before.vote_counts, Error::Validation)?;
    assert_condition(compare_arrays(&creator_lock_hash, &before.creator), Error::Validation)?;
    assert_condition(compare_scripts(&creator_return_lock, &creator_lock), Error::Validation)?;
    assert_condition(creator_return_capacity >= before.creator_deposit, Error::Validation)?;

    let mut output_index = 2usize;
    let mut input_index = 2usize;
    loop {
        let input = match load_cell_data(input_index, Source::Input) {
            Ok(data) => data,
            Err(SysError::IndexOutOfBound) => break,
            Err(err) => return Err(err.into()),
        };

        if let Ok(intent) = decode_vote_intent(&input) {
            let return_lock = load_output_script(output_index)?;
            let return_capacity = load_output_capacity(output_index)?;
            assert_condition(compare_scripts(&return_lock, &intent.refund_lock), Error::Validation)?;
            assert_condition(return_capacity >= VOTER_DEPOSIT_SHANNONS, Error::Validation)?;
            output_index += 1;
        }

        input_index += 1;
    }

    Ok(())
}

fn validate_delegate() -> Result<(), Error> {
    let output = load_cell_data(0, Source::Output)?;
    let delegation = decode_delegation(&output)?;
    let delegator_lock_hash = load_input_lock_hash_bytes(0)?;
    let output_capacity = load_output_capacity(0)?;

    assert_condition(
        compare_arrays(&delegation.delegator_lock_hash, &delegator_lock_hash),
        Error::Validation,
    )?;
    assert_condition(
        !compare_arrays(&delegation.delegator_lock_hash, &delegation.delegate_lock_hash),
        Error::Validation,
    )?;
    if delegation.expires_epoch > 0 {
        assert_condition(delegation.expires_epoch > current_epoch()?, Error::Validation)?;
    }
    assert_condition(output_capacity >= DELEGATION_MIN_SHANNONS, Error::Validation)
}

fn validate_revoke_delegation() -> Result<(), Error> {
    let input = load_cell_data(0, Source::Input)?;
    let _delegation = decode_delegation(&input)?;
    let input_lock = load_input_script(0)?;
    let output_lock = load_output_script(0)?;
    let output_capacity = load_output_capacity(0)?;
    let input_capacity = load_input_capacity(0)?;

    assert_condition(compare_scripts(&input_lock, &output_lock), Error::Validation)?;
    assert_condition(output_capacity >= DELEGATION_MIN_SHANNONS, Error::Validation)?;
    assert_condition(output_capacity >= input_capacity, Error::Validation)
}
