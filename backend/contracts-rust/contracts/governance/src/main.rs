#![no_std]
#![no_main]

mod codec;
mod constants;
mod entry;
mod error;
mod helpers;

use ckb_std::default_alloc;
ckb_std::entry!(program_entry);
default_alloc!();

/// Program entry for the Rust governance contract.
fn program_entry() -> i8 {
    match entry::main() {
        Ok(()) => 0,
        Err(err) => err as i8,
    }
}
