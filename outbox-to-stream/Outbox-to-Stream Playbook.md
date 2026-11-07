Contents

- [Why an outbox](#why)
- [The pipeline](#pipeline)
- [Producer](#producer)
- [Relay](#relay)
- [Envelope](#envelope)
- [Streams](#streams)
- [Consumers](#consumers)
- [Retention](#retention)
- [Failure modes](#failures)
- [Observability](#observe)
- [Adopting it](#adopt)
- [Traps](#common-traps)

# Outbox-to-Stream Playbook

This note explains how services share facts through a transactional outbox and a durable stream broker. Each change commits together with its event. A relay copies the event to a stream. Every interested service applies the event once in its own database, even when the stream delivers it twice.

The examples use language-neutral pseudocode and data structures. Adapt transaction, locking, and broker operations to your platform. Timings, batch sizes, and retry limits are example settings.

Atomic

An event exists if and only if the change it describes committed.

At least once

Committed events reach each consumer group at least once within the configured retention and recovery bounds. Events marked `GIVEN_UP` require operator recovery.

Effect once

Consumers deduplicate on the event id, so a duplicate changes nothing while deduplication evidence remains available.

Independent

Each consuming service keeps its own read position and fails on its own.

Loosely ordered

Best-effort order per stream. Nothing may depend on strict order.

Durable

Unsent events remain in the producer's database. After publishing, recovery depends on broker retention and retained outbox rows.

With the example settings, automatic publishing stops after about 7 hours of continuous failure. Sent outbox rows remain available for replay for 7 days after publishing. A consumer outage beyond stream retention can cause permanent loss if no retained copy remains.

## Why the event lives in the database first

A service that changes state and then tells other services about it makes two writes: one to its database and one to the broker. No transaction spans both, so a crash or an outage between them leaves the two disagreeing.

- **Publish after commit.** The process can die, or the broker can be down, right after the commit. The change stands and the event is gone, silently and for good.
- **Publish before commit.** The commit can fail after the event went out. Consumers act on a change that never happened.

Publishing from cleanup code has the same problem. A broker outage can lose events and leave only an error log. For example, a lost payment event can prevent a webhook, omit a ledger entry, and undercount risk metrics.

The transactional outbox fixes this. The event becomes a row in the same database and the same transaction as the change. Delivering that row to the broker becomes a separate job that can retry for as long as it needs to.

Principle

The database is the source of truth and the stream is transport. An event reports a fact that has already committed. Consumers keep their own copies of what they need.

## The pipeline, end to end

The only step that touches two systems is the relay's append, and it can safely repeat. Every consumer group reads every entry at its own pace and deduplicates in its own database.

1. **Write.** The request handler updates business rows and inserts one outbox row per event, in one transaction. The row holds the fully serialized event. Where supported, register a database notification in that transaction to wake the relay after commit.
2. **Claim.** A relay runs on every replica of the producer. It atomically claims a batch of due rows, skipping rows locked by other replicas. Each claim has a short lease.
3. **Publish.** The relay appends each row's stored bytes to the stream, unchanged, and then marks the row sent.
4. **Fan out.** Each consuming service reads the stream through its own consumer group, so every group sees every event.
5. **Apply.** The consumer applies the event in its own database, keyed so that a second copy does nothing. It acknowledges the entry only after that write succeeds.
6. **Hand off slow work.** When the effect is an external call, such as an HTTP webhook, the consumer only inserts a job row. A separate worker with its own retry schedule makes the call. One slow merchant endpoint can't stall the stream, and you get a delivery history you can query.

## Producer: writing the outbox row

### Publish only inside a transaction

The publish operation requires an active transaction and fails if there is none. Rejecting calls outside a transaction prevents accidental publishing without a durable record.

The insert shares the transaction's fate. If it fails, the business change fails too. Don't catch the error and continue. An event you can't record is as serious as a change you can't record.

Put the decision about whether to emit inside the operation that builds the event. For example, a payment event may require a terminal status. Validate that requirement before recording the event.

### Serialize once, send the stored bytes

Build and serialize the complete envelope at publish time, store it in the row, and have the relay send those exact bytes. This is the detail the rest of the design depends on. If the relay rebuilt the envelope at send time, three things would break:

- An event without a natural key would get a new random id on every retry. Consumers couldn't deduplicate it, and a merchant would receive the same webhook twice.
- The timestamp would become the relay's clock instead of the moment of the change.
- The request id that ties the event to the original request would be lost.

### The table

| Field | Meaning |
| --- | --- |
| `id` | Unique row identifier; the primary key. |
| `event_id` | Stable event identifier used by consumers for deduplication. |
| `aggregate_id` | Optional business identifier for queries and replay. |
| `stream` | Destination stream. |
| `event_type` | Stable event type name. |
| `schema_version` | Payload version number. |
| `payload` | Complete serialized envelope, sent unchanged. |
| `status` | One of `PENDING`, `IN_PROGRESS`, `SENT`, or `GIVEN_UP`; defaults to `PENDING`. |
| `attempts` | Failed publish count; defaults to zero. |
| `next_attempt_at` | Next eligible time, or lease expiry while `IN_PROGRESS`; defaults to the current time. |
| `claim_token` | Unique token generated for each claim; identifies the current relay attempt. |
| `last_error` | Optional error category, without payload content. |
| `stream_entry_id` | Optional broker entry identifier, recorded after publishing. |
| `created_at` | Row creation time in UTC. |
| `sent_at` | Optional successful publish time in UTC. |

- Each service owns its outbox table and migrations. Configure the publisher and relay to use that table.
- Enforce required fields and allowed status values with database constraints.
- Index due rows by `next_attempt_at` and sent rows by `sent_at`. Adapt index definitions to your database.

### No dual publishing

Move a producer from direct publishing to the outbox in one release. Running both paths at once doubles every event, and any consumer that isn't idempotent yet will double-count.

## Relay: from table to stream

Every outbox row moves through these four states. Only SENT rows are ever deleted. GIVEN_UP rows stay until someone replays them.

### Wake on committed work

Where supported, use transactional database notifications, such as `LISTEN`/`NOTIFY`, to wake the relay promptly. Register the notification in the same transaction as the business change and outbox insert. The database delivers it only after commit. A rollback delivers no notification.

Treat each notification as a hint that due work may exist. Keep event payloads in the outbox. Always use the same row-claiming path, whether a notification or a timer wakes the relay. Coalesce repeated wakeups while the relay is already running, and preserve a pending wakeup until it checks for work again.

At startup or after reconnecting, establish and commit the listener registration before scanning the outbox in a separate transaction. Keep listener transactions short, so notification delivery is not delayed. Monitor notification queue capacity; a full queue can fail a transaction that registers a notification.

Keep a fallback scan, for example every 2 seconds. It recovers missed notifications, disconnected listeners, expired leases, and retries that become due without a new insert. Scan at startup even if no notification arrives. Notifications improve normal delivery latency; durable rows and fallback scans preserve recovery. Databases without transactional notifications can use polling alone.

### Claim with a lease

```text
Begin a database transaction.
Select up to 100 rows with status PENDING or IN_PROGRESS and next_attempt_at at or before the current time.
Order by next_attempt_at and lock the selected rows, skipping rows locked by other transactions.
Set the selected rows to IN_PROGRESS with next_attempt_at two minutes in the future.
Assign each selected row a fresh claim_token.
Read the selected rows, including their stored payloads and claim tokens.
Commit the transaction.
Publish each stored payload outside the transaction.
```

- Keep the claim transaction short. For example, set a 5-second timeout. Publish after it commits, so no database lock spans a network call.
- The lease is just `next_attempt_at` pushed into the future. If a relay dies holding rows, they become due again when the lease runs out. You don't need a separate reaper job.
- Verify that the database claims only the selected rows. Query planning and locking behavior vary across databases.

### Finish with a guarded update

```text
Update the row only if its id and claim_token match the attempt and its status is IN_PROGRESS.
Set status to SENT, sent_at to the current time, and stream_entry_id to the broker entry identifier.
If no row changed, leave its current state unchanged.
```

Require the current claim token for every success, failure, and lease-renewal update. Reclaiming a row replaces its token, so a previous attempt cannot overwrite the new claim. A status check alone cannot distinguish those attempts.

The token protects database state. It cannot stop duplicate publishing. If a lease expires during a slow send, another relay may publish the same event. Consumers must handle those duplicates.

### Retries and giving up

- `attempts` counts failed publishes. Increment it when publishing fails, never when a row is claimed. Otherwise a relay that crashes repeatedly uses up the budget without a single real attempt.
- Back off with a step table: 5 s, 30 s, 2 min, 10 min, 1 h, and then 1 h again for each later failure. On the 12th failure the row becomes `GIVEN_UP`. With these numbers a row survives about 7 hours of continuous broker outage. Size the table to your longest plausible outage.
- Failures stay with their row. The relay resolves the stream name at send time, so a row it can't interpret fails alone and doesn't block the rest of the batch.
- Store an error category in `last_error`, without the message, because messages can echo payload content. Redact sensitive values from diagnostic logs.
- Keep `GIVEN_UP` rows forever and alert on them. Before replaying, verify that consumers retain the required deduplication evidence. Reset the row to `PENDING`, with `attempts = 0` and `next_attempt_at` set to the current time. Clear its claim token. Replay its original event id and stored payload. Unlimited replay requires permanent deduplication evidence.

### Every replica, no leader

Every replica runs the relay. Database row locks split the work, so no leader election or separate distributed lock is needed. Notifications and fallback scans trigger the same bounded draining process.

### Drain due work within a budget

On each wakeup, claim and publish batches while due work remains and the execution budget allows it. For example, allow at most 10 batches of 100 rows and a configurable time budget per run. Bound publish calls with timeouts. Stop claiming new batches when either budget is exhausted, then finish any bounded in-flight work.

Do not sleep between batches while due work remains and the budget permits another batch. When no due rows remain, wait for a notification or the next fallback scan. If the budget expires while work remains, yield and schedule a prompt continuation. Do not wait for the full polling interval merely because the batch limit was reached. Claim only due rows, so frequent wakeups cannot bypass retry backoff or active leases.

A setting can switch off the relay but never the publishing. With the relay off, events pile up safely in the table and drain when you turn it back on. That makes the relay a one-switch rollback.

A separate job deletes `SENT` rows 7 days after publishing, 1000 at a time. Broker recovery can replay only rows that remain available. Align this window with the recovery commitment and consumer deduplication retention.

## Envelope: the shape of every event

This JSON example illustrates the fields. Choose a serialization format that every producer and consumer supports.

```json
{
  "eventId": "6f1c0d3e-2b7a-3c51-9a7e-1d4b8c2f9e10",
  "type": "PaymentExecuted",
  "createdAt": "2026-11-06T09:41:27.512Z",
  "schemaVersion": 4,
  "source": "payments",
  "environment": "stage",
  "requestId": "c0a8017e-5f3b-4e1d-9b2a-7d6e5f4c3b2a",
  "headers": { "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
  "payload": { "paymentId": "…", "status": "APPROVED", "amount": 10050, "currency": "EUR" }
}
```

| Field | Rule |
| --- | --- |
| `eventId` | Derived from a natural key when the event has one, otherwise a random time-ordered UUID. Consumers deduplicate on it. |
| `type` | A stable string per event type. Consumers route on it. |
| `createdAt` | UTC instant at publish time, which is inside the business transaction. |
| `schemaVersion` | Version of the payload shape. |
| `source` | The producing service. |
| `environment` | The deployment environment. It's also part of the stream key. |
| `requestId` | Correlation id of the originating request. Consumers copy it into their log context. |
| `headers` | The W3C `traceparent` and nothing else. |
| `payload` | The event record: identifiers, amounts, statuses and masked values. |

### Deterministic ids

An event that describes a unique fact gets an id derived from that fact. For example, derive a name-based UUID from `PaymentExecuted:<paymentId>:<status>`. If a recovery path emits the same fact twice, both copies carry the same id and consumers keep one. Example keys:

| Event | Key |
| --- | --- |
| `PaymentExecuted` | type + payment id + terminal status |
| `PaymentRefunded` | type + refund event id |
| `RecurringCancelled` | type + payment id |
| `AuditRecorded` | type + audit id |

Choose keys carefully. Two genuinely different facts must never share one, or a consumer will drop the second.

### Versioning

Change payloads additively. Add fields, never rename or repurpose them, and have every consumer ignore fields it doesn't know. When a consumer needs a field that older events lack, it checks `schemaVersion` and handles the old shape explicitly. A minimum-version check only helps if the minimum reflects supported versions.

### Trace and log context

The publisher copies the current W3C `traceparent` into the envelope headers. Copy only `traceparent`. Callers control baggage and `tracestate`, and those would persist in rows and streams. The consumer opens its span as a child of that context, so a trace shows the time in the queue as the gap between the producer's span and the consumer's. The consumer also sets `requestId` in its log context for each message and clears it afterwards.

### What a payload may carry

An event persists in the outbox table, the stream, the dead-letter stream and every consumer's database. Treat a payload like a log line: identifiers, amounts, statuses and masked values only. Never put secrets, full card numbers or credentials in an event.

## Streams and naming

Use one stream per producing domain, such as payments or audit. Define each consumer group's subscribed types explicitly. Consumers route on `type` and acknowledge genuinely unrelated types.

Do not acknowledge subscribed but unsupported types as unrelated. Retain them for retry or write them durably to a dead-letter stream before acknowledging them. Apply the same rule to unsupported versions of subscribed types. Deploy compatible consumers before producers emit new subscribed types. During rolling upgrades, every instance that can receive a type must support it or preserve it for recovery.

The stream key includes the environment, as in `<prefix>:events:<env>:<domain>`, with a `…:dlq` sibling for dead letters.

Trap

A service started with the wrong environment name publishes to, and reads from, keys that no other service uses. Nothing errors. Events simply stop arriving. Derive the environment from one variable that every service shares, and alert when a stream that normally has traffic goes quiet.

### Ordering

Order is best-effort first-in, first-out per stream. A row waiting for a retry can be overtaken by newer rows, including events for the same business entity. Use this design only when consumers tolerate that reordering.

If an event type needs strict order per aggregate, this relay won't provide it. One in-flight row per aggregate is insufficient: newer rows can still overtake older rows awaiting retry.

An ordered extension needs a stable per-aggregate sequence. Older unresolved events must block newer events for that aggregate, including during backoff. The extension must also prevent stale publishers from breaking order and preserve order during consumer processing. These requirements apply only to that extension. The base design continues to allow reordering.

## Consumers: apply once, acknowledge after

An entry is acknowledged only after the handler returns. A failed entry stays unacknowledged and is retried, either by the same consumer or by another one once it has sat idle for 5 minutes.

### Groups and names

- Each consuming service has one consumer group per stream it reads. Groups are independent: each keeps its own position and its own list of unacknowledged entries. Adding a group never affects the others.
- Each instance is a named consumer inside the group. Use a distinct instance identifier. A restarted instance can recover pending entries if it retains that identifier.
- Configure a new group to start at the oldest retained entry. Its first deployment can replay a full retention window, such as 7 days. Make sure the handler is idempotent and handles old events before deployment.
- Ensure the stream exists before consumption. Use the broker's stream and group initialization operations.

### Three loops per consumer

| Loop | Schedule | What it does |
| --- | --- | --- |
| Read new | Every 200 ms, blocking up to 2 s, 100 entries | Reads entries this group has never received. |
| Recover own | Every 30 s | Re-reads this consumer's unacknowledged entries and retries them. |
| Claim orphans | Every 5 min | Takes over entries another consumer has held for more than 5 minutes, usually after an instance failed. |

The loops share one permit per instance, so a consumer handles one entry at a time. Guarantee due recovery work a turn within a configured maximum interval. Before starting another read, check whether recovery or orphan claiming is due. Bound read and handler execution times so they cannot hold the permit indefinitely. Use an explicit retry schedule to space repeated failures. To raise throughput, add instances. The group splits entries across them.

### Failures and dead letters

If the handler fails, the entry stays unacknowledged and its retry counter increases. Persist the counter by stream, group, and entry id, using broker metadata or a durable retry store. Retain retry state for at least the recovery window. For example, on the sixth failure, copy the entry to the dead-letter stream before acknowledging it. Handle duplicate dead letters safely. An entry that can't be parsed takes the same path.

### Idempotency is the contract

Contract

Every consumer of an outbox-backed stream, now or later, must produce the same result whether it sees an event once or several times. Test it directly: deliver the same envelope twice and assert a single effect.

Define the replay horizon for each event type. Retain deduplication evidence for every permitted stream redelivery, outbox replay, and dead-letter replay. If replay has no time limit, retain that evidence permanently. Reject or reconcile older replays when the evidence is unavailable. A stable event id alone cannot prevent a repeated effect after its deduplication evidence expires.

Four patterns support idempotent processing:

| Pattern | How | Example use |
| --- | --- | --- |
| Insert or ignore | Unique key on (target, eventId). Insert, and do nothing on conflict. | Webhook jobs keyed by (endpoint, eventId). Audit rows keyed by audit id. |
| Keyed upsert | Unique key on (businessId, eventId, kind). A repeat overwrites with the same values. | The merchant transaction ledger. |
| Processed-keys claim | In the same transaction as the effect, insert the event key into a processed-keys table. Skip the effect if that insert did nothing. | Daily refund-ratio counters, where a second increment is wrong. |
| Recompute | A scheduled job rebuilds the aggregate from source tables and overwrites it. | Nightly backstop for the same counters. |

Don't copy

A counter that adds each event's amount without a deduplication key counts redelivered events twice. Use the processed-keys claim for counters.

### Keep external calls out of the consumer

A consumer should write only to its own database. When the effect is a call to another system, insert a job row and let a separate worker make the call. Give that worker a retry schedule suited to the destination, independent of stream retries.

One local job does not guarantee one external effect. A worker can crash after the destination accepts a request but before recording success. Its retry can repeat the external action. Use a stable destination idempotency key for every retry of the same job, where supported. Ensure the destination retains that key throughout the retry window. Otherwise, document possible duplicate delivery and define reconciliation for ambiguous outcomes.

### Second use: the audit trail

Services can record staff and system actions through the same outbox, on an audit stream. A consumer writes them to a central audit table keyed on the audit id. Each record commits with its business change, so a rolled-back action leaves no committed-action audit entry. The recorder reads the actor from the request context to keep attribution consistent. Move old rows to an archive table in one database transaction, so a row is never missing from both tables.

Archiving must preserve deduplication evidence. A unique key only in the live table cannot reject an event whose original row has moved to the archive. Retain a separate processed-key record or enforce equivalent uniqueness across live and archived records.

## Retention and housekeeping

- Exactly one service owns trimming for each stream. Trimming is separate from the outbox, so a service that only consumes can own it.
- Trim by time: remove entries older than the retention window, such as 7 days. Use efficient retention operations supported by the broker. Never trim past the oldest unacknowledged entry of any group.
- Trim dead-letter streams by time only.
- If the broker retains consumer registrations, remove idle consumers only when they hold no pending entries.

Trap

The trim floor protects entries a group has read and not yet acknowledged. It doesn't protect entries a group has never read. A group that stays offline longer than the retention window silently loses events. Keep retention longer than any consumer outage you would tolerate, and alert on group lag.

Set explicit outage and replay bounds for each consumer group. Recovery must report any gap that exceeds the available stream and outbox history. A 7-day outbox window cannot recover every event from an outage longer than 7 days.

## What happens when something fails

| Failure | Result | How you see it |
| --- | --- | --- |
| Producer crashes before commit | No change and no event. | Nothing to see. |
| Notification missed or listener disconnected | The committed outbox row remains available. A fallback scan or reconnection scan finds it. | Listener health and oldest-pending age. |
| Broker down when the relay publishes | Rows back off and retry, and delivery resumes on recovery. After about 7 hours a row gives up. | Backlog and oldest-pending age climb. Failed-publish counter rises. |
| Relay crashes after publishing, before marking SENT | The lease expires after 2 minutes and the row is published again with the same id. | A duplicate on the stream, which consumers ignore. |
| Lease expires during a slow send | Two relays may publish the row. Claim-token guards reject stale state updates. | Log line saying the claim no longer matches. |
| Consumer instance fails mid-event | The entry stays unacknowledged. The restarted instance retries it, or another instance claims it after 5 minutes. | Consume lag spikes, then recovers. |
| Handler fails every time | After six failures the entry goes to the dead-letter stream and is acknowledged. | Dead-letter counter. |
| Group offline longer than retention | Unread entries are trimmed and lost for that group. | Group lag. Replay retained outbox rows with valid deduplication evidence. Report any unrecoverable gap. |
| Broker loses its data | Entries already marked SENT but not yet consumed are gone. | Replay retained outbox rows with their original ids after verifying deduplication evidence. Report gaps in retained history. |
| Twelve failed publishes for one row | The row becomes GIVEN_UP and stays in the table. | Given-up alert. Replay by hand. |

## What to measure

| Metric | Meaning |
| --- | --- |
| Producer |  |
| `outbox.oldest_pending_age` | Seconds since the oldest undelivered row was written. Your main alert. |
| `outbox.backlog` | Rows due for delivery. |
| `outbox.published`, `failed`, `given_up` | Counters by stream and event type. |
| `outbox.dwell` | Time from write to publish, as a histogram. |
| `outbox.relay.duration` | Time to send one batch. |
| Consumer |  |
| `stream.messages.processed`, `failed` | Counters by stream and group. |
| `stream.consume.lag` | Now minus the entry's broker timestamp. |
| `stream.messages.dlq` | Entries moved to a dead-letter stream. |
| Broker |  |
| `stream.length`, `memory`, `first_entry.age` | Per stream and per dead-letter stream. |
| `stream.trimmed` | Entries removed by retention. |

Alert on any given-up row, on an oldest-pending age above a few minutes, on any dead letter, on growing consumer lag, and on a first-entry age well past retention, which means trimming has stopped.

- Refresh gauges on their own timer from cached values. Counting outbox rows on every metrics scrape adds database load.
- Exclude the polling loops from tracing. Otherwise a loop that runs every 200 ms creates a root span every 200 ms.

## Adopting it in your project

### What your platform needs

- A database that commits business changes and outbox rows atomically, with a concurrency-safe method for claiming due rows.
- A broker with durable, append-only streams, consumer groups with independent positions, redelivery of work a dead consumer didn't finish, and retention you control.
- Services that wrap their business writes in transactions.

Offset-based brokers

With a partitioned log that tracks committed offsets instead of per-entry acknowledgements, the consumer side changes shape. Commit the offset after the handler succeeds, and a rebalance redelivers whatever wasn't committed. Use a retry or dead-letter topic instead of a per-entry counter. Message keys give order within a partition, but relay retries can still reorder events. The producer side stays exactly the same.

### Build order

1. **Shared contracts and components.** Define the envelope and transaction requirements. Provide reusable publishing, relay, consumption, dead-letter, retention, and metrics components for each implementation language.
2. **Producers.** Add the outbox table through each producing service's migrations. Configure its publisher and relay.
3. **Events.** One immutable record per fact, with a stable type string, a version and a natural key where one exists.
4. **Consumers.** Pick a dedup pattern for each consumer, and write the deliver-twice test before the handler.
5. **Retention.** Name one owner per stream, and set the window above the longest consumer outage you would tolerate.
6. **Dashboards and alerts.** Set them up from the list above before production traffic arrives.
7. **Cutover.** Deploy consumers that support new subscribed event types before producers emit them. Replace direct publishing with the outbox in one release, with no period of dual publishing.

### Design choices

- **No exactly-once delivery.** Use at-least-once delivery and idempotent consumers within the stated retention and recovery bounds. Recovery beyond retained history is not guaranteed.
- **No strict ordering.** Consumers must tolerate reordering. Strict ordering requires additional coordination.
- **No leader election.** Row locks already split the relay's work.
- **No event sourcing.** Tables hold the state. Events tell other services that the state changed.
- **Delivery latency.** Transactional notifications wake the relay after commit. Missed notifications fall back to periodic scans, every 2 seconds in this example. Backlogs, retries, and scheduling add further delay. Bounded draining avoids a fixed sleep between batches while due work remains.

## Common traps

Rebuilding the envelope in the relay

Each retry gets a new id, and merchants receive duplicate webhooks.

Counting attempts at claim time

A relay that crash-loops burns the retry budget without a single real failure.

Claiming more rows than intended

Verify batch limits and locking behavior under concurrency using your database's transaction semantics.

A stream with a producer and no consumer

It grows until retention removes entries. Assign a retention owner even when a stream has no consumers.

A version gate fixed at 1

It looks like protection and rejects nothing.

Error messages in rows or logs

Error messages can echo payload data. Redact diagnostic logs, including failures while writing dead letters.

A scheduler pool that's too small

The relay, consumer loops, retention tasks, and gauges can starve each other when execution capacity is too small. Provision capacity so blocking reads don't delay recovery or maintenance.

A new group meeting old events

Its first deployment replays the whole retention window, which surprises a handler that assumed fresh data.

