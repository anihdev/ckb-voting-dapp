SHELL := /bin/bash
.DEFAULT_GOAL := build
.NOTPARALLEL:

CONTRACT_RUST := 1.81.0
VM_TEST_RUST := stable
CKB_TARGET := riscv64imac-unknown-none-elf

.PHONY: setup check test build validate

setup:
	@command -v node >/dev/null || { printf '%s\n' 'Missing Node.js 20.19 or newer'; exit 1; }
	@command -v rustup >/dev/null || { printf '%s\n' 'Missing rustup'; exit 1; }
	@command -v riscv64-unknown-elf-gcc >/dev/null || { printf '%s\n' 'Missing riscv64-unknown-elf-gcc; install gcc-riscv64-unknown-elf on Ubuntu/Debian'; exit 1; }
	corepack enable
	rustup toolchain install $(CONTRACT_RUST) --profile minimal --component rustfmt --target $(CKB_TARGET)
	rustup toolchain install $(VM_TEST_RUST) --profile minimal
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
	pnpm build:contract:rust
	pnpm build:frontend

validate:
	$(MAKE) check
	$(MAKE) test
	$(MAKE) build
