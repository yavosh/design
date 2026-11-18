use super::Fixture;
use outbox_stream::Result;
use std::path::Path;
use std::process::{Child, Command};
use std::time::{Duration, Instant};
use tiny_http::{Request, Response, Server};

const TIMEOUT: Duration = Duration::from_secs(15);

fn cli(dir: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_outbox-stream"));
    cmd.arg(dir).args(args);
    cmd
}

struct Role(Child);
impl Drop for Role {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn webhook(request: &mut Request) -> Result<(String, Vec<u8>)> {
    assert_eq!(request.method(), &tiny_http::Method::Post);
    let key = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Idempotency-Key"))
        .ok_or("missing delivery key")?
        .value
        .to_string();
    assert!(!key.is_empty());
    let mut bytes = Vec::new();
    request.as_reader().read_to_end(&mut bytes)?;
    Ok((key, bytes))
}

#[test]
fn killed_webhook_worker_retries_the_same_request() -> Result<()> {
    let f = Fixture::empty()?;
    let server = Server::http("127.0.0.1:0").map_err(std::io::Error::other)?;
    let url = format!("http://{}/event", server.server_addr());
    assert!(cli(&f.0, &["init"]).status()?.success());
    let _relay = Role(cli(&f.0, &["relay"]).spawn()?);
    let _view = Role(cli(&f.0, &["consume", "projection", "view-1"]).spawn()?);
    let _jobs = Role(cli(&f.0, &["consume", "jobs", "jobs-1"]).spawn()?);
    let worker = Role(cli(&f.0, &["worker", &url]).spawn()?);
    assert!(
        cli(&f.0, &["update", "example", "active", "req-1"])
            .status()?
            .success()
    );

    let mut first = server
        .recv_timeout(TIMEOUT)?
        .ok_or("first POST timed out")?;
    let sent = webhook(&mut first)?;
    drop(worker); // Simulate a crash after receipt, before the worker sees a response.
    first.respond(Response::empty(204))?;
    let jobs = f.db("jobs");
    // Expire the private fixture's lease so the retry can run immediately.
    assert_eq!(
        jobs.execute("UPDATE jobs SET due=0 WHERE state='CLAIMED'", [])?,
        1
    );
    let _restarted = Role(cli(&f.0, &["worker", &url]).spawn()?);
    let mut retry = server.recv_timeout(TIMEOUT)?.ok_or("retry timed out")?;
    assert_eq!(webhook(&mut retry)?, sent);
    let event: outbox_stream::Event = serde_json::from_slice(&sent.1)?;
    assert_eq!(event.payload.status, "active");
    retry.respond(Response::empty(204))?;

    let deadline = Instant::now() + TIMEOUT;
    while f.count("jobs", "SELECT count(*) FROM jobs WHERE state='DONE'") != 1
        || f.count(
            "projection",
            "SELECT count(*) FROM projection WHERE revision=1 AND status='active'",
        ) != 1
        || f.count("producer", "SELECT count(*) FROM outbox WHERE state='SENT'") != 1
    {
        assert!(Instant::now() < deadline, "pipeline did not finish");
        std::thread::sleep(Duration::from_millis(50));
    }
    let status = cli(&f.0, &["status"]).output()?;
    assert!(status.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&status.stdout)?["unsent"],
        0
    );
    Ok(())
}
