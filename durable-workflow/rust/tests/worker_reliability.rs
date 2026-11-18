use durable_workflow::{
    Engine, RECOVERY_MARGIN, Result,
    activity::{CATALOG, Onboarding},
    now, worker,
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const STEP: &str = "SIGNUP/NORMALISE";

struct Fixture {
    dir: PathBuf,
    db: PathBuf,
    engine: Engine,
    id: i64,
}

impl Fixture {
    fn new(at: i64) -> Result<Self> {
        let dir = std::env::temp_dir().join(format!(
            "workflow-worker-{}-{}",
            std::process::id(),
            thread::current().name().unwrap()
        ));
        fs::create_dir(&dir)?;
        let db = dir.join("workflow.db");
        let mut engine = Engine::init(&db)?;
        Onboarding::init(&dir.join("activity.db"))?;
        let spec = serde_json::from_value(json!({
            "start":STEP, "terminals":[STEP], "steps":{(STEP):{"max_attempts":1, "max_duration":1}}
        }))?;
        let draft = engine.draft("flow", &spec, "designer")?;
        engine.submit(draft, "designer")?;
        engine.approve(draft, "reviewer", CATALOG)?;
        let id = engine.start("flow", "account", "example", &Value::Null, at)?;
        Ok(Self {
            dir,
            db,
            engine,
            id,
        })
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn wait_for(mut ready: impl FnMut() -> bool) -> bool {
    let until = Instant::now() + Duration::from_secs(10);
    while !ready() {
        if Instant::now() >= until {
            return false;
        }
        thread::sleep(Duration::from_millis(20));
    }
    true
}

#[test]
fn worker_resumes_claims_after_a_write_lock() -> Result<()> {
    let f = Fixture::new(now() + 3600)?;
    let lock = Connection::open(&f.db)?;
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let db = f.db.clone();
    let activity = Arc::new(Onboarding::open(&f.dir.join("activity.db"))?);
    let task =
        thread::spawn(move || worker::run(db, vec!["SIGNUP".into()], 1, activity, flag, now));
    assert!(wait_for(|| lock
        .query_row("SELECT EXISTS(SELECT 1 FROM worker)", [], |r| r.get(0))
        .unwrap()));
    lock.execute_batch("BEGIN IMMEDIATE; UPDATE execution SET next_at=0;")?;
    thread::sleep(Duration::from_secs(4));
    lock.execute_batch("COMMIT")?;
    let finished =
        wait_for(|| task.is_finished() || f.engine.status(f.id).unwrap()["status"] == "COMPLETED");
    stop.store(true, Ordering::Release);
    task.join().unwrap()?;
    assert!(finished);
    assert_eq!(f.engine.status(f.id)?["status"], "COMPLETED");
    Ok(())
}

#[test]
fn busy_record_leaves_the_dispatch_recoverable() -> Result<()> {
    let mut f = Fixture::new(0)?;
    let stages = vec!["SIGNUP".to_string()];
    let c = f.engine.claim(&stages, 1, 0)?.pop().unwrap();
    let lock = Connection::open(&f.db)?;
    lock.execute_batch("BEGIN IMMEDIATE")?;
    let activity = Arc::new(Onboarding::open(&f.dir.join("activity.db"))?);
    worker::execute(&f.db, c, activity.clone(), || 0)?;
    lock.execute_batch("ROLLBACK")?;
    let after_lease = 1 + RECOVERY_MARGIN;
    let c = f.engine.claim(&stages, 1, after_lease)?.pop().unwrap();
    worker::execute(&f.db, c, activity, || 1 + RECOVERY_MARGIN)?;
    assert_eq!(f.engine.status(f.id)?["status"], "COMPLETED");
    let business = Connection::open(f.dir.join("activity.db"))?;
    let count: i64 = business.query_row("SELECT count(*) FROM outbox", [], |r| r.get(0))?;
    assert_eq!(count, 1);
    Ok(())
}

#[test]
fn activity_error_reaches_the_audit_and_worker_log() -> Result<()> {
    let f = Fixture::new(0)?;
    let business = Connection::open(f.dir.join("activity.db"))?;
    business.execute_batch("CREATE TRIGGER reject_event BEFORE INSERT ON outbox BEGIN SELECT raise(ABORT,'event write rejected'); END;")?;
    let mut child = Command::new(env!("CARGO_BIN_EXE_durable-workflow"))
        .arg(&f.dir)
        .args(["worker", "1"])
        .stderr(Stdio::piped())
        .spawn()?;
    let failed = wait_for(|| f.engine.status(f.id).unwrap()["status"] == "FAILED");
    let _ = child.kill();
    let output = child.wait_with_output()?;
    assert!(failed);
    let audit = f.engine.audit(f.id)?;
    let reason = audit.last().unwrap()["reason"].as_str().unwrap();
    assert!(reason.contains("event write rejected"), "{reason}");
    assert!(
        String::from_utf8(output.stderr)?
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .any(|log| log["instance"] == f.id
                && log["step"] == STEP
                && log["dispatch"] == 1
                && log["reason"] == reason)
    );
    Ok(())
}
