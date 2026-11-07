import assert from "node:assert/strict";
import test from "node:test";
import { advance, createSimulation, isComplete, scenarios } from "../src/simulation.js";

function run(scenario, steps = scenarios[scenario].steps.length) {
  let state = createSimulation(scenario);
  for (let i = 0; i < steps; i += 1) state = advance(state);
  return state;
}

test("every scenario preserves atomic writes, stable envelopes, and effect-before-ack", () => {
  for (const key of Object.keys(scenarios)) {
    let state = createSimulation(key);
    let payload;
    while (!isComplete(state)) {
      const before = structuredClone(state);
      const next = advance(state);
      assert.deepEqual(state, before, "Stepping must not mutate the previous state");
      state = next;
      assert.equal(state.business, Boolean(state.outbox));
      if (state.outbox) {
        payload ??= state.outbox.payload;
        assert.equal(state.outbox.payload, payload);
        for (const entry of state.stream) assert.equal(entry.payload, payload);
      }
      for (const consumer of Object.values(state.consumers)) {
        assert.ok(consumer.effects <= 1);
        assert.equal(consumer.effects, consumer.processed.length);
        for (const id of consumer.acknowledged) {
          const entry = state.stream.find(item => item.entryId === id);
          assert.ok(entry);
          assert.ok(consumer.processed.includes(entry.eventId));
        }
      }
    }
    assert.equal(advance(state), state, "Completed scenarios must not advance");
  }
});

test("rollback leaves no durable business change, outbox event, or delivery", () => {
  const draft = run("rollback", 1);
  assert.equal(draft.draft, true);
  assert.equal(draft.outbox, null);
  const state = advance(draft);
  assert.equal(state.business, false);
  assert.equal(state.draft, false);
  assert.equal(state.outbox, null);
  assert.deepEqual(state.stream, []);
});

test("publish is visible before the separate SENT update", () => {
  const state = run("normal", 3);
  assert.equal(state.stream.length, 1);
  assert.equal(state.outbox.status, "IN_PROGRESS");
  assert.equal(state.consumers.readModel.acknowledged.length, 0);
  assert.equal(advance(state).outbox.status, "SENT");
});

test("a failed publish preserves the event and waits for backoff before a fresh claim", () => {
  const failed = run("broker", 3);
  assert.equal(failed.business, true);
  assert.equal(failed.outbox.status, "PENDING");
  assert.equal(failed.outbox.attempts, 1);
  assert.equal(failed.outbox.nextAttemptAt, 5);
  assert.equal(failed.stream.length, 0);
  const reclaimed = advance(advance(failed));
  assert.equal(reclaimed.time, 5);
  assert.equal(reclaimed.outbox.claimToken, "claim_02");
  assert.equal(reclaimed.outbox.attempts, 1);
  assert.equal(run("broker").consumers.readModel.effects, 1);
});

test("a stale claim cannot finish a new claim, and duplicate entries produce one effect per group", () => {
  const claimed = run("duplicate", 7);
  const stale = advance(claimed);
  assert.equal(stale.staleUpdates, 1);
  assert.deepEqual(stale.outbox, claimed.outbox);
  assert.equal(stale.outbox.claimToken, "claim_02");
  const complete = run("duplicate");
  assert.equal(complete.time, 120);
  assert.equal(complete.stream.length, 2);
  assert.equal(complete.stream[0].eventId, complete.stream[1].eventId);
  assert.notEqual(complete.stream[0].entryId, complete.stream[1].entryId);
  for (const consumer of Object.values(complete.consumers)) {
    assert.equal(consumer.effects, 1);
    assert.equal(consumer.duplicates, 1);
    assert.equal(consumer.acknowledged.length, 2);
  }
});

test("consumer groups recover independently without acknowledging a failed effect", () => {
  const failed = run("consumer", 5);
  assert.equal(failed.consumers.readModel.effects, 1);
  assert.equal(failed.consumers.readModel.acknowledged.length, 1);
  assert.equal(failed.consumers.deliveryJobs.effects, 0);
  assert.equal(failed.consumers.deliveryJobs.acknowledged.length, 0);
  const recovered = advance(failed);
  assert.deepEqual(recovered.consumers.readModel, failed.consumers.readModel);
  assert.equal(recovered.time, 30);
  assert.equal(recovered.consumers.deliveryJobs.effects, 1);
  assert.equal(recovered.consumers.deliveryJobs.acknowledged.length, 1);
});

test("fallback polling recovers committed work after a missed wakeup", () => {
  const committed = run("notification", 1);
  assert.equal(committed.business, true);
  assert.equal(committed.outbox.status, "PENDING");
  assert.equal(committed.relay, "Waiting for scan");
  const scanned = advance(committed);
  assert.equal(scanned.time, 2);
  assert.equal(scanned.stream.length, 0);
  const complete = run("notification");
  assert.equal(complete.outbox.status, "SENT");
  assert.equal(complete.consumers.readModel.effects, 1);
});
