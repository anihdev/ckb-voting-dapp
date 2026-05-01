//! Governance contract entry — validates and routes protocol operations.
//!
//! This file contains the top-level dispatch and the main validation
//! routines used by each on-chain operation. Comments are written to be
//! human-friendly and explain the purpose of checks and transitions.

use alloc::vec::Vec;

use ckb_std::{
    ckb_constants::Source,
    error::SysError,
    high_level::{load_cell_capacity, load_cell_data, load_cell_type_hash},
};

use crate::{
    codec::{decode_delegation, decode_poll, decode_vote_intent, PollData},
    constants::*,
    error::Error,
    helpers::{
        assert_condition, compare_arrays, compare_scripts, compare_slice_items, compare_vec_bytes,
        count_unique_counted_voters, current_epoch, first_input_type_byte, load_input_capacity,
        load_input_lock_hash_bytes, load_input_script, load_input_type_hash_bytes,
        load_output_capacity, load_output_lock_hash_bytes, load_output_script, min_poll_capacity,
        validate_duration,
    },
};

/// Entry point for the contract. Reads the script arguments and dispatches
/// to the validator that handles the selected operation.
///
/// The first byte of the script args is the operation code.
pub fn main() -> Result<(), Error> {
    // Load the currently executing script and parse arguments.
    // The operation code is the first byte of the args slice.
    let script = ckb_std::high_level::load_script()?;
    let args: Vec<u8> = script.args().raw_data().to_vec();
    let op = *args.first().ok_or(Error::UnknownOp)?;

    // Dispatch to the correct validation routine based on op code.
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

/// Try to load the cell data for group index 0.
///
/// Returns `Ok(None)` if the group is empty (IndexOutOfBound), otherwise
/// returns the raw bytes of the group cell payload.
fn maybe_group_cell_data(source: Source) -> Result<Option<Vec<u8>>, Error> {
    match load_cell_data(0, source) {
        Ok(data) => Ok(Some(data)),
        Err(SysError::IndexOutOfBound) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

/// Decide whether the poll group operation is a creation, an aggregation,
/// or a close, then call the matching validator.
///
/// Decision is based on whether the type-group has input and/or output cells.
fn validate_poll_lifecycle() -> Result<(), Error> {
    let group_input = maybe_group_cell_data(Source::GroupInput)?;
    let group_output = maybe_group_cell_data(Source::GroupOutput)?;

    match (group_input, group_output) {
        // No input poll but an output poll => new poll being created.
        (None, Some(output)) => {
            decode_poll(&output)?; // validate encoding
            validate_create_poll()
        }
        // Both input and output exist => either aggregate or close transition.
        (Some(input), Some(output)) => {
            let before = decode_poll(&input)?;
            let after = decode_poll(&output)?;

            // If poll moved from open -> closed then it's a close, otherwise
            // it's an aggregation update of vote counts.
            if !before.is_closed && after.is_closed {
                validate_close_poll()
            } else {
                validate_aggregate_votes()
            }
        }
        // Any other pattern is invalid for poll transitions.
        _ => Err(Error::Validation),
    }
}

/// Determine how intent (vote intent) group changed and validate the
/// corresponding operation: creation, aggregation (replace), or consumption.
fn validate_intent_lifecycle() -> Result<(), Error> {
    let group_input = maybe_group_cell_data(Source::GroupInput)?;
    let group_output = maybe_group_cell_data(Source::GroupOutput)?;

    match (group_input, group_output) {
        // New intent created (no input, output present)
        (None, Some(output)) => {
            decode_vote_intent(&output)?;
            validate_create_vote_intent()
        }
        // Intent replaced/aggregated: both input+output present
        (Some(input), Some(output)) => validate_intent_aggregation_transition(&input, &output),
        // Intent consumed without output (simple consumption)
        (Some(input), None) => {
            decode_vote_intent(&input)?;
            Ok(())
        }
        _ => Err(Error::Validation),
    }
}

/// Validate delegation creation or revocation by inspecting the group
/// inputs/outputs. Creation = no input, output present. Revoke = input consumed.
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

/// Validate a single intent aggregation transition (input -> output).
///
/// Typical aggregation replaces a pending intent with an aggregated marker
/// while preserving the intent's binding to the voter, poll, refund-lock
/// and chosen option. We check capacity, ownership and identity invariants.
fn validate_intent_aggregation_transition(input: &[u8], output: &[u8]) -> Result<(), Error> {
    let before = decode_vote_intent(input)?;
    let after = decode_vote_intent(output)?;
    // group deposit checks
    let input_capacity = load_cell_capacity(0, Source::GroupInput)?;
    let output_capacity = load_cell_capacity(0, Source::GroupOutput)?;
    let output_lock = load_output_script(0)?;

    // Basic invariants: before must be pending, after must be marked aggregated.
    assert_condition(!before.aggregated, Error::Validation)?;

    // Identity checks: voter and poll must match between before/after.
    assert_condition(
        compare_arrays(&after.voter_lock_hash, &before.voter_lock_hash),
        Error::Validation,
    )?;
    assert_condition(
        compare_arrays(&after.poll_type_hash, &before.poll_type_hash),
        Error::Validation,
    )?;

    // Refund-lock and output lock must match expected ownership.
    assert_condition(
        compare_scripts(&after.refund_lock, &before.refund_lock),
        Error::Validation,
    )?;
    assert_condition(
        compare_scripts(&output_lock, &after.refund_lock),
        Error::Validation,
    )?;

    // Capacity checks: outputs must preserve at least the voter deposit.
    assert_condition(output_capacity >= input_capacity, Error::Validation)?;
    assert_condition(output_capacity >= VOTER_DEPOSIT_SHANNONS, Error::Validation)?;

    // Final consistency checks: aggregated flag, option and epoch unchanged.
    assert_condition(after.aggregated, Error::Validation)?;
    assert_condition(after.option_index == before.option_index, Error::Validation)?;
    assert_condition(
        after.voted_at_epoch == before.voted_at_epoch,
        Error::Validation,
    )?;

    Ok(())
}

/// Look through `cell deps` for the poll type hash and ensure the poll is
/// present and still open at `epoch`.
///
/// This protects intent creation against referencing a nonexistent or closed
/// poll by enforcing the poll cell as a cell-dependency.
fn ensure_poll_dep_open(poll_type_hash: &[u8; 32], epoch: u64) -> Result<PollData, Error> {
    let mut matched_poll: Option<PollData> = None;
    let mut dep_index = 0usize;
    loop {
        match load_cell_type_hash(dep_index, Source::CellDep) {
            Ok(Some(type_hash)) => {
                if compare_arrays(&type_hash, poll_type_hash) {
                    let poll_bytes = load_cell_data(dep_index, Source::CellDep)?;
                    let poll = decode_poll(&poll_bytes)?;
                    // Poll must still be open and not past its deadline.
                    assert_condition(!poll.is_closed, Error::Validation)?;
                    assert_condition(epoch <= poll.deadline, Error::Validation)?;
                    matched_poll = Some(poll);
                    break;
                }
            }
            Ok(None) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(err) => return Err(err.into()),
        }
        dep_index += 1;
    }
    matched_poll.ok_or(Error::Validation)
}

/// Convert an intent's locked capacity into vote weight units.
///
/// If the poll is not token-weighted this always returns `1`. For token-
/// weighted polls the number of units is `capacity / VOTER_DEPOSIT_SHANNONS`
/// capped by `MAX_WEIGHT_UNITS_PER_INTENT`.
fn intent_vote_weight_units(intent_capacity: u64, token_weighted: bool) -> Result<u64, Error> {
    if !token_weighted {
        return Ok(1);
    }

    // Compute raw units and enforce a minimum/upper-bound.
    let units = intent_capacity / VOTER_DEPOSIT_SHANNONS;
    assert_condition(units > 0, Error::Validation)?;
    Ok(core::cmp::min(units, MAX_WEIGHT_UNITS_PER_INTENT))
}

/// @notice Validates CREATE_POLL output invariants.
/// @dev Enforces initial zeroed tally state, bounded metadata, and minimum capacity.
fn validate_create_poll() -> Result<(), Error> {
    let output = load_cell_data(0, Source::Output)?;
    let poll = decode_poll(&output)?;
    let capacity = load_output_capacity(0)?;
    let epoch = current_epoch()?;

    assert_condition(!poll.question.is_empty(), Error::Validation)?;
    assert_condition(poll.question.len() <= MAX_QUESTION_LEN, Error::Validation)?;
    assert_condition(poll.options.len() >= 2, Error::Validation)?;
    assert_condition(poll.options.len() <= MAX_OPTIONS, Error::Validation)?;
    assert_condition(
        poll.vote_counts.len() == poll.options.len(),
        Error::Validation,
    )?;
    assert_condition(!poll.is_closed, Error::Validation)?;
    assert_condition(poll.total_voters == 0, Error::Validation)?;
    assert_condition(poll.pending_intent_count == 0, Error::Validation)?;
    assert_condition(poll.counted_voter_lock_hashes.is_empty(), Error::Validation)?;
    assert_condition(
        poll.creator_deposit >= CREATOR_DEPOSIT_SHANNONS,
        Error::Validation,
    )?;
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

/// @notice Validates CREATE_VOTE_INTENT invariants.
/// @dev Verifies signer/delegation authority, poll liveness, and refund-lock ownership.
fn validate_create_vote_intent() -> Result<(), Error> {
    let output = load_cell_data(0, Source::Output)?;
    let intent = decode_vote_intent(&output)?;
    let witness_option = first_input_type_byte(0)?;
    let intent_capacity = load_output_capacity(0)?;
    let output_lock = load_output_script(0)?;
    let epoch = current_epoch()?;

    assert_condition(!intent.aggregated, Error::Validation)?;
    assert_condition(intent.option_index == witness_option, Error::Validation)?;
    assert_condition(intent_capacity >= VOTER_DEPOSIT_SHANNONS, Error::Validation)?;
    assert_condition(
        compare_scripts(&output_lock, &intent.refund_lock),
        Error::Validation,
    )?;

    // The referenced poll must be provided as a cell dep and still be open at
    // the tip epoch, so stale/forged poll references cannot create intents.
    let poll = ensure_poll_dep_open(&intent.poll_type_hash, epoch)?;
    if poll.token_weighted {
        let max_weighted_intent_capacity = VOTER_DEPOSIT_SHANNONS
            .checked_mul(MAX_WEIGHT_UNITS_PER_INTENT)
            .ok_or(Error::Validation)?;
        // Strict cap mode: weighted intents above the cap are rejected so
        // extra locked CKB cannot buy additional influence.
        assert_condition(
            intent_capacity <= max_weighted_intent_capacity,
            Error::Validation,
        )?;
    }

    let delegation_input = load_cell_data(1, Source::Input);
    if let Ok(data) = delegation_input {
        if let Ok(delegation) = decode_delegation(&data) {
            let signer_lock_hash = load_input_lock_hash_bytes(0)?;
            let delegation_lock_hash = load_input_lock_hash_bytes(1)?;
            let refund_lock = load_input_script(1)?;

            assert_condition(
                compare_arrays(&delegation.delegate_lock_hash, &signer_lock_hash),
                Error::Validation,
            )?;
            if delegation.expires_epoch > 0 {
                assert_condition(
                    epoch <= delegation.expires_epoch,
                    Error::Validation,
                )?;
            }
            assert_condition(
                compare_arrays(&delegation.delegator_lock_hash, &delegation_lock_hash),
                Error::Validation,
            )?;
            assert_condition(
                compare_arrays(&intent.voter_lock_hash, &delegation.delegator_lock_hash),
                Error::Validation,
            )?;
            return assert_condition(
                compare_scripts(&intent.refund_lock, &refund_lock),
                Error::Validation,
            );
        }
    }

    let voter_lock_hash = load_input_lock_hash_bytes(0)?;
    let refund_lock = load_input_script(0)?;
    assert_condition(
        compare_arrays(&intent.voter_lock_hash, &voter_lock_hash),
        Error::Validation,
    )?;
    assert_condition(
        compare_scripts(&intent.refund_lock, &refund_lock),
        Error::Validation,
    )
}

/// @notice Validates AGGREGATE_VOTES transition invariants.
/// @dev Enforces poll immutables, intent-to-poll binding, unique voter counting, and weighted deltas.
fn validate_aggregate_votes() -> Result<(), Error> {
    let input_poll = load_cell_data(0, Source::Input)?;
    let output_poll = load_cell_data(0, Source::Output)?;
    let before = decode_poll(&input_poll)?;
    let after = decode_poll(&output_poll)?;
    let epoch = current_epoch()?;
    let poll_type_hash = load_input_type_hash_bytes(0)?;

    assert_condition(!before.is_closed, Error::Validation)?;
    assert_condition(epoch <= before.deadline, Error::Validation)?;
    assert_condition(
        compare_vec_bytes(&after.question, &before.question),
        Error::Validation,
    )?;
    assert_condition(
        compare_slice_items(&after.options, &before.options),
        Error::Validation,
    )?;
    assert_condition(after.deadline == before.deadline, Error::Validation)?;
    assert_condition(
        compare_arrays(&after.creator, &before.creator),
        Error::Validation,
    )?;
    assert_condition(
        after.creator_deposit == before.creator_deposit,
        Error::Validation,
    )?;
    assert_condition(!after.is_closed, Error::Validation)?;
    assert_condition(
        after.token_weighted == before.token_weighted,
        Error::Validation,
    )?;
    assert_condition(
        compare_arrays(&after.udt_type_hash, &before.udt_type_hash),
        Error::Validation,
    )?;
    assert_condition(
        after.vote_counts.len() == before.vote_counts.len(),
        Error::Validation,
    )?;
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
        assert_condition(
            compare_arrays(
                &after_intent.voter_lock_hash,
                &before_intent.voter_lock_hash,
            ),
            Error::Validation,
        )?;
        assert_condition(
            compare_arrays(&after_intent.poll_type_hash, &before_intent.poll_type_hash),
            Error::Validation,
        )?;
        assert_condition(
            compare_arrays(&before_intent.poll_type_hash, &poll_type_hash),
            Error::Validation,
        )?;
        assert_condition(
            after_intent.option_index == before_intent.option_index,
            Error::Validation,
        )?;
        assert_condition(
            after_intent.voted_at_epoch == before_intent.voted_at_epoch,
            Error::Validation,
        )?;
        assert_condition(
            compare_scripts(&after_intent.refund_lock, &before_intent.refund_lock),
            Error::Validation,
        )?;
        assert_condition(output_capacity >= input_capacity, Error::Validation)?;
        assert_condition(
            (before_intent.option_index as usize) < before.options.len(),
            Error::Validation,
        )?;
        assert_condition(
            !seen_voters
                .iter()
                .any(|existing| existing == &before_intent.voter_lock_hash),
            Error::Validation,
        )?;

        let weight = intent_vote_weight_units(input_capacity, before.token_weighted)?;
        deltas[before_intent.option_index as usize] = deltas[before_intent.option_index as usize]
            .checked_add(weight)
            .ok_or(Error::Validation)?;
        seen_voters.push(before_intent.voter_lock_hash);
        batch_voters.push(before_intent.voter_lock_hash);
        intent_count += 1;
    }

    assert_condition(intent_count > 0, Error::Validation)?;
    assert_condition(
        after.counted_voter_lock_hashes.len()
            == before.counted_voter_lock_hashes.len() + batch_voters.len(),
        Error::Validation,
    )?;

    for (index, voter) in before.counted_voter_lock_hashes.iter().enumerate() {
        assert_condition(
            compare_arrays(&after.counted_voter_lock_hashes[index], voter),
            Error::Validation,
        )?;
    }
    for (offset, voter) in batch_voters.iter().enumerate() {
        let next_index = before.counted_voter_lock_hashes.len() + offset;
        assert_condition(
            compare_arrays(&after.counted_voter_lock_hashes[next_index], voter),
            Error::Validation,
        )?;
    }
    for (index, previous_count) in before.vote_counts.iter().enumerate() {
        let expected = previous_count
            .checked_add(deltas[index])
            .ok_or(Error::Validation)?;
        assert_condition(after.vote_counts[index] == expected, Error::Validation)?;
    }

    let expected_total = before
        .total_voters
        .checked_add(u64::try_from(intent_count).map_err(|_| Error::Validation)?)
        .ok_or(Error::Validation)?;
    assert_condition(after.total_voters == expected_total, Error::Validation)?;
    assert_condition(
        after.total_voters == after.counted_voter_lock_hashes.len() as u64,
        Error::Validation,
    )?;
    assert_condition(
        after.pending_intent_count <= before.pending_intent_count,
        Error::Validation,
    )
}

/// @notice Validates CLOSE_POLL and force-close recovery transition invariants.
/// @dev Creator can close after deadline; anyone can recover-close after grace by refunding pending intents.
fn validate_close_poll() -> Result<(), Error> {
    let input_poll = load_cell_data(0, Source::Input)?;
    let output_poll = load_cell_data(0, Source::Output)?;
    let before = decode_poll(&input_poll)?;
    let after = decode_poll(&output_poll)?;
    let epoch = current_epoch()?;
    let poll_type_hash = load_input_type_hash_bytes(0)?;
    let creator_return_lock_hash = load_output_lock_hash_bytes(1)?;
    let creator_return_capacity = load_output_capacity(1)?;

    // Polls can only be closed after they have actually ended.
    assert_condition(epoch > before.deadline, Error::Validation)?;

    assert_condition(!before.is_closed, Error::Validation)?;
    assert_condition(after.is_closed, Error::Validation)?;
    assert_condition(
        compare_vec_bytes(&after.question, &before.question),
        Error::Validation,
    )?;
    assert_condition(
        compare_slice_items(&after.options, &before.options),
        Error::Validation,
    )?;
    assert_condition(
        compare_slice_items(
            &after.counted_voter_lock_hashes,
            &before.counted_voter_lock_hashes,
        ),
        Error::Validation,
    )?;
    assert_condition(after.deadline == before.deadline, Error::Validation)?;
    assert_condition(
        compare_arrays(&after.creator, &before.creator),
        Error::Validation,
    )?;
    assert_condition(after.total_voters == before.total_voters, Error::Validation)?;
    assert_condition(
        after.creator_deposit == before.creator_deposit,
        Error::Validation,
    )?;
    assert_condition(after.pending_intent_count == 0, Error::Validation)?;
    assert_condition(
        after.token_weighted == before.token_weighted,
        Error::Validation,
    )?;
    assert_condition(
        compare_arrays(&after.udt_type_hash, &before.udt_type_hash),
        Error::Validation,
    )?;
    assert_condition(after.vote_counts == before.vote_counts, Error::Validation)?;
    assert_condition(
        compare_arrays(&creator_return_lock_hash, &before.creator),
        Error::Validation,
    )?;
    assert_condition(
        creator_return_capacity >= before.creator_deposit,
        Error::Validation,
    )?;

    // Mode selection:
    // 1) creator close: input[1] lock hash matches poll.creator
    // 2) permissionless recovery: allowed only after deadline + grace period
    let creator_authorized = match load_input_lock_hash_bytes(1) {
        Ok(lock_hash) => compare_arrays(&lock_hash, &before.creator),
        Err(Error::IndexOutOfBound) => false,
        Err(err) => return Err(err),
    };
    if !creator_authorized {
        let allow_epoch = before
            .deadline
            .checked_add(FORCE_CLOSE_GRACE_EPOCHS)
            .ok_or(Error::Validation)?;
        assert_condition(epoch > allow_epoch, Error::Validation)?;
    }

    let mut output_index = 2usize;
    let mut input_index = if creator_authorized { 2usize } else { 1usize };
    let mut refunded_pending_intents = 0u64;
    loop {
        let input = match load_cell_data(input_index, Source::Input) {
            Ok(data) => data,
            Err(SysError::IndexOutOfBound) => break,
            Err(err) => return Err(err.into()),
        };

        if let Ok(intent) = decode_vote_intent(&input) {
            assert_condition(
                compare_arrays(&intent.poll_type_hash, &poll_type_hash),
                Error::Validation,
            )?;
            let return_lock = load_output_script(output_index)?;
            let return_capacity = load_output_capacity(output_index)?;
            assert_condition(
                compare_scripts(&return_lock, &intent.refund_lock),
                Error::Validation,
            )?;
            assert_condition(return_capacity >= VOTER_DEPOSIT_SHANNONS, Error::Validation)?;
            if !intent.aggregated {
                refunded_pending_intents = refunded_pending_intents
                    .checked_add(1)
                    .ok_or(Error::Validation)?;
            }
            output_index += 1;
        }

        input_index += 1;
    }

    // Strict recovery invariant: every pending intent tracked on the poll must
    // be consumed and refunded during close. Treat poll.pending_intent_count as
    // a lower-bound until exact accounting is promoted to a hard invariant.
    assert_condition(
        refunded_pending_intents >= before.pending_intent_count,
        Error::Validation,
    )?;

    Ok(())
}

/// @notice Validates DELEGATE creation invariants.
/// @dev Delegator must authorize the cell and keep minimum delegation capacity.
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
        !compare_arrays(
            &delegation.delegator_lock_hash,
            &delegation.delegate_lock_hash,
        ),
        Error::Validation,
    )?;
    if delegation.expires_epoch > 0 {
        assert_condition(
            delegation.expires_epoch > current_epoch()?,
            Error::Validation,
        )?;
    }
    assert_condition(
        output_capacity >= DELEGATION_MIN_SHANNONS,
        Error::Validation,
    )
}

/// @notice Validates REVOKE_DELEGATION consumption invariants.
/// @dev Revocation keeps lock ownership and preserves minimum reclaimable capacity.
fn validate_revoke_delegation() -> Result<(), Error> {
    let input = load_cell_data(0, Source::Input)?;
    let _delegation = decode_delegation(&input)?;
    let input_lock = load_input_script(0)?;
    let output_lock = load_output_script(0)?;
    let output_capacity = load_output_capacity(0)?;
    let input_capacity = load_input_capacity(0)?;

    assert_condition(
        compare_scripts(&input_lock, &output_lock),
        Error::Validation,
    )?;
    assert_condition(
        output_capacity >= DELEGATION_MIN_SHANNONS,
        Error::Validation,
    )?;
    assert_condition(output_capacity >= input_capacity, Error::Validation)
}
