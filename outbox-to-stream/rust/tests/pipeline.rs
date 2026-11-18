use outbox_stream::*;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

#[path = "pipeline/cli.rs"]
mod cli;

struct Fixture(PathBuf);
impl Fixture {
    fn empty() -> Result<Self> {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "outbox-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&p)?;
        Ok(Self(p))
    }
    fn new() -> Result<Self> {
        let fixture = Self::empty()?;
        init(&fixture.0)?;
        Ok(fixture)
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
    // The dead letter is newer than the original stream entry.
    let trim_at = now + RETENTION + 1;
    assert_eq!(s.trim(trim_at)?, 1);
    assert!(s.redrive(g, id, trim_at)?);
    assert!(!s.redrive(g, id, now)?);
    assert_eq!(
        f.count("stream", "SELECT count(*) FROM entries"),
        0,
        "redrive leaked into other groups"
    );
    let retry = s.take(g, "operator", trim_at, true)?.unwrap();
    assert_eq!(retry.bytes, b"invalid");
    Ok(())
}

#[test]
fn late_and_duplicate_updates_preserve_the_latest_record() -> Result<()> {
    let f = Fixture::new()?;
    let mut producer = Producer::open(&f.0)?;
    producer.update("a", "open", "r1", None)?;
    producer.update("a", "closed", "r2", None)?;
    let mut claims = producer.claim(clock() + 1, 2)?;
    claims.sort_by_key(|c| c.id);
    let mut consumer = Consumer::open(&f.0, Group::Projection)?;
    for index in [1, 0, 1] {
        consumer.apply(&claims[index].bytes)?;
    }
    assert_eq!(
        f.count(
            "projection",
            "SELECT count(*) FROM projection WHERE revision=2 AND status='closed'"
        ),
        1
    );
    assert_eq!(f.count("projection", "SELECT count(*) FROM seen"), 2);
    Ok(())
}

#[test]
fn conflicting_event_identity_never_acknowledges_a_lost_update() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut producer = Producer::open(&fixture.0)?;
    let mut consumer = Consumer::open(&fixture.0, Group::Projection)?;
    producer.update("a", "open", "r1", None)?;
    producer.update("a", "closed", "r2", None)?;
    let mut claims = producer.claim(clock() + 1, 2)?;
    claims.sort_by_key(|c| c.id);
    consumer.apply(&claims[0].bytes)?;
    let mut event: Event = serde_json::from_slice(&claims[1].bytes)?;
    event.event_id = serde_json::from_slice::<Event>(&claims[0].bytes)?.event_id;
    assert!(
        consumer.apply(&serde_json::to_vec(&event)?).is_err(),
        "accepted revision 2 under revision 1's identity"
    );
    consumer.apply(&claims[1].bytes)?;
    assert_eq!(
        fixture.count("projection", "SELECT revision FROM projection"),
        2
    );
    Ok(())
}

#[test]
fn ambiguous_destination_response_retries_same_key_and_bytes() -> Result<()> {
    let f = Fixture::new()?;
    let mut p = Producer::open(&f.0)?;
    p.update("a", "open", "r", None)?;
    let bytes = p.claim(clock() + 1, 1)?.pop().unwrap().bytes;
    let mut jobs = Consumer::open(&f.0, Group::Jobs)?;
    jobs.apply(&bytes)?;
    let worker = Worker::open(&f.0, "https://example.invalid")?;
    let mut first = String::new();
    assert!(worker.deliver_with(100, |key, body| {
        first = key.into();
        assert_eq!(body, bytes);
        Err("lost response".into())
    })?);
    assert!(!worker.deliver_with(129, |_, _| unreachable!())?);
    assert!(worker.deliver_with(130, |key, body| {
        assert_eq!(key, first);
        assert_eq!(body, bytes);
        Ok(true)
    })?);
    jobs.apply(&bytes)?;
    assert!(!worker.deliver_with(200, |_, _| unreachable!())?);
    assert_eq!(
        f.count("jobs", "SELECT attempts FROM jobs WHERE state='DONE'"),
        2
    );
    assert!(Worker::open(&f.0, "https://elsewhere.invalid").is_err());
    Ok(())
}

#[test]
fn competing_relay_connections_claim_disjoint_rows() -> Result<()> {
    let f = Fixture::new()?;
    let mut producer = Producer::open(&f.0)?;
    for _ in 0..20 {
        producer.update("a", "open", "req", None)?;
    }
    let barrier = std::sync::Barrier::new(2);
    let now = clock() + 1;
    let ids = std::thread::scope(|scope| {
        let claim = || {
            let mut replica = Producer::open(&f.0).unwrap();
            barrier.wait();
            replica
                .claim(now, 10)
                .unwrap()
                .into_iter()
                .map(|c| c.id)
                .collect::<Vec<_>>()
        };
        let left = scope.spawn(claim);
        let right = scope.spawn(claim);
        [left.join().unwrap(), right.join().unwrap()]
    });
    assert!(ids.iter().all(|rows| rows.len() == 10));
    assert_eq!(
        ids.into_iter()
            .flatten()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        20
    );
    Ok(())
}

#[test]
fn failed_projection_transaction_keeps_entry_retriable() -> Result<()> {
    let f = Fixture::new()?;
    let mut producer = Producer::open(&f.0)?;
    let mut stream = Stream::open(&f.0)?;
    producer.update("a", "open", "r", None)?;
    producer.drain(&stream)?;
    let mut consumer = Consumer::open(&f.0, Group::Projection)?;
    stream.enroll(Group::Projection)?;
    let db = f.db("projection");
    db.execute_batch("CREATE TRIGGER reject BEFORE INSERT ON projection BEGIN SELECT raise(ABORT,'injected'); END;")?;
    let now = clock();
    consumer.tick(&mut stream, "one", now)?;
    assert_eq!(f.count("projection", "SELECT count(*) FROM seen"), 0);
    assert_eq!(f.count("stream", "SELECT failures FROM pending"), 1);
    db.execute_batch("DROP TRIGGER reject")?;
    consumer.tick(&mut stream, "two", now + 30)?;
    assert_eq!(f.count("projection", "SELECT revision FROM projection"), 1);
    assert_eq!(f.count("stream", "SELECT count(*) FROM pending"), 0);
    Ok(())
}

#[test]
fn reconciliation_requires_current_floor_and_preserves_retained_entries() -> Result<()> {
    let f = Fixture::new()?;
    let mut stream = Stream::open(&f.0)?;
    let g = Group::Jobs;
    stream.enroll(g)?;
    let now = clock();
    let expired = stream.append(STREAM, b"old", now - RETENTION - 1)?;
    let retained = stream.append(STREAM, b"retained", now)?;
    stream.trim(now)?;
    assert!(stream.take(g, "one", now, false).is_err());
    assert!(!stream.resume_reconciled(g, retained)?);
    assert!(stream.resume_reconciled(g, expired)?);
    assert_eq!(
        stream.take(g, "one", now, false)?.unwrap().bytes,
        b"retained"
    );
    Ok(())
}

#[test]
fn unsupported_subscribed_version_stays_pending_and_unrelated_type_advances() -> Result<()> {
    let f = Fixture::new()?;
    let mut producer = Producer::open(&f.0)?;
    producer.update("a", "open", "r", None)?;
    let mut event: Event =
        serde_json::from_slice(&producer.claim(clock() + 1, 1)?.pop().unwrap().bytes)?;
    event.schema_version = 2;
    let mut stream = Stream::open(&f.0)?;
    let g = Group::Jobs;
    let now = clock();
    stream.enroll(g)?;
    stream.append(STREAM, &serde_json::to_vec(&event)?, now)?;
    stream.append(STREAM, br#"{"type":"Unrelated"}"#, now)?;
    let mut consumer = Consumer::open(&f.0, g)?;
    consumer.tick(&mut stream, "one", now)?;
    consumer.tick(&mut stream, "one", now)?;
    assert_eq!(f.count("stream", "SELECT failures FROM pending"), 1);
    assert_eq!(f.count("stream", "SELECT cursor FROM groups"), 2);
    assert_eq!(f.count("jobs", "SELECT count(*) FROM jobs"), 0);
    Ok(())
}
