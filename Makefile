SHELL := /bin/bash
.DEFAULT_GOAL := build
.NOTPARALLEL:

CONTRACT_RUST := 1.81.0
VM_TEST_RUST := 1.95.0
CKB_TARGET := riscv64imac-unknown-none-elf
WASM_TARGET := wasm32-unknown-unknown
WASM_BINDGEN_VERSION := 0.2.125

.PHONY: setup check test build validate

setup:
	@command -v node >/dev/null || { printf '%s\n' 'Missing Node.js 20.19 or newer'; exit 1; }
	@command -v rustup >/dev/null || { printf '%s\n' 'Missing rustup'; exit 1; }
	@command -v riscv64-unknown-elf-gcc >/dev/null || { printf '%s\n' 'Missing riscv64-unknown-elf-gcc; install gcc-riscv64-unknown-elf on Ubuntu/Debian'; exit 1; }
	@command -v clang >/dev/null || { printf '%s\n' 'Missing clang; install clang on Ubuntu/Debian'; exit 1; }
	corepack enable
	rustup toolchain install $(CONTRACT_RUST) --profile minimal --component rustfmt --target $(CKB_TARGET)
	rustup toolchain install $(VM_TEST_RUST) --profile minimal
	rustup target add $(WASM_TARGET) --toolchain $(VM_TEST_RUST)
	@version="$$("$$HOME/.cargo/bin/wasm-bindgen" --version 2>/dev/null || true)"; \
		if [[ "$$version" != "wasm-bindgen $(WASM_BINDGEN_VERSION)" ]]; then \
			cargo +$(VM_TEST_RUST) install wasm-bindgen-cli --version $(WASM_BINDGEN_VERSION) --locked; \
		fi
	pnpm install --frozen-lockfile

check:
	cargo +$(CONTRACT_RUST) fmt --manifest-path backend/contracts-rust/Cargo.toml --all --check
	pnpm check:contract:rust
	pnpm --filter ckb-voting-deploy exec tsc -p tsconfig.json --noEmit
	git diff --check

test:
	pnpm test:contract:vm
	pnpm test:frontend

build:
	pnpm build:tally-smt-wasm
	pnpm build:contract:rust
	pnpm build:frontend

validate:
	$(MAKE) check
	$(MAKE) test
	$(MAKE) build
