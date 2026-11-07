export const scenarios = {
  normal: {
    name: "Normal delivery",
    description: "Follow one event from a business transaction to two independent consumers.",
    steps: ["commit", "claim", "publish", "finish", "consume"],
  },
  rollback: {
    name: "Transaction rolls back",
    description: "See why a failed transaction creates neither a business record nor an event.",
    steps: ["begin", "rollback"],
  },
  broker: {
    name: "Broker is unavailable",
    description: "Keep the committed event in the database while a failed publish backs off.",
    steps: ["commit", "claim", "publishFailure", "retryDue", "claim", "publish", "finish", "consume"],
  },
  duplicate: {
    name: "Relay crashes after publish",
    description: "Publish the same event twice, then watch each consumer prevent a second effect.",
    steps: ["commit", "claim", "publish", "crash", "consume", "leaseExpiry", "claim", "staleFinish", "publish", "finish", "consume"],
  },
  consumer: {
    name: "One consumer fails",
    description: "Let the read model continue while the delivery consumer recovers independently.",
    steps: ["commit", "claim", "publish", "finish", "consumerFailure", "consumerRecovery"],
  },
  notification: {
    name: "Wakeup notification is missed",
    description: "Find committed work with the fallback scan, even without a notification.",
    steps: ["commitWithoutWakeup", "fallback", "claim", "publish", "finish", "consume"],
  },
};

export function createSimulation(scenario = "normal") {
  if (!scenarios[scenario]) throw new Error("Unknown scenario");
  return {
    scenario, step: 0, time: 0, business: false, draft: false, outbox: null,
    relay: "Waiting", stream: [], claims: 0, staleUpdates: 0,
    consumers: {
      readModel: { processed: [], acknowledged: [], effects: 0, duplicates: 0, failed: false },
      deliveryJobs: { processed: [], acknowledged: [], effects: 0, duplicates: 0, failed: false },
    },
    title: "Start with one business change",
    explanation: "A record is ready to update. Take the next step to see what becomes durable, and when.",
    lesson: "This is a simulation. No database or broker is connected.",
    log: [], active: "producer",
  };
}

function commit(state, notify = true) {
  state.business = true;
  state.outbox = {
    eventId: "evt_001", status: "PENDING", attempts: 0, claimToken: null, nextAttemptAt: 0,
    payload: JSON.stringify({ eventId: "evt_001", type: "RecordUpdated", schemaVersion: 1,
      payload: { recordId: "record_001", revision: 1 } }),
  };
  state.relay = notify ? "Woken after commit" : "Waiting for scan";
}

function claim(state) {
  if (!state.outbox || !["PENDING", "IN_PROGRESS"].includes(state.outbox.status)
    || state.outbox.nextAttemptAt > state.time) throw new Error("Row is not due");
  state.claims += 1;
  state.outbox.status = "IN_PROGRESS";
  state.outbox.claimToken = `claim_${String(state.claims).padStart(2, "0")}`;
  state.outbox.nextAttemptAt = state.time + 120;
  state.relay = "Claimed";
}

function finish(state, token) {
  if (state.outbox?.status !== "IN_PROGRESS" || state.outbox.claimToken !== token) {
    state.staleUpdates += 1;
    return;
  }
  state.outbox.status = "SENT";
  state.relay = "Complete";
}

function consume(state, group) {
  const consumer = state.consumers[group];
  consumer.failed = false;
  for (const entry of state.stream) {
    if (consumer.acknowledged.includes(entry.entryId)) continue;
    // Deduplication and the local effect share one simulated transaction.
    if (consumer.processed.includes(entry.eventId)) consumer.duplicates += 1;
    else {
      consumer.processed.push(entry.eventId);
      consumer.effects += 1;
    }
    consumer.acknowledged.push(entry.entryId);
  }
}

export function advance(previous) {
  const action = scenarios[previous.scenario].steps[previous.step];
  if (!action) return previous;
  const state = structuredClone(previous);
  state.step += 1;
  let message;
  let kind = "success";
  switch (action) {
    case "begin":
      state.draft = true;
      state.active = "producer";
      state.title = "Prepare both writes in one transaction";
      state.explanation = "The business change and event are prepared together. Neither is committed yet, so the relay cannot see them.";
      state.lesson = "Prepared writes are not durable until their transaction commits.";
      message = "Transaction opened. Both writes are still uncommitted.";
      break;
    case "rollback":
      state.draft = false;
      state.active = "producer";
      state.title = "A rollback leaves neither record";
      state.explanation = "The transaction fails. The record change and outbox event are both discarded. There is nothing for the relay to publish.";
      state.lesson = "The change and its event share the same transaction outcome.";
      message = "Transaction rolled back. No business change and no event committed.";
      break;
    case "commit":
    case "commitWithoutWakeup":
      commit(state, action === "commit");
      state.active = "producer";
      state.title = "Two writes. One database commit.";
      state.explanation = "The updated record and its serialized event commit together. The event now survives a process crash, even before the broker receives it.";
      state.lesson = "A notification can wake the relay only after commit. The durable event stays in the database.";
      message = "Business change and outbox row committed together.";
      if (action === "commitWithoutWakeup") {
        state.title = "The wakeup is missed. The event remains.";
        state.explanation = "The transaction commits, but the relay misses its notification. The notification is only a hint. The committed outbox row is still available.";
        state.lesson = "Delivery jobs improve latency. Durable rows and fallback scans preserve recovery.";
        message = "Transaction committed. Wakeup missed; durable outbox row preserved.";
        kind = "warning";
      }
      break;
    case "claim":
      claim(state);
      state.active = "relay";
      state.title = "A short lease protects the claim";
      state.explanation = `The relay claims evt_001 for two minutes with a fresh token (${state.outbox.claimToken}). Publishing happens after this short claim transaction commits.`;
      state.lesson = "The claim token guards later database updates. A lease cannot prevent duplicate publishing.";
      message = `Relay claimed evt_001 with ${state.outbox.claimToken}. Outbox: IN_PROGRESS.`;
      break;
    case "publish":
      if (state.outbox?.status !== "IN_PROGRESS") throw new Error("Publishing needs a claim");
      state.stream.push({ entryId: `entry_${state.stream.length + 1}`, eventId: state.outbox.eventId, payload: state.outbox.payload });
      state.active = "stream";
      state.relay = "Published";
      state.title = state.stream.length > 1 ? "The retry sends the same event again" : "Publish the stored bytes, unchanged";
      state.explanation = state.stream.length > 1
        ? "The stream now contains two entries with the same event id and identical payloads. A new broker entry is not a new business fact."
        : "The relay appends the saved envelope to the durable stream. The outbox is still IN_PROGRESS until a separate database update records success.";
      state.lesson = "A stable event id lets consumers recognize a repeated event.";
      message = `Appended ${state.stream.at(-1).entryId} to the stream. Event id: evt_001.`;
      break;
    case "finish":
      finish(state, state.outbox.claimToken);
      state.active = "relay";
      state.title = "Record success using the current claim token";
      state.explanation = "The relay marks the row SENT only because its claim token still matches. The row remains available for recovery within the configured retention window.";
      state.lesson = "Publishing and marking SENT are separate operations. A crash between them can cause a duplicate.";
      message = "Matching claim token accepted. Outbox marked SENT.";
      break;
    case "consume": {
      const duplicatesBefore = Object.values(state.consumers).reduce((sum, c) => sum + c.duplicates, 0);
      consume(state, "readModel");
      consume(state, "deliveryJobs");
      const duplicate = Object.values(state.consumers).some(c => c.duplicates) && duplicatesBefore === 0;
      state.active = "consumers";
      state.title = duplicate ? "Two deliveries. One effect per consumer." : "Each consumer applies, then acknowledges";
      state.explanation = duplicate
        ? "Each group recognizes evt_001 in its own durable processed-event records. Both acknowledge the second entry without repeating their local effect."
        : "The read model records one entry. The delivery consumer inserts one durable delivery job. Each stores its event id with the local effect before acknowledging the stream entry.";
      state.lesson = "External calls run in a separate job worker. Safe retries also need destination idempotency or reconciliation.";
      message = duplicate ? "Both groups ignored the duplicate and acknowledged its stream entry." : "Both groups committed one local effect, then acknowledged delivery.";
      break;
    }
    case "publishFailure":
      state.outbox.status = "PENDING";
      state.outbox.attempts += 1;
      state.outbox.nextAttemptAt = state.time + 5;
      state.relay = "Backing off";
      state.active = "relay";
      state.title = "The broker is down. The event is safe.";
      state.explanation = "Publishing fails. A guarded update returns the row to PENDING and schedules a retry in five seconds. The record and event stay committed.";
      state.lesson = "Only failed publishes count as attempts. Claiming a row does not use the retry budget.";
      message = "Publish failed. Attempt 1 recorded; retry due at virtual 00:05.";
      kind = "warning";
      break;
    case "retryDue":
      state.time = state.outbox.nextAttemptAt;
      state.relay = "Ready to retry";
      state.active = "relay";
      state.title = "Wait for backoff, then retry";
      state.explanation = "The virtual clock advances five seconds and the broker recovers. The row is due again. The next claim receives a new token.";
      state.lesson = "Wakeups never bypass retry backoff or an active lease.";
      message = "Backoff elapsed. Broker recovered; row is eligible for another claim.";
      break;
    case "crash":
      state.relay = "Crashed";
      state.active = "relay";
      state.title = "The relay crashes before marking SENT";
      state.explanation = "The stream has the event, but the database still says IN_PROGRESS. The relay cannot know whether the publish completed when it restarts.";
      state.lesson = "The event is not lost. The uncertain outcome is why delivery may repeat.";
      message = "Relay crashed after append, before the SENT update.";
      kind = "warning";
      break;
    case "leaseExpiry":
      state.time = state.outbox.nextAttemptAt;
      state.active = "relay";
      state.title = "The expired lease makes the row due again";
      state.explanation = "The virtual clock advances to the two-minute lease expiry. Another relay can reclaim the row. No separate reaper process is required.";
      state.lesson = "The next claim replaces the old token, fencing stale database updates.";
      message = "Lease expired at virtual 02:00. Row is eligible for reclaiming.";
      break;
    case "staleFinish":
      finish(state, "claim_01");
      state.active = "relay";
      state.title = "An old claim cannot overwrite a new one";
      state.explanation = "The original attempt tries to mark the row SENT with claim_01. The row now belongs to claim_02, so the database rejects that stale update.";
      state.lesson = "Token checks protect success, failure, and lease-renewal updates. They do not stop an old network send.";
      message = "Stale claim_01 update rejected. Current claim_02 left unchanged.";
      kind = "warning";
      break;
    case "consumerFailure":
      consume(state, "readModel");
      state.consumers.deliveryJobs.failed = true;
      state.active = "consumers";
      state.title = "One slow consumer does not stop another";
      state.explanation = "The read model commits and acknowledges its event. The delivery consumer fails before its local transaction commits, so its entry remains unacknowledged.";
      state.lesson = "Consumer groups keep independent positions and recovery state.";
      message = "Read model acknowledged. Delivery jobs failed; its entry remains pending.";
      kind = "warning";
      break;
    case "consumerRecovery":
      state.time += 30;
      consume(state, "deliveryJobs");
      state.active = "consumers";
      state.title = "Recovery gets a turn, even with new traffic";
      state.explanation = "After 30 virtual seconds, The delivery consumer retries its own pending entry. It inserts the delivery job and event id together, then acknowledges the entry.";
      state.lesson = "Bounded scheduling opportunities prevent recovery work from starving behind new reads.";
      message = "Delivery consumer recovery committed one job, then acknowledged delivery.";
      break;
    case "fallback":
      state.time += 2;
      state.relay = "Fallback scan";
      state.active = "relay";
      state.title = "The fallback scan finds the work";
      state.explanation = "After two virtual seconds, the fallback scan finds the committed row. It uses the same claiming path as a notification-triggered run.";
      state.lesson = "Fallback scans also find due retries and expired leases.";
      message = "Fallback scan found the due row at virtual 00:02.";
      break;
    default: throw new Error("Unknown simulation action");
  }
  state.log.push({ step: state.step, time: state.time, message, kind });
  return state;
}

export function isComplete(state) {
  return state.step === scenarios[state.scenario].steps.length;
}

export function formatTime(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
