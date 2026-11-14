Contents

- [Why an engine](#why-the-engine-owns-durability)
- [One step run](#one-step-run-claim-work-record)
- [Outcomes](#outcomes-what-a-handler-can-return)
- [Step timeout](#step-timeout)
- [Instances](#instances-one-flow-over-one-entity)
- [Dispatch](#dispatch-the-step-row-is-the-queue)
- [Worker groups](#worker-groups-and-concurrency)
- [Worker registry](#worker-registry-and-stage-coverage)
- [Definitions](#definitions-the-flow-as-data)
- [A flow, step by step](#a-flow-step-by-step)
- [Tables](#the-tables)
- [Failure modes](#what-happens-when-something-fails)
- [Observability](#what-to-measure)
- [Adopting it](#adopting-it-in-your-project)
- [Traps](#common-traps)

# Durable Workflow Engine Playbook

This note explains how a service runs a multi-step process durably on a relational database. A process is a fixed pipeline of stages, and each stage has one or more steps. The engine owns retries, timers, serial execution, and the move from one step to the next. A step holds the business rule and little else.

The examples use language-neutral pseudocode and data structures. Adapt transactions, locks, and timers to your platform. Attempt limits, delays, and lease lengths are example settings.

A step communicates with other services, other systems, and other workflows by emitting events. Event delivery is out of scope here. The [Outbox-to-Stream Playbook](https://yavosh.github.io/design/eda/guide/) describes one way to deliver them.

Durable

A step runs until it reaches a terminal outcome or exhausts its retry budget. Retries survive process restarts.

At least once

The engine invokes each step at least once per instance. A crash or a lost engine write causes a repeat invocation.

Effect once

Each handler checks whether its work is already done, so a repeat invocation changes nothing.

Atomic

A step's business writes and its emitted events commit in one transaction.

Independent

Step execution depends on no delivery mechanism. A delivery outage delays events and never stops a flow.

The engine is entity-agnostic. It stores an entity kind and an opaque entity id, and it never reads the entity itself.

## Why the engine owns durability

In a traditional system, each service coordinates the work itself. One handler holds the business rule, the retry logic, and the knowledge of what runs next. Three concerns share one piece of code.

- **Sequencing.** Each handler publishes the event that starts the next one. The route is written down nowhere. To insert a stage, reorder two stages, or reuse a step, you edit several services.
- **Retry.** Each stage implements its own. One retries in memory and loses the retry on restart. Another keeps a hand-rolled durable timer. A third polls. "Is this retried, how often, and with what backoff" has a different answer for every stage.
- **Business logic.** The rule is the small part. The handler must also know its retry policy, its failure path, and which event advances the flow.

That coordination cost is per step, so teams bundle work to pay it once. For example, setting up a workspace creates the workspace, imports the data, and releases the name reservation in one operation. A failure in the third action can't retry without re-entering the first two. The audit trail records one step where three things happened.

Execution order has the same problem. A pipeline needs two properties that are rarely stated:

- **Serial within an instance.** The steps of one instance run strictly one at a time and never overlap.
- **Parallel across instances.** Many instances progress at once. Throughput comes from here.

An engine separates the concerns. The handler keeps the business rule. The engine takes the retry, the timers, and the sequence.

Principle

A handler is the business rule, a lock, and a completeness check. Retry, timers, serial execution, and transitions belong to the engine.

## One step run: claim, work, record

A step run uses three transactions in one process. The boundary between them is the design. CLAIM and RECORD are the engine's bookkeeping. WORK belongs to the handler.

1. **Claim.** The engine takes a due step row and marks it `RUNNING`. It increments `dispatch_count` and moves the timer forward. The count is now crash-durable.
2. **Work.** The handler takes its lock and runs a completeness check. If the work is not done, it calls the external system. Then it commits its business writes and its events in its own transaction.
3. **Record.** The engine writes the outcome, creates the next step row with its input, appends the audit entry, and updates the instance position.

```steps
Claim: one short database transaction
  Select step rows whose status is not COMPLETED or FAILED and whose next_at is before the current time.
  Keep only rows for hosted stages whose instance is ACTIVE.
  Order by next_at and lock the selected rows, skipping rows locked by other transactions.
  Set each row to RUNNING and add one to dispatch_count.
  Set next_at to the current time plus max_duration plus a grace period.
  Commit the transaction.
Work: outside the transaction
  Run each handler, up to the concurrency limit.
```

- Advancing the timer is part of the claim. Otherwise the row stays due while the handler runs, and every poll picks it up again.
- Skipping locked rows protects a row only while a transaction holds it. The claim commits before the handler starts, so the timer must carry the protection afterwards.

### Why the handler owns the work transaction

The handler owns locking and serialization. The engine can't wrap that transaction without constraining what it delegated. Events join the handler's open transaction, so they commit with the business change. There is no dual write.

Don't hold a database transaction open across the external call. Call the external system first, then open the transaction that records the result.

### Why losing a claim or a record is safe

Both are engine bookkeeping. A lost write leaves the step row non-terminal with a timer. The dispatcher re-drives the row, the completeness check returns `Done`, and the transition resolves again. Correctness never depends on the engine's own writes committing.

### Two levels of serialization

Within an instance, serialization costs nothing. One active step per instance means the steps never overlap. The handler's lock stops two concurrent deliveries of the same step. The second delivery returns `Defer`.

Some work must serialize across instances, such as items that share a resource, a batch, or a time window. The handler then locks a group key instead of the instance key. Only the handler knows what the group is, so locking belongs to the handler. The mechanism is the same: acquire the lock, or return `Defer`.

Contract

Every step that calls an external system must start with a completeness check. A lock covers concurrent double submission. Only the completeness check covers sequential double submission, because a crashed attempt releases its lock and the re-drive runs again.

### A step

```text
Step WORKSPACE/RELEASE_NAME, with at most 10 attempts and a 2-minute maximum duration.

Try to take the lock for the reserved workspace name. If the lock is busy, return Defer for 30 seconds.
Read the reservation from the external system. If the reservation is already released, return Done.
Ask the external system to release the reservation.
If the failure is transient, return Retry for 1 minute.
If the external system rejects the request, return Failed with the reason.
Begin a database transaction.
Record the release and emit the NameReleased event.
Commit the transaction.
Return Done.
```

The handler holds no retry loop, no next event to publish, and no compensation path.

## Outcomes: what a handler can return

| Outcome | Status after | Counters | `next_at` |
| --- | --- | --- | --- |
| `Done` | `COMPLETED` | Unchanged | Cleared |
| `Retry` | `PENDING` | `attempts` plus one | Now plus backoff |
| `Defer` | `PENDING` | `defer_count` plus one | Now plus delay |
| `Park` | `PARKED` | Unchanged | An absolute time |
| `Failed`, or attempts above `max_attempts` | `FAILED` | Unchanged | Cleared |

- `Done` can name a target other than the default next step. That target always carries a reason.
- `Retry` consumes the retry budget. Use it for a failure.
- `Defer` and `Park` mean "come back later without charging an attempt". Use `Defer` for contention or a dependency that isn't ready. Use `Park` for a planned wait until a known time.
- `Failed` has no target. A failed step stops the flow.

`Defer` and `Park` are mechanically the same and imply opposite things. A long park is healthy. A repeated defer is backpressure. Give them opposite alert thresholds.

### State transitions

| From | To | Cause |
| --- | --- | --- |
| None | `PENDING` | A transition creates the row. |
| `PENDING` or `PARKED` | `RUNNING` | The dispatcher claims the row. |
| `RUNNING` | `COMPLETED` | `Done`. |
| `RUNNING` | `PENDING` | `Retry` or `Defer`. |
| `RUNNING` | `PARKED` | `Park`. |
| `RUNNING` | `FAILED` | `Failed`, or the retry budget is exhausted. |
| `RUNNING` | `RUNNING` | The process died. The timer re-drives the row when it falls due. |
| `FAILED` | `PENDING` | An operator retries the step. `attempts` resets to zero. |

The engine never re-runs a terminal step. Only an operator can, and the audit log records it as their action.

Trap

`RUNNING` records that invocation began and carries no liveness. A row sits there for the length of a handler, and indefinitely after a crash. Nothing can tell the two apart. Don't branch on the status, and don't alert on time in `RUNNING`. Alert on an overdue `next_at` and a climbing `dispatch_count`.

### Payload

`Done` can carry a payload. The engine serializes it to JSON and writes it to the next step's `input_data` in the record transaction. The receiving step declares its own input type, so the engine stores no type discriminator.

Deserialization is best-effort. On failure, the engine passes the raw JSON to the handler and leaves the typed input at its default. A handler can then fall back instead of failing on a shape change.

The payload is forward-flowing input and not a result cache. Steps also receive the entity kind and id, so they can read the entity directly. Payload contents, including anything sensitive, are the handler's responsibility.

## Step timeout

Every step declares a maximum duration with its retry policy. The engine stamps both onto the row when it creates the row. Changing a policy then doesn't change the limits for work in flight.

The claim's fallback timer derives from the declared duration: `next_at` is now plus `max_duration` plus a grace period. The engine re-dispatches a step only if the step overran or its process died.

Don't copy

A fixed fallback timer re-dispatches a healthy slow step while it's still working. The new invocation blocks on the step's own lock and returns `Defer`. The cycle repeats and inflates `defer_count`, which is the signal that should mean contention.

When a step exceeds its duration, the engine stops the handler in two stages:

1. **Cancel.** The engine signals cancellation at `max_duration`. A well-behaved handler abandons its external call and returns.
2. **Abandon.** If the handler hasn't returned after a short grace period, the engine stops waiting and records a timeout.

Most runtimes can't kill a running task. A handler that ignores cancellation keeps its lock and can still commit after the engine recorded a timeout. So the escalation ends in a deliberate choice: the host process terminates. The connection drops, the database releases the lock, and the step re-drives on another node. A handler that ignores cancellation is a defect, and failing fast is the proportionate response.

A timeout consumes an attempt and behaves like a thrown error. `last_error` distinguishes a timeout from a handler-returned `Failed`.

## Instances: one flow over one entity

- **Start.** The definition declares its start step. Creating an instance creates the instance row and the first step row in one transaction.
- **Completion.** A `Done` on a declared terminal step completes the instance.
- **Failure.** A step that reaches `FAILED` fails the instance. In the same transaction, the engine terminates the instance's remaining non-terminal step row. Otherwise that row keeps its timer and is re-driven forever.
- **Guard.** The dispatcher skips any instance that isn't `ACTIVE`.
- **Recovery.** A failed step stops the flow. An operator retry resets the step to `PENDING` and returns the instance to `ACTIVE`. The flow continues from where it broke.

Each instance has one row per step. A second visit to a completed step is structurally impossible. Model legitimate re-execution as a distinct step. For example, a repeat review is its own step, not a second visit to the review step.

## Dispatch: the step row is the queue

One timer dispatcher runs as a background task in each worker process. It polls due rows, claims them, and runs each step in its own process. It publishes nothing.

Nothing is published to move a step, so there are no control messages. The timer row is the durable record and the only mechanism. Events tell other services, systems, and workflows what happened. They never move the flow itself.

The cost is a pickup latency floor of one poll interval. That is small next to retry delays measured in minutes.

`RUNNING` rows are in scope for the poll deliberately. The status carries no liveness, so a crashed step re-drives from there.

### Two clocks

The dispatcher takes the current time from an injectable clock and never from the database. A test can then advance time to fire a park or a backoff. Each node uses its own clock, so skew decides which node picks up a due timer. That is harmless at retry and park granularity.

The audit log is different. The database clock stamps its entries, so a skewed node can't file rows out of order. Scheduling needs testable time, and the audit trail needs one authoritative clock. Don't unify them.

## Worker groups and concurrency

A worker group claims a batch and runs those steps in parallel up to a configured limit. One instance stays strictly serial within itself.

By default, a process hosts every stage. A deployment can restrict a group to specific stages, and the dispatcher then filters its claim to those stages. Two reasons make that worthwhile:

- **A concurrency limit per remote system.** Each external system tolerates a different call rate. A shared pool has one limit, which is wrong for most of them. Isolating the stages that call one system gives that system its own limit. A slow remote then backs up its own workers instead of starving unrelated steps.
- **It can match an existing deployment.** If services are already split by stage, stage-restricted groups let the engine adopt that shape. Onboarding can proceed service by service.

Row locks make several groups safe against one table. Two dispatchers that claim concurrently take disjoint rows. Groups can overlap in the stages they host without double-driving a step.

Trap

A stage that no group hosts stalls with no error. Its steps sit in `PENDING` with a due timer, and nothing claims them. The configuration and the step rows both look correct. A process knows only its own stage filter, so no process can assert that the fleet covers the flow.

## Worker registry and stage coverage

A process registers itself at startup with the stages it can run, then renews a lease. A stage with no live registration is an unhosted stage. That is a query, not an inference.

- **Register what you can run.** The registration is the configured stage filter intersected with the stages that have a registered handler. A host with no filter registers the full set, so no reader has to interpret an empty list.
- **Fail the node on a missing handler.** A configured stage with no registered handler is a startup failure for that node.
- **Liveness is the lease.** A node is live while `lease_expires_at` is in the future. Don't add a status column, because it would be a second source of truth.
- **Stamp the lease with the database clock.** Many nodes write these rows, and readers compare the rows against each other. An ordinary local timer decides when to send a heartbeat.
- **Example settings.** A 60-second lease renewed every 20 seconds survives two missed heartbeats. Keep the renewal interval well under a third of the lease.
- **Re-register on a missed row.** A heartbeat that updates no row inserts a fresh one. The node then never works invisibly.
- **Separate expiry from deletion.** A reaper deletes rows expired for longer than a retention window measured in hours. A dead node stays visible while someone diagnoses it. Every node runs the reaper, and the delete is idempotent, so no leader election is needed.
- **Deregister on shutdown.** A node deletes its own row on a graceful stop, so a rolling deployment doesn't wait out a lease.

A process that only delivers events registers too, with no stages and a delivery flag. The same table then answers "is anything delivering events".

```text
Collect the distinct stages named by every current definition.
Collect the distinct stages hosted by every worker whose lease has not expired.
Report each required stage that no live worker hosts.
```

The registry never gates dispatch. A node claims work whether or not its registration succeeded. An empty or stale registry costs visibility and never throughput.

Report coverage as a metric and an alert. Don't wire it to a health probe. An unhosted stage is a fleet-level fact, and failing every node's probe restarts the fleet for a problem a restart can't fix.

## Definitions: the flow as data

Stages, steps, and entity kinds are named constants that the code maps to handlers. A definition can name only a step that the code declares. A definition that names a step the running build lacks is a hard startup failure.

Persist the names of those constants and never their ordinals. An ordinal silently re-points every stored row when someone inserts a member.

A definition declares the start step, the terminal steps, a default `next` for each step, and the alternates a handler may choose:

```json
{
  "start": "SIGNUP/NORMALISE",
  "terminals": ["WELCOME/SEND"],
  "steps": {
    "SIGNUP/NORMALISE":       { "next": "PROFILE/ENRICH" },
    "PROFILE/ENRICH":         { "next": "VERIFICATION/VERIFY", "alternates": ["SCHEDULE/PARK"] },
    "SCHEDULE/PARK":          { "next": "VERIFICATION/VERIFY" },
    "VERIFICATION/VERIFY":    { "next": "WORKSPACE/RESERVE_NAME" },
    "WORKSPACE/RESERVE_NAME": { "next": "WORKSPACE/CREATE", "alternates": ["REVIEW/REQUEST"] },
    "REVIEW/REQUEST":         { "next": "WORKSPACE/ADJUST" },
    "WORKSPACE/ADJUST":       { "next": "WORKSPACE/CREATE" },
    "WORKSPACE/CREATE":       { "next": "WORKSPACE/RELEASE_NAME", "alternates": ["WORKSPACE/IMPORT_DATA"] },
    "WORKSPACE/IMPORT_DATA":  { "next": "WORKSPACE/RELEASE_NAME" },
    "WORKSPACE/RELEASE_NAME": { "next": "WELCOME/SEND" },
    "WELCOME/SEND":           { "next": null }
  }
}
```

### Declared branches and overrides

Handler-chosen targets are unconstrained. A handler can route to a step the definition doesn't list. The record transaction resolves the target against the instance's pinned definition version and logs three cases:

| Handler returned | Target compared with default | `was_override` | Reason |
| --- | --- | --- | --- |
| `Done` with no target | Same | `false` | None |
| A declared alternate | Differs | `false` | Recorded |
| Anything else | Differs | `true` | Recorded, and mandatory by constraint |

`was_override` means undeclared, not merely different. A routine branch is the flow working as designed. If every branch set the flag, the deviation alert would fill with normal traffic and stop being read.

So "which declared branch did it take" is a comparison of the target with the default. "Did it go somewhere nobody declared" is `was_override`. Two questions, two queries.

The choice of which branch is `next` and which is an alternate is a readability decision. Put the case a reader should treat as normal on `next`.

### Versioning

Definitions are temporally versioned with `valid_from` and `valid_until`. The row with no `valid_until` is the current version. A partial unique index allows exactly one current version per key.

- Instances pin the definition key and version at creation. A flow that parks across a deployment finishes on the definition it started on.
- A validity range answers which version was live on a given date. A status column can't.
- Published versions are immutable. `valid_until` moves from empty to a value exactly once, enforced by a trigger.
- There is no future-dating. A scheduled version and a current version would both have no `valid_until`.

### Publish sequence

Run the publish in one transaction:

1. Take an advisory lock on the definition key. Don't lock the current row, because a first publish has no row to lock.
2. Reject the publish if the draft's base version doesn't match the current version. The draft is stale.
3. Reject the publish if any row for the key overlaps the new validity period.
4. Close the current row by setting `valid_until` to the current time.
5. Insert the new version with `valid_from` set to the same time. There is no gap and no overlap.
6. Mark the draft approved, with the published version and the approver.

Validate at publish time and not at execution time. A bad edit must fail for the editing user, not in production against a live entity. The gate checks three things:

- Every referenced step has a registered handler.
- Terminal targets exist and are reachable.
- Selection rules don't overlap ambiguously.

The gate also reports any referenced stage that has no live worker. Make that a warning and not a rejection. A definition can legitimately be published before the deployment that hosts its new stage.

Build-time tests can't cover a user-editable flow. Give the gate a simulator: a dry run that reports the path a synthetic entity would take.

### Drafts

Unapproved work stays out of the definition table. A draft has its own lifecycle: `EDITING`, `SUBMITTED`, then `APPROVED` or `REJECTED`. Enforce two-person approval there, where the decision happens: the approver can't be the author. Keep draft rows after the decision.

## A flow, step by step

The table follows one account whose workspace name needs a review. There is one instance, with one active step at a time.

| # | Step | Outcome | Row after |
| --- | --- | --- | --- |
| 1 | `SIGNUP/NORMALISE` | `Done` | `COMPLETED`. Next row created for `PROFILE/ENRICH`. |
| 2 | `PROFILE/ENRICH` | `Done` with no target, because the account starts now | `COMPLETED`. `VERIFICATION/VERIFY` created. |
| 3 | `VERIFICATION/VERIFY` | `Done` | `COMPLETED`. `WORKSPACE/RESERVE_NAME` created. |
| 4 | `WORKSPACE/RESERVE_NAME` | The external system queues the request, so `Retry` for 1 minute | `PENDING`, `attempts` is 1, `next_at` is 1 minute ahead. |
| 5 | `WORKSPACE/RESERVE_NAME` | Re-driven by the timer and confirmed, so `Done` with target `REVIEW/REQUEST` | `COMPLETED`. The log holds the default and the actual target. |
| 6 | `REVIEW/REQUEST` | The review is not back yet, so `Defer` for 30 seconds | `PENDING`, `defer_count` is 1, `attempts` untouched. |
| 7 | `REVIEW/REQUEST` | Review applied, so `Done` | `COMPLETED`. `WORKSPACE/ADJUST` created. |
| 8 | `WORKSPACE/ADJUST` | `Done` | `COMPLETED`. `WORKSPACE/CREATE` created. |
| 9 | `WORKSPACE/CREATE` | `Done` with target `WORKSPACE/IMPORT_DATA` | `COMPLETED`. |
| 10 | `WORKSPACE/IMPORT_DATA` | The process is killed mid-handler | Stays `RUNNING` with the claim's timer. |
| 11 | `WORKSPACE/IMPORT_DATA` | Re-driven when `next_at` falls due. The completeness check finds the imported data, so `Done` | `COMPLETED`. `WORKSPACE/RELEASE_NAME` created. |
| 12 | `WORKSPACE/RELEASE_NAME` | `Done` | `COMPLETED`. `WELCOME/SEND` created. |
| 13 | `WELCOME/SEND` | `Done` on a declared terminal | `COMPLETED`. The instance is `COMPLETED`. |

Two rows are worth reading closely. In row 10, a bundled operation with no durable timer would lose the remaining work. Here the row is still non-terminal, so it re-drives and the completeness check absorbs the repeat. Rows 4 and 5 cost an attempt and rows 6 and 7 don't. That is why `Retry` and `Defer` are different outcomes.

## The tables

| Table | Purpose |
| --- | --- |
| `workflow_instance` | One flow execution over one entity. |
| `workflow_step_execution` | Current state of one step. Updated in place, with history in the log. |
| `workflow_worker` | Live worker nodes and the stages they host, by lease. Operational state, not audit. |
| `workflow_state_log` | Append-only audit of step states, transitions, and instance states. |
| `workflow_definition` | Temporally versioned definitions. Every row is approved and immutable. |
| `workflow_definition_draft` | Unapproved work in progress. |

### The instance row

| Field | Meaning |
| --- | --- |
| `entity_kind` | What the flow runs over, as a constant name. The engine routes by it and never interprets it. |
| `entity_id` | The entity's id. No foreign key, because the engine must not know which table to point at. |
| `definition_key`, `definition_version` | The flow definition and version, pinned at creation. |
| `selected_by` | What chose the definition: a rule id or a code path identifier. |
| `selection_inputs` | A snapshot of the attributes the choice was made on, not a reference to the entity. |
| `status` | `ACTIVE`, `COMPLETED`, or `FAILED`. |
| `current_stage`, `current_step` | Denormalized position, written in the same transaction as the transition. |
| `last_progress_at` | Stall watchdog. An `ACTIVE` instance that hasn't moved is stuck in a way no step timer catches. |
| `started_at`, `completed_at`, `failure_reason` | Lifecycle. A reason is required whenever the status is `FAILED`. |

### The step row

| Field | Meaning |
| --- | --- |
| `instance_id` | The owning flow. |
| `stage`, `step` | Constant names, never ordinals. |
| `status` | `PENDING`, `RUNNING`, `PARKED`, `COMPLETED`, or `FAILED`. |
| `attempts`, `max_attempts` | The retry budget and its ceiling. `attempts` is written only in the record transaction. |
| `max_duration` | The step's timeout. It also sets the claim's fallback timer. |
| `dispatch_count` | Invocations, written before the handler runs so that it survives a kill. A signal, not a bound. |
| `defer_count` | Deferrals. Separate from `dispatch_count`, because "keeps waiting" and "keeps dying" are different signals. |
| `next_at` | The durable timer. Retry backoff, defer delay, park time, and crash recovery all write here. |
| `last_outcome`, `last_error` | Diagnostic. `last_error` separates a timeout from a handler-returned `Failed`. |
| `input_data` | What the previous step chose to pass forward. |

Three constraints carry design weight:

- **One row per step per instance.** A unique key on instance, stage, and step makes revisits impossible and removes any need for a run discriminator.
- **Non-terminal implies a timer.** A row is `COMPLETED` or `FAILED`, or it has a `next_at`. A killed process then leaves a row the dispatcher picks up.
- **One active step per instance.** A partial unique index on the instance id covers non-terminal rows. The database rejects a transition that fires twice instead of producing two live steps.

### The audit log

The log is append-only. Each entry records the step, the status change, the outcome, the attempt number, and the dispatch number. A transition entry also records the actual target, the default target, `was_override`, and the reason.

- The record transaction writes the entry, so the entry can't diverge from the state it describes.
- An undeclared target without a reason violates a constraint.
- `actor` records the role: handler, dispatcher, operator, or engine. It doesn't record the node.
- The log records what the engine observed. A crash between work and record leaves work with no entry. The dispatch number comes from a pre-invocation counter, so a gap in the sequence makes that detectable.

## What happens when something fails

| Failure | Result | How you see it |
| --- | --- | --- |
| Process dies before the claim commits | The row stays due. The next poll takes it. | Nothing to see. |
| Process dies mid-handler | The row stays `RUNNING` with the claim's timer. It re-drives when due, and the completeness check absorbs the repeat. | A gap in the log's dispatch numbers. `dispatch_count` climbs. |
| Record transaction is lost | The row re-drives. The completeness check returns `Done` and the transition resolves again. | A gap in the log's dispatch numbers. |
| External system fails transiently | `Retry` with backoff. The step fails when the budget is exhausted. | `attempts` on the row. Failed-instance alert at exhaustion. |
| The lock is busy | `Defer`. No attempt is charged. | `defer_count` climbs. |
| Handler exceeds its maximum duration | The engine cancels the handler. The timeout consumes an attempt. | Timeouts by step. `last_error` names the timeout. |
| Handler ignores cancellation | The host process terminates. The database releases the lock and the step re-drives on another node. | A worker lease that expires without a deregistration. |
| No worker hosts a stage | Rows sit in `PENDING` with a due timer. | Unhosted-stage alert within a lease period. Overdue `next_at`. |
| A transition fires twice | The database rejects the second active step row. | A constraint violation in the logs. |
| A step fails | The instance fails and its remaining step row terminates. An operator retry resumes the flow. | Failed-instance alert. |
| Event delivery is down | Events wait, already committed with the step's work. Steps keep running. | Age of the oldest undelivered event. |
| An `ACTIVE` instance stops moving | No step timer catches it. | `last_progress_at` passes the stall threshold. |

## What to measure

Emit spans and metrics for step start, outcome, and attempts. Keep stage, step, and outcome as dimensions. Never use instance or entity ids as metric dimensions; those belong in traces.

| Signal | Meaning |
| --- | --- |
| Steps overdue on `next_at` | Due rows that nothing has claimed. Your main alert. |
| Dispatcher due count | Rows waiting for a worker. |
| Step duration | Time in the handler, as a histogram by stage and step. |
| Outcomes | Counters by stage, step, and outcome. |
| `dispatch_count` without completion | A step that keeps dying. |
| `defer_count` | A step that keeps waiting. |
| Timeouts | Counter by step. |
| Undeclared transitions | Log entries where `was_override` is true. |
| Unhosted stages | Stages in a current definition with no live worker. |
| Stalled instances | `ACTIVE` instances whose `last_progress_at` is old. |

Alert on overdue steps, on `dispatch_count` climbing without completion, and on `defer_count` climbing. Alert on timeouts by step and on any unhosted stage. Alert on an undeclared transition that skips a stage carrying a control. Never alert on time in `RUNNING`.

- A host terminated for an uncooperative handler must be distinguishable from an ordinary restart. It shows up as a lease that expires without a deregistration.
- Backlog and age of undelivered events belong to event delivery. See the [Outbox-to-Stream Playbook](https://yavosh.github.io/design/eda/guide/).
- Propagate the W3C `traceparent` from the step's span into the events it emits.

## Adopting it in your project

### What your platform needs

- A database with transactions, row locks that can skip locked rows, advisory or named locks, and partial unique indexes.
- A background task per worker process, with an injectable clock.
- Handlers that honor cancellation.
- A completeness check for every step that calls an external system.
- A way to commit events in the handler's transaction and deliver them afterwards, such as a transactional outbox.

### Build order

1. **Name the steps.** Turn the current stages and steps into named constants mapped to handlers. Everything else references them.
2. **Schema.** Add the tables, the constraints, and the immutability trigger. Alter no existing object.
3. **Contracts.** Define the step key, the outcomes, the retry policy, the step context, and the step interface.
4. **Step repository.** Claim, create next, complete, schedule retry, schedule defer, park, fail, and take due. Verify that concurrent claims serialize.
5. **Step runner.** Claim, work, record. Verify every outcome and a killed process.
6. **Timer dispatcher.** One background task with a configurable concurrency limit and an optional stage filter.
7. **Step timeout.** Cancel, abandon, then terminate the host.
8. **Worker registry.** Register, heartbeat, deregister, the coverage query, and the reaper.
9. **Definition publisher.** The publish sequence, the gate, and the simulator.
10. **Wiring.** Register the engine behind feature flags. It stays inert with the flags off.

Make the first pilot synthetic. A real business step drags in the whole chain: a step row needs an instance, and an instance needs a published definition. Use a synthetic step and a seeded test workflow that exercise all five outcomes.

That choice moves a risk instead of removing it. The dispatcher doesn't run inside a deployed service until the first real step is onboarded. Make that first step the smallest one available, behind a feature flag, with a rollback path.

### Onboard one step at a time

- Onboard the lowest blast radius first. A good first step fixes a known defect, such as a release that never retries.
- Fold each stage's existing retry timer into the engine and preserve its behavior.
- Split bundled operations into separate steps, so each one retries on its own.
- Remodel any flow that resumes at a completed stage before you onboard it.
- Remove the old retry timers and per-service producers after the last stage moves.

### Design choices

- **No workflow framework.** The design borrows the vocabulary of durable execution platforms: an activity is a step, and a durable timer is `next_at`. It adopts none of them. A separate cluster brings its own datastore, deployment, and recovery story. Reimplementing a subset is an accepted cost.
- **No replay.** Handlers are ordinary code with no determinism rules. The price is the completeness check.
- **No parallel steps.** One active step per instance is enforced. Fan-out means dropping that index and revisiting the failure path.
- **No revisits.** Re-execution is a distinct step.
- **No compensation routing.** A failed step stops the flow. An operator resumes it.
- **No operator hold.** Nothing suspends one instance. Until that exists, you stop one entity by exhausting its attempts.
- **No leader election.** Row locks split the dispatch work, and the reaper's delete is idempotent.
- **No dispatch ceiling.** `dispatch_count` is a signal and not a bound. The usual cause of a failing record transaction is the database, and then writing `FAILED` fails too.
- **Detective control on routing.** Handler targets are unconstrained. The log and its alert are the control, so the control works only if someone monitors it.

## Common traps

A handler without a completeness check

It double-submits to the external system in the window between work and record. The failure is rare, load-dependent, and costly.

A fixed fallback timer

A healthy slow step is re-dispatched into its own lock. Derive the timer from the step's declared duration.

Alerting on time in RUNNING

A long handler and a dead process look the same. Alert on an overdue `next_at`.

Charging an attempt for contention

A busy lock isn't a failure. Return `Defer`, or a step under load exhausts its budget without one real attempt.

Persisting ordinals

Inserting a constant re-points every stored row. Store names.

Flagging every branch as an override

The deviation alert fills with normal traffic and stops being read. Flag only undeclared targets.

Gating dispatch on the registry

A registry outage then stops the flow. Keep the registry observational.

Coverage on a health probe

One unhosted stage restarts the whole fleet, and a restart can't fix it.

Revisiting a completed step

The unique key rejects it. Model a repeat review as its own step.

Editing step rows by hand

A direct edit bypasses the audit log, and the two silently diverge. Control it with database permissions.

A real step as the first pilot

It drags in instances, definitions, and selection before the engine is proven.
