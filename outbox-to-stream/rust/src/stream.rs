use super::*;

pub struct Stream(pub(super) Connection);
pub struct Delivery {
    pub group: Group,
    pub id: i64,
    pub token: String,
    pub bytes: Vec<u8>,
}
impl Stream {
    pub fn open(dir: &Path) -> Result<Self> {
        Ok(Self(database(&dir.join("stream.db"))?))
    }
    pub fn append(&self, stream: &str, bytes: &[u8], now: i64) -> Result<i64> {
        if stream != STREAM {
            return Err("unknown stream".into());
        }
        Ok(self.0.query_row(
            "INSERT INTO entries(bytes,created) VALUES(?1,?2) RETURNING id",
            params![bytes, now],
            |r| r.get(0),
        )?)
    }
    pub fn enrolled(&self, group: Group) -> Result<bool> {
        Ok(self.0.query_row(
            "SELECT EXISTS(SELECT 1 FROM groups WHERE name=?1)",
            [group.name()],
            |r| r.get(0),
        )?)
    }

    pub fn enroll(&self, group: Group) -> Result<()> {
        self.0.execute(
            "INSERT OR IGNORE INTO groups SELECT ?1,trimmed FROM retention",
            [group.name()],
        )?;
        Ok(())
    }
    /// Resume retained history after the operator reconciles the reported gap.
    pub fn resume_reconciled(&self, group: Group, trimmed_through: i64) -> Result<bool> {
        Ok(self.0.execute(
            "UPDATE groups SET cursor=?2 WHERE name=?1 AND cursor<?2
             AND ?2=(SELECT trimmed FROM retention)",
            params![group.name(), trimmed_through],
        )? == 1)
    }

    pub fn take(
        &mut self,
        group: Group,
        owner: &str,
        now: i64,
        recover: bool,
    ) -> Result<Option<Delivery>> {
        let tx = self
            .0
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let g = group.name();
        let (cursor, floor): (i64, i64) = tx.query_row(
            "SELECT cursor,trimmed FROM groups,retention WHERE name=?1",
            [g],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if !recover && cursor < floor {
            return Err("unread entries expired: reconcile group history".into());
        }
        let id: Option<i64> = if recover {
            tx.query_row(
                "SELECT entry FROM pending WHERE name=?1 AND due<=?2 ORDER BY due,entry LIMIT 1",
                params![g, now],
                |r| r.get(0),
            )
            .optional()?
        } else {
            tx.query_row(
                "SELECT id FROM entries WHERE id>?1 ORDER BY id LIMIT 1",
                [cursor],
                |r| r.get(0),
            )
            .optional()?
        };
        let Some(id) = id else { return Ok(None) };
        if !recover {
            tx.execute("UPDATE groups SET cursor=?2 WHERE name=?1", params![g, id])?;
        }
        let token=tx.query_row("INSERT INTO pending(name,entry,owner,token,due) VALUES(?1,?2,?3,lower(hex(randomblob(16))),?4)
             ON CONFLICT(name,entry) DO UPDATE SET owner=excluded.owner,token=excluded.token,due=excluded.due
             RETURNING token",params![g,id,owner,now+DELIVERY_LEASE],|r|r.get(0))?;
        let bytes = tx.query_row(
            "SELECT coalesce(p.redriven, e.bytes) FROM pending p
             LEFT JOIN entries e ON e.id=p.entry WHERE p.name=?1 AND p.entry=?2",
            params![g, id],
            |r| r.get(0),
        )?;
        tx.commit()?;
        Ok(Some(Delivery {
            group,
            id,
            token,
            bytes,
        }))
    }
    pub fn ack(&self, d: &Delivery) -> Result<bool> {
        Ok(self.0.execute(
            "DELETE FROM pending WHERE name=?1 AND entry=?2 AND token=?3",
            params![d.group.name(), d.id, d.token],
        )? == 1)
    }
    pub fn failure(&mut self, d: &Delivery, now: i64, reason: &str) -> Result<()> {
        let tx = self
            .0
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let failures: Option<i64> = tx
            .query_row(
                "UPDATE pending SET failures=failures+1,due=?4+30,token=''
             WHERE name=?1 AND entry=?2 AND token=?3 RETURNING failures",
                params![d.group.name(), d.id, d.token, now],
                |r| r.get(0),
            )
            .optional()?;
        if failures == Some(6) {
            tx.execute(
                "INSERT INTO dead VALUES(?1,?2,?3,?4,?5)",
                params![d.group.name(), d.id, d.bytes, reason, now],
            )?;
            tx.execute(
                "DELETE FROM pending WHERE name=?1 AND entry=?2",
                params![d.group.name(), d.id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn redrive(&mut self, group: Group, id: i64, now: i64) -> Result<bool> {
        let tx = self
            .0
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "INSERT INTO pending(name,entry,owner,token,due,redriven)
             SELECT name,entry,'','',?3,bytes FROM dead WHERE name=?1 AND entry=?2",
            params![group.name(), id, now],
        )?;
        tx.execute(
            "DELETE FROM dead WHERE name=?1 AND entry=?2",
            params![group.name(), id],
        )?;
        tx.commit()?;
        Ok(changed == 1)
    }
    pub fn trim(&mut self, now: i64) -> Result<usize> {
        let tx = self
            .0
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Delete only a prefix. A backward clock adjustment can make timestamps nonmonotonic.
        let end:Option<i64>=tx.query_row("SELECT max(id) FROM (
                SELECT id FROM entries
                WHERE id<coalesce((SELECT min(entry) FROM pending WHERE redriven IS NULL),9223372036854775807)
                  AND id<coalesce((SELECT min(id) FROM entries WHERE created>=?1),9223372036854775807)
                ORDER BY id LIMIT 1000
             )",[now-RETENTION],|r|r.get(0))?;
        let count = if let Some(end) = end {
            tx.execute("UPDATE retention SET trimmed=?1", [end])?;
            tx.execute("DELETE FROM entries WHERE id<=?1", [end])?
        } else {
            0
        };
        tx.execute("DELETE FROM dead WHERE created<?1", [now - RETENTION])?;
        tx.commit()?;
        Ok(count)
    }
}
