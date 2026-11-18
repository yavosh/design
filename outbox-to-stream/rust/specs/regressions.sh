#!/usr/bin/env bash
# Run the same SQLite regressions against the first implementation and current code.
set -eu
cd "$(dirname "$0")/.."
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
git -C ../.. archive 25a0ac9:outbox-to-stream/rust | tar -x -C "$scratch"
python3 - "$scratch" <<'PY'
from pathlib import Path
import sys
source = Path("tests/pipeline.rs").read_text()
parts = source.split("#[test]")
tests = ("fn six_handler_failures", "fn conflicting_event_identity")
Path(sys.argv[1], "tests/pipeline.rs").write_text(
    parts[0] + "".join("#[test]" + p for p in parts[1:] if p.lstrip().startswith(tests)))
PY
check_failure() {
    if cargo test --locked --manifest-path "$scratch/Cargo.toml" "$1" >"$scratch/run.log" 2>&1; then
        echo "Expected $1 to fail" >&2
        exit 1
    fi
    grep -F "$2" "$scratch/run.log"
}
check_failure conflicting_event_identity "accepted revision 2 under revision 1's identity"
check_failure six_handler_failures "redrive leaked into other groups"
# A separate negative control removes only the revision predicate in a disposable copy.
cp src/*.rs src/*.sql "$scratch/src/"
cp tests/pipeline.rs "$scratch/tests/"
cp specs/*.json "$scratch/specs/"
python3 - "$scratch/src/consumer.rs" <<'PYTHON'
from pathlib import Path
import sys
file = Path(sys.argv[1])
source = file.read_text()
guard = "WHERE excluded.revision>projection.revision"
assert source.count(guard) == 1
file.write_text(source.replace(guard, ""))
PYTHON
check_failure projection_trace_matches_proof_fixture "late event restored an older revision"
cargo test --locked --test pipeline
