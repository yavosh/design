use super::*;

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum Group {
    Projection,
    Jobs,
}
impl Group {
    pub const ALL: [Group; 2] = [Self::Projection, Self::Jobs];
    pub fn name(self) -> &'static str {
        match self {
            Self::Projection => "projection",
            Self::Jobs => "jobs",
        }
    }
}
pub struct Consumer {
    db: Connection,
    group: Group,
}

const UPSERT: &str = "INSERT INTO projection VALUES(?1,?2,?3)
    ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, status=excluded.status
    WHERE excluded.revision>projection.revision";
impl Consumer {
    pub fn open(dir: &Path, group: Group) -> Result<Self> {
        let db = database(&dir.join(format!("{}.db", group.name())))?;
        Ok(Self { db, group })
    }
    pub fn apply(&mut self, bytes: &[u8]) -> Result<()> {
        #[derive(Deserialize)]
        struct Route {
            #[serde(rename = "type")]
            kind: String,
        }
        let route: Route = serde_json::from_slice(bytes)?;
        if route.kind != "RecordUpdated" {
            return Ok(());
        }
        let event: Event = serde_json::from_slice(bytes)?;
        if event.schema_version != 1
            || event.source != "records"
            || event.environment != "local"
            || event.payload.revision < 1
            || event.event_id != record_event_id(&event.payload.record_id, event.payload.revision)
        {
            return Err("unsupported event".into());
        }
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let fresh = tx.execute(
            "INSERT INTO seen VALUES(?1,?2) ON CONFLICT DO NOTHING",
            params![event.source, event.event_id],
        )?;
        if fresh == 1 {
            match self.group {
                Group::Projection => {
                    tx.execute(
                        UPSERT,
                        params![
                            event.payload.record_id,
                            event.payload.revision,
                            event.payload.status
                        ],
                    )?;
                }
                Group::Jobs => {
                    tx.execute(
                        "INSERT INTO jobs(source,event,bytes) VALUES(?1,?2,?3)",
                        params![event.source, event.event_id, bytes],
                    )?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }
    pub fn tick(&mut self, stream: &mut Stream, owner: &str, now: i64) -> Result<usize> {
        let mut count = 0;
        for recover in [true, false] {
            if let Some(d) = stream.take(self.group, owner, now, recover)? {
                if self.apply(&d.bytes).is_ok() {
                    stream.ack(&d)?;
                } else {
                    stream.failure(&d, now, "handler")?;
                }
                count += 1;
            }
        }
        Ok(count)
    }
    pub fn bootstrap(&mut self, producer: &mut Producer, stream: &mut Stream) -> Result<()> {
        if self.group != Group::Projection {
            return Err("only current state can be bootstrapped".into());
        }
        let watermark: i64 = stream.0.query_row(
            "SELECT max(trimmed,coalesce((SELECT max(id) FROM entries),0)) FROM retention",
            [],
            |r| r.get(0),
        )?;
        let snapshot = producer.0.transaction()?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut query = snapshot.prepare("SELECT id,revision,status FROM records")?;
        let mut rows = query.query([])?;
        while let Some(row) = rows.next()? {
            tx.execute(
                UPSERT,
                params![
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?
                ],
            )?;
        }
        tx.commit()?;
        stream.0.execute(
            "INSERT INTO groups VALUES(?1,?2)
             ON CONFLICT(name) DO UPDATE SET cursor=max(cursor,excluded.cursor)",
            params![self.group.name(), watermark],
        )?;
        Ok(())
    }
}
