use super::*;
use crate::activity::Activity;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Instant,
};

pub fn hosted(catalog: &[&str], requested: &[String]) -> Result<Vec<String>> {
    let available = catalog
        .iter()
        .map(|k| stage(k).to_owned())
        .collect::<BTreeSet<_>>();
    if requested.iter().any(|k| !available.contains(k)) {
        return Err("configured stage has no registered activity".into());
    }
    if requested.is_empty() {
        Ok(available.into_iter().collect())
    } else {
        Ok(requested.to_vec())
    }
}
impl Engine {
    pub fn heartbeat(&self, id: &str, stages: &[String], delivers: bool) -> Result<()> {
        self.db.execute("INSERT INTO worker VALUES(?1,?2,?3,unixepoch()+60)
            ON CONFLICT(id) DO UPDATE SET stages=excluded.stages,delivers=excluded.delivers,expires=excluded.expires",
            params![id,serde_json::to_string(stages)?,delivers])?;
        Ok(())
    }
    pub fn deregister(&self, id: &str) -> Result<()> {
        self.db.execute("DELETE FROM worker WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn reap(&self) -> Result<usize> {
        Ok(self
            .db
            .execute("DELETE FROM worker WHERE expires<unixepoch()-86400", [])?)
    }
    pub fn coverage(&self) -> Result<Vec<String>> {
        // Include pinned versions while any active instance can still enter their stages.
        Ok(self.db.prepare("SELECT DISTINCT substr(s.key,1,instr(s.key,'/')-1) AS stage
            FROM definition d,json_each(d.spec,'$.steps') s
            WHERE (d.valid_until IS NULL OR EXISTS(SELECT 1 FROM instance i WHERE i.status='ACTIVE' AND i.name=d.name AND i.version=d.version))
            AND NOT EXISTS(SELECT 1 FROM worker w,json_each(w.stages) h WHERE w.expires>unixepoch() AND h.value=substr(s.key,1,instr(s.key,'/')-1))
            ORDER BY stage")?.query_map([],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?)
    }
    pub fn validate_installed(&self, catalog: &[&str]) -> Result<()> {
        let mut q=self.db.prepare("SELECT spec FROM definition d WHERE valid_until IS NULL OR EXISTS(
            SELECT 1 FROM instance i WHERE i.status<>'COMPLETED' AND i.name=d.name AND i.version=d.version)")?;
        for json in q.query_map([], |r| r.get::<_, String>(0))? {
            serde_json::from_str::<Definition>(&json?)?.validate(catalog)?;
        }
        Ok(())
    }
    pub fn status(&self, id: i64) -> Result<Value> {
        let json:String=self.db.query_row(
            "SELECT json_object('id',i.id,'status',i.status,'step',current_step,'version',version,
             'stepStatus',e.status,'attempts',attempts,'dispatch',dispatch_count,'deferrals',defer_count,
             'nextAt',next_at,'lastProgress',last_progress_at,'reason',failure_reason)
             FROM instance i JOIN execution e ON i.id=e.instance AND i.current_step=e.step
             WHERE i.id=?1", [id], |r|r.get(0),
        )?;
        Ok(serde_json::from_str(&json)?)
    }
    pub fn audit(&self, id: i64) -> Result<Vec<Value>> {
        let mut q=self.db.prepare("SELECT json_object('seq',seq,'at',at,'step',step,'status',status,'actor',actor,'outcome',detail,
            'attempt',attempts,'dispatch',dispatch,'default',default_target,'target',target,'override',was_override,'reason',reason)
            FROM audit WHERE instance=?1 ORDER BY seq")?;
        let mut rows = Vec::new();
        for v in q.query_map([id], |r| r.get::<_, String>(0))? {
            rows.push(serde_json::from_str(&v?)?);
        }
        Ok(rows)
    }
}
const CANCEL_GRACE: Duration = Duration::from_secs(2);
const _: () = assert!(RECOVERY_MARGIN > CANCEL_GRACE.as_secs() as i64);
fn database_busy(error: &(dyn std::error::Error + 'static)) -> bool {
    matches!(
        error
            .downcast_ref::<rusqlite::Error>()
            .and_then(|e| e.sqlite_error_code()),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    )
}
fn retry(reason: &str) -> Outcome {
    Outcome::Retry {
        delay: 1,
        reason: reason.into(),
    }
}
/// Runs inside a dedicated worker process. An uncooperative activity terminates that process.
pub fn execute(
    path: &Path,
    c: Claim,
    activity: Arc<dyn Activity>,
    clock: fn() -> i64,
) -> Result<()> {
    let started = Instant::now();
    eprintln!(
        "{}",
        serde_json::json!({"event":"step_started","step":c.step,"instance":c.instance,"dispatch":c.dispatch})
    );
    let cancel = Arc::new(AtomicBool::new(false));
    let (send, receive) = mpsc::sync_channel(1);
    let context = c.clone();
    let flag = Arc::clone(&cancel);
    thread::spawn(move || {
        let _ = send.send(activity.invoke(&context, &flag));
    });
    let mut abandon = false;
    let outcome = match receive.recv_timeout(Duration::from_secs(c.max_duration.into())) {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            let detail: String = error.to_string().chars().take(512).collect();
            let reason = format!("activity error: {detail}");
            eprintln!(
                "{}",
                serde_json::json!({
                    "event":"activity_error","instance":c.instance,"step":c.step,
                    "dispatch":c.dispatch,"reason":reason
                })
            );
            retry(&reason)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => retry("activity panicked"),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            cancel.store(true, Ordering::Release);
            abandon = matches!(
                receive.recv_timeout(CANCEL_GRACE),
                Err(mpsc::RecvTimeoutError::Timeout)
            );
            retry("timeout")
        }
    };
    let result = Engine::open(path).and_then(|mut e| e.record(&c, outcome, clock()));
    if abandon {
        eprintln!("activity ignored cancellation; terminating worker");
        std::process::exit(70);
    }
    let recorded = match result {
        Ok(recorded) => recorded,
        Err(error) if database_busy(error.as_ref()) => {
            // The claim stays RUNNING. Its lease makes this dispatch recoverable.
            eprintln!(
                "{}",
                serde_json::json!({
                    "event":"record_deferred","instance":c.instance,"step":c.step,
                    "dispatch":c.dispatch,"reason":error.to_string()
                })
            );
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    eprintln!(
        "{}",
        serde_json::json!({
            "event":"step_finished","instance":c.instance,"step":c.step,"dispatch":c.dispatch,
            "durationMs":started.elapsed().as_millis(),"recorded":recorded
        })
    );
    Ok(())
}
pub fn run(
    path: PathBuf,
    stages: Vec<String>,
    limit: u16,
    activity: Arc<dyn Activity>,
    stop: Arc<AtomicBool>,
    clock: fn() -> i64,
) -> Result<()> {
    if limit == 0 {
        return Err("concurrency must be positive".into());
    }
    let mut e = Engine::open(&path)?;
    let id: String =
        e.db.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
    let mut active: Vec<thread::JoinHandle<Result<()>>> = Vec::new();
    let mut heartbeat = Instant::now();
    let mut blocked = false;
    let result = (|| -> Result<()> {
        while !stop.load(Ordering::Acquire) {
            if Instant::now() >= heartbeat {
                if let Err(error) = e.heartbeat(&id, &stages, false).and_then(|_| e.reap()) {
                    eprintln!("registry update failed: {error}");
                }
                heartbeat = Instant::now() + Duration::from_secs(15);
            }
            let mut index = 0;
            while index < active.len() {
                if active[index].is_finished() {
                    active
                        .swap_remove(index)
                        .join()
                        .map_err(|_| "worker thread panicked")??;
                } else {
                    index += 1;
                }
            }
            let slots = limit - active.len() as u16;
            if slots > 0 {
                let claims = match e.claim(&stages, slots, clock()) {
                    Ok(claims) => {
                        blocked = false;
                        claims
                    }
                    Err(error) if database_busy(error.as_ref()) => {
                        if !blocked {
                            eprintln!("worker {id} waiting to claim steps: {error}");
                            blocked = true;
                        }
                        Vec::new()
                    }
                    Err(error) => return Err(error),
                };
                for c in claims {
                    let path = path.clone();
                    let activity = Arc::clone(&activity);
                    active.push(thread::spawn(move || execute(&path, c, activity, clock)));
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    })();
    for task in active {
        task.join().map_err(|_| "worker thread panicked")??;
    }
    if let Err(error) = e.deregister(&id) {
        if !database_busy(error.as_ref()) {
            return result.and(Err(error));
        }
        eprintln!("worker {id} could not deregister before lease expiry: {error}");
    }
    result
}
