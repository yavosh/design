"""Check both proof replays against the fixture observed by the SQLite test."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
states = json.loads((root / "trace.json").read_text())
assert states[0] == {"action": "init", "input": 0, "revision": 0, "seen": []}


def compact(text):
    return "".join(text.split())


def matches(path, start, end, expected):
    source = (root / path).read_text().split(start, 1)[1].split(end, 1)[0]
    if compact(source) != compact(expected):
        raise SystemExit(f"{path} replay differs from the SQLite test fixture")


tla = []
lean = []
for state in states:
    action = state["action"]
    incoming = state["input"]
    revision = state["revision"]
    seen = state["seen"]
    ids = ",".join(map(str, sorted(seen)))
    tla.append(f'[op |-> "{action}", r |-> {incoming}, rev |-> {revision}, ids |-> {{{ids}}}]')
    if action != "init":
        lean.append(f"(.{action} {incoming}, ⟨{revision},{seen}⟩)")

matches("ProjectionTraces.tla", "Trace == <<", ">>", ",".join(tla))
matches("lean/Projection/Projection.lean", "theorem observed : replay init [",
        "] = true := by decide", ",".join(lean))

identity = json.loads((root / "identity-trace.json").read_text())
expected = []
for state in identity:
    ids = ",".join(map(str, state["seen"]))
    done = ",".join(map(str, state["handled"]))
    expected.append(
        f'[r |-> {state["input"]}, k |-> {state["key"]}, rev |-> {state["revision"]}, '
        f'ids |-> {{{ids}}}, done |-> {{{done}}}]')
matches("IdentityTraces.tla", "Trace == <<", ">>", ",".join(expected))
