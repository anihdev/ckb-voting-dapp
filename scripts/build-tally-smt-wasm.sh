#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crate_dir="$repo_root/frontend/tally-smt-wasm"
web_out_dir="$repo_root/frontend/src/lib/tally-smt-wasm-pkg"
node_out_dir="$repo_root/backend/deploy/tally-smt-wasm-pkg"
wasm_bindgen_bin="${WASM_BINDGEN_BIN:-$HOME/.cargo/bin/wasm-bindgen}"
host_rust_toolchain="${HOST_RUST_TOOLCHAIN:-1.95.0}"
wasm_bindgen_version="0.2.125"

if [[ ! -x "$wasm_bindgen_bin" ]]; then
  echo "wasm-bindgen $wasm_bindgen_version is required at $wasm_bindgen_bin" >&2
  exit 1
fi

if [[ "$($wasm_bindgen_bin --version)" != "wasm-bindgen $wasm_bindgen_version" ]]; then
  echo "wasm-bindgen $wasm_bindgen_version is required at $wasm_bindgen_bin" >&2
  exit 1
fi

cargo +"$host_rust_toolchain" build \
  --manifest-path "$crate_dir/Cargo.toml" \
  --target wasm32-unknown-unknown \
  --release \
  --locked

# Flow: one reviewed Rust implementation produces both runtime adapters so the
# browser builder and testnet smoke tooling cannot choose different tree rules.
"$wasm_bindgen_bin" \
  --target web \
  --out-dir "$web_out_dir" \
  --out-name tally_smt \
  "$crate_dir/target/wasm32-unknown-unknown/release/ckb_governance_tally_smt_wasm.wasm"

"$wasm_bindgen_bin" \
  --target nodejs \
  --out-dir "$node_out_dir" \
  --out-name tally_smt \
  "$crate_dir/target/wasm32-unknown-unknown/release/ckb_governance_tally_smt_wasm.wasm"
