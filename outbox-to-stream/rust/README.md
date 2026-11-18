# Rust outbox to stream

This reference implementation publishes committed record changes to two independent consumers.
The projection stores current record status. The jobs consumer creates one webhook job per event.

## Run locally

Build the binary and initialize a fresh directory from this crate.

```sh
cargo build --locked
run=./target/debug/outbox-stream
data=$(mktemp -d)
"$run" "$data" init
"$run" "$data" relay &
"$run" "$data" consume projection view-1 &
"$run" "$data" consume jobs jobs-1 &
"$run" "$data" update example active request-1
"$run" "$data" status
```

Keep the same directory across restarts. Scope each directory to one environment and one records producer.
Each update creates a revision. The request ID provides correlation. Retrying the business command creates another revision.

The optional `worker URL` process posts queued jobs to the configured destination using curl.
The first worker binds its destination to the jobs database. Use a URL without embedded credentials.
The receiver must retain the supplied `Idempotency-Key` throughout its retry and recovery window.
An ambiguous HTTP result can cause another POST. After twelve failed sends, the job enters `REVIEW` for reconciliation.
The jobs table records attempts, state, due time, and delivery key.

## Storage and recovery

| Store | Transaction boundary |
|---|---|
| `producer.db` | A record revision commits with its serialized event. Each relay claims due rows in a short write transaction. |
| `stream.db` | Each append commits independently. Each group advances its cursor and registers pending work together. |
| `projection.db` | The processed key and conditional revision update commit together. |
| `jobs.db` | The processed key and webhook job commit together. The worker sends HTTP outside the transaction. |

Use a local filesystem with SQLite locking and WAL support. SQLite serializes writers per file.
The relay polls every two seconds while idle. Replicas use bounded batches, claim tokens, and two-minute leases.
The delivery loop gives both recovery and new work a turn. Each delivery has a five-minute lease.
An explicit handler failure becomes eligible again after 30 seconds. Six recorded failures produce a group-specific dead letter.

Start the projection consumer to bootstrap from existing records. Bootstrap reads the stream position before taking the producer snapshot.
It commits the projection before advancing the group cursor. A repeated snapshot or delivery keeps the highest committed revision.
The jobs group starts at the oldest retained entry. Historical side effects require retained events.

| Command after the data directory | Action |
|---|---|
| `status` | Show undelivered rows, given-up rows, group positions, unread age, pending counts, dead letters, and history gaps. |
| `maintain` | Run one cleanup batch. Schedule this command under one retention owner. The default window is seven days. |
| `replay EVENT` | Queue a retained sent or given-up row using its original ID and bytes. Both consumers retain processed keys. |
| `redrive GROUP ENTRY` | Retry a retained dead letter in its owning group after resolving the handler failure. |
| `bootstrap` | Restore current projection state, including records whose events have expired. |
| `resume-reconciled GROUP TRIMMED_THROUGH` | Resume after reconciling a reported history gap. The supplied trim boundary must still match. |

An unread gap stops the consumer. For jobs, reconcile missing effects using retained outbox rows and delivery history.
Report any unrecoverable interval before advancing the cursor. Losing the jobs database also loses destination idempotency keys.
Restore that database with its processed keys before redriving external work.

## Verify

```sh
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

The CLI integration test kills a webhook worker after receipt and checks the retry against a local HTTP receiver.
