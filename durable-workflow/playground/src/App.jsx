import { useEffect, useRef, useState } from "react";
import {
  IconArrowDown, IconArrowRight, IconBolt, IconCheck, IconCircle, IconCircleCheck,
  IconClock, IconCube, IconDatabase, IconInfoCircle, IconLock, IconPlayerPause,
  IconPlayerPlay, IconRotateClockwise, IconServer, IconSettings, IconX,
} from "./icons.jsx";
import { advance, createSimulation, definition, formatTime, isComplete, scenarios } from "./simulation.js";

const standalone = globalThis.location?.protocol === "file:";
const playbook = standalone ? "https://yavosh.github.io/design/workflow/guide/" : "./guide/";
const guidesIndex = standalone ? "https://yavosh.github.io/design/" : "../";
const warnings = ["Process killed", "Ignoring cancellation", "Abandoned, still running", "Host terminated"];

function Connector() {
  return <span className="connector"><IconArrowRight size={33} stroke={1.5} /><IconArrowDown className="mobile-arrow" size={28} stroke={1.5} /></span>;
}

export function App() {
  const [state, setState] = useState(() => createSimulation());
  const [playing, setPlaying] = useState(false);
  const [inspector, setInspector] = useState(null);
  const [showAllLogs, setShowAllLogs] = useState(false);
  const failureDialog = useRef(null);
  const inspectorDialog = useRef(null);
  const complete = isComplete(state);
  const scenario = scenarios[state.scenario];
  const row = state.rows.find(item => item.step === state.instance.currentStep);
  const due = row.nextAt !== null && row.nextAt <= state.time && row.status !== "RUNNING";
  const next = state.instance.status === "COMPLETED" ? null : definition.steps[row.step].next;
  const outcome = state.handler.outcome;
  const calls = state.external.calls[row.step] ?? 0;

  useEffect(() => {
    if (!playing || complete) return;
    const timer = setTimeout(() => setState(previous => advance(previous)), 1800);
    return () => clearTimeout(timer);
  }, [playing, complete, state.step]);

  useEffect(() => { if (complete) setPlaying(false); }, [complete]);

  function selectScenario(key) {
    setPlaying(false);
    setState(createSimulation(key));
    setShowAllLogs(false);
    failureDialog.current.close();
  }

  function inspect(section) {
    setPlaying(false);
    setInspector(section);
    inspectorDialog.current.showModal();
  }

  const inspectorData = inspector === "Instance" ? { instance: state.instance, auditLog: state.log }
    : inspector === "Step rows" ? state.rows
    : inspector === "Dispatcher" ? { status: state.dispatcher, virtualSeconds: state.time, workers: state.workers, unhostedStages: state.unhosted }
    : inspector === "Handler" ? { ...state.handler, lock: state.lock, businessWrites: state.business, outbox: state.outbox }
    : state.external;

  return <main className="playground">
    <header className="masthead">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); selectScenario("normal"); }}>
        <IconCube size={34} stroke={1.6} /><span>Workflow Playground</span>
      </a>
      <nav className="header-links" aria-label="Guide navigation">
        <a className="guides-link" href={guidesIndex}>Design guides</a>
        <a className="playbook-link" href={playbook} target="_blank" rel="noreferrer">Read the playbook <IconArrowRight size={17} /></a>
      </nav>
    </header>
    <section className="intro" aria-labelledby="page-title">
      <h1 id="page-title">Workflow step flow</h1>
      <p>Run one record through its steps, and see what the engine does when a step waits, fails, or dies.</p>
    </section>
    <div className="scenario-bar">
      <label htmlFor="scenario">Scenario</label>
      <select id="scenario" value={state.scenario} onChange={event => selectScenario(event.target.value)}>
        {Object.entries(scenarios).map(([key, item]) => <option key={key} value={key}>{item.name}</option>)}
      </select>
      <div className="simulation-note"><span className="simulation-tag">Simulation</span><span>Explore safely. Nothing connects to a live system.</span></div>
      <span className="virtual-clock" title="Time advances only when a simulation step requires it."><IconClock size={17} /> Virtual {formatTime(state.time)}</span>
    </div>
    <section className="simulation" aria-label="Interactive workflow engine">
      <div className="stage-row">
        <span className="stage-label">{complete && <IconCheck size={20} />}{state.step} / {scenario.steps.length} <span className="stage-dot">·</span> {complete ? "Scenario complete" : state.step ? "Follow the step" : "Ready when you are"}</span>
        <span className="diagram-hint">Select a component to inspect its state</span>
      </div>
      <button className={`instance node ${state.instance.status === "FAILED" ? "has-warning" : ""}`} onClick={() => inspect("Instance")}>
        <span className="instance-heading">
          <strong>Instance <code>{state.instance.id}</code></strong>
          <span>{state.instance.entityKind} <code>{state.instance.entityId}</code> · {state.instance.definitionKey} v{state.instance.definitionVersion}</span>
          <span className={`status status-${state.instance.status.toLowerCase()}`}>{state.instance.status}</span>
        </span>
        <span className="chips">
          {state.rows.map(item => <span className={`chip chip-${item.status.toLowerCase()}`} key={item.step}>{item.status === "COMPLETED" && <IconCheck size={14} />}{item.step}</span>)}
          {next && <span className="chip chip-next">{next}</span>}
        </span>
      </button>
      <div className="pipeline">
        <button className={`step-row node ${state.active === "row" ? "is-active" : ""} ${row.status === "FAILED" ? "has-warning" : ""}`} onClick={() => inspect("Step rows")}>
          <span className="node-heading"><IconDatabase size={34} stroke={1.6} /><strong>Step row</strong></span>
          <span className="event-token has-event">{row.step}</span>
          <span className="row-status"><span className={`status status-${row.status.toLowerCase()}`}>{row.status}</span>{due && <span className="status status-due">DUE</span>}</span>
          <span className="row-fields">
            <span><code>attempts</code><b>{row.attempts} / {row.maxAttempts}</b></span>
            <span><code>dispatch_count</code><b>{row.dispatchCount}</b></span>
            <span><code>defer_count</code><b>{row.deferCount}</b></span>
            <span><code>next_at</code><b>{row.nextAt === null ? "cleared" : formatTime(row.nextAt)}</b></span>
          </span>
        </button>
        <Connector />
        <button className={`dispatcher node ${state.active === "dispatcher" ? "is-active" : ""} ${state.unhosted.length ? "has-warning" : ""}`} onClick={() => inspect("Dispatcher")}>
          <span className="node-heading"><IconClock size={34} stroke={1.6} /><strong>Dispatcher</strong></span>
          <span className="node-state">{state.dispatcher}</span>
          <span className="workers">{state.workers.map(worker => <span className={`worker ${worker.alive ? "worker-live" : "worker-down"}`} key={worker.node}>{worker.node}<span>{worker.alive ? "live" : worker.leaseExpiresAt > state.time ? `down · lease to ${formatTime(worker.leaseExpiresAt)}` : "lease expired"}</span></span>)}</span>
          {state.unhosted.length > 0 && <span className="node-note">Unhosted: {state.unhosted.join(", ")}</span>}
        </button>
        <Connector />
        <button className={`handler node ${state.active === "handler" ? "is-active" : ""} ${warnings.includes(state.handler.phase) ? "has-warning" : ""}`} onClick={() => inspect("Handler")}>
          <span className="node-heading"><IconSettings size={34} stroke={1.6} /><strong>Handler</strong></span>
          <span className="node-state">{state.handler.phase}{state.handler.worker ? ` on ${state.handler.worker}` : ""}</span>
          <span className="lock-line"><IconLock size={16} /><code>{state.lock?.key ?? "resource_7"}</code>{state.lock ? `held by ${state.lock.holder}` : "free"}</span>
          <span className="node-note">{outcome ? `Outcome: ${outcome.type}${outcome.target ? ` → ${outcome.target}` : ""}` : "No outcome to record"}</span>
        </button>
        <Connector />
        <button className={`external node ${state.active === "external" ? "is-active" : ""} ${["transient error", "no response"].includes(state.external.lastResult) ? "has-warning" : ""}`} onClick={() => inspect("External system")}>
          <span className="node-heading"><IconServer size={34} stroke={1.6} /><strong>External system</strong></span>
          <span className={`event-token ${state.external.effects[row.step] ? "has-event" : ""}`}>{state.external.effects[row.step] ? "Effect applied once" : "No effect yet"}</span>
          <span className="node-note">{calls} {calls === 1 ? "call" : "calls"} for this step{state.external.lastResult ? ` · last: ${state.external.lastResult}` : ""}</span>
        </button>
      </div>
      <p className="pipeline-caption">Claim and record are engine transactions on the step row. Work belongs to the handler.</p>
    </section>
    <section className="explanation" aria-live="polite" aria-atomic="true">
      <h2>{state.title}</h2>
      <p>{state.explanation}</p>
    </section>
    <div className="controls">
      <div className="playback-controls">
        <button className="primary-button" disabled={complete} onClick={() => { setPlaying(false); setState(previous => advance(previous)); }}>
          {complete ? "Complete" : "Next step"}{complete ? <IconCheck size={21} /> : <IconArrowRight size={21} />}
        </button>
        <button className="secondary-button" disabled={complete} onClick={() => setPlaying(previous => !previous)}>
          {playing ? <IconPlayerPause size={21} /> : <IconPlayerPlay size={21} />}{playing ? "Pause" : "Play"}
        </button>
        <button className="secondary-button" onClick={() => selectScenario(state.scenario)}><IconRotateClockwise size={21} />Reset</button>
      </div>
      <button className="failure-button" onClick={() => { setPlaying(false); failureDialog.current.showModal(); }}><IconBolt size={22} />Try a failure</button>
    </div>
    <section className="timeline" aria-labelledby="timeline-heading">
      <div className="timeline-heading"><h3 id="timeline-heading">Step timeline</h3>{state.timeline.length > 3 && <button className="text-button" onClick={() => setShowAllLogs(previous => !previous)}>{showAllLogs ? "Show latest" : `Show all ${state.timeline.length} steps`}</button>}</div>
      <ol>
        {!state.timeline.length && <li className="empty-log"><IconCircle size={19} /><code>{row.step}</code><span>The step row is the queue. Nothing has claimed it yet.</span></li>}
        {(showAllLogs ? state.timeline : state.timeline.slice(-3)).map(entry => <li className={entry.kind} key={entry.step}>
          {entry.kind === "warning" ? <IconInfoCircle size={19} /> : <IconCircleCheck size={19} />}<code>{entry.stepKey}</code><span>{entry.message}</span><time>{formatTime(entry.time)}</time>
        </li>)}
      </ol>
    </section>
    <div className="takeaway"><IconInfoCircle size={19} /><p>{state.lesson}</p></div>
    <footer className="page-footer"><span>One instance. One active step. Each effect once.</span><span>Example settings · Virtual time · No broker takes part</span></footer>
    <dialog ref={failureDialog} aria-labelledby="failure-title" className="scenario-dialog" onClick={event => { if (event.target === event.currentTarget) failureDialog.current.close(); }}>
      <div className="dialog-heading"><div><span className="eyebrow">LEARN BY EXPERIMENTING</span><h2 id="failure-title">What could go wrong?</h2></div><button aria-label="Close scenarios" className="icon-button" onClick={() => failureDialog.current.close()}><IconX /></button></div>
      <p className="dialog-description">Choose a scenario. Each experiment starts fresh and explains its recovery.</p>
      <div className="scenario-options">{Object.entries(scenarios).filter(([, item]) => item.failure).map(([key, item]) => <button key={key} onClick={() => selectScenario(key)}><span><strong>{item.name}</strong><span>{item.description}</span></span><IconArrowRight size={20} /></button>)}</div>
    </dialog>
    <dialog ref={inspectorDialog} aria-labelledby="inspector-title" className="inspector-dialog" onClick={event => { if (event.target === event.currentTarget) inspectorDialog.current.close(); }}>
      <div className="dialog-heading"><div><span className="eyebrow">SIMULATED STATE</span><h2 id="inspector-title">{inspector}</h2></div><button aria-label="Close state inspector" className="icon-button" onClick={() => inspectorDialog.current.close()}><IconX /></button></div>
      <p className="dialog-description">{inspector === "Instance" ? "The audit log is append-only. Claims write no entry, so a crashed run leaves a gap in the dispatch numbers." : "The state below changes as you step through the scenario."}</p>
      <pre>{JSON.stringify(inspectorData, null, 2)}</pre>
    </dialog>
  </main>;
}
