//! A SQLite-backed workflow engine. Scheduling timestamps use Unix seconds.
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}
pub struct Engine {
    db: Connection,
}
impl Engine {
    pub fn init(path: &Path) -> Result<Self> {
        let mut engine = Self::connect(path, true)?;
        engine.db.execute_batch("PRAGMA journal_mode=WAL;")?;
        let tx = engine.write()?;
        tx.execute_batch(include_str!("schema.sql"))?;
        tx.commit()?;
        Ok(engine)
    }
    pub fn open(path: &Path) -> Result<Self> {
        Self::connect(path, false)
    }
    fn connect(path: &Path, create: bool) -> Result<Self> {
        let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE;
        if create {
            flags |= OpenFlags::SQLITE_OPEN_CREATE;
        }
        let db = Connection::open_with_flags(path, flags)?;
        db.busy_timeout(Duration::from_secs(3))?;
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
        Ok(Self { db })
    }
    fn write(&mut self) -> Result<Transaction<'_>> {
        Ok(self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Step {
    pub next: Option<String>,
    #[serde(default)]
    pub alternates: Vec<String>,
    #[serde(default = "attempts")]
    pub max_attempts: u32,
    #[serde(default = "duration")]
    pub max_duration: u32,
}
fn attempts() -> u32 {
    10
}
fn duration() -> u32 {
    120
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Definition {
    pub start: String,
    pub terminals: BTreeSet<String>,
    pub steps: BTreeMap<String, Step>,
}
pub fn stage(key: &str) -> &str {
    key.split_once('/').map_or("", |v| v.0)
}
impl Definition {
    pub fn validate(&self, catalog: &[&str]) -> Result<()> {
        fn visit<'a>(
            d: &'a Definition,
            key: &'a str,
            done: &mut BTreeSet<&'a str>,
            path: &mut BTreeSet<&'a str>,
        ) -> Result<()> {
            if done.contains(key) {
                return Ok(());
            }
            if !path.insert(key) {
                return Err("definition revisits a step".into());
            }
            let step = d.steps.get(key).ok_or("unknown step in definition")?;
            for target in step.next.iter().chain(&step.alternates) {
                visit(d, target, done, path)?;
            }
            path.remove(key);
            done.insert(key);
            Ok(())
        }
        for (key, s) in &self.steps {
            if !catalog.contains(&key.as_str()) || stage(key).is_empty() {
                return Err(format!("missing activity: {key}").into());
            }
            if s.max_attempts == 0 || s.max_duration == 0 {
                return Err("invalid step policy".into());
            }
            if self.terminals.contains(key) != s.next.is_none()
                || (s.next.is_none() && !s.alternates.is_empty())
            {
                return Err("invalid terminal step".into());
            }
        }
        let mut reachable = BTreeSet::new();
        visit(self, &self.start, &mut reachable, &mut BTreeSet::new())?;
        if reachable.len() != self.steps.len()
            || self
                .terminals
                .iter()
                .any(|t| !reachable.contains(t.as_str()))
        {
            return Err("unreachable or unknown step".into());
        }
        Ok(())
    }
    pub fn simulate(&self, choices: &BTreeMap<String, String>) -> Result<Vec<String>> {
        let mut path = vec![];
        let mut key = self.start.as_str();
        loop {
            if path.iter().any(|k| k == key) {
                return Err("route revisits a step".into());
            }
            let step = self.steps.get(key).ok_or("unknown route target")?;
            path.push(key.to_owned());
            match choices.get(key).or(step.next.as_ref()) {
                Some(next) => key = next,
                None => return Ok(path),
            }
        }
    }
}
impl Engine {
    pub fn draft(&mut self, name: &str, spec: &Definition, author: &str) -> Result<i64> {
        if name.trim().is_empty() || author.trim().is_empty() {
            return Err("name and author required".into());
        }
        Ok(self.db.query_row(
            "INSERT INTO draft(name,base,spec,author)
            SELECT ?1,coalesce(max(version),0),?2,?3 FROM definition WHERE name=?1 RETURNING id",
            params![name, serde_json::to_string(spec)?, author],
            |r| r.get(0),
        )?)
    }
    pub fn submit(&self, id: i64, author: &str) -> Result<()> {
        if self.db.execute(
            "UPDATE draft SET status='SUBMITTED' WHERE id=?1 AND author=?2 AND status='EDITING'",
            params![id, author],
        )? != 1
        {
            return Err("draft cannot be submitted".into());
        }
        Ok(())
    }
    pub fn reject(&self, id: i64, reviewer: &str) -> Result<()> {
        if reviewer.trim().is_empty() {
            return Err("reviewer required".into());
        }
        let changed = self.db.execute(
            "UPDATE draft SET status='REJECTED',reviewer=?2
             WHERE id=?1 AND author<>?2 AND status='SUBMITTED'",
            params![id, reviewer],
        )?;
        if changed != 1 {
            return Err("draft cannot be rejected".into());
        }
        Ok(())
    }
    pub fn approve(&mut self, id: i64, reviewer: &str, catalog: &[&str]) -> Result<i64> {
        if reviewer.trim().is_empty() {
            return Err("reviewer required".into());
        }
        let tx = self.write()?;
        let (name, base, json): (String, i64, String) = tx.query_row(
            "SELECT name,base,spec FROM draft WHERE id=?1 AND status='SUBMITTED' AND author<>?2",
            params![id, reviewer],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        serde_json::from_str::<Definition>(&json)?.validate(catalog)?;
        let current: Option<(i64, i64)> = tx
            .query_row(
                "SELECT version,valid_from FROM definition WHERE name=?1 AND valid_until IS NULL",
                [&name],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if base != current.map_or(0, |v| v.0) {
            return Err("stale draft".into());
        }
        let database_time = || {
            tx.query_row(
                "SELECT cast(round(unixepoch('subsec')*1000) AS INTEGER)",
                [],
                |r| r.get::<_, i64>(0),
            )
        };
        let mut at = database_time()?;
        if let Some((_, previous)) = current {
            if at == previous {
                // Two short publications can share one database clock tick.
                std::thread::sleep(Duration::from_millis(1));
                at = database_time()?;
            }
            if at <= previous {
                return Err("database clock must advance before publication".into());
            }
        }
        tx.execute(
            "UPDATE definition SET valid_until=?2 WHERE name=?1 AND valid_until IS NULL",
            params![name, at],
        )?;
        tx.execute(
            "INSERT INTO definition VALUES(?1,?2,?3,?4,NULL)",
            params![name, base + 1, json, at],
        )?;
        tx.execute(
            "UPDATE draft SET reviewer=?2,status='APPROVED',published=?3 WHERE id=?1",
            params![id, reviewer, base + 1],
        )?;
        tx.commit()?;
        Ok(base + 1)
    }
}
mod execution;
pub use execution::{Claim, Outcome, RECOVERY_MARGIN, Route};
pub mod activity;
pub mod worker;

impl Engine {
    pub fn edit(&self, id: i64, author: &str, spec: &Definition) -> Result<()> {
        if self.db.execute(
            "UPDATE draft SET spec=?3 WHERE id=?1 AND author=?2 AND status='EDITING'",
            params![id, author, serde_json::to_string(spec)?],
        )? != 1
        {
            return Err("draft cannot be edited".into());
        }
        Ok(())
    }
    pub fn metrics(&self, at: i64) -> Result<Value> {
        let (due, overdue): (i64, i64) = self.db.query_row(
            "SELECT count(*),coalesce(?1-min(next_at),0)
            FROM execution WHERE next_at<=?1",
            [at],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let age: i64 = self.db.query_row(
            "SELECT coalesce(?1-min(last_progress_at),0) FROM instance WHERE status='ACTIVE'",
            [at],
            |r| r.get(0),
        )?;
        let mut query = self.db.prepare(
            "SELECT step,detail,count(*),sum(was_override),count(*) FILTER (WHERE reason='timeout')
             FROM audit GROUP BY step,detail ORDER BY step,detail",
        )?;
        let counts = query
            .query_map([], |r| {
                Ok(serde_json::json!({
                    "step": r.get::<_,String>(0)?,
                    "outcome": r.get::<_,String>(1)?,
                    "count": r.get::<_,i64>(2)?,
                    "overrides": r.get::<_,i64>(3)?,
                    "timeouts": r.get::<_,i64>(4)?
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(serde_json::json!({
            "due": due,
            "oldestOverdueSeconds": overdue,
            "oldestActiveProgressSeconds": age,
            "unhostedStages": self.coverage()?,
            "observations": counts
        }))
    }
}
