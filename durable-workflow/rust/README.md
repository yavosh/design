# Rust durable workflow engine

Run the playbook’s account onboarding flow with a local SQLite database. Workers claim due steps, invoke activities, and record outcomes. Instances keep their published definition version across restarts.

## Run

From this crate, build the CLI and start a workflow in a fresh directory.

```sh
make build
run=./target/debug/durable-workflow
data=$(mktemp -d)
"$run" "$data" init
draft=$("$run" "$data" draft onboarding designer)
"$run" "$data" submit "$draft" designer
"$run" "$data" approve "$draft" reviewer
instance=$("$run" "$data" start onboarding account example '{"review":true,"import":true}')
"$run" "$data" worker 4 &
worker_pid=$!
"$run" "$data" status "$instance"
"$run" "$data" audit "$instance"
```

Poll `status` until the instance completes. Send `kill -TERM "$worker_pid"` to drain and stop this worker. Use the same directory to resume work.

| Command after the data directory | Purpose |
|---|---|
| `worker 4 REVIEW WORKSPACE` | Run up to four activities on the listed stages. Omitting stages hosts all registered activities. |
| `coverage` | List stages missing a live worker, including stages needed by active instances on older definitions. |
| `metrics` | Inspect overdue work, progress age, and audit counts by step and outcome. Workers log dispatch durations to stderr. |
| `retry INSTANCE OPERATOR` | Reset a failed step’s retry budget and resume its instance. |
| `draft NAME AUTHOR FILE` | Draft a new version from JSON. The CLI defaults to the bundled definition when FILE is omitted. |
| `edit DRAFT AUTHOR FILE` | Replace an editing draft. Submit it before approval or rejection. |
| `simulate FILE [CHOICES_JSON]` | Print a path without running activities. Optional choices map a step to its selected target. |

## Execution boundaries

`workflow.db` holds definitions, worker leases, instances, timers, and audit entries. SQLite serializes its short write transactions.
A record transaction checks the dispatch number before moving the instance. One committed record creates at most one successor.

The synthetic activities use a separate `activity.db`. Each operation saves its outcome and outbox event together.
A repeated invocation returns the saved route and payload. Events stay available for a separate delivery service.
External activities must supply their own locking, destination idempotency, or reconciliation.

The CLI selects a definition by explicit key. Author, reviewer, and operator arguments represent trusted caller identities.
The library accepts an injected scheduling clock. Publication timestamps, audit entries, and worker leases use the database clock.
After the step deadline, workers signal cancellation and wait two seconds. An unresponsive activity terminates its worker with exit code 70.

Run `make check` for formatting, Clippy, and Rust integration tests. Tests include process termination after a business commit and during cancellation.
