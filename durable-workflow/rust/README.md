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
instance=$("$run" "$data" start onboarding account example '{"review":true,"import":true}' --request-key signup-42)
"$run" "$data" worker 4 &
worker_pid=$!
"$run" "$data" status "$instance"
"$run" "$data" audit "$instance"
```

Poll `status` until the instance completes. Send `kill -TERM "$worker_pid"` to drain and stop this worker. Use the same directory to resume work.

Reuse the request key after a lost response. An identical start returns the original instance ID, even after you publish a new version.
Keys are unique across workflows in the same database. Reusing a key with different start arguments fails. Omit the key to start a separate run.

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

Back up and restore both databases from the same point in time. Stop workers and clients before taking both snapshots.
New runs carry a random ID. If a restored instance encounters another run's saved result, the activity fails.
When upgrading, stop old workers and run `init` on the existing data directory to add the request-key index.
Existing runs keep their original event IDs. New events use `<runId>:<step>`.
During a restore drill, match each completed step to its operation and event. Check the run ID and entity before restarting workers.

Workers retry busy claims. If a write lock blocks the result, the worker logs `record_deferred` and the lease schedules recovery.
A committed failure emits `step_failed` on stderr. Match its `runId`, step, and dispatch number to the audit.
Older runs show a null `runId`. Use their instance number within a matched backup.
Custom activities should return operator-safe reasons in `Retry` and `Failed`. Raw exception text can contain input data.

The CLI selects a definition by explicit key. Author, reviewer, and operator arguments represent trusted caller identities.
The library accepts an injected scheduling clock. Publication timestamps, audit entries, and worker leases use the database clock.
After the step deadline, workers signal cancellation and wait two seconds. An unresponsive activity terminates its worker with exit code 70.

Run `make check` for formatting, Clippy, and Rust integration tests. Tests include process termination after a business commit and during cancellation.
