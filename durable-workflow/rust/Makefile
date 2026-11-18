.PHONY: build test fmt fmt-check lint check

build:
	cargo build --locked

test:
	cargo test --locked

fmt:
	cargo fmt

fmt-check:
	cargo fmt --check

lint:
	cargo clippy --locked --all-targets -- -D warnings

check: fmt-check lint test
