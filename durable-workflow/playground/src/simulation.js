export const definition = {
  key: "account-onboarding",
  version: 3,
  start: "SIGNUP/NORMALISE",
  terminals: ["WELCOME/SEND"],
  steps: {
    "SIGNUP/NORMALISE": { next: "PROFILE/ENRICH" },
    "PROFILE/ENRICH": { next: "VERIFICATION/VERIFY", alternates: ["SCHEDULE/PARK"] },
    "SCHEDULE/PARK": { next: "VERIFICATION/VERIFY" },
    "VERIFICATION/VERIFY": { next: "WORKSPACE/RESERVE_NAME" },
    "WORKSPACE/RESERVE_NAME": { next: "WORKSPACE/CREATE", alternates: ["REVIEW/REQUEST"] },
    "REVIEW/REQUEST": { next: "WORKSPACE/ADJUST" },
    "WORKSPACE/ADJUST": { next: "WORKSPACE/CREATE" },
    "WORKSPACE/CREATE": { next: "WORKSPACE/RELEASE_NAME", alternates: ["WORKSPACE/IMPORT_DATA"] },
    "WORKSPACE/IMPORT_DATA": { next: "WORKSPACE/RELEASE_NAME" },
    "WORKSPACE/RELEASE_NAME": { next: "WELCOME/SEND" },
    "WELCOME/SEND": { next: null },
  },
};

// Each step's external effect and the event its handler emits.
const effects = {
  "SIGNUP/NORMALISE": ["sign-up normalised", "SignupNormalised"],
  "PROFILE/ENRICH": ["profile enriched", "ProfileEnriched"],
  "SCHEDULE/PARK": ["start scheduled", "StartScheduled"],
  "VERIFICATION/VERIFY": ["account verified", "AccountVerified"],
  "WORKSPACE/RESERVE_NAME": ["workspace name reserved", "NameReserved"],
  "REVIEW/REQUEST": ["review applied", "ReviewApplied"],
  "WORKSPACE/ADJUST": ["name reservation adjusted", "ReservationAdjusted"],
  "WORKSPACE/CREATE": ["workspace created", "WorkspaceCreated"],
  "WORKSPACE/IMPORT_DATA": ["data imported", "DataImported"],
  "WORKSPACE/RELEASE_NAME": ["name reservation released", "NameReleased"],
  "WELCOME/SEND": ["welcome message sent", "WelcomeSent"],
};

const reasons = {
  "SCHEDULE/PARK": "The account starts at a later time.",
  "REVIEW/REQUEST": "The workspace name needs a review.",
  "WORKSPACE/IMPORT_DATA": "The account has data to import.",
};

const GRACE = 30;
const CANCEL_GRACE = 10;
const RETRY_DELAY = 60;
const DEFER_DELAY = 30;
const LEASE = 60;
const LOCK = "workspace_name_7";
const stageOf = key => key.split("/")[0];
const stages = [...new Set(Object.keys(definition.steps).map(stageOf))];
const terminal = row => row.status === "COMPLETED" || row.status === "FAILED";

const verified = ["SIGNUP/NORMALISE", "PROFILE/ENRICH", "VERIFICATION/VERIFY"];
const created = [...verified, "WORKSPACE/RESERVE_NAME", "WORKSPACE/CREATE"];

export const scenarios = {
  normal: {
    name: "One step run",
    description: "Follow one step through claim, work, and record, then complete the flow.",
    start: "WORKSPACE/RELEASE_NAME", path: created,
    steps: ["claim", "work", "record", "run"],
  },
  flow: {
    name: "A full flow, step by step",
    description: "Run one account from sign-up to the welcome message, with a retry, a deferral, two branches, and a crash.",
    start: "SIGNUP/NORMALISE", path: [],
    steps: ["run", "run", "run", "runRetry", "runAlternate", "runWait", "run", "run", "runAlternate", "runCrash", "run", "run", "run"],
  },
  retry: {
    name: "External system fails",
    description: "Charge one attempt, wait for the backoff timer, and run the step again.",
    failure: true, start: "WORKSPACE/RELEASE_NAME", path: created,
    steps: ["claim", "workRetry", "record", "timerDue", "claim", "work", "record"],
  },
  defer: {
    name: "The lock is busy",
    description: "Wait for another instance to release a shared lock, without using the retry budget.",
    failure: true, start: "WORKSPACE/RELEASE_NAME", path: created, lock: "wf_002",
    intro: "Another instance, wf_002, holds the lock for the same workspace name.",
    steps: ["claim", "work", "record", "timerDue", "claim", "work", "record"],
  },
  park: {
    name: "A planned wait",
    description: "Park a step until a known time, then continue when the timer falls due.",
    start: "SCHEDULE/PARK", path: ["SIGNUP/NORMALISE", "PROFILE/ENRICH"],
    steps: ["claim", "workPark", "record", "timerDue", "claim", "work", "record"],
  },
  branch: {
    name: "Declared branch and undeclared override",
    description: "Compare a routine branch with a target that the definition does not list.",
    start: "WORKSPACE/RESERVE_NAME", path: verified,
    steps: ["claim", "workAlternate", "record", "claim", "workOverride", "record"],
  },
  crash: {
    name: "Process dies mid-handler",
    description: "Kill the worker after its work commits, then watch the timer re-drive the step.",
    failure: true, start: "WORKSPACE/IMPORT_DATA", path: created,
    steps: ["claim", "crash", "timerDue", "claim", "work", "record"],
  },
  exhausted: {
    name: "Retry budget runs out",
    description: "Fail the step and its instance, then resume the flow with an operator retry.",
    failure: true, start: "WORKSPACE/RELEASE_NAME", path: created, seed: { attempts: 9 },
    intro: "Nine of its ten attempts have already failed.",
    steps: ["claim", "workRetry", "record", "pollMiss", "operatorRetry", "claim", "work", "record"],
  },
  timeout: {
    name: "Handler ignores cancellation",
    description: "Cancel a step that overruns, abandon it, and terminate its host process.",
    failure: true, start: "WORKSPACE/RELEASE_NAME", path: created,
    steps: ["claim", "cancel", "abandon", "hostTerminates", "timerDue", "claim", "work", "record"],
  },
  unhosted: {
    name: "No worker hosts a stage",
    description: "Let a step stall with no error, then find it with the worker registry.",
    failure: true, start: "WORKSPACE/RESERVE_NAME", path: verified,
    workers: stages.filter(stage => stage !== "REVIEW"),
    intro: "No worker group hosts the REVIEW stage.",
    steps: ["runAlternate", "pollMiss", "coverage", "workerJoins", "claim", "work", "record"],
  },
};

function currentRow(state) {
  return state.rows.find(row => row.step === state.instance.currentStep);
}

function createRow(step, time) {
  return {
    step, status: "PENDING", attempts: 0, maxAttempts: 10, maxDuration: 120,
    dispatchCount: 0, deferCount: 0, nextAt: time, lastOutcome: null, lastError: null,
  };
}

function append(state, row, entry) {
  state.log.push({
    seq: state.log.length + 1, step: row.step, outcome: null, attempt: row.attempts, dispatch: row.dispatchCount,
    target: null, defaultTarget: null, wasOverride: false, reason: null, at: state.time, ...entry,
  });
}

function unhostedStages(state) {
  const hosted = new Set(state.workers.filter(worker => worker.leaseExpiresAt > state.time).flatMap(worker => worker.stages));
  return stages.filter(stage => !hosted.has(stage));
}

function claimer(state) {
  const row = currentRow(state);
  if (state.instance.status !== "ACTIVE" || terminal(row) || row.nextAt > state.time) return null;
  return state.workers.find(worker => worker.alive && worker.stages.includes(stageOf(row.step))) ?? null;
}

export function createSimulation(scenario = "normal") {
  const config = scenarios[scenario];
  if (!config) throw new Error("Unknown scenario");
  const workers = node => ({ node, stages: [...stages], leaseExpiresAt: LEASE, alive: true });
  const state = {
    scenario, step: 0, time: 0,
    instance: {
      id: "wf_001", entityKind: "ACCOUNT", entityId: "account_001",
      definitionKey: definition.key, definitionVersion: definition.version,
      status: "ACTIVE", currentStep: definition.start, lastProgressAt: 0, failureReason: null,
    },
    rows: [createRow(definition.start, 0)],
    log: [], workers: [workers("worker-a"), workers("worker-b")], lock: null, unhosted: [],
    external: { calls: {}, effects: {}, lastResult: null }, business: [], events: [],
    handler: { phase: "Idle", worker: null, outcome: null }, dispatcher: "Polling for due rows",
    title: "Start with one due step row", lesson: "This is a simulation. No database or external system is connected.",
    timeline: [], active: "row",
  };
  append(state, state.rows[0], { from: null, to: "PENDING", actor: "engine" });
  // Seed the completed steps through the same claim, work, and record path.
  config.path.forEach((step, index) => {
    const target = config.path[index + 1] ?? config.start;
    run(state, target === definition.steps[step].next ? {} : { target, reason: reasons[target] });
  });
  Object.assign(currentRow(state), config.seed);
  if (config.workers) state.workers.forEach(worker => { worker.stages = config.workers; });
  if (config.lock) state.lock = { key: LOCK, holder: config.lock };
  state.unhosted = unhostedStages(state);
  state.external.lastResult = null;
  state.handler = { phase: "Idle", worker: null, outcome: null };
  state.dispatcher = "Polling for due rows";
  state.explanation = `${config.path.length ? `One account, account_001, has reached ${config.start}.` : "One account, account_001, starts its onboarding. The engine created the instance and its first step row in one transaction."} ${config.intro ?? "The step row is PENDING and due."} Take the next step to see what the engine does.`;
  return state;
}

function claim(state) {
  const worker = claimer(state);
  if (!worker) throw new Error("No row is claimable");
  const row = currentRow(state);
  row.status = "RUNNING";
  row.dispatchCount += 1;
  row.nextAt = state.time + row.maxDuration + GRACE;
  state.handler = { phase: "Claimed", worker: worker.node, outcome: null };
  state.dispatcher = `Claimed by ${worker.node}`;
  return {
    active: "dispatcher",
    title: row.dispatchCount > 1 ? "The dispatcher claims the row again" : "Claim: the engine takes the due row",
    explanation: `${worker.node} claims ${row.step} in a short transaction. The row is RUNNING, dispatch_count is ${row.dispatchCount}, and next_at moves to virtual ${formatTime(row.nextAt)}. The claim commits before the handler starts.`,
    lesson: "The moved timer is the crash recovery. If this process dies, the row falls due again.",
    message: `${worker.node} claimed the row. dispatch_count ${row.dispatchCount}; next_at ${formatTime(row.nextAt)}.`,
  };
}

function work(state, { fail, target, reason } = {}) {
  const row = currentRow(state);
  if (row.status !== "RUNNING") throw new Error("Work needs a claim");
  const [effect, event] = effects[row.step];
  if (state.lock) {
    state.handler = { ...state.handler, phase: "Returned Defer", outcome: { type: "Defer", delay: DEFER_DELAY } };
    return {
      active: "handler", kind: "warning",
      title: "The lock is busy. The handler returns Defer.",
      explanation: `Another instance, ${state.lock.holder}, holds the lock for the same workspace name. The handler can't take the lock, so it calls nothing. It returns Defer for 30 seconds.`,
      summary: "The lock was busy, so the handler returned Defer.",
      lesson: "A busy lock is contention, not a failure. Defer charges no attempt.",
      message: `Lock ${LOCK} is held by ${state.lock.holder}. Outcome: Defer for 30 seconds.`,
    };
  }
  if (fail === "notReady") {
    state.handler = { ...state.handler, phase: "Returned Defer", outcome: { type: "Defer", delay: DEFER_DELAY } };
    return {
      active: "handler", kind: "warning",
      title: "A dependency is not ready. The handler returns Defer.",
      explanation: "The handler takes its lock and finds that its input is not back yet. It calls nothing and returns Defer for 30 seconds.",
      summary: "A dependency was not ready yet, so the handler returned Defer.",
      lesson: "Use Defer for contention or a dependency that isn't ready.",
      message: "Dependency not ready. Outcome: Defer for 30 seconds.",
    };
  }
  if (fail === "park") {
    const until = state.time + 21600;
    state.handler = { ...state.handler, phase: "Returned Park", outcome: { type: "Park", until } };
    return {
      active: "handler",
      title: "The handler returns Park until a known time",
      explanation: `The account starts later. The handler returns Park with an absolute time: virtual ${formatTime(until)}. It charges nothing and holds nothing while it waits.`,
      summary: `The handler returned Park until virtual ${formatTime(until)}.`,
      lesson: "Park is a planned wait. A long park is healthy; a repeated defer is backpressure.",
      message: `Outcome: Park until virtual ${formatTime(until)}.`,
    };
  }
  if (fail === "transient") {
    state.external.calls[row.step] = (state.external.calls[row.step] ?? 0) + 1;
    state.external.lastResult = "transient error";
    state.handler = { ...state.handler, phase: "Returned Retry", outcome: { type: "Retry", delay: RETRY_DELAY, error: "External system unavailable" } };
    return {
      active: "external", kind: "warning",
      title: "The external system fails. The handler returns Retry.",
      explanation: "The handler takes its lock, and the completeness check finds nothing. The external call fails with a transient error. The handler commits nothing and returns Retry for 1 minute.",
      summary: "The external call failed with a transient error, so the handler returned Retry.",
      lesson: "Retry is for a failure. It consumes one attempt from the retry budget.",
      message: "External call failed transiently. Outcome: Retry in 1 minute.",
    };
  }
  const found = Boolean(state.external.effects[row.step]);
  if (!found) {
    state.external.calls[row.step] = (state.external.calls[row.step] ?? 0) + 1;
    state.external.effects[row.step] = 1;
  }
  state.external.lastResult = found ? "already done" : "ok";
  if (!state.business.includes(row.step)) {
    state.business.push(row.step);
    state.events.push({ eventId: `evt_${String(state.events.length + 1).padStart(3, "0")}`, type: event, instanceId: state.instance.id });
  }
  const outcome = target ? { type: "Done", target, reason } : { type: "Done" };
  state.handler = { ...state.handler, phase: "Returned Done", outcome };
  const returned = target ? `Done with target ${target}` : "Done";
  if (found) {
    return {
      active: "handler", found,
      title: "The completeness check absorbs the repeat",
      explanation: `The handler takes its lock and checks the external system. The work is already done: ${effect}. It makes no second call and returns ${returned}.`,
      summary: "The completeness check found the work already done, so the handler made no second call.",
      lesson: "A lock stops concurrent double submission. Only the completeness check stops a sequential one.",
      message: `Completeness check found the work done. No second external call. Outcome: ${returned}.`,
    };
  }
  const declared = !target || (definition.steps[row.step].alternates ?? []).includes(target);
  return {
    active: "handler", kind: declared ? "success" : "warning",
    title: declared ? "Work: the handler runs the business rule" : "The handler picks a target nobody declared",
    explanation: `The handler takes its lock and runs its completeness check. The work is not done, so it calls the external system: ${effect}. Then it commits its business write and the ${event} event in one transaction. It returns ${returned}.`,
    summary: `The handler ran its completeness check, called the external system, and committed its write with the ${event} event.`,
    lesson: target
      ? declared ? "A declared alternate is a routine branch. The flow works as designed." : "Handler targets are unconstrained. A handler can route to a step the definition doesn't list."
      : "The handler holds no retry loop and publishes no next step. It only returns an outcome.",
    message: `External call succeeded: ${effect}. Business write and ${event} committed. Outcome: ${returned}.`,
  };
}

// A failed attempt or a timeout charges the retry budget and can exhaust it.
function chargeAttempt(state, row, entry, error) {
  row.attempts += 1;
  row.lastError = error;
  if (row.attempts < row.maxAttempts) {
    row.status = "PENDING";
    row.nextAt = state.time + RETRY_DELAY;
    append(state, row, { from: "RUNNING", to: "PENDING", ...entry });
    return false;
  }
  row.status = "FAILED";
  row.nextAt = null;
  state.instance.status = "FAILED";
  state.instance.failureReason = `${row.step} exhausted its retry budget: ${error}`;
  append(state, row, { from: "RUNNING", to: "FAILED", ...entry });
  return true;
}

function record(state) {
  const row = currentRow(state);
  const outcome = state.handler.outcome;
  if (row.status !== "RUNNING" || !outcome) throw new Error("Record needs an outcome");
  state.handler = { phase: "Idle", worker: null, outcome: null };
  state.dispatcher = "Polling for due rows";
  row.lastOutcome = outcome.type;
  if (outcome.type === "Retry") {
    const exhausted = chargeAttempt(state, row, { outcome: "Retry", actor: "handler" }, outcome.error);
    if (exhausted) {
      return {
        active: "row", kind: "warning",
        title: "The retry budget is exhausted. The flow stops.",
        explanation: `This was attempt ${row.attempts} of ${row.maxAttempts}. The engine marks the step FAILED and clears its timer. The instance becomes FAILED with a reason, in the same transaction.`,
        summary: "The retry budget is exhausted. The step and the instance are FAILED.",
        shortTitle: "The retry budget is exhausted.",
        lesson: "A failed step stops the flow. Nothing compensates or reroutes it.",
        message: `attempts ${row.attempts}/${row.maxAttempts}. ${row.step} FAILED. Instance ${state.instance.id} FAILED.`,
      };
    }
    return {
      active: "row", kind: "warning",
      title: "Record: one attempt charged, timer set",
      explanation: `The engine sets the row back to PENDING, raises attempts to ${row.attempts} of ${row.maxAttempts}, and sets next_at to virtual ${formatTime(row.nextAt)}. The backoff is a database row, so it survives a restart.`,
      summary: `The engine charged one attempt (${row.attempts} of ${row.maxAttempts}) and set next_at to virtual ${formatTime(row.nextAt)}.`,
      shortTitle: "Retry. One attempt is charged.",
      lesson: "attempts changes only in the record transaction. A Retry costs an attempt, and a Defer does not.",
      message: `Retry recorded. attempts ${row.attempts}/${row.maxAttempts}; next_at ${formatTime(row.nextAt)}.`,
    };
  }
  if (outcome.type === "Defer") {
    row.status = "PENDING";
    row.deferCount += 1;
    row.nextAt = state.time + outcome.delay;
    append(state, row, { from: "RUNNING", to: "PENDING", outcome: "Defer", actor: "handler" });
    return {
      active: "row",
      title: "Record: a deferral, with no attempt charged",
      explanation: `The row returns to PENDING. defer_count is ${row.deferCount}, attempts stays ${row.attempts}, and next_at is virtual ${formatTime(row.nextAt)}.`,
      summary: `The engine raised defer_count to ${row.deferCount}, charged no attempt, and set next_at to virtual ${formatTime(row.nextAt)}.`,
      shortTitle: "Defer. No attempt is charged.",
      lesson: "A climbing defer_count means the step keeps waiting. A climbing dispatch_count means it keeps dying.",
      message: `Defer recorded. defer_count ${row.deferCount}; attempts ${row.attempts}; next_at ${formatTime(row.nextAt)}.`,
    };
  }
  if (outcome.type === "Park") {
    row.status = "PARKED";
    row.nextAt = outcome.until;
    append(state, row, { from: "RUNNING", to: "PARKED", outcome: "Park", actor: "handler" });
    return {
      active: "row",
      title: "Record: the row is PARKED",
      explanation: `The row is PARKED with next_at at virtual ${formatTime(row.nextAt)}. No counter changes. The dispatcher claims a PARKED row like a PENDING one, when it falls due.`,
      summary: `The row is PARKED until virtual ${formatTime(row.nextAt)}.`,
      shortTitle: "Park. The row waits for a known time.",
      lesson: "A flow that parks across a deployment finishes on the definition version it started on.",
      message: `Park recorded. next_at ${formatTime(row.nextAt)}; counters unchanged.`,
    };
  }
  const step = definition.steps[row.step];
  const target = outcome.target ?? step.next;
  const wasOverride = target !== step.next && !(step.alternates ?? []).includes(target);
  if (wasOverride && !outcome.reason) throw new Error("An undeclared target needs a reason");
  row.status = "COMPLETED";
  row.nextAt = null;
  state.instance.lastProgressAt = state.time;
  append(state, row, {
    from: "RUNNING", to: "COMPLETED", outcome: "Done", actor: "handler",
    target, defaultTarget: step.next, wasOverride, reason: target === step.next ? null : outcome.reason,
  });
  if (!target) {
    state.instance.status = "COMPLETED";
    return {
      active: "row",
      title: "The terminal step completes the instance",
      explanation: `${row.step} is a declared terminal. The record transaction marks it COMPLETED and sets the instance to COMPLETED. It creates no next row.`,
      summary: "The engine marked the terminal step COMPLETED. The instance is COMPLETED.",
      shortTitle: "Done on a terminal step. The flow is complete.",
      lesson: "Each step ran at least once, and each effect happened once.",
      message: `${row.step} COMPLETED. Instance ${state.instance.id} COMPLETED.`,
    };
  }
  state.rows.push(createRow(target, state.time));
  state.instance.currentStep = target;
  const base = `One transaction marks ${row.step} COMPLETED, creates the ${target} row as PENDING, appends the audit entry, and moves the instance position.`;
  if (wasOverride) {
    return {
      active: "row", kind: "warning",
      title: "Record: an undeclared transition is logged",
      explanation: `${base} ${target} is not the default and not a declared alternate. The audit entry sets was_override to true with a mandatory reason. ${step.next} never runs.`,
      summary: `The engine marked the step COMPLETED and created ${target}. That target is undeclared, so was_override is true.`,
      shortTitle: "Done, with an undeclared target",
      lesson: "The log and its alert are the control on routing. The control works only if someone monitors it.",
      message: `${row.step} COMPLETED. ${target} created. was_override: true; ${step.next} skipped.`,
    };
  }
  if (target !== step.next) {
    return {
      active: "row",
      title: "Record: a declared branch is logged",
      explanation: `${base} The target differs from the default ${step.next}, but it is a declared alternate. was_override stays false, and the log records the reason.`,
      summary: `The engine marked the step COMPLETED and created ${target}, a declared alternate to ${step.next}. was_override stays false.`,
      shortTitle: "Done, with a declared alternate target",
      lesson: "was_override means undeclared, not merely different. A routine branch must not raise the deviation alert.",
      message: `${row.step} COMPLETED. ${target} created. Declared alternate; was_override: false.`,
    };
  }
  return {
    active: "row",
    title: "Record: the engine writes the outcome and the next step",
    explanation: base,
    summary: `The engine marked the step COMPLETED and created ${target}.`,
    shortTitle: "Done. The flow moves to the next step.",
    lesson: "One active step per instance. The next row exists only after this step completes.",
    message: `${row.step} COMPLETED. ${target} created as PENDING.`,
  };
}

function timerDue(state) {
  const row = currentRow(state);
  if (terminal(row) || row.nextAt <= state.time) throw new Error("No timer is pending");
  state.time = row.nextAt;
  state.dispatcher = "Found a due row";
  const text = { active: "row", title: "The timer falls due", message: `next_at reached at virtual ${formatTime(state.time)}. The row is due.` };
  const clock = `The virtual clock advances to ${formatTime(state.time)}.`;
  if (state.lock) {
    const holder = state.lock.holder;
    state.lock = null;
    return { ...text,
      explanation: `${clock} The defer delay has elapsed, and ${holder} has released the lock. The row is due again.`,
      lesson: "The step row is the queue. Nothing is published to move a step." };
  }
  if (row.status === "RUNNING") {
    return { ...text,
      explanation: `${clock} The row is still RUNNING, and its next_at is no longer in the future. RUNNING rows are in scope for the poll, so the dispatcher finds it.`,
      lesson: "RUNNING carries no liveness. Alert on an overdue next_at, never on time in RUNNING." };
  }
  if (row.status === "PARKED") {
    return { ...text,
      explanation: `${clock} The park time has arrived, so the row is due.`,
      lesson: "The dispatcher reads an injectable clock. A test can advance time to fire a park or a backoff." };
  }
  if (row.lastError === "timeout") {
    return { ...text,
      explanation: `${clock} The backoff after the timeout has elapsed. The lease of the terminated worker has expired, and it sent no deregistration.`,
      lesson: "A lease that expires without a deregistration marks a host terminated for an uncooperative handler." };
  }
  return { ...text,
    explanation: `${clock} The backoff has elapsed, and the row is due again.`,
    lesson: "The step row is the queue. Nothing is published to move a step." };
}

function crash(state) {
  const row = currentRow(state);
  const worker = state.workers.find(item => item.node === state.handler.worker);
  const [effect] = effects[row.step];
  work(state);
  worker.alive = false;
  state.handler = { phase: "Process killed", worker: worker.node, outcome: null };
  state.dispatcher = `${worker.node} is down`;
  return {
    active: "handler", kind: "warning",
    title: "The process dies mid-handler",
    explanation: `The handler calls the external system and commits its own transaction: ${effect}. Then ${worker.node} is killed before the handler returns. The engine records nothing, and the row stays RUNNING with the claim's timer.`,
    lesson: "A crash between work and record leaves work with no audit entry. The dispatch number gap makes it detectable.",
    message: `${worker.node} killed after the handler's commit. No outcome recorded. Row stays RUNNING.`,
  };
}

function pollMiss(state) {
  if (claimer(state)) throw new Error("A row is claimable");
  const row = currentRow(state);
  state.time += 5;
  state.dispatcher = "Poll claimed nothing";
  if (state.instance.status === "FAILED") {
    return {
      active: "dispatcher", kind: "warning",
      title: "The dispatcher skips a failed instance",
      explanation: "The dispatcher polls for due rows and keeps only rows whose instance is ACTIVE. The failed step has no timer. Nothing is claimed, and nothing re-drives.",
      lesson: "The engine never re-runs a terminal step. Only an operator can.",
      message: `Poll claimed nothing. Instance ${state.instance.id} is FAILED.`,
    };
  }
  return {
    active: "dispatcher", kind: "warning",
    title: "A due row that nothing claims",
    explanation: `Each dispatcher claims only rows for the stages it hosts. No worker hosts ${stageOf(row.step)}. The row sits in PENDING with a due timer, and no process reports an error.`,
    lesson: "A process knows only its own stage filter. No process can assert that the fleet covers the flow.",
    message: `Poll claimed nothing. ${row.step} is due, and no worker hosts ${stageOf(row.step)}.`,
  };
}

function operatorRetry(state) {
  const row = currentRow(state);
  if (row.status !== "FAILED") throw new Error("Only a failed step can be retried");
  state.time += 600;
  row.status = "PENDING";
  row.attempts = 0;
  row.nextAt = state.time;
  state.instance.status = "ACTIVE";
  state.instance.failureReason = null;
  state.dispatcher = "Found a due row";
  append(state, row, { from: "FAILED", to: "PENDING", actor: "operator" });
  return {
    active: "row",
    title: "An operator retries the failed step",
    explanation: "After 10 virtual minutes, an operator retries the step. The row returns to PENDING with attempts reset to zero and a due timer. The instance returns to ACTIVE.",
    lesson: "The flow continues from where it broke. The audit log records the retry as the operator's action.",
    message: `Operator retry. ${row.step} PENDING; attempts 0. Instance ${state.instance.id} ACTIVE.`,
  };
}

function cancel(state) {
  const row = currentRow(state);
  state.time = row.nextAt - GRACE;
  state.lock = { key: LOCK, holder: state.instance.id };
  state.external.calls[row.step] = (state.external.calls[row.step] ?? 0) + 1;
  state.external.lastResult = "no response";
  state.handler = { ...state.handler, phase: "Ignoring cancellation" };
  return {
    active: "handler", kind: "warning",
    title: "The step exceeds its maximum duration",
    explanation: "The handler took its lock and called the external system. The call hangs. At the 2-minute maximum duration, the engine signals cancellation. This handler ignores the signal and keeps its lock.",
    lesson: "A well-behaved handler abandons its external call and returns. One that ignores cancellation is a defect.",
    message: `max_duration reached at virtual ${formatTime(state.time)}. Cancellation signalled; the handler ignores it.`,
  };
}

function abandon(state) {
  const row = currentRow(state);
  state.time += CANCEL_GRACE;
  row.lastOutcome = "Timeout";
  chargeAttempt(state, row, { outcome: "Timeout", actor: "dispatcher" }, "timeout");
  state.handler = { ...state.handler, phase: "Abandoned, still running" };
  return {
    active: "row", kind: "warning",
    title: "The engine stops waiting and records a timeout",
    explanation: `After a 10-second grace period, the engine abandons the handler. It records a timeout: attempts is ${row.attempts}, last_error names the timeout, and next_at is virtual ${formatTime(row.nextAt)}. The handler still runs and still holds its lock.`,
    lesson: "A timeout consumes an attempt, like a thrown error. last_error separates it from a handler-returned Failed.",
    message: `Timeout recorded. attempts ${row.attempts}/${row.maxAttempts}; next_at ${formatTime(row.nextAt)}. The handler still holds its lock.`,
  };
}

function hostTerminates(state) {
  const worker = state.workers.find(item => item.node === state.handler.worker);
  worker.alive = false;
  state.lock = null;
  state.handler = { phase: "Host terminated", worker: worker.node, outcome: null };
  state.dispatcher = `${worker.node} is down`;
  return {
    active: "handler", kind: "warning",
    title: "The host process terminates",
    explanation: `Most runtimes can't kill a running task, and this handler could still commit. So ${worker.node} exits on purpose. Its connection drops, and the database releases the lock. It sends no deregistration, so its lease runs out.`,
    lesson: "Failing fast is the proportionate response. The step re-drives on another node.",
    message: `${worker.node} terminated. Lock released. Its lease is left to expire.`,
  };
}

function coverage(state) {
  state.time += 55;
  state.unhosted = unhostedStages(state);
  if (!state.unhosted.length) throw new Error("Every stage is hosted");
  state.dispatcher = `Coverage alert: ${state.unhosted.join(", ")}`;
  return {
    active: "dispatcher", kind: "warning",
    title: "The registry reports the unhosted stage",
    explanation: `The coverage query compares the stages in the current definition with the stages that live workers host. It reports ${state.unhosted.join(", ")} within one lease period. The overdue next_at confirms it.`,
    lesson: "Report coverage as a metric and an alert. Don't wire it to a health probe.",
    message: `Coverage alert: no live worker hosts ${state.unhosted.join(", ")}.`,
  };
}

function workerJoins(state) {
  const hosted = state.unhosted;
  state.workers.push({ node: "worker-c", stages: hosted, leaseExpiresAt: state.time + LEASE, alive: true });
  state.unhosted = unhostedStages(state);
  state.dispatcher = "Found a due row";
  return {
    active: "dispatcher",
    title: "A worker group for the stage registers",
    explanation: `worker-c starts with a stage filter of ${hosted.join(", ")} and registers itself with a lease. The registry now shows the stage as hosted, and the dispatcher of worker-c can claim the waiting row.`,
    lesson: "The registry never gates dispatch. A stale registry costs visibility and never throughput.",
    message: `worker-c registered for ${hosted.join(", ")}. Coverage is complete.`,
  };
}

// One click for a whole step run: wait for the timer if needed, then claim, work, and record.
function run(state, options = {}) {
  const row = currentRow(state);
  const waited = row.nextAt > state.time;
  if (waited) timerDue(state);
  const prefix = waited ? `The timer fell due at virtual ${formatTime(state.time)}. ` : "";
  claim(state);
  const worker = state.handler.worker;
  if (options.crash) {
    const crashed = crash(state);
    return { ...crashed, active: "row", explanation: `${prefix}${worker} claimed the row. ${crashed.explanation}` };
  }
  const worked = work(state, options);
  const recorded = record(state);
  return {
    active: "row", kind: recorded.kind ?? worked.kind,
    title: worked.found ? "Re-driven. The completeness check returns Done." : recorded.shortTitle,
    explanation: `${prefix}${worker} claimed the row. ${worked.summary} ${recorded.summary}`,
    lesson: worked.found ? worked.lesson : recorded.lesson,
    message: worked.found ? `Re-driven on ${worker}. No second external call. ${recorded.message}` : recorded.message,
  };
}

function alternate(state) {
  const target = definition.steps[state.instance.currentStep].alternates[0];
  return { target, reason: reasons[target] };
}

const actions = {
  claim, record, timerDue, crash, pollMiss, operatorRetry, cancel, abandon, hostTerminates, coverage, workerJoins,
  work: state => work(state),
  workRetry: state => work(state, { fail: "transient" }),
  workPark: state => work(state, { fail: "park" }),
  workAlternate: state => work(state, alternate(state)),
  workOverride: state => work(state, { target: "WORKSPACE/CREATE", reason: "The review confirmed the name, so the handler skipped WORKSPACE/ADJUST." }),
  run: state => run(state),
  runRetry: state => run(state, { fail: "transient" }),
  runWait: state => run(state, { fail: "notReady" }),
  runAlternate: state => run(state, alternate(state)),
  runCrash: state => run(state, { crash: true }),
};

export function advance(previous) {
  const action = scenarios[previous.scenario].steps[previous.step];
  if (!action) return previous;
  const state = structuredClone(previous);
  state.step += 1;
  const stepKey = state.instance.currentStep;
  const text = actions[action](state);
  for (const worker of state.workers) if (worker.alive) worker.leaseExpiresAt = state.time + LEASE;
  state.unhosted = unhostedStages(state);
  state.active = text.active;
  state.title = text.title;
  state.explanation = text.explanation;
  state.lesson = text.lesson;
  state.timeline.push({ step: state.step, time: state.time, stepKey, message: text.message, kind: text.kind ?? "success" });
  return state;
}

export function isComplete(state) {
  return state.step === scenarios[state.scenario].steps.length;
}

export function formatTime(seconds) {
  const pad = value => String(value).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${pad(minutes)}:${pad(seconds % 60)}`;
  return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds % 60)}`;
}
