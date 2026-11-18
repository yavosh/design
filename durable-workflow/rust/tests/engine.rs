use durable_workflow::{
    Claim, Definition, Engine, Outcome, RECOVERY_MARGIN, Result, Route,
    activity::{Activity, CATALOG, Onboarding, onboarding},
    worker,
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::{
        Arc, Barrier,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const FIRST: &str = "SIGNUP/NORMALISE";
const SECOND: &str = "PROFILE/ENRICH";

struct Fixture {
    dir: PathBuf,
    db: PathBuf,
    engine: Engine,
}
impl Fixture {
    fn new() -> Result<Self> {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "workflow-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir)?;
        let db = dir.join("workflow.db");
        let engine = Engine::init(&db)?;
        Ok(Self { dir, db, engine })
    }
    fn pending(&mut self, d: &Definition) -> Result<i64> {
        let id = self.engine.draft("flow", d, "author")?;
        self.engine.submit(id, "author")?;
        Ok(id)
    }
    fn start(&mut self, d: &Definition) -> Result<i64> {
        let id = self.pending(d)?;
        self.engine.approve(id, "reviewer", CATALOG)?;
        self.engine
            .start("flow", "account", "abc", &json!({"test":true}), 100)
    }
    fn sql(&self) -> Connection {
        Connection::open(&self.db).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn all() -> Vec<String> {
    worker::hosted(CATALOG, &[]).unwrap()
}
fn claim(e: &mut Engine, at: i64) -> Claim {
    e.claim(&all(), 1, at).unwrap().pop().unwrap()
}
fn one() -> Definition {
    serde_json::from_value(json!({"start":FIRST,"terminals":[FIRST],"steps":{(FIRST):{"max_attempts":2,"max_duration":1}}})).unwrap()
}
fn routed(target: &str) -> Outcome {
    Outcome::Done {
        route: Some(Route {
            target: target.into(),
            reason: "chosen by activity".into(),
        }),
        payload: json!(42),
    }
}

#[test]
fn stale_records_cannot_transition_or_charge_new_claims() -> Result<()> {
    let mut f = Fixture::new()?;
    let id = f.start(&one())?;
    let old = claim(&mut f.engine, 100);
    let mut replica = Engine::open(&f.db)?;
    assert!(replica.claim(&all(), 1, 100 + RECOVERY_MARGIN)?.is_empty());
    let new = claim(&mut replica, 101 + RECOVERY_MARGIN);
    for result in [
        Outcome::done(Value::Null),
        Outcome::Retry {
            delay: 1,
            reason: "late error".into(),
        },
        Outcome::Failed {
            reason: "late".into(),
        },
    ] {
        assert!(!f.engine.record(&old, result, 200)?);
    }
    assert_eq!(replica.status(id)?["attempts"], 0);
    assert_eq!(replica.audit(id)?.len(), 1);
    assert!(replica.record(&new, Outcome::done(Value::Null), 201)?);
    assert!(!replica.record(&new, Outcome::done(Value::Null), 202)?);
    assert_eq!(replica.status(id)?["status"], "COMPLETED");
    Ok(())
}
#[test]
fn timers_budgets_and_operator_retry_survive_restart() -> Result<()> {
    let mut f = Fixture::new()?;
    let id = f.start(&one())?;
    for (at, res, next, attempts, deferrals) in [
        (100, Outcome::Defer { delay: 4 }, 104, 0, 1),
        (104, Outcome::Park { until: 120 }, 120, 0, 1),
        (
            120,
            Outcome::Retry {
                delay: 7,
                reason: "temporary".into(),
            },
            127,
            1,
            1,
        ),
    ] {
        let c = claim(&mut f.engine, at);
        f.engine.record(&c, res, at)?;
        f.engine = Engine::open(&f.db)?;
        assert!(f.engine.claim(&all(), 1, next - 1)?.is_empty());
        assert_eq!(f.engine.status(id)?["attempts"], attempts);
        assert_eq!(f.engine.status(id)?["deferrals"], deferrals);
    }
    let c = claim(&mut f.engine, 127);
    f.engine.record(
        &c,
        Outcome::Retry {
            delay: 3,
            reason: "unavailable".into(),
        },
        127,
    )?;
    assert_eq!(f.engine.status(id)?["status"], "FAILED");
    assert!(f.engine.claim(&all(), 1, 1000)?.is_empty());
    f.engine.retry(id, "on-call", 130)?;
    let next = claim(&mut f.engine, 130);
    assert_eq!(next.dispatch, c.dispatch + 1);
    assert_eq!(f.engine.status(id)?["attempts"], 0);
    f.engine.record(
        &next,
        Outcome::Failed {
            reason: "rejected".into(),
        },
        130,
    )?;
    assert_eq!(f.engine.status(id)?["attempts"], 0);
    assert!(
        f.engine
            .audit(id)?
            .iter()
            .any(|r| r["actor"] == "operator" && r["reason"] == "on-call")
    );
    Ok(())
}
#[test]
fn record_rolls_back_on_successor_or_audit_failure() -> Result<()> {
    let mut f = Fixture::new()?;
    let id = f.start(&onboarding())?;
    let c = claim(&mut f.engine, 100);
    for table in ["execution", "audit"] {
        let db = f.sql();
        db.execute_batch(&format!("CREATE TRIGGER injected BEFORE INSERT ON {table} BEGIN SELECT raise(ABORT,'injected'); END;"))?;
        assert!(f.engine.record(&c, Outcome::done(json!(1)), 101).is_err());
        assert_eq!(f.engine.status(id)?["stepStatus"], "RUNNING");
        assert_eq!(f.engine.audit(id)?.len(), 1);
        db.execute_batch("DROP TRIGGER injected")?;
    }
    f.engine.record(&c, Outcome::done(json!(1)), 101)?;
    let next = claim(&mut f.engine, 101);
    assert_eq!(next.step, SECOND);
    assert_eq!(next.input, 1);
    assert_eq!(next.typed_input::<String>(), None);
    Ok(())
}
#[test]
fn approval_is_atomic_and_concurrent_drafts_share_one_winner() -> Result<()> {
    let mut f = Fixture::new()?;
    let id = f.start(&onboarding())?;
    let a = f.pending(&one())?;
    let b = f.pending(&one())?;
    assert!(f.engine.approve(a, "author", CATALOG).is_err());
    let db = f.sql();
    db.execute_batch("CREATE TRIGGER injected BEFORE INSERT ON definition BEGIN SELECT raise(ABORT,'injected'); END;")?;
    assert!(f.engine.approve(a, "reviewer", CATALOG).is_err());
    assert_eq!(
        db.query_row(
            "SELECT version FROM definition WHERE valid_until IS NULL",
            [],
            |r| r.get::<_, i64>(0)
        )?,
        1
    );
    db.execute_batch("DROP TRIGGER injected")?;
    let barrier = Barrier::new(2);
    let approve = |draft| {
        let mut e = Engine::open(&f.db).unwrap();
        barrier.wait();
        e.approve(draft, "reviewer", CATALOG)
    };
    let results = thread::scope(|s| {
        let left = s.spawn(|| approve(a));
        let right = s.spawn(|| approve(b));
        [left.join().unwrap(), right.join().unwrap()]
    });
    assert_eq!(results.iter().filter(|r| matches!(r, Ok(2))).count(), 1);
    assert_eq!(f.engine.status(id)?["version"], 1);
    let first = claim(&mut f.engine, 100);
    f.engine.record(&first, Outcome::done(Value::Null), 100)?;
    assert_eq!(f.engine.status(id)?["step"], SECOND);
    assert!(db.execute("UPDATE definition SET spec='{}'", []).is_err());
    assert!(db.execute("DELETE FROM audit", []).is_err());
    Ok(())
}
#[test]
fn invalid_definitions_and_unregistered_workers_are_rejected() -> Result<()> {
    let mut f = Fixture::new()?;
    let mut flow = onboarding();
    flow.steps.get_mut(SECOND).unwrap().next = Some(FIRST.into());
    let draft = f.pending(&flow)?;
    assert!(f.engine.approve(draft, "reviewer", CATALOG).is_err());
    f.engine.reject(draft, "reviewer")?;
    assert!(f.engine.submit(draft, "author").is_err());
    assert!(worker::hosted(CATALOG, &["MISSING".into()]).is_err());
    let mut flow = onboarding();
    flow.steps.get_mut(SECOND).unwrap().next = Some("NOT/REGISTERED".into());
    assert!(flow.validate(CATALOG).is_err());
    assert!(flow.simulate(&BTreeMap::new()).is_err());
    Ok(())
}
#[test]
fn routing_distinguishes_declared_alternates_from_overrides() -> Result<()> {
    let mut f = Fixture::new()?;
    let id = f.start(&onboarding())?;
    let c = claim(&mut f.engine, 100);
    f.engine.record(&c, Outcome::done(Value::Null), 100)?;
    let c = claim(&mut f.engine, 100);
    f.engine.record(&c, routed("SCHEDULE/PARK"), 100)?;
    let c = claim(&mut f.engine, 100);
    assert_eq!(c.input, 42);
    f.engine.record(&c, routed("WELCOME/SEND"), 100)?;
    let rows = f.engine.audit(id)?;
    assert_eq!(rows[2]["override"], 0);
    assert_eq!(rows[3]["override"], 1);
    assert_eq!(rows[3]["default"], "VERIFICATION/VERIFY");
    assert_eq!(rows[3]["target"], "WELCOME/SEND");
    let c = claim(&mut f.engine, 100);
    f.engine.record(&c, routed(FIRST), 100)?;
    assert_eq!(f.engine.status(id)?["status"], "FAILED");
    Ok(())
}
#[test]
fn coverage_includes_stages_in_active_pinned_definitions() -> Result<()> {
    let mut f = Fixture::new()?;
    f.start(&onboarding())?;
    let d = f.pending(&one())?;
    f.engine.approve(d, "approver", CATALOG)?;
    f.engine.heartbeat("only", &["SIGNUP".into()], false)?;
    assert!(f.engine.coverage()?.contains(&"WORKSPACE".into()));
    assert!(!f.engine.coverage()?.contains(&"SIGNUP".into()));
    f.sql().execute("UPDATE worker SET expires=0", [])?;
    assert!(f.engine.coverage()?.contains(&"SIGNUP".into()));
    assert_eq!(f.engine.reap()?, 1);
    f.engine.heartbeat("only", &all(), false)?;
    assert!(f.engine.coverage()?.is_empty());
    f.engine.deregister("only")?;
    // Leases are observational. Dispatch still works with an empty registry.
    assert!(f.engine.claim(&["REVIEW".into()], 1, 100)?.is_empty());
    assert_eq!(claim(&mut f.engine, 100).step, FIRST);
    Ok(())
}
#[test]
fn concurrent_stage_workers_claim_disjoint_instances() -> Result<()> {
    let mut f = Fixture::new()?;
    f.start(&one())?;
    for _ in 1..8 {
        f.engine.start("flow", "account", "x", &Value::Null, 100)?;
    }
    let barrier = Barrier::new(2);
    let ids = thread::scope(|s| {
        let take = || {
            let mut e = Engine::open(&f.db).unwrap();
            barrier.wait();
            e.claim(&all(), 4, 100)
                .unwrap()
                .into_iter()
                .map(|c| c.instance)
                .collect::<Vec<_>>()
        };
        let l = s.spawn(take);
        let r = s.spawn(take);
        [l.join().unwrap(), r.join().unwrap()]
    });
    assert!(ids.iter().all(|v| v.len() == 4));
    assert_eq!(
        ids.concat()
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        8
    );
    Ok(())
}

#[test]
fn historical_versions_require_a_positive_validity_interval() -> Result<()> {
    let mut f = Fixture::new()?;
    f.start(&one())?;
    assert!(
        f.sql()
            .execute(
                "UPDATE definition SET valid_until=valid_from WHERE valid_until IS NULL",
                []
            )
            .is_err(),
        "accepted an empty validity interval"
    );
    let draft = f.pending(&one())?;
    f.engine.approve(draft, "reviewer", CATALOG)?;
    let boundaries: (i64, i64, i64) = f.sql().query_row(
        "SELECT a.valid_from,a.valid_until,b.valid_from
        FROM definition a JOIN definition b ON b.name=a.name AND b.version=a.version+1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    assert!(boundaries.0 < boundaries.1);
    assert_eq!(boundaries.1, boundaries.2);
    Ok(())
}

fn wait_for(mut ready: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(15);
    while !ready() {
        assert!(
            Instant::now() < until,
            "timed out waiting for workflow transition"
        );
        thread::sleep(Duration::from_millis(20));
    }
}
struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn cli(dir: &Path, args: &[&str]) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_durable-workflow"));
    c.arg(dir).args(args);
    c
}
fn call(dir: &Path, args: &[&str]) -> Value {
    let result = cli(dir, args).output().unwrap();
    assert!(
        result.status.success(),
        "CLI failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    if result.stdout.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&result.stdout).unwrap()
    }
}

#[test]
fn cli_workers_finish_branched_onboarding_with_events_waiting() -> Result<()> {
    let f = Fixture::new()?;
    call(&f.dir, &["init"]);
    let draft = call(&f.dir, &["draft", "signup", "designer"]).to_string();
    call(&f.dir, &["submit", &draft, "designer"]);
    call(&f.dir, &["approve", &draft, "reviewer"]);
    let id = call(
        &f.dir,
        &[
            "start",
            "signup",
            "account",
            "a",
            r#"{"review":true,"import":true}"#,
        ],
    )
    .as_i64()
    .unwrap();
    let _worker = Process(cli(&f.dir, &["worker", "3"]).spawn()?);
    wait_for(|| f.engine.status(id).unwrap()["status"] == "COMPLETED");
    let audit = call(&f.dir, &["audit", &id.to_string()]);
    assert!(
        audit
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["target"] == "REVIEW/REQUEST" && r["override"] == 0)
    );
    assert!(
        audit
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["target"] == "WORKSPACE/IMPORT_DATA" && r["override"] == 0)
    );
    let db = Connection::open(f.dir.join("activity.db"))?;
    assert_eq!(
        db.query_row("SELECT count(*) FROM outbox", [], |r| r.get::<_, u32>(0))?,
        10
    );
    assert_eq!(call(&f.dir, &["metrics"])["due"], 0);
    Ok(())
}

#[test]
fn killed_after_work_recovers_saved_route_payload_and_one_event() -> Result<()> {
    const CHILD: &str = "WORKFLOW_TEST_KILL_AFTER_WORK";
    if let Some(path) = std::env::var_os(CHILD) {
        let dir = PathBuf::from(path);
        let mut e = Engine::open(&dir.join("workflow.db"))?;
        let c = claim(&mut e, 100);
        Onboarding::open(&dir.join("activity.db"))?.invoke(&c, &AtomicBool::new(false))?;
        fs::write(dir.join("committed"), [])?;
        loop {
            thread::park();
        }
    }
    let mut f = Fixture::new()?;
    Onboarding::init(&f.dir.join("activity.db"))?;
    let spec = serde_json::from_value(
        json!({"start":"WORKSPACE/CREATE","terminals":["WELCOME/SEND"],
        "steps":{"WORKSPACE/CREATE":{"next":"WELCOME/SEND","alternates":["WORKSPACE/IMPORT_DATA"]},
                 "WORKSPACE/IMPORT_DATA":{"next":"WELCOME/SEND"},"WELCOME/SEND":{}}}),
    )?;
    let draft = f.pending(&spec)?;
    f.engine.approve(draft, "reviewer", CATALOG)?;
    let id = f
        .engine
        .start("flow", "account", "example", &json!({"import":true}), 100)?;
    let child = Process(
        Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "killed_after_work_recovers_saved_route_payload_and_one_event",
            ])
            .env(CHILD, &f.dir)
            .spawn()?,
    );
    wait_for(|| f.dir.join("committed").exists());
    drop(child);
    let c = claim(&mut f.engine, 220 + RECOVERY_MARGIN);
    assert_eq!(c.dispatch, 2);
    let outcome =
        Onboarding::open(&f.dir.join("activity.db"))?.invoke(&c, &AtomicBool::new(false))?;
    f.engine.record(&c, outcome, 300)?;
    let next = claim(&mut f.engine, 300);
    assert_eq!(next.step, "WORKSPACE/IMPORT_DATA");
    assert_eq!(next.input, json!({"import":true}));
    assert_eq!(f.engine.audit(id)?.last().unwrap()["dispatch"], 2);
    let db = Connection::open(f.dir.join("activity.db"))?;
    for sql in [
        "SELECT count(*) FROM operation",
        "SELECT count(*) FROM outbox",
    ] {
        assert_eq!(db.query_row(sql, [], |r| r.get::<_, u32>(0))?, 1);
    }
    Ok(())
}

struct Slow {
    cooperative: bool,
}
impl Activity for Slow {
    fn invoke(&self, _: &Claim, cancel: &AtomicBool) -> Result<Outcome> {
        while !self.cooperative || !cancel.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(10));
        }
        Ok(Outcome::done(Value::Null))
    }
}
#[test]
fn timeout_charges_retry_and_uncooperative_activity_terminates_its_host() -> Result<()> {
    const CHILD: &str = "WORKFLOW_TEST_TIMEOUT_DB";
    if let Some(db) = std::env::var_os(CHILD) {
        let path = PathBuf::from(db);
        let mut e = Engine::open(&path)?;
        let c = claim(&mut e, durable_workflow::now() + 10);
        worker::execute(
            &path,
            c,
            Arc::new(Slow { cooperative: false }),
            durable_workflow::now,
        )?;
        panic!("uncooperative activity returned");
    }
    let mut f = Fixture::new()?;
    let id = f.start(&one())?;
    let c = claim(&mut f.engine, 100);
    worker::execute(
        &f.db,
        c,
        Arc::new(Slow { cooperative: true }),
        durable_workflow::now,
    )?;
    assert_eq!(f.engine.status(id)?["attempts"], 1);
    let mut child = Process(
        Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "timeout_charges_retry_and_uncooperative_activity_terminates_its_host",
            ])
            .env(CHILD, &f.db)
            .spawn()?,
    );
    wait_for(|| child.0.try_wait().unwrap().is_some());
    assert_eq!(child.0.wait()?.code(), Some(70));
    let state = f.engine.status(id)?;
    assert_eq!(state["attempts"], 2);
    assert_eq!(state["status"], "FAILED");
    assert_eq!(state["reason"], "timeout");
    Ok(())
}

#[test]
fn activity_rolls_back_business_write_when_event_insert_fails() -> Result<()> {
    let mut f = Fixture::new()?;
    f.start(&one())?;
    let c = claim(&mut f.engine, 100);
    let path = f.dir.join("activity.db");
    let a = Onboarding::init(&path)?;
    let db = Connection::open(&path)?;
    db.execute_batch("CREATE TRIGGER reject_event BEFORE INSERT ON outbox BEGIN SELECT raise(ABORT,'injected'); END;")?;
    assert!(a.invoke(&c, &AtomicBool::new(false)).is_err());
    assert_eq!(
        db.query_row("SELECT count(*) FROM operation", [], |r| r.get::<_, u32>(0))?,
        0
    );
    Ok(())
}
