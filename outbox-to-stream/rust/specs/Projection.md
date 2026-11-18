# Projection verification

For one record, the modeled revision equals the highest revision applied by an event or snapshot.
Duplicate delivery leaves the modeled projection unchanged.
A successful return for a subscribed record event covers its revision when identities pass validation.

## Results

| Check | Result |
|---|---|
| TLC, one record and revisions 1 through 4 | Every reachable committed state covers all processed revisions. The revision never decreases. |
| TLC, revision predicate removed | A later delivery restores an older revision. The corresponding SQL mutation fails the SQLite trace test. |
| TLC, two revisions and two candidate identities | Identity validation preserves revision coverage after each successful handler return. |
| TLC, model of the consumer from commit `25a0ac9` | A reused key suppresses a distinct revision. The regression test fails on this commit. |
| TLC trace replay | Both observed SQLite traces passed. Projection has six states. Identity validation has four states. |
| Lean 4 | Induction proves the maximum-revision property for arbitrary finite event and snapshot histories. The axiom audit passes. |

The Lean project also proves duplicate idempotence, canonical-key agreement, and the pre-fix counterexample.
The agreement theorem shows that adding the revision predicate preserves any step that already kept the revision monotone.
Two independent model reviews identified the missing canonical ID check in the original handler.
The Rust regression now rejects revision 2 under revision 1's ID and subsequently accepts the canonical event.

A separate SQLite regression found that dead-letter replay appended the failed event to the shared stream.
Redrive now restores its original bytes only to the owning group's pending entries.
The regression includes trimming the original entry before redrive.

## Correspondence and bounds

One transition represents a committed SQLite projection transaction for one record.
SQLite serializes concurrent writers. The model therefore explores all orders of those commits.
A rollback or rejected envelope leaves the projected state unchanged.
The model permits arbitrary snapshot revisions, including schedules SQLite may exclude.
The reversed-event counterexample uses two genuine producer events.

The trace test observes the stored revision, processed IDs and status after delivery and snapshot operations.
The revision model represents processed canonical IDs by their revision for a single source and record.
The checker compares both language fixtures with the JSON fixture exercised by the Rust test.
The Rust test closes and reopens the projection between delivery and bootstrap.

The producer assigns immutable content to each record revision and retains its revision counter.
The SQL proof correspondence assumes that applications use these transactions and preserve the deduplication tables.
A matching ID alone cannot authenticate the message or detect conflicting content under the same canonical ID.

The formal claims concern the projection and identity models. Database engine durability, HTTP receiver behavior, and eventual delivery require separate assumptions.
Rust tests exercise transaction rollback, concurrent relay claims, lease expiry, stale completions, retry exhaustion, retention, and group-scoped redrive.
The CLI test exercises the crash between HTTP receipt and durable completion. Permanent outages can stop progress.

## Reproduce

Run the following from the Rust crate.

```sh
./specs/check.sh
./specs/regressions.sh
```

The first script checks the SQLite trace, TLC expectations, Lean theorems, and allowed axioms.
Set `TLA2TOOLS` to the path of the TLC JAR if it differs from the runner default.
Set `JAVA` when the runner needs a specific Java executable.
The second script runs both confirmed regressions against the original implementation in a temporary directory.
It also removes the revision guard in a disposable copy and checks the expected failure.

Verified with Rust 1.99.1, TLC 2.19, OpenJDK 27.0.1, and Lean 4.24.0.
