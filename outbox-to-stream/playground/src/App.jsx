import { useEffect, useRef, useState } from "react";
import {
  IconArrowDown, IconArrowRight, IconBolt, IconChartBar, IconCheck,
  IconCircle, IconCircleCheck, IconClock, IconCube, IconDatabase,
  IconFileDescription, IconInfoCircle, IconPlayerPause, IconPlayerPlay,
  IconRotateClockwise, IconSettings, IconShieldCheck, IconX,
} from "./icons.jsx";
import { advance, createSimulation, formatTime, isComplete, scenarios } from "./simulation.js";

const playbook = "https://github.com/yavosh/design/blob/main/outbox-to-stream/Outbox-to-Stream%20Playbook.md";

function Consumer({ name, consumer, entries, onInspect }) {
  const pending = entries.length - consumer.acknowledged.length;
  return <button className={`consumer node ${consumer.failed ? "has-warning" : ""}`} onClick={onInspect}>
    <IconDatabase size={33} stroke={1.6} className="node-icon" />
    <span className="consumer-copy">
      <strong>{name}</strong>
      <span>{consumer.failed ? "Failed · entry stays pending" : consumer.effects
        ? name === "Read model" ? "1 local record updated" : "1 delivery job committed"
        : "Deduplicates in its own database, then acknowledges."}</span>
      {consumer.effects > 0 && <span className="consumer-result"><IconCircleCheck size={16} />
        {consumer.duplicates ? "Duplicate ignored" : "Effect committed"}
        <span className="ack-label">{pending ? `${pending} pending` : "Acknowledged"}</span>
      </span>}
    </span>
  </button>;
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

  const inspectorData = inspector === "Producer database"
    ? { businessCommitted: state.business, outbox: state.outbox && { ...state.outbox, payload: JSON.parse(state.outbox.payload) } }
    : inspector === "Relay" ? { status: state.relay, claims: state.claims, rejectedStaleUpdates: state.staleUpdates,
      claimToken: state.outbox?.claimToken ?? null, virtualSeconds: state.time, nextEligibleAt: state.outbox?.nextAttemptAt ?? null }
    : inspector === "Durable stream" ? state.stream.map(entry => ({ ...entry, payload: JSON.parse(entry.payload) }))
    : inspector === "Read model" ? state.consumers.readModel : state.consumers.deliveryJobs;

  return <main className="playground">
    <header className="masthead">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); selectScenario("normal"); }}>
        <IconCube size={34} stroke={1.6} /><span>Outbox Playground</span>
      </a>
      <nav className="header-links" aria-label="Guide navigation">
        <a className="guides-link" href="../">Design guides</a>
        <a className="playbook-link" href={playbook} target="_blank" rel="noreferrer">Read the playbook <IconArrowRight size={17} /></a>
      </nav>
    </header>
    <section className="intro" aria-labelledby="page-title">
      <h1 id="page-title">Outbox event flow</h1>
      <p>Commit a change, follow its delivery, and see what happens when something fails.</p>
    </section>
    <div className="scenario-bar">
      <label htmlFor="scenario">Scenario</label>
      <select id="scenario" value={state.scenario} onChange={event => selectScenario(event.target.value)}>
        {Object.entries(scenarios).map(([key, item]) => <option key={key} value={key}>{item.name}</option>)}
      </select>
      <div className="simulation-note"><span className="simulation-tag">Simulation</span><span>Explore safely. Nothing connects to a live system.</span></div>
      <span className="virtual-clock" title="Time advances only when a simulation step requires it."><IconClock size={17} /> Virtual {formatTime(state.time)}</span>
    </div>
    <section className="simulation" aria-label="Interactive event pipeline">
      <div className="stage-row">
        <span className="stage-label">{complete && <IconCheck size={20} />}{state.step} / {scenario.steps.length} <span className="stage-dot">·</span> {complete ? "Scenario complete" : state.step ? "Follow the event" : "Ready when you are"}</span>
        <span className="diagram-hint">Select a component to inspect its state</span>
      </div>
      <div className={`pipeline active-${state.active}`}>
        <button className={`producer node ${state.active === "producer" ? "is-active" : ""}`} onClick={() => inspect("Producer database")}>
          <span className="node-heading"><IconDatabase size={34} stroke={1.6} /><strong>Producer database</strong></span>
          <span className="transaction-records">
            <span className="record"><IconFileDescription size={31} stroke={1.6} /><span><strong>Business<br />change</strong><span className={`record-state ${state.business ? "success-text" : ""}`}>{state.business ? "Committed" : state.draft ? "Uncommitted" : "Not committed"}</span></span></span>
            <span className="transaction-plus" aria-label="and">+</span>
            <span className="record outbox-record"><IconFileDescription size={31} stroke={1.6} /><span><strong>Outbox row</strong><span className={`status status-${state.outbox?.status.toLowerCase() ?? "empty"}`}>{state.outbox?.status ?? (state.draft ? "UNCOMMITTED" : "NO EVENT")}</span></span></span>
          </span>
          <span className="transaction-caption"><IconShieldCheck size={16} />One database transaction<br /><span>commits both together</span></span>
        </button>
        <span className="connector"><IconArrowRight size={33} stroke={1.5} /><IconArrowDown className="mobile-arrow" size={28} stroke={1.5} /></span>
        <button className={`relay node ${state.active === "relay" ? "is-active" : ""} ${["Crashed", "Backing off"].includes(state.relay) ? "has-warning" : ""}`} onClick={() => inspect("Relay")}>
          <span className="node-heading"><IconSettings size={34} stroke={1.6} /><strong>Relay</strong></span>
          <span className={`event-token ${state.outbox ? "has-event" : ""}`}>{state.outbox ? "evt_001" : "No event yet"}</span>
          <span className="relay-detail">{state.outbox?.claimToken ? <>claim: <code>{state.outbox.claimToken}</code></> : "Waiting for due work"}</span>
          {state.relay !== "Claimed" && state.outbox && <span className="relay-state">{state.relay}</span>}
        </button>
        <span className="connector"><IconArrowRight size={33} stroke={1.5} /><IconArrowDown className="mobile-arrow" size={28} stroke={1.5} /></span>
        <div className="stream-wrap">
          <button className={`stream node ${state.active === "stream" ? "is-active" : ""}`} onClick={() => inspect("Durable stream")}>
            <span className="node-heading"><IconChartBar size={36} stroke={1.6} /><strong>Durable<br />stream</strong></span>
            {state.stream.length > 0 && <span className="stream-entries">{state.stream.map(entry => <span className="event-token has-event" key={entry.entryId}>evt_001</span>)}</span>}
          </button>
          <p>May deliver duplicates<br />Each group reads independently.</p>
        </div>
        <span className="connector fanout"><IconArrowRight size={33} stroke={1.5} /><IconArrowDown className="mobile-arrow" size={28} stroke={1.5} /></span>
        <div className={`consumers ${state.active === "consumers" ? "is-active" : ""}`}>
          <Consumer name="Read model" consumer={state.consumers.readModel} entries={state.stream} onInspect={() => inspect("Read model")} />
          <Consumer name="Delivery jobs" consumer={state.consumers.deliveryJobs} entries={state.stream} onInspect={() => inspect("Delivery jobs")} />
        </div>
      </div>
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
      <div className="timeline-heading"><h3 id="timeline-heading">Event timeline</h3>{state.log.length > 3 && <button className="text-button" onClick={() => setShowAllLogs(previous => !previous)}>{showAllLogs ? "Show latest" : `Show all ${state.log.length} steps`}</button>}</div>
      <ol>
        {!state.log.length && <li className="empty-log"><IconCircle size={19} /><code>evt_001</code><span>Your event journey starts with a single transaction.</span></li>}
        {(showAllLogs ? state.log : state.log.slice(-3)).map(entry => <li className={entry.kind} key={entry.step}>
          {entry.kind === "warning" ? <IconInfoCircle size={19} /> : <IconCircleCheck size={19} />}<code>evt_001</code><span>{entry.message}</span><time>{formatTime(entry.time)}</time>
        </li>)}
      </ol>
    </section>
    <div className="takeaway"><IconInfoCircle size={19} /><p>{state.lesson}</p></div>
    <footer className="page-footer"><span>One fact. One stable event id. Independent consumers.</span><span>Example timings · Virtual time · No strict ordering guarantee</span></footer>
    <dialog ref={failureDialog} aria-labelledby="failure-title" className="scenario-dialog" onClick={event => { if (event.target === event.currentTarget) failureDialog.current.close(); }}>
      <div className="dialog-heading"><div><span className="eyebrow">LEARN BY EXPERIMENTING</span><h2 id="failure-title">What could go wrong?</h2></div><button aria-label="Close scenarios" className="icon-button" onClick={() => failureDialog.current.close()}><IconX /></button></div>
      <p className="dialog-description">Choose a scenario. Each experiment starts fresh and explains its recovery.</p>
      <div className="scenario-options">{Object.entries(scenarios).filter(([key]) => key !== "normal").map(([key, item]) => <button key={key} onClick={() => selectScenario(key)}><span><strong>{item.name}</strong><span>{item.description}</span></span><IconArrowRight size={20} /></button>)}</div>
    </dialog>
    <dialog ref={inspectorDialog} aria-labelledby="inspector-title" className="inspector-dialog" onClick={event => { if (event.target === event.currentTarget) inspectorDialog.current.close(); }}>
      <div className="dialog-heading"><div><span className="eyebrow">SIMULATED STATE</span><h2 id="inspector-title">{inspector}</h2></div><button aria-label="Close state inspector" className="icon-button" onClick={() => inspectorDialog.current.close()}><IconX /></button></div>
      <p className="dialog-description">{inspector === "Delivery jobs" ? "Effects count durable jobs inserted locally. External delivery runs in a separate worker." : "The state below changes as you step through the scenario."}</p>
      <pre>{JSON.stringify(inspectorData, null, 2)}</pre>
    </dialog>
  </main>;
}
