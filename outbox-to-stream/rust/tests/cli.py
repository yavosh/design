"""Exercise the compiled roles and a lost HTTP response on loopback."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import time


def wait_for(check):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.05)
    raise AssertionError("timed out waiting for pipeline transition")


def main():
    binary = Path(__file__).resolve().parents[1] / "target/debug/outbox-stream"
    release = threading.Event()
    received = threading.Event()
    requests = []

    class Receiver(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            requests.append((self.headers["Idempotency-Key"], body))
            received.set()
            if len(requests) == 1:
                release.wait(15)
            self.send_response(204)
            self.end_headers()

        def log_message(self, *_):
            pass

    with tempfile.TemporaryDirectory() as directory, ThreadingHTTPServer(("127.0.0.1", 0), Receiver) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        cmd = [str(binary), directory]
        children = []

        def run(*args):
            return subprocess.check_output([*cmd, *args], text=True)

        def start(*args):
            child = subprocess.Popen([*cmd, *args])
            children.append(child)
            return child

        try:
            run("init")
            start("relay")
            start("consume", "projection", "view-1")
            start("consume", "jobs", "jobs-1")
            url = f"http://127.0.0.1:{server.server_port}/event"
            first = start("worker", url)
            run("update", "example", "active", "request-1")
            assert received.wait(15), "no webhook arrived"
            first.kill()
            first.wait()
            release.set()
            with sqlite3.connect(Path(directory) / "jobs.db") as jobs:
                assert jobs.execute("SELECT state FROM jobs").fetchone() == ("CLAIMED",)
                # Advance only the private fixture's job lease to avoid a one-minute wait.
                jobs.execute("UPDATE jobs SET due=0")
                jobs.commit()
                start("worker", url)
                wait_for(lambda: jobs.execute("SELECT state FROM jobs").fetchone() == ("DONE",))
            assert len(requests) == 2 and requests[0] == requests[1]
            assert json.loads(requests[0][1])["payload"]["status"] == "active"
            with sqlite3.connect(Path(directory) / "projection.db") as projection:
                wait_for(lambda: projection.execute("SELECT revision,status FROM projection").fetchone() == (1, "active"))
            wait_for(lambda: json.loads(run("status"))["unsent"] == 0)
            print("CLI pipeline passed. A killed webhook worker retried with identical bytes and key.")
        finally:
            release.set()
            for child in children:
                if child.poll() is None:
                    child.terminate()
                child.wait()
            server.shutdown()


if __name__ == "__main__":
    main()
