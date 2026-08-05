//! Governance contract entry — validates and routes protocol operations.
//!
//! This file contains the top-level dispatch and the main validation
//! routines used by each on-chain operation. Comments are written to be
//! human-friendly and explain the purpose of checks and transitions.

use alloc::vec::Vec;

use ckb_std::{
    ckb_constants::Source,
    error::SysError,
    high_level::{load_cell_capacity, load_cell_data, load_cell_type_hash, load_witness_args},
    type_id::check_type_id,
};
use sparse_merkle_tree::{SMTBuilder, H256};

use crate::{
    codec::{
        decode_delegation, decode_poll, decode_tally_aggregation_proof, decode_tally_merge_result,
        decode_tally_shard, decode_vote_intent, EncodedScript, PollData, TallyMergeResultData,
        TallyShardData,
    },
    constants::*,
    error::Error,
    helpers::{
        assert_condition, compare_arrays, compare_scripts, compare_slice_items, compare_vec_bytes,
        count_unique_counted_voters, derive_tally_shard_id, first_input_type_byte,
        load_cell_dep_lock_hash_bytes, load_cell_dep_script, load_cell_dep_type_script,
        load_current_script, load_group_input_script, load_group_output_script,
        load_input_capacity, load_input_creation_epoch, load_input_lock_hash_bytes,
        load_input_script, load_input_type_hash_bytes, load_input_type_script,
        load_output_capacity, load_output_lock_hash_bytes, load_output_script,
        load_output_type_hash_bytes, load_output_type_script, min_poll_capacity,
        require_input_since_strictly_after, validate_deadline_epoch,
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
        OP_RETIRED_AGGREGATE_VOTES => Err(Error::UnknownOp),
        OP_CLOSE_POLL => {
            if current_lock_can_defer_to_same_index_protocol_type_update()? {
                Ok(())
            } else {
                validate_close_poll()
            }
        }
        OP_DELEGATE => validate_delegation_lifecycle(),
        OP_RETIRED_REVOKE_DELEGATION => Err(Error::UnknownOp),
        OP_CREATE_TALLY_SHARD => validate_tally_shard_lifecycle(),
        OP_MERGE_TALLY_SHARDS => validate_tally_merge_lifecycle(),
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

fn assert_single_group_cell(source: Source) -> Result<(), Error> {
    match load_cell_data(1, source) {
        Err(SysError::IndexOutOfBound) => Ok(()),
        Ok(_) => Err(Error::Validation),
        Err(err) => Err(err.into()),
    }
}

fn group_cell_count(source: Source) -> Result<usize, Error> {
    let mut count = 0usize;
    loop {
        match load_cell_data(count, source) {
            Ok(_) => count = count.checked_add(1).ok_or(Error::Validation)?,
            Err(SysError::IndexOutOfBound) => return Ok(count),
            Err(err) => return Err(err.into()),
        }
    }
}

fn assert_equal_group_input_output_counts() -> Result<(), Error> {
    assert_condition(
        group_cell_count(Source::GroupInput)? == group_cell_count(Source::GroupOutput)?,
        Error::Validation,
    )
}

fn same_index_type_scripts(index: usize) -> Result<Option<(EncodedScript, EncodedScript)>, Error> {
    match (
        load_input_type_script(index),
        load_output_type_script(index),
    ) {
        (Ok(input_type), Ok(output_type)) => Ok(Some((input_type, output_type))),
        (Err(Error::Validation), _) | (_, Err(Error::Validation)) => Ok(None),
        (Err(Error::IndexOutOfBound), _) | (_, Err(Error::IndexOutOfBound)) => Ok(None),
        (Err(err), _) | (_, Err(err)) => Err(err),
    }
}

fn same_index_protocol_type_update_matches_current_lock(
    index: usize,
    current_script: &EncodedScript,
) -> Result<bool, Error> {
    let (input_type, output_type) = match same_index_type_scripts(index)? {
        Some(scripts) => scripts,
        None => return Ok(false),
    };
    if !compare_scripts(&input_type, &output_type) {
        return Ok(false);
    }
    if input_type.code_hash != current_script.code_hash
        || input_type.hash_type != current_script.hash_type
    {
        return Ok(false);
    }

    let current_op = match current_script.args.first().copied() {
        Some(op) => op,
        None => return Ok(false),
    };
    let type_op = match input_type.args.first().copied() {
        Some(op) => op,
        None => return Ok(false),
    };

    match current_op {
        // Poll cells use OP_CLOSE_POLL as the protocol lock and OP_CREATE_POLL
        // as the Type ID-backed type. The lock scope must match the actual
        // input type hash instead of merely seeing any governance poll type.
        OP_CLOSE_POLL => {
            if type_op != OP_CREATE_POLL
                || current_script.args.len() != 33
                || input_type.args.len() != 33
            {
                return Ok(false);
            }
            let lock_poll_type_hash: [u8; 32] = current_script.args[1..33]
                .try_into()
                .map_err(|_| Error::Encoding)?;
            let input_type_hash = load_input_type_hash_bytes(index)?;
            Ok(compare_arrays(&lock_poll_type_hash, &input_type_hash))
        }
        // Intent, tally shard, and merge-result cells use the same governance
        // script as both lock and type, so deferral is valid only for the exact
        // same script/op/scope relationship.
        OP_CREATE_VOTE_INTENT => Ok(type_op == current_op
            && current_script.args.len() == 33
            && compare_scripts(&input_type, current_script)),
        OP_CREATE_TALLY_SHARD => Ok(type_op == current_op
            && current_script.args.len() == 37
            && compare_scripts(&input_type, current_script)),
        OP_MERGE_TALLY_SHARDS => Ok(type_op == current_op
            && current_script.args.len() == 33
            && compare_scripts(&input_type, current_script)),
        _ => Ok(false),
    }
}

fn current_lock_can_defer_to_same_index_protocol_type_update() -> Result<bool, Error> {
    let current_script = load_current_script()?;
    let mut saw_current_lock = false;
    let mut index = 0usize;
    loop {
        match load_cell_data(index, Source::Input) {
            Ok(_) => {
                let input_lock = load_input_script(index)?;
                if compare_scripts(&current_script, &input_lock) {
                    saw_current_lock = true;
                    if !same_index_protocol_type_update_matches_current_lock(
                        index,
                        &current_script,
                    )? {
                        return Ok(false);
                    }
                }
                index += 1;
            }
            Err(SysError::IndexOutOfBound) => return Ok(saw_current_lock),
            Err(err) => return Err(err.into()),
        }
    }
}

/// Phase B intent cells use the governance script itself as the lock path.
///
/// The lock mirrors the governance code hash/hash type and binds args to the
/// `CREATE_VOTE_INTENT` op plus the poll type hash scope.
fn expected_intent_lock_script(
    poll_type_hash: &[u8; 32],
) -> Result<crate::codec::EncodedScript, Error> {
    let current_script = load_current_script()?;
    let mut args = Vec::with_capacity(33);
    args.push(OP_CREATE_VOTE_INTENT);
    args.extend_from_slice(poll_type_hash);
    Ok(crate::codec::EncodedScript {
        code_hash: current_script.code_hash,
        hash_type: current_script.hash_type,
        args,
    })
}

/// Validate that an intent output uses the governance-controlled Phase B lock.
fn assert_intent_lock_matches_policy(
    lock: &crate::codec::EncodedScript,
    poll_type_hash: &[u8; 32],
) -> Result<(), Error> {
    let expected_lock = expected_intent_lock_script(poll_type_hash)?;
    assert_condition(compare_scripts(lock, &expected_lock), Error::Validation)
}

/// Shard cells are also governed by this script so future third-party
/// aggregators can spend them through protocol validation, not private locks.
fn expected_tally_shard_script(
    poll_type_hash: &[u8; 32],
    shard_id: u32,
) -> Result<EncodedScript, Error> {
    let current_script = load_current_script()?;
    let mut args = Vec::with_capacity(37);
    args.push(OP_CREATE_TALLY_SHARD);
    args.extend_from_slice(poll_type_hash);
    args.extend_from_slice(&shard_id.to_le_bytes());
    Ok(EncodedScript {
        code_hash: current_script.code_hash,
        hash_type: current_script.hash_type,
        args,
    })
}

fn assert_tally_shard_script_policy(
    lock: &EncodedScript,
    type_script: &EncodedScript,
    poll_type_hash: &[u8; 32],
    shard_id: u32,
) -> Result<(), Error> {
    let expected = expected_tally_shard_script(poll_type_hash, shard_id)?;
    assert_condition(compare_scripts(lock, &expected), Error::Validation)?;
    assert_condition(compare_scripts(type_script, &expected), Error::Validation)
}

fn parse_tally_shard_scope(script: &EncodedScript) -> Result<([u8; 32], u32), Error> {
    assert_condition(script.args.len() == 37, Error::Validation)?;
    assert_condition(
        script.args.first().copied() == Some(OP_CREATE_TALLY_SHARD),
        Error::Validation,
    )?;
    let poll_type_hash: [u8; 32] = script.args[1..33].try_into().map_err(|_| Error::Encoding)?;
    let shard_id = u32::from_le_bytes(
        script.args[33..37]
            .try_into()
            .map_err(|_| Error::Encoding)?,
    );
    Ok((poll_type_hash, shard_id))
}

fn expected_tally_merge_script(poll_type_hash: &[u8; 32]) -> Result<EncodedScript, Error> {
    let current_script = load_current_script()?;
    let mut args = Vec::with_capacity(33);
    args.push(OP_MERGE_TALLY_SHARDS);
    args.extend_from_slice(poll_type_hash);
    Ok(EncodedScript {
        code_hash: current_script.code_hash,
        hash_type: current_script.hash_type,
        args,
    })
}

fn parse_tally_merge_scope(script: &EncodedScript) -> Result<[u8; 32], Error> {
    assert_condition(script.args.len() == 33, Error::Validation)?;
    assert_condition(
        script.args.first().copied() == Some(OP_MERGE_TALLY_SHARDS),
        Error::Validation,
    )?;
    script.args[1..33].try_into().map_err(|_| Error::Encoding)
}

fn assert_tally_merge_script_policy(
    lock: &EncodedScript,
    type_script: &EncodedScript,
    poll_type_hash: &[u8; 32],
) -> Result<(), Error> {
    let expected = expected_tally_merge_script(poll_type_hash)?;
    assert_condition(compare_scripts(lock, &expected), Error::Validation)?;
    assert_condition(compare_scripts(type_script, &expected), Error::Validation)
}

fn expected_governance_script(op: u8, scope: &[u8]) -> Result<EncodedScript, Error> {
    let current_script = load_current_script()?;
    let mut args = Vec::with_capacity(1 + scope.len());
    args.push(op);
    args.extend_from_slice(scope);
    Ok(EncodedScript {
        code_hash: current_script.code_hash,
        hash_type: current_script.hash_type,
        args,
    })
}

fn assert_protocol_poll_lock(lock: &EncodedScript, poll_type_hash: &[u8; 32]) -> Result<(), Error> {
    let expected = expected_governance_script(OP_CLOSE_POLL, poll_type_hash)?;
    assert_condition(compare_scripts(lock, &expected), Error::Validation)
}

fn script_is_governance_op(script: &EncodedScript, op: u8) -> Result<bool, Error> {
    let current_script = load_current_script()?;
    Ok(script.code_hash == current_script.code_hash
        && script.hash_type == current_script.hash_type
        && script.args.first().copied() == Some(op))
}

fn script_scope_matches(script: &EncodedScript, scope: &[u8]) -> bool {
    script.args.len() == 1 + scope.len() && script.args[1..] == scope[..]
}

fn input_is_current_poll_intent(index: usize, poll_type_hash: &[u8; 32]) -> Result<bool, Error> {
    let input_type = match load_input_type_script(index) {
        Ok(script) => script,
        Err(Error::Validation) => return Ok(false),
        Err(err) => return Err(err),
    };
    let current_script = load_current_script()?;

    if input_type.code_hash != current_script.code_hash
        || input_type.hash_type != current_script.hash_type
        || input_type.args.first().copied() != Some(OP_CREATE_VOTE_INTENT)
    {
        return Ok(false);
    }

    assert_condition(input_type.args.len() == 33, Error::Validation)?;
    let intent_poll_type_hash: [u8; 32] = input_type.args[1..33]
        .try_into()
        .map_err(|_| Error::Encoding)?;
    assert_condition(
        compare_arrays(&intent_poll_type_hash, poll_type_hash),
        Error::Validation,
    )?;
    Ok(true)
}

fn assert_intent_transition_has_matching_shard(
    intent: &crate::codec::VoteIntentData,
) -> Result<(), Error> {
    let input_shard = decode_tally_shard(&load_cell_data(0, Source::Input)?)?;
    let output_shard = decode_tally_shard(&load_cell_data(0, Source::Output)?)?;
    let current_script = load_current_script()?;
    let input_shard_type = load_input_type_script(0)?;
    let output_shard_type = load_output_type_script(0)?;

    let (script_poll_type_hash, script_shard_id) = parse_tally_shard_scope(&input_shard_type)?;
    assert_condition(
        input_shard_type.code_hash == current_script.code_hash,
        Error::Validation,
    )?;
    assert_condition(
        input_shard_type.hash_type == current_script.hash_type,
        Error::Validation,
    )?;
    assert_condition(
        compare_scripts(&input_shard_type, &output_shard_type),
        Error::Validation,
    )?;
    assert_condition(
        compare_arrays(&script_poll_type_hash, &intent.poll_type_hash),
        Error::Validation,
    )?;
    assert_condition(script_shard_id == input_shard.shard_id, Error::Validation)?;
    assert_condition(
        compare_arrays(&input_shard.poll_type_hash, &intent.poll_type_hash),
        Error::Validation,
    )?;
    assert_condition(
        compare_arrays(&output_shard.poll_type_hash, &intent.poll_type_hash),
        Error::Validation,
    )?;
    assert_condition(
        output_shard.shard_id == input_shard.shard_id,
        Error::Validation,
    )?;
    assert_condition(
        output_shard.shard_count == input_shard.shard_count,
        Error::Validation,
    )?;

    let derived_shard_id = derive_tally_shard_id(
        &intent.poll_type_hash,
        &intent.voter_lock_hash,
        input_shard.shard_count,
    )?;
    assert_condition(derived_shard_id == input_shard.shard_id, Error::Validation)
}

fn assert_intent_transition_has_aggregation_anchor(
    intent: &crate::codec::VoteIntentData,
) -> Result<(), Error> {
    let anchor_type = load_input_type_script(0)?;
    let current_script = load_current_script()?;
    assert_condition(
        anchor_type.code_hash == current_script.code_hash,
        Error::Validation,
    )?;
    assert_condition(
        anchor_type.hash_type == current_script.hash_type,
        Error::Validation,
    )?;
    match anchor_type.args.first().copied() {
        Some(OP_CREATE_TALLY_SHARD) => assert_intent_transition_has_matching_shard(intent),
        _ => Err(Error::Validation),
    }
}

fn poll_close_has_creator_authorization(poll: &PollData) -> Result<bool, Error> {
    match load_input_lock_hash_bytes(1) {
        Ok(lock_hash) => Ok(compare_arrays(&lock_hash, &poll.creator)),
        Err(Error::IndexOutOfBound) => Ok(false),
        Err(err) => Err(err),
    }
}

fn require_poll_close_since(poll: &PollData, creator_authorized: bool) -> Result<(), Error> {
    let threshold = if creator_authorized {
        poll.deadline
    } else {
        poll.deadline
            .checked_add(FORCE_CLOSE_GRACE_EPOCHS)
            .ok_or(Error::Validation)?
    };
    require_input_since_strictly_after(0, threshold)
}

/// Intent cells may only disappear without a corresponding output during a
/// validated poll close, a post-close refund, or an immediate late refund.
///
/// This prevents a future permissionless lock from turning `input present /
/// output absent` into a free-spend path outside the refund-enforced close flow.
fn validate_intent_consumption_without_output(input: &[u8]) -> Result<(), Error> {
    let intent = decode_vote_intent(input)?;

    if let Ok(input_poll) = load_cell_data(0, Source::Input) {
        if let Ok(before_poll) = decode_poll(&input_poll) {
            let output_poll = load_cell_data(0, Source::Output)?;
            let after_poll = decode_poll(&output_poll)?;
            let poll_type_hash = load_input_type_hash_bytes(0)?;
            let output_poll_type_hash = load_output_type_hash_bytes(0)?;

            assert_condition(
                compare_arrays(&intent.poll_type_hash, &poll_type_hash),
                Error::Validation,
            )?;
            assert_condition(
                compare_arrays(&output_poll_type_hash, &poll_type_hash),
                Error::Validation,
            )?;
            assert_condition(!before_poll.is_closed, Error::Validation)?;
            assert_condition(after_poll.is_closed, Error::Validation)?;
            let creator_authorized = poll_close_has_creator_authorization(&before_poll)?;
            require_poll_close_since(&before_poll, creator_authorized)?;

            return Ok(());
        }
    }

    let poll = match ensure_poll_dep_closed(&intent.poll_type_hash) {
        Ok(poll) => poll,
        Err(Error::Validation) => ensure_poll_dep_unclosed(&intent.poll_type_hash)?,
        Err(err) => return Err(err),
    };

    if !poll.is_closed {
        // Immediate late-refund transactions pin the intent as global input 0.
        // Source::Input then authenticates its creation block; HeaderDep(0)
        // cannot be substituted to make a late intent look timely.
        // Aggregated markers may themselves be created after the deadline even
        // when their underlying intent was timely, so they remain locked until
        // poll close and must never enter this pending-intent refund branch.
        assert_condition(!intent.aggregated, Error::Validation)?;
        let global_input = load_cell_data(0, Source::Input)?;
        assert_condition(compare_vec_bytes(&global_input, input), Error::Validation)?;
        let current_script = load_current_script()?;
        let input_type = load_input_type_script(0)?;
        assert_condition(
            compare_scripts(&current_script, &input_type),
            Error::Validation,
        )?;
        let creation_epoch = load_input_creation_epoch(0)?;
        assert_condition(creation_epoch > poll.deadline, Error::Validation)?;
    }

    let output_lock = load_output_script(0)?;
    let output_capacity = load_output_capacity(0)?;
    let input_capacity = load_cell_capacity(0, Source::GroupInput)?;
    assert_no_additional_intent_inputs(1)?;
    assert_no_output_type(0)?;
    assert_condition(
        compare_scripts(&output_lock, &intent.refund_lock),
        Error::Validation,
    )?;
    assert_condition(output_capacity >= VOTER_DEPOSIT_SHANNONS, Error::Validation)?;
    assert_condition(output_capacity == input_capacity, Error::Validation)
}

fn assert_no_additional_intent_inputs(start_index: usize) -> Result<(), Error> {
    match load_cell_data(start_index, Source::GroupInput) {
        Ok(_) => Err(Error::Validation),
        Err(SysError::IndexOutOfBound) => Ok(()),
        Err(err) => Err(err.into()),
    }
}

fn ensure_poll_dep_closed(poll_type_hash: &[u8; 32]) -> Result<PollData, Error> {
    let mut dep_index = 0usize;
    loop {
        match load_cell_type_hash(dep_index, Source::CellDep) {
            Ok(Some(type_hash)) => {
                if compare_arrays(&type_hash, poll_type_hash) {
                    let poll_bytes = load_cell_data(dep_index, Source::CellDep)?;
                    let poll = decode_poll(&poll_bytes)?;
                    assert_condition(poll.is_closed, Error::Validation)?;
                    return Ok(poll);
                }
            }
            Ok(None) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(err) => return Err(err.into()),
        }
        dep_index += 1;
    }
    Err(Error::Validation)
}

fn delegation_scope_matches(
    delegation: &crate::codec::DelegationData,
    poll_type_hash: &[u8; 32],
) -> bool {
    let zero_hash = [0u8; 32];
    compare_arrays(&delegation.poll_type_hash, &zero_hash)
        || compare_arrays(&delegation.poll_type_hash, poll_type_hash)
}

fn ensure_delegation_dep_live(
    delegator_lock_hash: &[u8; 32],
    delegate_lock_hash: &[u8; 32],
    poll_type_hash: &[u8; 32],
) -> Result<EncodedScript, Error> {
    let mut dep_index = 0usize;
    loop {
        match load_cell_type_hash(dep_index, Source::CellDep) {
            Ok(Some(_)) => {
                let data = load_cell_data(dep_index, Source::CellDep)?;
                if let Ok(delegation) = decode_delegation(&data) {
                    let type_script = load_cell_dep_type_script(dep_index)?;
                    if compare_arrays(&delegation.delegator_lock_hash, delegator_lock_hash)
                        && compare_arrays(&delegation.delegate_lock_hash, delegate_lock_hash)
                        && compare_arrays(
                            &load_cell_dep_lock_hash_bytes(dep_index)?,
                            &delegation.delegator_lock_hash,
                        )
                        && delegation_scope_matches(&delegation, poll_type_hash)
                        && delegation.expires_epoch == 0
                        && script_is_governance_op(&type_script, OP_DELEGATE)?
                        && script_scope_matches(&type_script, &delegation.poll_type_hash)
                    {
                        return load_cell_dep_script(dep_index);
                    }
                }
            }
            Ok(None) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(err) => return Err(err.into()),
        }
        dep_index += 1;
    }
    Err(Error::Validation)
}

/// Decide whether the poll group operation is a creation or close.
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
        // New deployments only permit the poll's open -> closed transition.
        (Some(input), Some(output)) => {
            check_type_id(1)?;
            let current_script = load_current_script()?;
            assert_condition(
                compare_scripts(&load_input_type_script(0)?, &current_script),
                Error::Validation,
            )?;
            assert_condition(
                compare_scripts(&load_output_type_script(0)?, &current_script),
                Error::Validation,
            )?;
            let before = decode_poll(&input)?;
            let after = decode_poll(&output)?;

            if !before.is_closed && after.is_closed {
                validate_close_poll()
            } else {
                Err(Error::Validation)
            }
        }
        // Any other pattern is invalid for poll transitions.
        _ => Err(Error::Validation),
    }
}

/// Determine how intent (vote intent) group changed and validate the
/// corresponding operation: creation, aggregation marker update, or consumption.
fn validate_intent_lifecycle() -> Result<(), Error> {
    let group_input = maybe_group_cell_data(Source::GroupInput)?;
    let group_output = maybe_group_cell_data(Source::GroupOutput)?;

    match (group_input, group_output) {
        // New intent created (no input, output present)
        (None, Some(output)) => {
            assert_single_group_cell(Source::GroupOutput)?;
            decode_vote_intent(&output)?;
            validate_create_vote_intent()
        }
        // Intent marked aggregated: both input+output present.
        (Some(input), Some(output)) => {
            assert_equal_group_input_output_counts()?;
            validate_intent_aggregation_transition(&input, &output)
        }
        // Intent consumed without output (simple consumption)
        (Some(input), None) => {
            if current_lock_can_defer_to_same_index_protocol_type_update()? {
                return Ok(());
            }
            validate_intent_consumption_without_output(&input)
        }
        _ => Err(Error::Validation),
    }
}

/// Validate delegation creation or revocation under the OP_DELEGATE type
/// family. Creation = no input, output present. Revoke = input consumed.
fn validate_delegation_lifecycle() -> Result<(), Error> {
    let group_input = maybe_group_cell_data(Source::GroupInput)?;
    let group_output = maybe_group_cell_data(Source::GroupOutput)?;

    match (group_input, group_output) {
        (None, Some(output)) => {
            assert_single_group_cell(Source::GroupOutput)?;
            decode_delegation(&output)?;
            validate_delegate()
        }
        (Some(input), None) => {
            assert_single_group_cell(Source::GroupInput)?;
            decode_delegation(&input)?;
            validate_delegation_revocation()
        }
        _ => Err(Error::Validation),
    }
}

/// Validate tally shard creation, aggregation, or finalization by inspecting
/// group input/output shape.
fn validate_tally_shard_lifecycle() -> Result<(), Error> {
    let group_input = maybe_group_cell_data(Source::GroupInput)?;
    let group_output = maybe_group_cell_data(Source::GroupOutput)?;

    match (group_input, group_output) {
        (None, Some(output)) => {
            decode_tally_shard(&output)?;
            validate_create_tally_shard()
        }
        (Some(input), Some(output)) => {
            let before = decode_tally_shard(&input)?;
            let after = decode_tally_shard(&output)?;
            if !before.finalized && after.finalized {
                validate_finalize_tally_shard(&before, &after)
            } else {
                validate_aggregate_tally_shard(&input, &output)
            }
        }
        (Some(input), None) => {
            if current_lock_can_defer_to_same_index_protocol_type_update()? {
                return Ok(());
            }
            let shard = decode_tally_shard(&input)?;
            let output_type = load_output_type_script(0)?;
            match output_type.args.first().copied() {
                Some(OP_CREATE_POLL) => validate_consume_finalized_tally_shard_on_close(&shard),
                Some(OP_MERGE_TALLY_SHARDS) => {
                    validate_consume_finalized_tally_shard_on_merge(&shard)
                }
                _ => Err(Error::Validation),
            }
        }
        _ => Err(Error::Validation),
    }
}

fn validate_tally_merge_lifecycle() -> Result<(), Error> {
    let group_input = maybe_group_cell_data(Source::GroupInput)?;
    let group_output = maybe_group_cell_data(Source::GroupOutput)?;

    match (group_input, group_output) {
        (None, Some(output)) | (Some(_), Some(output)) => {
            decode_tally_merge_result(&output)?;
            validate_merge_tally_shards(&output)
        }
        (Some(input), None) => {
            if current_lock_can_defer_to_same_index_protocol_type_update()? {
                return Ok(());
            }
            let result = decode_tally_merge_result(&input)?;
            validate_consume_final_merge_result_on_close(&result)
        }
        _ => Err(Error::Validation),
    }
}

/// Validate a single intent aggregation-marker transition (input -> output).
///
/// Typical aggregation updates a pending intent into an aggregated marker
/// while preserving the intent's binding to the voter, poll, refund-lock
/// and chosen option. We check capacity, ownership and identity invariants.
fn validate_intent_aggregation_transition(input: &[u8], output: &[u8]) -> Result<(), Error> {
    let before = decode_vote_intent(input)?;
    let after = decode_vote_intent(output)?;
    // group deposit checks
    let input_capacity = load_cell_capacity(0, Source::GroupInput)?;
    let output_capacity = load_cell_capacity(0, Source::GroupOutput)?;
    // Use group-output index for intent transitions; global output index 0 is
    // often the poll cell during aggregate flows.
    let output_lock = load_group_output_script(0)?;

    // Basic invariants: before must be pending, after must be marked aggregated.
    assert_condition(!before.aggregated, Error::Validation)?;
    assert_intent_transition_has_aggregation_anchor(&before)?;

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
    assert_intent_lock_matches_policy(&output_lock, &before.poll_type_hash)?;

    // Capacity checks: outputs must preserve at least the voter deposit.
    assert_condition(output_capacity == input_capacity, Error::Validation)?;
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
fn ensure_poll_dep_open(poll_type_hash: &[u8; 32]) -> Result<PollData, Error> {
    let mut matched_poll: Option<PollData> = None;
    let mut dep_index = 0usize;
    loop {
        match load_cell_type_hash(dep_index, Source::CellDep) {
            Ok(Some(type_hash)) => {
                if compare_arrays(&type_hash, poll_type_hash) {
                    let poll_bytes = load_cell_data(dep_index, Source::CellDep)?;
                    let poll = decode_poll(&poll_bytes)?;
                    // Intent creation can authenticate poll lifecycle state,
                    // but not the output cell's eventual inclusion epoch.
                    assert_condition(!poll.is_closed, Error::Validation)?;
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

fn ensure_poll_dep_unclosed(poll_type_hash: &[u8; 32]) -> Result<PollData, Error> {
    let mut matched_poll: Option<PollData> = None;
    let mut dep_index = 0usize;
    loop {
        match load_cell_type_hash(dep_index, Source::CellDep) {
            Ok(Some(type_hash)) => {
                if compare_arrays(&type_hash, poll_type_hash) {
                    let poll_bytes = load_cell_data(dep_index, Source::CellDep)?;
                    let poll = decode_poll(&poll_bytes)?;
                    assert_condition(!poll.is_closed, Error::Validation)?;
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

fn ensure_created_output_poll_open(poll_type_hash: &[u8; 32]) -> Result<PollData, Error> {
    let output_poll_type_script = load_output_type_script(0)?;
    let current_script = load_current_script()?;
    assert_condition(
        output_poll_type_script.code_hash == current_script.code_hash,
        Error::Validation,
    )?;
    assert_condition(
        output_poll_type_script.hash_type == current_script.hash_type,
        Error::Validation,
    )?;
    assert_condition(
        output_poll_type_script.args.first().copied() == Some(OP_CREATE_POLL),
        Error::Validation,
    )?;

    let output_poll_type_hash = load_output_type_hash_bytes(0)?;
    assert_condition(
        compare_arrays(&output_poll_type_hash, poll_type_hash),
        Error::Validation,
    )?;
    let poll_bytes = load_cell_data(0, Source::Output)?;
    let poll = decode_poll(&poll_bytes)?;
    assert_condition(!poll.is_closed, Error::Validation)?;
    Ok(poll)
}

fn assert_no_matching_poll_input(poll_type_hash: &[u8; 32]) -> Result<(), Error> {
    let mut index = 0usize;
    loop {
        match load_cell_type_hash(index, Source::Input) {
            Ok(Some(type_hash)) => {
                assert_condition(
                    !compare_arrays(&type_hash, poll_type_hash),
                    Error::Validation,
                )?;
            }
            Ok(None) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(err) => return Err(err.into()),
        }
        index += 1;
    }
    Ok(())
}

fn assert_initial_tally_shard_data(
    shard: &TallyShardData,
    poll: &PollData,
    poll_type_hash: &[u8; 32],
    expected_shard_id: u32,
) -> Result<(), Error> {
    assert_condition(
        compare_arrays(&shard.poll_type_hash, poll_type_hash),
        Error::Validation,
    )?;
    assert_condition(shard.shard_count == poll.shard_count, Error::Validation)?;
    assert_condition(shard.shard_id == expected_shard_id, Error::Validation)?;
    assert_condition(!shard.finalized, Error::Validation)?;
    assert_condition(shard.total_voters == 0, Error::Validation)?;
    assert_condition(shard.counted_voter_root == [0u8; 32], Error::Validation)?;
    assert_condition(
        shard.vote_counts.len() == poll.options.len(),
        Error::Validation,
    )?;
    for count in &shard.vote_counts {
        assert_condition(*count == 0, Error::Validation)?;
    }
    Ok(())
}

fn validate_initial_tally_shard_output(
    output_index: usize,
    poll: &PollData,
    poll_type_hash: &[u8; 32],
    expected_shard_id: u32,
) -> Result<(), Error> {
    let output = load_cell_data(output_index, Source::Output)?;
    let shard = decode_tally_shard(&output)?;
    let output_capacity = load_output_capacity(output_index)?;
    let output_lock = load_output_script(output_index)?;
    let output_type = load_output_type_script(output_index)?;

    assert_initial_tally_shard_data(&shard, poll, poll_type_hash, expected_shard_id)?;
    assert_tally_shard_script_policy(&output_lock, &output_type, poll_type_hash, shard.shard_id)?;
    assert_condition(
        output_capacity >= TALLY_SHARD_MIN_SHANNONS,
        Error::Validation,
    )
}

fn output_is_tally_shard(index: usize) -> Result<bool, Error> {
    match load_output_type_script(index) {
        Ok(script) => Ok(script.args.first().copied() == Some(OP_CREATE_TALLY_SHARD)),
        Err(Error::Validation) => Ok(false),
        Err(err) => Err(err),
    }
}

/// @notice Validates CREATE_POLL output invariants.
/// @dev Enforces initial zeroed tally state, bounded metadata, and minimum capacity.
fn validate_create_poll() -> Result<(), Error> {
    let output = load_cell_data(0, Source::Output)?;
    let poll = decode_poll(&output)?;
    let capacity = load_output_capacity(0)?;
    let output_type = load_output_type_script(0)?;
    let output_lock = load_output_script(0)?;
    let current_script = load_current_script()?;
    let creator_auth_lock_hash = load_input_lock_hash_bytes(0)?;
    let creator_auth_lock = load_input_script(0)?;

    assert_condition(
        compare_scripts(&output_type, &current_script),
        Error::Validation,
    )?;
    assert_condition(output_type.args.len() == 33, Error::Validation)?;
    assert_condition(
        output_type.args.first().copied() == Some(OP_CREATE_POLL),
        Error::Validation,
    )?;
    // Poll identity is Type ID-backed: args are CREATE_POLL || type_id,
    // where type_id is derived from input 0 and output index 0.
    check_type_id(1)?;

    assert_condition(!poll.question.is_empty(), Error::Validation)?;
    assert_condition(poll.question.len() <= MAX_QUESTION_LEN, Error::Validation)?;
    assert_condition(poll.options.len() >= 2, Error::Validation)?;
    assert_condition(poll.options.len() <= MAX_OPTIONS, Error::Validation)?;
    assert_condition(
        poll.vote_counts.len() == poll.options.len(),
        Error::Validation,
    )?;
    assert_condition(poll.shard_count > 0, Error::Validation)?;
    assert_condition(poll.shard_count <= MAX_TALLY_SHARDS, Error::Validation)?;
    assert_condition(!poll.is_closed, Error::Validation)?;
    assert_condition(!poll.token_weighted, Error::Validation)?;
    assert_condition(
        compare_arrays(&poll.udt_type_hash, &[0u8; 32]),
        Error::Validation,
    )?;
    assert_condition(
        compare_arrays(&poll.creator, &creator_auth_lock_hash),
        Error::Validation,
    )?;
    assert_condition(
        compare_scripts(&poll.creator_lock, &creator_auth_lock),
        Error::Validation,
    )?;
    assert_condition(poll.total_voters == 0, Error::Validation)?;
    assert_condition(poll.pending_intent_count == 0, Error::Validation)?;
    assert_condition(poll.counted_voter_lock_hashes.is_empty(), Error::Validation)?;
    assert_condition(
        poll.creator_deposit >= CREATOR_DEPOSIT_SHANNONS,
        Error::Validation,
    )?;
    assert_condition(count_unique_counted_voters(&poll), Error::Validation)?;
    // The VM cannot authenticate the eventual inclusion epoch of this output.
    // Builders enforce duration policy; the contract only requires a deadline
    // that can later be enforced with an absolute epoch `since` value.
    validate_deadline_epoch(poll.deadline)?;

    for option in &poll.options {
        assert_condition(!option.is_empty(), Error::Validation)?;
        assert_condition(option.len() <= MAX_OPTION_LEN, Error::Validation)?;
    }
    for count in &poll.vote_counts {
        assert_condition(*count == 0, Error::Validation)?;
    }

    let min_capacity = min_poll_capacity(output.len(), poll.creator_deposit)?;
    assert_condition(capacity >= min_capacity, Error::Validation)?;

    let poll_type_hash = load_output_type_hash_bytes(0)?;
    assert_protocol_poll_lock(&output_lock, &poll_type_hash)?;
    for shard_id in 0..poll.shard_count {
        let output_index = usize::try_from(shard_id + 1).map_err(|_| Error::Validation)?;
        validate_initial_tally_shard_output(output_index, &poll, &poll_type_hash, shard_id)?;
    }

    // Prevent extra shard cells beyond the canonical complete set.
    let mut index = usize::try_from(poll.shard_count + 1).map_err(|_| Error::Validation)?;
    loop {
        match load_cell_data(index, Source::Output) {
            Ok(_) => {
                assert_condition(!output_is_tally_shard(index)?, Error::Validation)?;
                index += 1;
            }
            Err(SysError::IndexOutOfBound) => break,
            Err(err) => return Err(err.into()),
        }
    }

    Ok(())
}

/// @notice Validates tally shard creation inside the atomic CREATE_POLL tx.
/// @dev Standalone post-poll creation is intentionally rejected: output[0]
/// must be the matching newly-created poll, and no input may carry that poll
/// type hash. This keeps the complete CREATE_POLL shard set as the uniqueness
/// boundary until shard aggregation/finalization are implemented.
fn validate_create_tally_shard() -> Result<(), Error> {
    let output = load_cell_data(0, Source::GroupOutput)?;
    let shard = decode_tally_shard(&output)?;
    let current_script = load_current_script()?;
    let output_lock = load_group_output_script(0)?;
    let output_capacity = load_cell_capacity(0, Source::GroupOutput)?;

    assert_condition(current_script.args.len() == 37, Error::Validation)?;
    assert_condition(
        current_script.args.first().copied() == Some(OP_CREATE_TALLY_SHARD),
        Error::Validation,
    )?;
    let script_poll_type_hash: [u8; 32] = current_script.args[1..33]
        .try_into()
        .map_err(|_| Error::Encoding)?;
    assert_condition(
        compare_arrays(&script_poll_type_hash, &shard.poll_type_hash),
        Error::Validation,
    )?;
    let script_shard_id = u32::from_le_bytes(
        current_script.args[33..37]
            .try_into()
            .map_err(|_| Error::Encoding)?,
    );
    assert_condition(script_shard_id == shard.shard_id, Error::Validation)?;
    assert_tally_shard_script_policy(
        &output_lock,
        &current_script,
        &script_poll_type_hash,
        shard.shard_id,
    )?;
    assert_condition(
        output_capacity >= TALLY_SHARD_MIN_SHANNONS,
        Error::Validation,
    )?;

    assert_no_matching_poll_input(&shard.poll_type_hash)?;
    let poll = ensure_created_output_poll_open(&shard.poll_type_hash)?;
    assert_initial_tally_shard_data(&shard, &poll, &script_poll_type_hash, shard.shard_id)?;

    // One exact shard type script may appear in this type group. Duplicate
    // same-id shard outputs would otherwise create competing canonical cells.
    match load_cell_data(1, Source::GroupOutput) {
        Err(SysError::IndexOutOfBound) => Ok(()),
        Ok(_) => Err(Error::Validation),
        Err(err) => Err(err.into()),
    }
}

fn assert_tally_shard_group_update_policy(
    before: &TallyShardData,
    after: &TallyShardData,
) -> Result<(PollData, [u8; 32], u32, usize), Error> {
    let current_script = load_current_script()?;
    let input_lock = load_group_input_script(0)?;
    let output_lock = load_group_output_script(0)?;
    let input_capacity = load_cell_capacity(0, Source::GroupInput)?;
    let output_capacity = load_cell_capacity(0, Source::GroupOutput)?;
    let (script_poll_type_hash, script_shard_id) = parse_tally_shard_scope(&current_script)?;
    let global_index = find_current_type_input_index(&current_script)?;
    let global_input_type = load_input_type_script(global_index)?;
    let global_output_type = load_output_type_script(global_index)?;

    assert_condition(
        compare_scripts(&global_input_type, &current_script),
        Error::Validation,
    )?;
    assert_condition(
        compare_scripts(&global_output_type, &current_script),
        Error::Validation,
    )?;
    assert_condition(script_shard_id == before.shard_id, Error::Validation)?;
    assert_condition(script_shard_id == after.shard_id, Error::Validation)?;
    assert_condition(
        compare_arrays(&script_poll_type_hash, &before.poll_type_hash),
        Error::Validation,
    )?;
    assert_condition(
        compare_arrays(&script_poll_type_hash, &after.poll_type_hash),
        Error::Validation,
    )?;
    assert_tally_shard_script_policy(
        &input_lock,
        &current_script,
        &script_poll_type_hash,
        script_shard_id,
    )?;
    assert_tally_shard_script_policy(
        &output_lock,
        &current_script,
        &script_poll_type_hash,
        script_shard_id,
    )?;
    assert_condition(
        input_capacity >= TALLY_SHARD_MIN_SHANNONS,
        Error::Validation,
    )?;
    assert_condition(output_capacity == input_capacity, Error::Validation)?;

    // Exactly one cell with this shard type may be updated in the type group.
    match load_cell_data(1, Source::GroupInput) {
        Err(SysError::IndexOutOfBound) => {}
        Ok(_) => return Err(Error::Validation),
        Err(err) => return Err(err.into()),
    }
    match load_cell_data(1, Source::GroupOutput) {
        Err(SysError::IndexOutOfBound) => {}
        Ok(_) => return Err(Error::Validation),
        Err(err) => return Err(err.into()),
    }

    assert_no_matching_poll_input(&before.poll_type_hash)?;
    let poll = ensure_poll_dep_unclosed(&before.poll_type_hash)?;
    assert_condition(poll.shard_count == before.shard_count, Error::Validation)?;
    assert_condition(before.shard_count == after.shard_count, Error::Validation)?;
    assert_condition(before.shard_id == after.shard_id, Error::Validation)?;
    assert_condition(before.version == after.version, Error::Validation)?;
    assert_condition(
        before.vote_counts.len() == poll.options.len(),
        Error::Validation,
    )?;
    assert_condition(
        after.vote_counts.len() == before.vote_counts.len(),
        Error::Validation,
    )?;
    Ok((poll, script_poll_type_hash, script_shard_id, global_index))
}

/// Locate the exact global input represented by the current one-cell type group.
/// Multi-lane finalization gives every lane distinct script args, so every group
/// sees itself at group index zero but may live at any global input index.
fn find_current_type_input_index(current_script: &EncodedScript) -> Result<usize, Error> {
    let mut matched = None;
    let mut index = 0usize;
    loop {
        match load_cell_data(index, Source::Input) {
            Ok(_) => {
                if let Ok(input_type) = load_input_type_script(index) {
                    if compare_scripts(&input_type, current_script) {
                        assert_condition(matched.is_none(), Error::Validation)?;
                        matched = Some(index);
                    }
                }
                index = index.checked_add(1).ok_or(Error::Validation)?;
            }
            Err(SysError::IndexOutOfBound) => return matched.ok_or(Error::Validation),
            Err(err) => return Err(err.into()),
        }
    }
}

fn verify_counted_voter_root_transition(
    before_root: &[u8; 32],
    after_root: &[u8; 32],
    voter_keys: &[[u8; 32]],
) -> Result<(), Error> {
    let witness = load_witness_args(0, Source::Input)?;
    let input_type = witness.input_type().to_opt().ok_or(Error::Validation)?;
    let proof = decode_tally_aggregation_proof(&input_type.raw_data())?;

    // One compiled multiproof authenticates both sides of the state transition:
    // every intent key is absent from the old tree and present in the new tree.
    let mut absent = SMTBuilder::new();
    let mut present = SMTBuilder::new();
    let present_value = H256::from(COUNTED_VOTER_PRESENT_VALUE);
    for voter_key in voter_keys {
        let key = H256::from(*voter_key);
        absent = absent
            .insert(&key, &H256::zero())
            .map_err(|_| Error::Validation)?;
        present = present
            .insert(&key, &present_value)
            .map_err(|_| Error::Validation)?;
    }
    absent
        .build()
        .map_err(|_| Error::Validation)?
        .verify(&H256::from(*before_root), &proof.compiled_proof)
        .map_err(|_| Error::Validation)?;
    present
        .build()
        .map_err(|_| Error::Validation)?
        .verify(&H256::from(*after_root), &proof.compiled_proof)
        .map_err(|_| Error::Validation)
}

fn validate_aggregate_tally_shard(input: &[u8], output: &[u8]) -> Result<(), Error> {
    let before = decode_tally_shard(input)?;
    let after = decode_tally_shard(output)?;
    let (poll, _, _, global_lane_index) = assert_tally_shard_group_update_policy(&before, &after)?;
    assert_condition(global_lane_index == 0, Error::Validation)?;
    assert_condition(!poll.token_weighted, Error::Validation)?;
    assert_condition(!before.finalized, Error::Validation)?;
    assert_condition(!after.finalized, Error::Validation)?;

    let mut batch_voters: Vec<[u8; 32]> = Vec::new();
    let mut deltas = alloc::vec![0u64; before.vote_counts.len()];
    let mut matched_intents = 0usize;
    let mut global_index = 1usize;

    loop {
        match load_cell_data(global_index, Source::Input) {
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(err) => return Err(err.into()),
        }

        if !input_is_current_poll_intent(global_index, &before.poll_type_hash)? {
            global_index += 1;
            continue;
        }

        let input_bytes = load_cell_data(global_index, Source::Input)?;
        let output_bytes = load_cell_data(global_index, Source::Output)?;
        let before_intent = decode_vote_intent(&input_bytes)?;
        let after_intent = decode_vote_intent(&output_bytes)?;
        let input_intent_capacity = load_input_capacity(global_index)?;
        let output_intent_capacity = load_output_capacity(global_index)?;
        let input_intent_lock = load_input_script(global_index)?;
        let output_intent_lock = load_output_script(global_index)?;
        let input_intent_type = load_input_type_script(global_index)?;
        let output_intent_type = load_output_type_script(global_index)?;

        assert_condition(!before_intent.aggregated, Error::Validation)?;
        assert_condition(after_intent.aggregated, Error::Validation)?;
        assert_condition(
            compare_arrays(&before_intent.poll_type_hash, &before.poll_type_hash),
            Error::Validation,
        )?;
        assert_condition(
            compare_arrays(&after_intent.poll_type_hash, &before_intent.poll_type_hash),
            Error::Validation,
        )?;
        assert_condition(
            compare_arrays(
                &after_intent.voter_lock_hash,
                &before_intent.voter_lock_hash,
            ),
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
        assert_intent_lock_matches_policy(&input_intent_lock, &before_intent.poll_type_hash)?;
        assert_intent_lock_matches_policy(&output_intent_lock, &before_intent.poll_type_hash)?;
        assert_condition(
            compare_scripts(&output_intent_type, &input_intent_type),
            Error::Validation,
        )?;
        assert_condition(
            output_intent_capacity == input_intent_capacity,
            Error::Validation,
        )?;
        assert_condition(
            output_intent_capacity >= VOTER_DEPOSIT_SHANNONS,
            Error::Validation,
        )?;
        assert_condition(
            (before_intent.option_index as usize) < poll.options.len(),
            Error::Validation,
        )?;
        let creation_epoch = load_input_creation_epoch(global_index)?;
        assert_condition(creation_epoch <= poll.deadline, Error::Validation)?;

        let derived_shard_id = derive_tally_shard_id(
            &before_intent.poll_type_hash,
            &before_intent.voter_lock_hash,
            before.shard_count,
        )?;
        assert_condition(derived_shard_id == before.shard_id, Error::Validation)?;
        assert_condition(
            !batch_voters
                .iter()
                .any(|existing| existing == &before_intent.voter_lock_hash),
            Error::Validation,
        )?;

        let option_index = before_intent.option_index as usize;
        deltas[option_index] = deltas[option_index]
            .checked_add(1)
            .ok_or(Error::Validation)?;
        batch_voters.push(before_intent.voter_lock_hash);
        matched_intents += 1;
        assert_condition(matched_intents <= MAX_INTENTS_PER_AGG, Error::Validation)?;
        global_index += 1;
    }

    assert_condition(matched_intents > 0, Error::Validation)?;
    verify_counted_voter_root_transition(
        &before.counted_voter_root,
        &after.counted_voter_root,
        &batch_voters,
    )?;
    for (index, previous_count) in before.vote_counts.iter().enumerate() {
        let expected = previous_count
            .checked_add(deltas[index])
            .ok_or(Error::Validation)?;
        assert_condition(after.vote_counts[index] == expected, Error::Validation)?;
    }

    let expected_total = before
        .total_voters
        .checked_add(u64::try_from(matched_intents).map_err(|_| Error::Validation)?)
        .ok_or(Error::Validation)?;
    assert_condition(after.total_voters == expected_total, Error::Validation)
}

fn validate_finalize_tally_shard(
    before: &TallyShardData,
    after: &TallyShardData,
) -> Result<(), Error> {
    let (_, _, _, current_global_index) = assert_tally_shard_group_update_policy(before, after)?;
    validate_finalize_tally_shard_batch(current_global_index)
}

fn validate_finalize_tally_shard_batch(current_global_index: usize) -> Result<(), Error> {
    let current_script = load_current_script()?;
    let mut lane_count = 0usize;
    let mut expected_poll_hash: Option<[u8; 32]> = None;
    let mut previous_shard_id: Option<u32> = None;
    let mut current_group_seen = false;
    let mut index = 0usize;

    loop {
        let input_data = match load_cell_data(index, Source::Input) {
            Ok(data) => data,
            Err(SysError::IndexOutOfBound) => break,
            Err(err) => return Err(err.into()),
        };
        let input_type = match load_input_type_script(index) {
            Ok(script) => script,
            Err(Error::Validation) => {
                index += 1;
                continue;
            }
            Err(err) => return Err(err),
        };
        let shard_id = match read_shard_id_from_tally_script(&input_type)? {
            Some(shard_id) => shard_id,
            None => {
                index += 1;
                continue;
            }
        };

        // Protocol lanes form one ordered prefix. Wallet fee inputs may follow,
        // but cannot be interleaved with or placed before a lane in this batch.
        assert_condition(index == lane_count, Error::Validation)?;
        lane_count = lane_count.checked_add(1).ok_or(Error::Validation)?;
        assert_condition(lane_count <= MAX_SHARDS_PER_FINALIZE, Error::Validation)?;
        if index == current_global_index {
            current_group_seen = true;
        }

        let output_data = load_cell_data(index, Source::Output)?;
        let output_type = load_output_type_script(index)?;
        let input_lock = load_input_script(index)?;
        let output_lock = load_output_script(index)?;
        let before_lane = decode_tally_shard(&input_data)?;
        let after_lane = decode_tally_shard(&output_data)?;
        let (poll_hash, script_shard_id) = parse_tally_shard_scope(&input_type)?;

        assert_condition(
            compare_scripts(&input_type, &output_type),
            Error::Validation,
        )?;
        assert_condition(
            compare_scripts(&input_lock, &output_lock),
            Error::Validation,
        )?;
        assert_condition(
            load_input_capacity(index)? == load_output_capacity(index)?,
            Error::Validation,
        )?;
        assert_condition(script_shard_id == shard_id, Error::Validation)?;
        assert_tally_shard_script_policy(&input_lock, &input_type, &poll_hash, shard_id)?;
        assert_condition(
            !before_lane.finalized && after_lane.finalized,
            Error::Validation,
        )?;
        assert_condition(before_lane.version == after_lane.version, Error::Validation)?;
        assert_condition(
            before_lane.poll_type_hash == after_lane.poll_type_hash,
            Error::Validation,
        )?;
        assert_condition(before_lane.poll_type_hash == poll_hash, Error::Validation)?;
        assert_condition(
            before_lane.shard_id == shard_id && after_lane.shard_id == shard_id,
            Error::Validation,
        )?;
        assert_condition(
            before_lane.shard_count == after_lane.shard_count,
            Error::Validation,
        )?;
        assert_condition(
            before_lane.vote_counts == after_lane.vote_counts,
            Error::Validation,
        )?;
        assert_condition(
            before_lane.total_voters == after_lane.total_voters,
            Error::Validation,
        )?;
        assert_condition(
            before_lane.counted_voter_root == after_lane.counted_voter_root,
            Error::Validation,
        )?;

        if let Some(expected) = expected_poll_hash {
            assert_condition(expected == poll_hash, Error::Validation)?;
        } else {
            expected_poll_hash = Some(poll_hash);
        }
        if let Some(previous) = previous_shard_id {
            assert_condition(shard_id > previous, Error::Validation)?;
        }
        previous_shard_id = Some(shard_id);

        let poll = ensure_poll_dep_unclosed(&poll_hash)?;
        assert_condition(
            before_lane.shard_count == poll.shard_count,
            Error::Validation,
        )?;
        assert_condition(
            before_lane.vote_counts.len() == poll.options.len(),
            Error::Validation,
        )?;
        require_input_since_strictly_after(index, poll.deadline)?;
        index += 1;
    }

    assert_condition(lane_count > 0, Error::Validation)?;
    assert_condition(current_group_seen, Error::Validation)?;
    let poll_hash = expected_poll_hash.ok_or(Error::Validation)?;
    assert_no_matching_poll_input(&poll_hash)?;

    // No extra current-code tally output may be hidden after the protocol
    // prefix. This closes the same-index bypass and duplicate-output surfaces.
    let mut output_index = 0usize;
    loop {
        match load_cell_data(output_index, Source::Output) {
            Ok(_) => {
                if let Ok(output_type) = load_output_type_script(output_index) {
                    if read_shard_id_from_tally_script(&output_type)?.is_some() {
                        assert_condition(output_index < lane_count, Error::Validation)?;
                    }
                }
                output_index += 1;
            }
            Err(SysError::IndexOutOfBound) => break,
            Err(err) => return Err(err.into()),
        }
    }

    // Every invocation must correspond to one of the exact same-index lanes.
    assert_condition(
        compare_scripts(
            &load_input_type_script(current_global_index)?,
            &current_script,
        ),
        Error::Validation,
    )
}

fn validate_consume_finalized_tally_shard_on_close(shard: &TallyShardData) -> Result<(), Error> {
    let current_script = load_current_script()?;
    let input_lock = load_group_input_script(0)?;
    let input_capacity = load_cell_capacity(0, Source::GroupInput)?;
    let (script_poll_type_hash, script_shard_id) = parse_tally_shard_scope(&current_script)?;
    let input_poll = load_cell_data(0, Source::Input)?;
    let output_poll = load_cell_data(0, Source::Output)?;
    let before_poll = decode_poll(&input_poll)?;
    let after_poll = decode_poll(&output_poll)?;
    let poll_type_hash = load_input_type_hash_bytes(0)?;

    assert_condition(shard.finalized, Error::Validation)?;
    assert_condition(script_shard_id == shard.shard_id, Error::Validation)?;
    assert_condition(
        compare_arrays(&script_poll_type_hash, &shard.poll_type_hash),
        Error::Validation,
    )?;
    assert_condition(
        compare_arrays(&poll_type_hash, &shard.poll_type_hash),
        Error::Validation,
    )?;
    assert_condition(!before_poll.is_closed, Error::Validation)?;
    assert_condition(after_poll.is_closed, Error::Validation)?;
    assert_condition(
        before_poll.shard_count == shard.shard_count,
        Error::Validation,
    )?;
    assert_condition(
        input_capacity >= TALLY_SHARD_MIN_SHANNONS,
        Error::Validation,
    )?;
    assert_tally_shard_script_policy(
        &input_lock,
        &current_script,
        &script_poll_type_hash,
        script_shard_id,
    )?;

    Ok(())
}

fn validate_consume_finalized_tally_shard_on_merge(shard: &TallyShardData) -> Result<(), Error> {
    let current_script = load_current_script()?;
    let input_lock = load_group_input_script(0)?;
    let input_capacity = load_cell_capacity(0, Source::GroupInput)?;
    let output_result = decode_tally_merge_result(&load_cell_data(0, Source::Output)?)?;
    let output_lock = load_output_script(0)?;
    let output_type = load_output_type_script(0)?;
    let (script_poll_type_hash, script_shard_id) = parse_tally_shard_scope(&current_script)?;

    assert_condition(shard.finalized, Error::Validation)?;
    assert_condition(script_shard_id == shard.shard_id, Error::Validation)?;
    assert_condition(
        compare_arrays(&script_poll_type_hash, &shard.poll_type_hash),
        Error::Validation,
    )?;
    assert_condition(
        compare_arrays(&output_result.poll_type_hash, &shard.poll_type_hash),
        Error::Validation,
    )?;
    assert_tally_merge_script_policy(&output_lock, &output_type, &script_poll_type_hash)?;
    assert_condition(
        input_capacity >= TALLY_SHARD_MIN_SHANNONS,
        Error::Validation,
    )?;
    assert_tally_shard_script_policy(
        &input_lock,
        &current_script,
        &script_poll_type_hash,
        script_shard_id,
    )
}

fn validate_consume_final_merge_result_on_close(
    result: &TallyMergeResultData,
) -> Result<(), Error> {
    let current_script = load_current_script()?;
    let input_lock = load_group_input_script(0)?;
    let input_type = load_current_script()?;
    let input_capacity = load_cell_capacity(0, Source::GroupInput)?;
    let input_poll = load_cell_data(0, Source::Input)?;
    let output_poll = load_cell_data(0, Source::Output)?;
    let before_poll = decode_poll(&input_poll)?;
    let after_poll = decode_poll(&output_poll)?;
    let poll_type_hash = load_input_type_hash_bytes(0)?;
    let script_poll_type_hash = parse_tally_merge_scope(&current_script)?;

    assert_condition(
        compare_arrays(&script_poll_type_hash, &result.poll_type_hash),
        Error::Validation,
    )?;
    assert_condition(
        compare_arrays(&poll_type_hash, &result.poll_type_hash),
        Error::Validation,
    )?;
    assert_condition(!before_poll.is_closed, Error::Validation)?;
    assert_condition(after_poll.is_closed, Error::Validation)?;
    assert_condition(
        before_poll.shard_count > MAX_DIRECT_CLOSE_SHARDS,
        Error::Validation,
    )?;
    assert_condition(
        coverage_complete(&result.coverage, before_poll.shard_count)?,
        Error::Validation,
    )?;
    assert_condition(
        input_capacity >= TALLY_MERGE_RESULT_MIN_SHANNONS,
        Error::Validation,
    )?;
    assert_tally_merge_script_policy(&input_lock, &input_type, &script_poll_type_hash)
}

fn validate_merge_result_shape(
    result: &TallyMergeResultData,
    poll: &PollData,
    poll_type_hash: &[u8; 32],
) -> Result<(), Error> {
    assert_condition(
        compare_arrays(&result.poll_type_hash, poll_type_hash),
        Error::Validation,
    )?;
    assert_condition(result.version == 1, Error::Validation)?;
    assert_condition(
        result.vote_counts.len() == poll.options.len(),
        Error::Validation,
    )?;
    coverage_within_shard_count(&result.coverage, poll.shard_count)?;
    assert_condition(coverage_count(&result.coverage) > 0, Error::Validation)
}

fn validate_merge_tally_shards(output: &[u8]) -> Result<(), Error> {
    let result = decode_tally_merge_result(output)?;
    let current_script = load_current_script()?;
    let output_lock = load_group_output_script(0)?;
    let output_type = load_output_type_script(0)?;
    let output_capacity = load_cell_capacity(0, Source::GroupOutput)?;
    let script_poll_type_hash = parse_tally_merge_scope(&current_script)?;
    let global_output_type = load_output_type_script(0)?;

    assert_condition(
        compare_scripts(&global_output_type, &current_script),
        Error::Validation,
    )?;
    assert_condition(
        compare_arrays(&script_poll_type_hash, &result.poll_type_hash),
        Error::Validation,
    )?;
    assert_tally_merge_script_policy(&output_lock, &output_type, &script_poll_type_hash)?;
    assert_condition(
        output_capacity >= TALLY_MERGE_RESULT_MIN_SHANNONS,
        Error::Validation,
    )?;

    let poll = ensure_poll_dep_unclosed(&result.poll_type_hash)?;
    assert_condition(
        poll.shard_count > MAX_DIRECT_CLOSE_SHARDS,
        Error::Validation,
    )?;
    validate_merge_result_shape(&result, &poll, &script_poll_type_hash)?;

    match load_cell_data(1, Source::GroupOutput) {
        Err(SysError::IndexOutOfBound) => {}
        Ok(_) => return Err(Error::Validation),
        Err(err) => return Err(err.into()),
    }

    let mut expected_coverage = [0u8; MERGE_COVERAGE_BYTES];
    let mut expected_vote_counts = alloc::vec![0u64; poll.options.len()];
    let mut expected_total_voters = 0u64;
    let mut max_input_level = 0u32;
    let mut merge_inputs = 0usize;
    let mut locked_capacity = 0u64;
    let mut index = 0usize;

    loop {
        let input_data = match load_cell_data(index, Source::Input) {
            Ok(data) => data,
            Err(SysError::IndexOutOfBound) => break,
            Err(err) => return Err(err.into()),
        };
        let input_type = match load_input_type_script(index) {
            Ok(script) => script,
            Err(Error::Validation) => {
                index += 1;
                continue;
            }
            Err(err) => return Err(err),
        };

        match input_type.args.first().copied() {
            Some(OP_CREATE_TALLY_SHARD) => {
                let shard = decode_tally_shard(&input_data)?;
                let (input_poll_hash, input_shard_id) = parse_tally_shard_scope(&input_type)?;
                let input_lock = load_input_script(index)?;
                let input_capacity = load_input_capacity(index)?;
                assert_condition(shard.finalized, Error::Validation)?;
                assert_condition(shard.shard_id == input_shard_id, Error::Validation)?;
                assert_condition(shard.shard_count == poll.shard_count, Error::Validation)?;
                assert_condition(
                    compare_arrays(&input_poll_hash, &result.poll_type_hash),
                    Error::Validation,
                )?;
                assert_condition(
                    compare_arrays(&shard.poll_type_hash, &result.poll_type_hash),
                    Error::Validation,
                )?;
                assert_condition(
                    shard.vote_counts.len() == poll.options.len(),
                    Error::Validation,
                )?;
                assert_tally_shard_script_policy(
                    &input_lock,
                    &input_type,
                    &result.poll_type_hash,
                    shard.shard_id,
                )?;
                coverage_set(&mut expected_coverage, shard.shard_id)?;
                for (vote_index, count) in shard.vote_counts.iter().enumerate() {
                    expected_vote_counts[vote_index] = expected_vote_counts[vote_index]
                        .checked_add(*count)
                        .ok_or(Error::Validation)?;
                }
                expected_total_voters = expected_total_voters
                    .checked_add(shard.total_voters)
                    .ok_or(Error::Validation)?;
                locked_capacity = locked_capacity
                    .checked_add(input_capacity)
                    .ok_or(Error::Validation)?;
                merge_inputs += 1;
            }
            Some(OP_MERGE_TALLY_SHARDS) => {
                let input_result = decode_tally_merge_result(&input_data)?;
                let input_poll_hash = parse_tally_merge_scope(&input_type)?;
                let input_lock = load_input_script(index)?;
                let input_capacity = load_input_capacity(index)?;
                assert_condition(
                    compare_arrays(&input_poll_hash, &result.poll_type_hash),
                    Error::Validation,
                )?;
                validate_merge_result_shape(&input_result, &poll, &result.poll_type_hash)?;
                assert_tally_merge_script_policy(&input_lock, &input_type, &result.poll_type_hash)?;
                coverage_or_disjoint(&mut expected_coverage, &input_result.coverage)?;
                for (vote_index, count) in input_result.vote_counts.iter().enumerate() {
                    expected_vote_counts[vote_index] = expected_vote_counts[vote_index]
                        .checked_add(*count)
                        .ok_or(Error::Validation)?;
                }
                expected_total_voters = expected_total_voters
                    .checked_add(input_result.total_voters)
                    .ok_or(Error::Validation)?;
                if input_result.merge_level > max_input_level {
                    max_input_level = input_result.merge_level;
                }
                locked_capacity = locked_capacity
                    .checked_add(input_capacity)
                    .ok_or(Error::Validation)?;
                merge_inputs += 1;
            }
            _ => {}
        }
        index += 1;
    }

    assert_condition(merge_inputs > 0, Error::Validation)?;
    assert_condition(merge_inputs <= MAX_SHARDS_PER_MERGE, Error::Validation)?;
    assert_condition(result.coverage == expected_coverage, Error::Validation)?;
    assert_condition(
        result.vote_counts == expected_vote_counts,
        Error::Validation,
    )?;
    assert_condition(
        result.total_voters == expected_total_voters,
        Error::Validation,
    )?;
    assert_condition(
        result.merge_level == max_input_level.checked_add(1).ok_or(Error::Validation)?,
        Error::Validation,
    )?;
    assert_condition(output_capacity >= locked_capacity, Error::Validation)
}

fn read_shard_id_from_tally_script(script: &EncodedScript) -> Result<Option<u32>, Error> {
    let current_script = load_current_script()?;
    if script.code_hash != current_script.code_hash
        || script.hash_type != current_script.hash_type
        || script.args.first().copied() != Some(OP_CREATE_TALLY_SHARD)
    {
        return Ok(None);
    }
    let (_, shard_id) = parse_tally_shard_scope(script)?;
    Ok(Some(shard_id))
}

fn input_is_tally_shard(index: usize) -> Result<Option<u32>, Error> {
    let input_type = match load_input_type_script(index) {
        Ok(script) => script,
        Err(Error::IndexOutOfBound) => return Ok(None),
        Err(Error::Validation) => return Ok(None),
        Err(err) => return Err(err),
    };
    read_shard_id_from_tally_script(&input_type)
}

fn input_is_tally_merge_result(index: usize) -> Result<bool, Error> {
    let input_type = match load_input_type_script(index) {
        Ok(script) => script,
        Err(Error::IndexOutOfBound) => return Ok(false),
        Err(Error::Validation) => return Ok(false),
        Err(err) => return Err(err),
    };
    let current_script = load_current_script()?;
    Ok(input_type.code_hash == current_script.code_hash
        && input_type.hash_type == current_script.hash_type
        && input_type.args.first().copied() == Some(OP_MERGE_TALLY_SHARDS))
}

fn coverage_has(coverage: &[u8; MERGE_COVERAGE_BYTES], shard_id: u32) -> Result<bool, Error> {
    assert_condition(shard_id < MAX_TALLY_SHARDS, Error::Validation)?;
    let byte_index = usize::try_from(shard_id / 8).map_err(|_| Error::Validation)?;
    let bit = (shard_id % 8) as u8;
    Ok((coverage[byte_index] & (1u8 << bit)) != 0)
}

fn coverage_set(coverage: &mut [u8; MERGE_COVERAGE_BYTES], shard_id: u32) -> Result<(), Error> {
    assert_condition(!coverage_has(coverage, shard_id)?, Error::Validation)?;
    let byte_index = usize::try_from(shard_id / 8).map_err(|_| Error::Validation)?;
    let bit = (shard_id % 8) as u8;
    coverage[byte_index] |= 1u8 << bit;
    Ok(())
}

fn coverage_or_disjoint(
    target: &mut [u8; MERGE_COVERAGE_BYTES],
    source: &[u8; MERGE_COVERAGE_BYTES],
) -> Result<(), Error> {
    for index in 0..MERGE_COVERAGE_BYTES {
        assert_condition((target[index] & source[index]) == 0, Error::Validation)?;
        target[index] |= source[index];
    }
    Ok(())
}

fn coverage_count(coverage: &[u8; MERGE_COVERAGE_BYTES]) -> u32 {
    coverage.iter().map(|byte| byte.count_ones()).sum()
}

fn coverage_within_shard_count(
    coverage: &[u8; MERGE_COVERAGE_BYTES],
    shard_count: u32,
) -> Result<(), Error> {
    assert_condition(shard_count > 0, Error::Validation)?;
    assert_condition(shard_count <= MAX_TALLY_SHARDS, Error::Validation)?;
    for shard_id in shard_count..MAX_TALLY_SHARDS {
        assert_condition(!coverage_has(coverage, shard_id)?, Error::Validation)?;
    }
    Ok(())
}

fn coverage_complete(
    coverage: &[u8; MERGE_COVERAGE_BYTES],
    shard_count: u32,
) -> Result<bool, Error> {
    coverage_within_shard_count(coverage, shard_count)?;
    for shard_id in 0..shard_count {
        if !coverage_has(coverage, shard_id)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn assert_no_more_tally_inputs(start_index: usize) -> Result<(), Error> {
    let mut index = start_index;
    loop {
        match load_cell_data(index, Source::Input) {
            Ok(_) => {
                if input_is_tally_shard(index)?.is_some() || input_is_tally_merge_result(index)? {
                    return Err(Error::Validation);
                }
                index += 1;
            }
            Err(SysError::IndexOutOfBound) => break,
            Err(err) => return Err(err.into()),
        }
    }
    Ok(())
}

fn assert_no_output_type(index: usize) -> Result<(), Error> {
    match load_cell_type_hash(index, Source::Output) {
        Ok(None) => Ok(()),
        Ok(Some(_)) => Err(Error::Validation),
        Err(err) => Err(err.into()),
    }
}

fn validate_sharded_close_result(
    before: &PollData,
    after: &PollData,
    poll_type_hash: &[u8; 32],
    first_input_index: usize,
    first_shard_return_output_index: usize,
) -> Result<usize, Error> {
    let shard_count = usize::try_from(before.shard_count).map_err(|_| Error::Validation)?;
    assert_condition(shard_count > 0, Error::Validation)?;
    assert_condition(shard_count <= MAX_TALLY_SHARDS as usize, Error::Validation)?;
    assert_condition(
        shard_count <= MAX_DIRECT_CLOSE_SHARDS as usize,
        Error::Validation,
    )?;

    let mut seen = alloc::vec![false; shard_count];
    let mut vote_counts = alloc::vec![0u64; before.options.len()];
    let mut total_voters = 0u64;
    let mut consumed_shards = 0usize;

    for offset in 0..shard_count {
        let input_index = first_input_index
            .checked_add(offset)
            .ok_or(Error::Validation)?;
        let shard_id_from_type = input_is_tally_shard(input_index)?.ok_or(Error::Validation)?;
        let shard_data = load_cell_data(input_index, Source::Input)?;
        let shard = decode_tally_shard(&shard_data)?;
        let shard_index = usize::try_from(shard.shard_id).map_err(|_| Error::Validation)?;
        let expected_script = expected_tally_shard_script(poll_type_hash, shard.shard_id)?;
        let input_lock = load_input_script(input_index)?;
        let input_type = load_input_type_script(input_index)?;
        let input_capacity = load_input_capacity(input_index)?;
        let return_output_index = first_shard_return_output_index
            .checked_add(offset)
            .ok_or(Error::Validation)?;
        let return_lock = load_output_script(return_output_index)?;
        let return_capacity = load_output_capacity(return_output_index)?;

        assert_condition(
            compare_arrays(&shard.poll_type_hash, poll_type_hash),
            Error::Validation,
        )?;
        assert_condition(shard.shard_count == before.shard_count, Error::Validation)?;
        assert_condition(shard_id_from_type == shard.shard_id, Error::Validation)?;
        assert_condition(shard_index < shard_count, Error::Validation)?;
        assert_condition(!seen[shard_index], Error::Validation)?;
        assert_condition(shard.finalized, Error::Validation)?;
        assert_condition(
            shard.vote_counts.len() == before.options.len(),
            Error::Validation,
        )?;
        assert_condition(
            compare_scripts(&input_lock, &expected_script),
            Error::Validation,
        )?;
        assert_condition(
            compare_scripts(&input_type, &expected_script),
            Error::Validation,
        )?;
        assert_condition(
            compare_scripts(&return_lock, &before.creator_lock),
            Error::Validation,
        )?;
        assert_condition(return_capacity == input_capacity, Error::Validation)?;

        for (index, count) in shard.vote_counts.iter().enumerate() {
            vote_counts[index] = vote_counts[index]
                .checked_add(*count)
                .ok_or(Error::Validation)?;
        }
        total_voters = total_voters
            .checked_add(shard.total_voters)
            .ok_or(Error::Validation)?;
        seen[shard_index] = true;
        consumed_shards += 1;
    }

    assert_condition(seen.iter().all(|value| *value), Error::Validation)?;
    assert_condition(after.vote_counts == vote_counts, Error::Validation)?;
    assert_condition(after.total_voters == total_voters, Error::Validation)?;
    assert_condition(
        after.counted_voter_lock_hashes.is_empty(),
        Error::Validation,
    )?;

    let next_input_index = first_input_index
        .checked_add(shard_count)
        .ok_or(Error::Validation)?;
    assert_no_more_tally_inputs(next_input_index)?;

    Ok(consumed_shards)
}

fn validate_merged_close_result(
    before: &PollData,
    after: &PollData,
    poll_type_hash: &[u8; 32],
    result_input_index: usize,
    result_return_output_index: usize,
) -> Result<usize, Error> {
    assert_condition(
        before.shard_count > MAX_DIRECT_CLOSE_SHARDS,
        Error::Validation,
    )?;
    let input_type = load_input_type_script(result_input_index)?;
    let input_lock = load_input_script(result_input_index)?;
    let input_capacity = load_input_capacity(result_input_index)?;
    let result_data = load_cell_data(result_input_index, Source::Input)?;
    let result = decode_tally_merge_result(&result_data)?;
    let script_poll_type_hash = parse_tally_merge_scope(&input_type)?;
    let return_lock = load_output_script(result_return_output_index)?;
    let return_capacity = load_output_capacity(result_return_output_index)?;

    assert_condition(
        compare_arrays(&script_poll_type_hash, poll_type_hash),
        Error::Validation,
    )?;
    validate_merge_result_shape(&result, before, poll_type_hash)?;
    assert_condition(
        coverage_complete(&result.coverage, before.shard_count)?,
        Error::Validation,
    )?;
    assert_tally_merge_script_policy(&input_lock, &input_type, poll_type_hash)?;
    assert_condition(
        input_capacity >= TALLY_MERGE_RESULT_MIN_SHANNONS,
        Error::Validation,
    )?;
    assert_condition(
        compare_scripts(&return_lock, &before.creator_lock),
        Error::Validation,
    )?;
    assert_condition(return_capacity == input_capacity, Error::Validation)?;
    assert_condition(after.vote_counts == result.vote_counts, Error::Validation)?;
    assert_condition(after.total_voters == result.total_voters, Error::Validation)?;
    assert_condition(
        after.counted_voter_lock_hashes.is_empty(),
        Error::Validation,
    )?;

    let next_input_index = result_input_index.checked_add(1).ok_or(Error::Validation)?;
    assert_no_more_tally_inputs(next_input_index)?;

    Ok(1)
}

/// @notice Validates CREATE_VOTE_INTENT invariants.
/// @dev Verifies signer/delegation authority, poll liveness, and refund-lock ownership.
fn validate_create_vote_intent() -> Result<(), Error> {
    let output = load_cell_data(0, Source::Output)?;
    let intent = decode_vote_intent(&output)?;
    let witness_option = first_input_type_byte(0)?;
    let intent_capacity = load_output_capacity(0)?;
    let output_lock = load_output_script(0)?;
    let output_type = load_output_type_script(0)?;
    let current_script = load_current_script()?;

    assert_condition(!intent.aggregated, Error::Validation)?;
    assert_condition(intent.option_index == witness_option, Error::Validation)?;
    assert_condition(intent_capacity >= VOTER_DEPOSIT_SHANNONS, Error::Validation)?;
    assert_condition(
        compare_scripts(&current_script, &output_type),
        Error::Validation,
    )?;
    assert_condition(current_script.args.len() == 33, Error::Validation)?;
    assert_condition(
        current_script.args.first().copied() == Some(OP_CREATE_VOTE_INTENT),
        Error::Validation,
    )?;
    let script_poll_type_hash: [u8; 32] = current_script.args[1..33]
        .try_into()
        .map_err(|_| Error::Encoding)?;
    assert_condition(
        compare_arrays(&script_poll_type_hash, &intent.poll_type_hash),
        Error::Validation,
    )?;
    assert_intent_lock_matches_policy(&output_lock, &intent.poll_type_hash)?;

    // The referenced poll must be provided as an open cell dep. An output's
    // eventual inclusion epoch is unknowable here, so the authenticated cutoff
    // is enforced when the intent input is aggregated or refunded.
    let poll = ensure_poll_dep_open(&intent.poll_type_hash)?;
    assert_condition(!poll.token_weighted, Error::Validation)?;
    assert_condition(
        (intent.option_index as usize) < poll.options.len(),
        Error::Validation,
    )?;
    let signer_lock_hash = load_input_lock_hash_bytes(0)?;
    let signer_lock = load_input_script(0)?;
    // The proposer is a neutral lifecycle authority in v1 and cannot submit
    // either their own intent or an intent on another voter's behalf.
    assert_condition(
        !compare_arrays(&intent.voter_lock_hash, &poll.creator),
        Error::Validation,
    )?;
    assert_condition(
        !compare_arrays(&signer_lock_hash, &poll.creator),
        Error::Validation,
    )?;
    if compare_arrays(&intent.voter_lock_hash, &signer_lock_hash) {
        return assert_condition(
            compare_scripts(&intent.refund_lock, &signer_lock),
            Error::Validation,
        );
    }

    let delegation_refund_lock = ensure_delegation_dep_live(
        &intent.voter_lock_hash,
        &signer_lock_hash,
        &intent.poll_type_hash,
    )?;
    assert_condition(
        compare_scripts(&intent.refund_lock, &delegation_refund_lock),
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
    let poll_type_hash = load_input_type_hash_bytes(0)?;
    let input_poll_lock = load_input_script(0)?;
    let output_poll_lock = load_output_script(0)?;
    let creator_return_lock = load_output_script(1)?;
    let creator_return_capacity = load_output_capacity(1)?;

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
        after.counted_voter_lock_hashes.is_empty()
            || compare_slice_items(
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
    assert_condition(
        compare_scripts(&after.creator_lock, &before.creator_lock),
        Error::Validation,
    )?;
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
    assert_condition(
        compare_scripts(&creator_return_lock, &before.creator_lock),
        Error::Validation,
    )?;
    assert_condition(
        creator_return_capacity == before.creator_deposit,
        Error::Validation,
    )?;
    assert_protocol_poll_lock(&input_poll_lock, &poll_type_hash)?;
    assert_protocol_poll_lock(&output_poll_lock, &poll_type_hash)?;

    // Mode selection:
    // 1) creator close: input[1] lock hash matches poll.creator
    // 2) permissionless recovery: allowed only after deadline + grace period
    let creator_authorized = poll_close_has_creator_authorization(&before)?;
    require_poll_close_since(&before, creator_authorized)?;

    let first_after_auth_input = if creator_authorized { 2usize } else { 1usize };
    let consumed_tally_inputs = if before.shard_count > MAX_DIRECT_CLOSE_SHARDS {
        validate_merged_close_result(&before, &after, &poll_type_hash, first_after_auth_input, 2)?
    } else {
        assert_condition(before.shard_count > 0, Error::Validation)?;
        validate_sharded_close_result(&before, &after, &poll_type_hash, first_after_auth_input, 2)?
    };

    let mut output_index = 2usize
        .checked_add(consumed_tally_inputs)
        .ok_or(Error::Validation)?;
    let mut input_index = first_after_auth_input
        .checked_add(consumed_tally_inputs)
        .ok_or(Error::Validation)?;
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
            let input_capacity = load_input_capacity(input_index)?;
            assert_no_output_type(output_index)?;
            assert_condition(
                compare_scripts(&return_lock, &intent.refund_lock),
                Error::Validation,
            )?;
            assert_condition(return_capacity >= VOTER_DEPOSIT_SHANNONS, Error::Validation)?;
            assert_condition(return_capacity == input_capacity, Error::Validation)?;
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
    let output_lock = load_output_script(0)?;
    let output_type = load_output_type_script(0)?;
    let output_capacity = load_output_capacity(0)?;
    let current_script = load_current_script()?;

    assert_condition(
        compare_scripts(&output_type, &current_script),
        Error::Validation,
    )?;

    assert_condition(
        compare_arrays(&delegation.delegator_lock_hash, &delegator_lock_hash),
        Error::Validation,
    )?;
    assert_condition(
        compare_arrays(
            &delegation.delegator_lock_hash,
            &load_output_lock_hash_bytes(0)?,
        ),
        Error::Validation,
    )?;
    assert_condition(
        script_is_governance_op(&output_type, OP_DELEGATE)?,
        Error::Validation,
    )?;
    assert_condition(
        script_scope_matches(&output_type, &delegation.poll_type_hash),
        Error::Validation,
    )?;
    assert_condition(
        compare_scripts(&output_lock, &load_input_script(0)?),
        Error::Validation,
    )?;
    assert_condition(
        !compare_arrays(
            &delegation.delegator_lock_hash,
            &delegation.delegate_lock_hash,
        ),
        Error::Validation,
    )?;
    // v1 delegations are revocation-based. The serialized expiry field is
    // retained for codec compatibility but nonzero values are not executable.
    assert_condition(delegation.expires_epoch == 0, Error::Validation)?;
    assert_condition(
        output_capacity >= DELEGATION_MIN_SHANNONS,
        Error::Validation,
    )
}

/// @notice Validates delegation-cell destruction under the OP_DELEGATE family.
/// @dev Revocation keeps lock ownership and preserves minimum reclaimable capacity.
fn validate_delegation_revocation() -> Result<(), Error> {
    let input = load_cell_data(0, Source::Input)?;
    let _delegation = decode_delegation(&input)?;
    let input_lock = load_input_script(0)?;
    let output_lock = load_output_script(0)?;
    let output_capacity = load_output_capacity(0)?;
    let input_capacity = load_input_capacity(0)?;
    let input_type = load_input_type_script(0)?;
    let current_script = load_current_script()?;

    assert_condition(
        compare_scripts(&input_type, &current_script),
        Error::Validation,
    )?;

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
