//! Durable record events. Each store commits independently.
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::{error::Error, fs, path::Path, time::Duration};

pub type Result<T> = std::result::Result<T, Box<dyn Error>>;
pub const RETENTION: i64 = 7 * 86400;
pub const LEASE: i64 = 120;
pub const DELIVERY_LEASE: i64 = 300;

fn database(path: &Path) -> Result<Connection> {
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute_batch("PRAGMA synchronous=FULL;")?;
    Ok(db)
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub event_id: String,
    pub source: String,
    pub environment: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub schema_version: u32,
    pub created_at: String,
    pub request_id: String,
    pub headers: std::collections::BTreeMap<String, String>,
    pub payload: Record,
}
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub record_id: String,
    pub revision: i64,
    pub status: String,
}

fn record_event_id(key: &str, revision: i64) -> String {
    format!("RecordUpdated:{key}:{revision}")
}

pub struct Producer(Connection);
pub struct Claim {
    pub id: i64,
    pub token: String,
    pub bytes: Vec<u8>,
    pub stream: String,
}
impl Producer {
    pub fn open(dir: &Path) -> Result<Self> {
        Ok(Self(database(&dir.join("producer.db"))?))
    }

    pub fn update(
        &mut self,
        key: &str,
        status: &str,
        request: &str,
        trace: Option<&str>,
    ) -> Result<String> {
        if key.is_empty() || status.is_empty() || request.is_empty() {
            return Err("empty record, status or request".into());
        }
        let tx = self
            .0
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let revision = tx.query_row(
            "INSERT INTO records VALUES(?1,1,?2)
             ON CONFLICT(id) DO UPDATE SET revision=revision+1, status=excluded.status
             RETURNING revision",
            params![key, status],
            |r| r.get(0),
        )?;
        let event_id = record_event_id(key, revision);
        let created_at = tx.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
            r.get(0)
        })?;
        let event = Event {
            event_id: event_id.clone(),
            source: "records".into(),
            environment: "local".into(),
            kind: "RecordUpdated".into(),
            schema_version: 1,
            created_at,
            request_id: request.into(),
            headers: trace
                .map(|s| ("traceparent".into(), s.into()))
                .into_iter()
                .collect(),
            payload: Record {
                record_id: key.into(),
                revision,
                status: status.into(),
            },
        };
        tx.execute(
            "INSERT INTO outbox(event_id,stream,bytes) VALUES(?1,'events:local:records',?2)",
            params![event_id, serde_json::to_vec(&event)?],
        )?;
        tx.commit()?;
        Ok(event_id)
    }

    pub fn claim(&mut self, now: i64, limit: u16) -> Result<Vec<Claim>> {
        let tx = self
            .0
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let claims = tx
            .prepare(
                "UPDATE outbox SET state='IN_PROGRESS', due=?3, token=lower(hex(randomblob(16)))
             WHERE id IN (
                SELECT id FROM outbox WHERE state IN ('PENDING','IN_PROGRESS') AND due<=?1
                ORDER BY due,id LIMIT ?2
             ) RETURNING id,token,bytes,stream",
            )?
            .query_map(params![now, limit, now + LEASE], |r| {
                Ok(Claim {
                    id: r.get(0)?,
                    token: r.get(1)?,
                    bytes: r.get(2)?,
                    stream: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        tx.commit()?;
        Ok(claims)
    }
    pub fn finish(&self, c: &Claim, entry: i64, now: i64) -> Result<bool> {
        Ok(self.0.execute(
            "UPDATE outbox SET state='SENT',sent=?3,entry=?4,token=NULL,error=NULL
             WHERE id=?1 AND token=?2 AND state='IN_PROGRESS'",
            params![c.id, c.token, now, entry],
        )? == 1)
    }
    pub fn fail(&self, c: &Claim, now: i64) -> Result<bool> {
        Ok(self.0.execute("UPDATE outbox SET attempts=attempts+1,
             state=CASE WHEN attempts+1>=12 THEN 'GIVEN_UP' ELSE 'PENDING' END,
             due=?3+CASE attempts WHEN 0 THEN 5 WHEN 1 THEN 30 WHEN 2 THEN 120 WHEN 3 THEN 600 ELSE 3600 END,
             token=NULL,error='append'
             WHERE id=?1 AND token=?2 AND state='IN_PROGRESS'",params![c.id,c.token,now])?==1)
    }
    pub fn replay(&self, id: &str, now: i64) -> Result<bool> {
        Ok(self.0.execute(
            "UPDATE outbox SET state='PENDING',attempts=0,due=?2,token=NULL,error=NULL
             WHERE event_id=?1 AND state IN ('SENT','GIVEN_UP')",
            params![id, now],
        )? == 1)
    }
    pub fn clean(&self, now: i64) -> Result<usize> {
        Ok(self.0.execute("DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE state='SENT' AND sent<?1 LIMIT 1000)",[now-RETENTION])?)
    }
    pub fn drain(&mut self, broker: &Stream) -> Result<usize> {
        let mut total = 0;
        let started = std::time::Instant::now();
        for _ in 0..10 {
            if started.elapsed() >= Duration::from_secs(2) {
                break;
            }
            let batch = self.claim(clock(), 10)?;
            if batch.is_empty() {
                break;
            }
            for c in batch {
                match broker.append(&c.stream, &c.bytes, clock()) {
                    Ok(id) => {
                        self.finish(&c, id, clock())?;
                    }
                    Err(_) => {
                        self.fail(&c, clock())?;
                    }
                }
                total += 1;
            }
        }
        Ok(total)
    }
}
pub fn clock() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_secs() as i64
}
pub const STREAM: &str = "events:local:records";
pub fn init(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir)?;
    for (file, schema) in [
        ("producer.db", include_str!("producer.sql")),
        ("stream.db", include_str!("stream.sql")),
        ("projection.db", include_str!("projection.sql")),
        ("jobs.db", include_str!("jobs.sql")),
    ] {
        let db = Connection::open(dir.join(file))?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")?;
        db.execute_batch(schema)?;
    }
    Ok(())
}
mod stream;
pub use stream::{Delivery, Stream};
mod consumer;
pub use consumer::{Consumer, Group};

/// Read gauges from the stores so a stopped consumer is still visible.
pub fn status(dir: &Path) -> Result<serde_json::Value> {
    let now = clock();
    let producer = Producer::open(dir)?;
    let (unsent, oldest, given_up): (i64, i64, i64) = producer.0.query_row(
        "SELECT count(*),coalesce(?1-min(created),0), count(*) FILTER (WHERE state='GIVEN_UP')
         FROM outbox WHERE state!='SENT'",
        [now],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let broker = Stream::open(dir)?;
    let mut groups = serde_json::Map::new();
    for g in Group::ALL {
        let progress = broker
            .0
            .query_row(
                "SELECT cursor,trimmed,
                    (SELECT count(*) FROM entries WHERE id>cursor),
                    coalesce(?2-(SELECT min(created) FROM entries WHERE id>cursor),0),
                    (SELECT count(*) FROM pending WHERE name=?1),
                    (SELECT count(*) FROM dead WHERE name=?1)
             FROM groups,retention WHERE name=?1",
                params![g.name(), now],
                |r| {
                    let cursor: i64 = r.get(0)?;
                    let floor: i64 = r.get(1)?;
                    Ok(serde_json::json!({
                        "cursor":cursor, "trimmedThrough":floor, "historyGap":cursor<floor,
                        "unread":r.get::<_,i64>(2)?, "oldestUnreadSeconds":r.get::<_,i64>(3)?,
                        "pending":r.get::<_,i64>(4)?, "dead":r.get::<_,i64>(5)?
                    }))
                },
            )
            .optional()?;
        groups.insert(g.name().into(), serde_json::json!(progress));
    }
    Ok(
        serde_json::json!({"unsent":unsent,"oldestUnsentSeconds":oldest,"givenUp":given_up,"groups":groups}),
    )
}

mod worker;
pub use worker::Worker;
