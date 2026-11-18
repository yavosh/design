//! Deliver jobs to the single destination assigned to this jobs database.
use super::*;
use std::{
    io::Write,
    process::{Command, Stdio},
};

pub struct Worker {
    db: Connection,
    url: String,
}
impl Worker {
    pub fn open(dir: &Path, url: &str) -> Result<Self> {
        let db = database(&dir.join("jobs.db"))?;
        db.execute("INSERT OR IGNORE INTO destination VALUES(1,?1)", [url])?;
        let configured: String = db.query_row("SELECT url FROM destination", [], |r| r.get(0))?;
        if configured != url {
            return Err("destination differs from the configured jobs destination".into());
        }
        Ok(Self {
            db,
            url: configured,
        })
    }
    pub fn tick(&self, now: i64) -> Result<bool> {
        self.deliver_with(now, |key, bytes| post(&self.url, key, bytes))
    }
    pub fn deliver_with(
        &self,
        now: i64,
        send: impl FnOnce(&str, &[u8]) -> Result<bool>,
    ) -> Result<bool> {
        let job:Option<(String,String,Vec<u8>)>=self.db.query_row(
            "UPDATE jobs SET state='CLAIMED',due=?1+60,token=lower(hex(randomblob(16)))
             WHERE rowid=(SELECT rowid FROM jobs WHERE state IN ('READY','CLAIMED') AND due<=?1 ORDER BY due,rowid LIMIT 1)
             RETURNING delivery_key,token,bytes",[now],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let Some((key, token, bytes)) = job else {
            return Ok(false);
        };
        let accepted = send(&key, &bytes).unwrap_or(false);
        self.db.execute(
            "UPDATE jobs SET attempts=attempts+1,token=NULL,
             state=CASE WHEN ?3 THEN 'DONE' WHEN attempts>=11 THEN 'REVIEW' ELSE 'READY' END,
             due=?4+min(3600,30*(1<<min(7,attempts)))
             WHERE delivery_key=?1 AND token=?2 AND state='CLAIMED'",
            params![key, token, accepted, now],
        )?;
        Ok(true)
    }
}
fn post(url: &str, key: &str, bytes: &[u8]) -> Result<bool> {
    let mut child = Command::new("curl")
        .args([
            "--disable",
            "--silent",
            "--max-time",
            "15",
            "--proto",
            "=https,http",
            "--output",
            "/dev/null",
            "--write-out",
            "%{http_code}",
            "--header",
            "Content-Type: application/json",
            "--header",
            &format!("Idempotency-Key: {key}"),
            "--data-binary",
            "@-",
            "--url",
            url,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let written = child
        .stdin
        .take()
        .ok_or("missing curl stdin")?
        .write_all(bytes);
    let result = child.wait_with_output()?;
    written?;
    Ok(result.status.success() && result.stdout.first() == Some(&b'2'))
}
