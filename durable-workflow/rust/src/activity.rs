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
#[derive(Debug)]
pub(crate) struct WriteError(&'static str, rusqlite::Error);

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} insert failed", self.0)?;
        if let Some(code) = self.1.sqlite_error() {
            write!(f, " ({code})")?;
        }
        Ok(())
    }
}

impl std::error::Error for WriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.1)
    }
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
        db.busy_timeout(Duration::from_millis(50))?;
        let tx = match db.transaction_with_behavior(TransactionBehavior::Immediate) {
            Ok(tx) => tx,
            Err(e) if e.sqlite_error_code() == Some(rusqlite::ErrorCode::DatabaseBusy) => {
                return Ok(Outcome::Defer { delay: 1 });
            }
            Err(e) => return Err(e.into()),
        };
        // A restore can reuse an instance number, even when its new first step differs.
        let saved = tx
            .query_row(
                "SELECT o.step,o.entity,o.result,b.event
             FROM operation o LEFT JOIN outbox b ON b.instance=o.instance AND b.step=o.step
             WHERE o.instance=?1 ORDER BY o.step=?2 DESC LIMIT 1",
                params![c.instance, c.step],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()?;
        if let Some((step, entity, saved, event)) = saved {
            let event = event
                .map(|raw| serde_json::from_str::<Value>(&raw))
                .transpose()?;
            let same_owner = event.as_ref().is_some_and(|e| {
                e["instance"] == c.instance
                    && e["step"] == step
                    && e["entityKind"] == c.kind
                    && e["entityId"] == c.entity
                    && match &c.run_id {
                        Some(id) => e["runId"] == *id,
                        None => e.get("runId").is_none(),
                    }
            });
            let mismatch = || Outcome::Failed {
                reason: "stored activity belongs to a different workflow or input".into(),
            };
            if entity != c.entity || !same_owner {
                return Ok(mismatch());
            }
            if step == c.step {
                let outcome: Outcome = serde_json::from_str(&saved)?;
                if !matches!(&outcome, Outcome::Done { payload, .. } if *payload == c.input) {
                    return Ok(mismatch());
                }
                return Ok(outcome);
            }
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
        let event_prefix = c.run_id.clone().unwrap_or_else(|| c.instance.to_string());
        let mut event = serde_json::json!({"eventId":format!("{event_prefix}:{}",c.step),"type":"OnboardingStepCompleted",
            "instance":c.instance,"entityKind":c.kind,"entityId":c.entity,"step":c.step,
            "traceparent":c.input.get("traceparent")});
        if let Some(run_id) = &c.run_id {
            event["runId"] = run_id.clone().into();
        }
        tx.execute(
            "INSERT INTO operation VALUES(?1,?2,?3,?4)",
            params![
                c.instance,
                c.step,
                c.entity,
                serde_json::to_string(&outcome)?
            ],
        )
        .map_err(|e| WriteError("operation", e))?;
        tx.execute(
            "INSERT INTO outbox(instance,step,event) VALUES(?1,?2,?3)",
            params![c.instance, c.step, event.to_string()],
        )
        .map_err(|e| WriteError("outbox", e))?;
        tx.commit()?;
        Ok(outcome)
    }
}
