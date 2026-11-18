use outbox_stream::*;
use rusqlite::{Connection, params};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Result<Self> {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "outbox-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&p)?;
        init(&p)?;
        Ok(Self(p))
    }
    fn db(&self, name: &str) -> Connection {
        Connection::open(self.0.join(format!("{name}.db"))).unwrap()
    }
    fn count(&self, name: &str, sql: &str) -> i64 {
        self.db(name).query_row(sql, [], |r| r.get(0)).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn failed_outbox_insert_rolls_back_change() -> Result<()> {
    let f = Fixture::new()?;
    let mut p = Producer::open(&f.0)?;
    p.update("a", "open", "r", None)?;
    f.db("producer").execute_batch(
        "CREATE TRIGGER reject BEFORE INSERT ON outbox BEGIN SELECT raise(ABORT,'injected'); END;",
    )?;
    assert!(p.update("a", "closed", "r", None).is_err());
    assert_eq!(f.count("producer", "SELECT revision FROM records"), 1);
    assert_eq!(f.count("producer", "SELECT count(*) FROM outbox"), 1);
    Ok(())
}

#[test]
fn relay_and_handler_crashes_preserve_one_effect_per_group() -> Result<()> {
    let f = Fixture::new()?;
    let mut p = Producer::open(&f.0)?;
    let mut other = Producer::open(&f.0)?;
    let mut stream = Stream::open(&f.0)?;
    p.update("a", "open", "r", Some("trace"))?;
    let now = clock() + 1;
    let old = p.claim(now, 1)?.pop().unwrap();
    assert!(other.claim(now + LEASE - 1, 1)?.is_empty());
    let entry = stream.append(&old.stream, &old.bytes, now)?;
    let new = other.claim(now + LEASE, 1)?.pop().unwrap();
    assert!(!p.finish(&old, entry, now)?);
    assert!(!p.fail(&old, now)?);
    assert_eq!(old.bytes, new.bytes);
    let duplicate = stream.append(&new.stream, &new.bytes, now)?;
    assert!(other.finish(&new, duplicate, now)?);
    for group in Group::ALL {
        stream.enroll(group)?;
        let mut c = Consumer::open(&f.0, group)?;
        let d = stream.take(group, "one", now, false)?.unwrap();
        c.apply(&d.bytes)?;
        drop(c);
        let mut restarted = Consumer::open(&f.0, group)?;
        let again = stream
            .take(group, "two", now + DELIVERY_LEASE, true)?
            .unwrap();
        assert!(!stream.ack(&d)?);
        restarted.apply(&again.bytes)?;
        assert!(stream.ack(&again)?);
        restarted.tick(&mut stream, "two", now + DELIVERY_LEASE)?;
        assert_eq!(f.count(group.name(), "SELECT count(*) FROM seen"), 1);
    }
    assert_eq!(f.count("jobs", "SELECT count(*) FROM jobs"), 1);
    assert_eq!(f.count("stream", "SELECT count(*) FROM pending"), 0);
    Ok(())
}
#[test]
fn retry_budget_and_replay_use_original_bytes() -> Result<()> {
    let f = Fixture::new()?;
    let mut p = Producer::open(&f.0)?;
    let id = p.update("a", "open", "r", None)?;
    let mut now = clock() + 1;
    let bytes = p.claim(now, 1)?.pop().unwrap().bytes;
    now += LEASE;
    for delay in [
        5, 30, 120, 600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600,
    ] {
        let c = p.claim(now, 1)?.pop().unwrap();
        assert_eq!(c.bytes, bytes);
        assert!(p.fail(&c, now)?);
        now += delay;
        assert!(p.claim(now - 1, 1)?.is_empty());
    }
    assert!(p.claim(now, 1)?.is_empty());
    assert_eq!(
        f.count(
            "producer",
            "SELECT attempts FROM outbox WHERE state='GIVEN_UP'"
        ),
        12
    );
    assert_eq!(p.clean(now + RETENTION + 1)?, 0);
    assert!(p.replay(&id, now)?);
    assert_eq!(p.claim(now, 1)?.pop().unwrap().bytes, bytes);
    Ok(())
}
#[test]
fn expired_history_is_visible_and_projection_bootstraps() -> Result<()> {
    let f = Fixture::new()?;
    let mut p = Producer::open(&f.0)?;
    let mut s = Stream::open(&f.0)?;
    let now = clock() + 1;
    p.update("a", "open", "r", None)?;
    p.drain(&s)?;
    for g in Group::ALL {
        s.enroll(g)?;
    }
    let d = s.take(Group::Jobs, "worker", now, false)?.unwrap();
    assert_eq!(s.trim(now + RETENTION + 1)?, 0);
    Consumer::open(&f.0, Group::Jobs)?.apply(&d.bytes)?;
    s.ack(&d)?;
    assert_eq!(s.trim(now + RETENTION + 1)?, 1);
    assert_eq!(p.clean(now + RETENTION + 1)?, 1);
    assert!(s.take(Group::Projection, "worker", now, false).is_err());
    assert_eq!(status(&f.0)?["groups"]["projection"]["historyGap"], true);
    Consumer::open(&f.0, Group::Projection)?.bootstrap(&mut p, &mut s)?;
    assert_eq!(f.count("projection", "SELECT revision FROM projection"), 1);
    assert!(s.take(Group::Projection, "worker", now, false)?.is_none());
    Ok(())
}
#[test]
fn six_handler_failures_move_entry_to_durable_dead_letters() -> Result<()> {
    let f = Fixture::new()?;
    let mut s = Stream::open(&f.0)?;
    let g = Group::Jobs;
    s.enroll(g)?;
    let now = clock();
    let id = s.append(STREAM, b"invalid", now)?;
    let _crashed = s.take(g, "gone", now, false)?.unwrap();
    let mut c = Consumer::open(&f.0, g)?;
    for i in 0..6 {
        let t = now + DELIVERY_LEASE + i * 30;
        c.tick(&mut s, "live", t)?;
        assert_eq!(
            f.count("stream", "SELECT count(*) FROM dead"),
            i64::from(i == 5)
        );
    }
    assert_eq!(f.count("stream", "SELECT count(*) FROM pending"), 0);
    assert!(s.redrive(g, id, now)?);
    assert!(!s.redrive(g, id, now)?);
    Ok(())
}

// Record observable states after committed SQL transitions, including a reopened consumer.
#[test]
fn projection_trace_matches_proof_fixture() -> Result<()> {
    let f = Fixture::new()?;
    let mut p = Producer::open(&f.0)?;
    let mut s = Stream::open(&f.0)?;
    let mut c = Consumer::open(&f.0, Group::Projection)?;
    let mut trace = Vec::new();
    let observe = |action: &str, input: i64| -> Result<serde_json::Value> {
        let db = f.db("projection");
        let revision = f.count(
            "projection",
            "SELECT coalesce(max(revision),0) FROM projection",
        );
        let seen = db
            .prepare("SELECT event FROM seen ORDER BY rowid DESC")?
            .query_map([], |r| r.get::<_, String>(0))?
            .map(|v| Ok(v?.rsplit(':').next().unwrap().parse::<i64>()?))
            .collect::<Result<Vec<_>>>()?;
        if revision > 0 {
            let status: String = db.query_row("SELECT status FROM projection", [], |r| r.get(0))?;
            assert_eq!(status, format!("v{revision}"));
        }
        Ok(serde_json::json!({"action":action,"input":input,"revision":revision,"seen":seen}))
    };
    trace.push(observe("init", 0)?);
    for i in 1..=2 {
        p.update("a", &format!("v{i}"), "r", None)?;
    }
    let payload = |i: i64| -> Vec<u8> {
        f.db("producer")
            .query_row("SELECT bytes FROM outbox WHERE id=?1", params![i], |r| {
                r.get(0)
            })
            .unwrap()
    };
    for i in [2, 1, 2] {
        c.apply(&payload(i))?;
        trace.push(observe("apply", i)?);
    }
    drop(c);
    let mut c = Consumer::open(&f.0, Group::Projection)?;
    p.update("a", "v3", "r", None)?;
    c.bootstrap(&mut p, &mut s)?;
    trace.push(observe("snapshot", 3)?);
    c.apply(&payload(3))?;
    trace.push(observe("apply", 3)?);
    let expected =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("specs/trace.json"))?;
    assert_eq!(
        serde_json::Value::Array(trace),
        serde_json::from_str::<serde_json::Value>(&expected)?
    );
    Ok(())
}
