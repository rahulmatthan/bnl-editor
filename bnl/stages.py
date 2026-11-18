"""Authenticate an instrument at a stage, and keep the record that proves nothing changed afterwards.

  - the text authenticated at a stage is the text that is published: the snapshot is the file;
  - no change after authentication save by a fresh authentication: snapshots are never rewritten;
  - verification before publication: an instrument with any error is refused, with the reasons;
  - a public record to which entries may only be added: stages.jsonl, each entry carrying the
    hash of the one before, so removing or altering an entry breaks the chain.

Not yet: electronic signatures (the officer is recorded by name only), trusted time-stamps, and a
register of authorised officers. Those need the Controller of Certifying Authorities'
infrastructure (DSCs) and are the next step, not something to imitate.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
from pathlib import Path

from . import akn, checks
from .akn import q

STAGES = {
    "vetted": "Vetted by the Legislative Department",
    "introduced-ls": "Introduced in the Lok Sabha",
    "introduced-rs": "Introduced in the Rajya Sabha",
    "committee": "Reported by a Parliamentary Committee",
    "passed-ls": "Passed by the Lok Sabha",
    "passed-rs": "Passed by the Rajya Sabha",
    "passed-both": "As passed by both Houses of Parliament",
    "assented": "Assented to by the President",
}

META_ORDER = ["identification", "publication", "classification", "lifecycle", "workflow", "analysis",
              "temporalData", "references", "notes", "proprietary", "presentation"]


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _entry_hash(entry: dict) -> str:
    body = {k: v for k, v in entry.items() if k != "hash"}
    return sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode("utf-8"))


def read_log(folder: Path) -> list:
    f = folder / "stages.jsonl"
    if not f.exists():
        return []
    return [json.loads(l) for l in f.read_text().splitlines() if l.strip()]


def _meta_child(meta, name):
    el = meta.find(q(name))
    if el is not None:
        return el
    el = meta.makeelement(q(name), {})
    pos = META_ORDER.index(name)
    idx = len(meta)
    for i, c in enumerate(meta):
        n = akn.local(c.tag)
        if n in META_ORDER and META_ORDER.index(n) > pos:
            idx = i
            break
    meta.insert(idx, el)
    return el


def record_event(root, stage, date):
    """Add the stage to the instrument's lifecycle (and its event to the references)."""
    doc = next(iter(root))
    meta = doc.find(q("meta"))
    refs = _meta_child(meta, "references")
    if refs.get("source") is None:
        refs.set("source", "#bnl-editor")
    if refs.find(q("original")) is None:
        uri = meta.find(f"{q('identification')}/{q('FRBRExpression')}/{q('FRBRuri')}").get("value")
        orig = refs.makeelement(q("original"), {"eId": "original", "href": uri, "showAs": "Original"})
        refs.insert(0, orig)
    ev_id = f"stage_{stage}"
    if not any(e.get("eId") == ev_id for e in refs):
        refs.append(refs.makeelement(q("TLCEvent"), {"eId": ev_id, "href": f"/ontology/event/in/{stage}",
                                                    "showAs": STAGES[stage]}))
    life = _meta_child(meta, "lifecycle")
    life.set("source", "#bnl-editor")
    n = sum(1 for _ in life.iter(q("eventRef"))) + 1
    life.append(life.makeelement(q("eventRef"), {"eId": f"e_{stage}_{n}", "date": date, "source": "#original",
                                                 "type": "generation", "refersTo": f"#{ev_id}"}))


def authenticate(folder: Path, xml_name: str, stage: str, officer: str, date: str | None = None):
    """-> (entry, None) on success, or (None, check results) when the instrument is refused."""
    if stage not in STAGES:
        raise ValueError(f"unknown stage {stage}")
    if not officer.strip():
        raise ValueError("the authenticating officer must be named")
    date = date or dt.date.today().isoformat()
    path = folder / xml_name

    first = checks.run(path)
    if any(r["level"] == "error" for r in first):
        return None, first

    root = akn.parse(path.read_bytes())
    record_event(root, stage, date)
    data = akn.serialize(root)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)

    results = checks.run(path)
    if any(r["level"] == "error" for r in results):
        return None, results

    log = read_log(folder)
    n = len(log) + 1
    snap_dir = folder / "stages"
    snap_dir.mkdir(exist_ok=True)
    snap = snap_dir / f"{n:02d}-{stage}.xml"
    if snap.exists():
        raise RuntimeError(f"{snap} already exists; the record has been tampered with")
    snap.write_bytes(data)
    os.chmod(snap, 0o444)

    entry = {
        "n": n,
        "stage": stage,
        "label": STAGES[stage],
        "date": date,
        "officer": officer.strip(),
        "file": f"stages/{snap.name}",
        "sha256": sha256(data),
        "bnl": checks.BNL_VERSION,
        "warnings": sum(1 for r in results if r["level"] == "warning"),
        "prev": log[-1]["hash"] if log else None,
        "recorded_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    entry["hash"] = _entry_hash(entry)
    with open(folder / "stages.jsonl", "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry, None


def verify(folder: Path) -> list:
    """Check every authenticated stage: the snapshot is unchanged and the chain is unbroken."""
    out, prev = [], None
    for e in read_log(folder):
        problems = []
        if e.get("prev") != prev:
            problems.append("the link to the previous entry is broken")
        if _entry_hash(e) != e.get("hash"):
            problems.append("this entry has been altered")
        f = folder / e["file"]
        if not f.exists():
            problems.append("the authenticated text is missing")
        elif sha256(f.read_bytes()) != e["sha256"]:
            problems.append("the authenticated text has changed since it was authenticated")
        out.append({"n": e["n"], "stage": e["stage"], "ok": not problems, "problems": problems})
        prev = e.get("hash")
    return out
