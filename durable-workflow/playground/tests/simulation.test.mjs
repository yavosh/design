import assert from "node:assert/strict";
import test from "node:test";
import { advance, createSimulation, definition, formatTime, isComplete, scenarios } from "../src/simulation.js";

function run(scenario, steps = scenarios[scenario].steps.length) {
  let state = createSimulation(scenario);
  for (let i = 0; i < steps; i += 1) state = advance(state);
  return state;
}

const row = (state, step = state.instance.currentStep) => state.rows.find(item => item.step === step);
const terminal = item => ["COMPLETED", "FAILED"].includes(item.status);

function checkInvariants(state) {
  assert.equal(new Set(state.rows.map(item => item.step)).size, state.rows.length, "One row per step per instance");
  for (const item of state.rows) {
    assert.equal(item.nextAt === null, terminal(item), "Non-terminal implies a timer");
    assert.ok(item.dispatchCount >= item.attempts + item.deferCount, "Counted outcomes need a dispatch");
  }
  assert.ok(state.rows.filter(item => !terminal(item)).length <= 1, "One active step per instance");
  state.log.forEach((entry, index) => {
    assert.equal(entry.seq, index + 1);
    if (!entry.target) return assert.equal(entry.wasOverride, false);
    const step = definition.steps[entry.step];
    const declared = entry.target === step.next || (step.alternates ?? []).includes(entry.target);
    assert.equal(entry.wasOverride, !declared);
    if (entry.wasOverride) assert.ok(entry.reason, "An undeclared target needs a reason");
  });
  for (const count of Object.values(state.external.effects)) assert.ok(count <= 1, "Each effect happens once");
  const failed = state.rows.some(item => item.status === "FAILED");
  assert.equal(state.instance.status === "FAILED", failed);
  assert.equal(Boolean(state.instance.failureReason), failed);
  const done = definition.terminals.some(step => row(state, step)?.status === "COMPLETED");
  assert.equal(state.instance.status === "COMPLETED", done);
}

test("every scenario keeps the step, instance, and audit constraints at every step", () => {
  for (const key of Object.keys(scenarios)) {
    let state = createSimulation(key);
    assert.equal(state.instance.currentStep, scenarios[key].start);
    checkInvariants(state);
    while (!isComplete(state)) {
      const before = structuredClone(state);
      const next = advance(state);
      assert.deepEqual(state, before, "Stepping must not mutate the previous state");
      assert.deepEqual(next.log.slice(0, state.log.length), state.log, "The audit log only appends");
      for (const item of next.rows) {
        const previous = row(state, item.step);
        if (previous && item.attempts !== previous.attempts) {
          assert.ok(next.log.length > state.log.length, "attempts changes only with an audit entry");
        }
      }
      state = next;
      checkInvariants(state);
      assert.equal(state.timeline.length, state.step);
    }
    assert.equal(advance(state), state, "Completed scenarios must not advance");
  }
});

test("one step run claims, works, and records, then the terminal step completes the instance", () => {
  const claimed = run("normal", 1);
  assert.equal(row(claimed).status, "RUNNING");
  assert.equal(row(claimed).dispatchCount, 1);
  assert.equal(row(claimed).nextAt, 150);
  assert.equal(claimed.log.length, createSimulation("normal").log.length, "A claim writes no audit entry");
  const worked = advance(claimed);
  assert.equal(row(worked).status, "RUNNING");
  assert.equal(worked.handler.outcome.type, "Done");
  assert.equal(worked.events.at(-1).type, "NameReleased");
  const recorded = advance(worked);
  assert.equal(row(recorded, "WORKSPACE/RELEASE_NAME").status, "COMPLETED");
  assert.deepEqual(row(recorded), { ...row(recorded), step: "WELCOME/SEND", status: "PENDING", nextAt: 0 });
  assert.equal(recorded.log.at(-1).wasOverride, false);
  const complete = advance(recorded);
  assert.equal(complete.instance.status, "COMPLETED");
  assert.equal(complete.rows.length, 7);
});

test("the full flow follows the playbook table", () => {
  const state = run("flow");
  assert.equal(scenarios.flow.steps.length, 13);
  assert.equal(state.instance.status, "COMPLETED");
  assert.deepEqual(state.rows.map(item => item.step), [
    "SIGNUP/NORMALISE", "PROFILE/ENRICH", "VERIFICATION/VERIFY", "WORKSPACE/RESERVE_NAME", "REVIEW/REQUEST",
    "WORKSPACE/ADJUST", "WORKSPACE/CREATE", "WORKSPACE/IMPORT_DATA", "WORKSPACE/RELEASE_NAME", "WELCOME/SEND",
  ]);
  assert.ok(state.rows.every(item => item.status === "COMPLETED"));
  assert.equal(row(state, "WORKSPACE/RESERVE_NAME").attempts, 1);
  assert.equal(row(state, "REVIEW/REQUEST").deferCount, 1);
  assert.equal(row(state, "REVIEW/REQUEST").attempts, 0);
  assert.equal(row(state, "WORKSPACE/IMPORT_DATA").dispatchCount, 2);
  assert.equal(state.external.calls["WORKSPACE/IMPORT_DATA"], 1);
  assert.equal(state.log.filter(entry => entry.wasOverride).length, 0);
  assert.equal(run("flow", 10).rows.at(-1).status, "RUNNING");
});

test("a retry charges one attempt and waits for the backoff timer", () => {
  const recorded = run("retry", 3);
  assert.deepEqual(row(recorded), { ...row(recorded), status: "PENDING", attempts: 1, nextAt: 60, deferCount: 0 });
  assert.throws(() => advance({ ...recorded, step: 4 }), /No row is claimable/, "A claim must wait for next_at");
  const reclaimed = advance(advance(recorded));
  assert.equal(reclaimed.time, 60);
  assert.equal(row(reclaimed).dispatchCount, 2);
  const state = run("retry");
  assert.equal(row(state, "WORKSPACE/RELEASE_NAME").status, "COMPLETED");
  assert.equal(state.external.calls["WORKSPACE/RELEASE_NAME"], 2);
  assert.equal(state.external.effects["WORKSPACE/RELEASE_NAME"], 1);
});

test("a busy lock defers the step without charging an attempt", () => {
  const worked = run("defer", 2);
  assert.equal(worked.handler.outcome.type, "Defer");
  assert.equal(worked.external.calls["WORKSPACE/RELEASE_NAME"], undefined);
  const recorded = advance(worked);
  assert.deepEqual(row(recorded), { ...row(recorded), status: "PENDING", attempts: 0, deferCount: 1, nextAt: 30 });
  const due = advance(recorded);
  assert.equal(due.time, 30);
  assert.equal(due.lock, null);
  assert.equal(row(run("defer"), "WORKSPACE/RELEASE_NAME").status, "COMPLETED");
});

test("a park waits for an absolute time and changes no counter", () => {
  const parked = run("park", 3);
  assert.deepEqual(row(parked), { ...row(parked), status: "PARKED", attempts: 0, deferCount: 0, nextAt: 21600 });
  const state = run("park");
  assert.equal(state.time, 21600);
  assert.equal(formatTime(state.time), "6:00:00");
  assert.equal(row(state, "SCHEDULE/PARK").status, "COMPLETED");
  assert.equal(state.instance.currentStep, "VERIFICATION/VERIFY");
});

test("a declared alternate is not an override, and an undeclared target is", () => {
  const declared = run("branch", 3).log.at(-1);
  assert.deepEqual(
    { target: declared.target, defaultTarget: declared.defaultTarget, wasOverride: declared.wasOverride },
    { target: "REVIEW/REQUEST", defaultTarget: "WORKSPACE/CREATE", wasOverride: false },
  );
  assert.ok(declared.reason);
  const state = run("branch");
  const undeclared = state.log.at(-1);
  assert.deepEqual(
    { target: undeclared.target, defaultTarget: undeclared.defaultTarget, wasOverride: undeclared.wasOverride },
    { target: "WORKSPACE/CREATE", defaultTarget: "WORKSPACE/ADJUST", wasOverride: true },
  );
  assert.ok(undeclared.reason);
  assert.equal(row(state, "WORKSPACE/ADJUST"), undefined);
  assert.equal(state.log.filter(entry => entry.wasOverride).length, 1);
});

test("a killed process re-drives from the claim's timer with no second external call", () => {
  const crashed = run("crash", 2);
  const step = "WORKSPACE/IMPORT_DATA";
  assert.deepEqual(row(crashed), { ...row(crashed), status: "RUNNING", dispatchCount: 1, nextAt: 150 });
  assert.equal(crashed.workers[0].alive, false);
  assert.equal(crashed.log.filter(entry => entry.step === step && entry.dispatch === 1).length, 0);
  assert.equal(crashed.external.effects[step], 1);
  const reclaimed = run("crash", 4);
  assert.equal(reclaimed.time, 150);
  assert.equal(reclaimed.handler.worker, "worker-b");
  const state = run("crash");
  assert.equal(row(state, step).status, "COMPLETED");
  assert.equal(state.external.calls[step], 1);
  assert.equal(state.events.filter(event => event.type === "DataImported").length, 1);
  assert.deepEqual(state.log.filter(entry => entry.step === step && entry.actor === "handler").map(entry => entry.dispatch), [2]);
});

test("an exhausted retry budget fails the instance until an operator retries the step", () => {
  const initial = createSimulation("exhausted");
  assert.equal(row(initial).dispatchCount, 9);
  assert.equal(row(initial).lastOutcome, "Retry");
  assert.equal(row(initial).lastError, "External system unavailable");
  assert.equal(row(initial).nextAt, initial.time);
  const retries = initial.log.filter(entry => entry.step === initial.instance.currentStep);
  assert.equal(retries.length, 9);
  assert.deepEqual(retries.map(entry => [entry.attempt, entry.dispatch]), Array.from({ length: 9 }, (_, index) => [index + 1, index + 1]));
  assert.ok(retries.every(entry => entry.outcome === "Retry" && entry.at <= initial.time));
  assert.ok(initial.workers.every(worker => worker.leaseExpiresAt > initial.time));
  const failed = run("exhausted", 3);
  assert.deepEqual(row(failed), { ...row(failed), status: "FAILED", attempts: 10, nextAt: null });
  assert.equal(failed.instance.status, "FAILED");
  const skipped = advance(failed);
  assert.deepEqual(skipped.rows, failed.rows, "The dispatcher skips an instance that is not ACTIVE");
  const retried = advance(skipped);
  assert.deepEqual(row(retried), { ...row(retried), status: "PENDING", attempts: 0, nextAt: retried.time });
  assert.equal(retried.instance.status, "ACTIVE");
  assert.equal(retried.log.at(-1).actor, "operator");
  const state = run("exhausted");
  assert.equal(row(state, "WORKSPACE/RELEASE_NAME").status, "COMPLETED");
  assert.equal(state.instance.status, "ACTIVE");
});

test("a handler-returned Failed stops the instance without charging an attempt", () => {
  const initial = createSimulation("failed");
  const worked = run("failed", 2);
  assert.deepEqual(worked.handler.outcome, { type: "Failed", reason: "The account could not be verified." });
  assert.equal(worked.external.calls[initial.instance.currentStep], 1);
  assert.equal(worked.external.effects[initial.instance.currentStep], undefined);
  assert.deepEqual(worked.business, initial.business);
  assert.deepEqual(worked.events, initial.events);
  const recorded = advance(worked);
  assert.equal(row(recorded).status, "FAILED");
  assert.equal(row(recorded).nextAt, null);
  assert.equal(row(recorded).attempts, 0);
  assert.equal(row(recorded).deferCount, 0);
  assert.equal(row(recorded).lastOutcome, "Failed");
  assert.equal(recorded.instance.status, "FAILED");
  assert.equal(recorded.instance.failureReason, worked.handler.outcome.reason);
  assert.equal(recorded.rows.length, initial.rows.length);
  assert.equal(recorded.log.at(-1).outcome, "Failed");
  assert.equal(recorded.log.at(-1).reason, worked.handler.outcome.reason);
  assert.equal(recorded.log.at(-1).target, null);
});

test("record rejects an unknown handler outcome instead of completing the step", () => {
  const worked = run("normal", 2);
  worked.handler.outcome = { type: "Unknown" };
  assert.throws(() => advance(worked), /Unknown outcome/);
  assert.equal(row(worked).status, "RUNNING");
});

test("a re-drive completes a missing local commit without repeating the external effect", () => {
  const reclaimed = run("crash", 4);
  const step = reclaimed.instance.currentStep;
  reclaimed.business = reclaimed.business.filter(item => item !== step);
  reclaimed.events = reclaimed.events.filter(event => event.type !== "DataImported");
  const worked = advance(reclaimed);
  assert.equal(worked.external.calls[step], 1);
  assert.equal(worked.external.effects[step], 1);
  assert.equal(worked.business.filter(item => item === step).length, 1);
  assert.equal(worked.events.filter(event => event.type === "DataImported").length, 1);
});

test("a handler that ignores cancellation times out and its host terminates", () => {
  assert.equal(row(run("timeout", 1)).nextAt, 150);
  const cancelled = run("timeout", 2);
  assert.equal(cancelled.time, 120);
  assert.equal(cancelled.lock.holder, "wf_001");
  assert.equal(row(cancelled).attempts, 0);
  const abandoned = advance(cancelled);
  assert.equal(abandoned.time, 130);
  assert.deepEqual(row(abandoned), { ...row(abandoned), status: "PENDING", attempts: 1, lastError: "timeout", nextAt: 190 });
  assert.equal(abandoned.log.at(-1).actor, "dispatcher");
  assert.equal(abandoned.lock.holder, "wf_001");
  const terminated = advance(abandoned);
  assert.equal(terminated.lock, null);
  assert.equal(terminated.workers[0].alive, false);
  const reclaimed = advance(advance(terminated));
  assert.equal(reclaimed.time, 190);
  assert.ok(reclaimed.workers[0].leaseExpiresAt <= reclaimed.time, "The lease expires without a deregistration");
  assert.equal(reclaimed.handler.worker, "worker-b");
  const state = run("timeout");
  assert.equal(row(state, "WORKSPACE/RELEASE_NAME").status, "COMPLETED");
  assert.equal(state.external.effects["WORKSPACE/RELEASE_NAME"], 1);
});

test("an unhosted stage stalls with no error until a worker registers for it", () => {
  const initial = createSimulation("unhosted");
  assert.deepEqual(initial.unhosted, []);
  assert.notEqual(initial.workers[0].stages, scenarios.unhosted.workers);
  assert.notEqual(initial.workers[0].stages, initial.workers[1].stages);
  const stalled = run("unhosted", 2);
  assert.deepEqual(stalled.unhosted, []);
  assert.deepEqual(row(stalled), { ...row(stalled), step: "REVIEW/REQUEST", status: "PENDING", dispatchCount: 0 });
  assert.ok(row(stalled).nextAt < stalled.time, "The row is overdue");
  const reported = advance(stalled);
  assert.deepEqual(reported.unhosted, ["REVIEW"]);
  const joined = advance(reported);
  assert.deepEqual(joined.unhosted, []);
  assert.deepEqual(joined.workers.at(-1).stages, ["REVIEW"]);
  const claimed = advance(joined);
  assert.equal(claimed.handler.worker, "worker-c");
  assert.equal(row(run("unhosted"), "REVIEW/REQUEST").status, "COMPLETED");
});
