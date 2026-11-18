//! Synthetic onboarding activities. The activity owns its business transaction.
use super::*;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
pub const CATALOG: &[&str] = &[
    "SIGNUP/NORMALISE",
    "PROFILE/ENRICH",
    "SCHEDULE/PARK",
    "VERIFICATION/VERIFY",
    "WORKSPACE/RESERVE_NAME",
    "REVIEW/REQUEST",
    "WORKSPACE/ADJUST",
    "WORKSPACE/CREATE",
    "WORKSPACE/IMPORT_DATA",
    "WORKSPACE/RELEASE_NAME",
    "WELCOME/SEND",
];
pub fn onboarding() -> Definition {
    serde_json::from_str(include_str!("onboarding.json")).expect("built-in onboarding definition")
}
pub trait Activity: Send + Sync + 'static {
    fn invoke(&self, claim: &Claim, cancel: &AtomicBool) -> Result<Outcome>;
}
pub struct Onboarding {
    path: PathBuf,
}
impl Onboarding {
    pub fn open(path: &Path) -> Result<Self> {
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        Ok(Self { path: path.into() })
    }

    pub fn init(path: &Path) -> Result<Self> {
        let db = Connection::open(path)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS operation(instance INTEGER,step TEXT,entity TEXT NOT NULL,result TEXT NOT NULL,
            PRIMARY KEY(instance,step)) STRICT;
          CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY, instance INTEGER NOT NULL,step TEXT NOT NULL,
            event TEXT NOT NULL, UNIQUE(instance,step)) STRICT;")?;
        Ok(Self { path: path.into() })
    }
}
impl Activity for Onboarding {
    fn invoke(&self, c: &Claim, cancel: &AtomicBool) -> Result<Outcome> {
        if !CATALOG.contains(&c.step.as_str()) {
            return Err("unknown onboarding activity".into());
        }
        let mut db = Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        db.busy_timeout(Duration::ZERO)?;
        let tx = match db.transaction_with_behavior(TransactionBehavior::Immediate) {
            Ok(tx) => tx,
            Err(e) if e.sqlite_error_code() == Some(rusqlite::ErrorCode::DatabaseBusy) => {
                return Ok(Outcome::Defer { delay: 1 });
            }
            Err(e) => return Err(e.into()),
        };
        if let Some(saved) = tx
            .query_row(
                "SELECT result FROM operation WHERE instance=?1 AND step=?2",
                params![c.instance, c.step],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(serde_json::from_str(&saved)?);
        }
        if cancel.load(Ordering::Acquire) {
            return Err("activity cancelled".into());
        }
        let planned = c.input["startAt"].as_i64().unwrap_or(0);
        let route = match c.step.as_str() {
            "PROFILE/ENRICH" if planned > now() => Some(("SCHEDULE/PARK", "scheduled start")),
            "SCHEDULE/PARK" if planned > now() => return Ok(Outcome::Park { until: planned }),
            "WORKSPACE/RESERVE_NAME" if c.input["review"] == true => {
                Some(("REVIEW/REQUEST", "name requires review"))
            }
            "WORKSPACE/CREATE" if c.input["import"] == true => {
                Some(("WORKSPACE/IMPORT_DATA", "import requested"))
            }
            "VERIFICATION/VERIFY" if c.input["rejected"] == true => {
                return Ok(Outcome::Failed {
                    reason: "verification rejected".into(),
                });
            }
            _ => None,
        };
        let outcome = Outcome::Done {
            route: route.map(|(target, reason)| Route {
                target: target.into(),
                reason: reason.into(),
            }),
            payload: c.input.clone(),
        };
        let event = serde_json::json!({"eventId":format!("{}:{}",c.instance,c.step),"type":"OnboardingStepCompleted",
            "instance":c.instance,"entityKind":c.kind,"entityId":c.entity,"step":c.step,
            "traceparent":c.input.get("traceparent")});
        tx.execute(
            "INSERT INTO operation VALUES(?1,?2,?3,?4)",
            params![
                c.instance,
                c.step,
                c.entity,
                serde_json::to_string(&outcome)?
            ],
        )?;
        tx.execute(
            "INSERT INTO outbox(instance,step,event) VALUES(?1,?2,?3)",
            params![c.instance, c.step, event.to_string()],
        )?;
        tx.commit()?;
        Ok(outcome)
    }
}
