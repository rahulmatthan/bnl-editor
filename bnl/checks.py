"""Check a BNL file: the Akoma Ntoso schema, the BNL rulebook, and the editor's own checks.

Every result is {level, code, message, line, eId}. Levels:
  error    the instrument is not valid BNL; it cannot be authenticated
  warning  probably a mistake in drafting; authentication is allowed
  finding  a fact the rules exist to expose (e.g. BNL-4: a State change with no State instrument cited)
  info     for review (links marked inferred or contested)
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from . import akn

SPEC = Path(__file__).resolve().parent.parent / "spec" / "bnl-0.1"
SCHEMA = SPEC / "validate.xsd"
RULES = SPEC / "rules.sch"
BNL_VERSION = "0.1"

SCHEMA_LINE = re.compile(r"^.*?:(\d+): element (\S+): Schemas validity error : (.*)$")
RULE_LINE = re.compile(r"^(\S+) line (\d+): (BNL-\d+) (.*)$")
NS_BRACES = re.compile(r"\{[^}]*\}")


def _result(level, code, message, line=None, eid=None):
    return {"level": level, "code": code, "message": message, "line": line, "eId": eid}


def schema(path: Path, index: dict) -> list:
    r = subprocess.run(["xmllint", "--noout", "--schema", str(SCHEMA), str(path)],
                       capture_output=True, text=True)
    out = []
    for ln in r.stderr.splitlines():
        m = SCHEMA_LINE.match(ln)
        if m:
            line = int(m.group(1))
            msg = NS_BRACES.sub("", m.group(3)).replace("Element '", "'")
            out.append(_result("error", "AKN", msg, line, akn.eid_at(index, line)))
    if r.returncode != 0 and not out:
        out.append(_result("error", "AKN", "The schema check could not run: " + r.stderr.strip()[:300]))
    return out


def rules(path: Path, index: dict) -> list:
    r = subprocess.run(["xmllint", "--noout", "--schematron", str(RULES), str(path)],
                       capture_output=True, text=True)
    if "failed to compile" in r.stderr or "parser error" in r.stderr:
        # Never report a pass when the rules did not run.
        return [_result("error", "RULEBOOK", "The BNL rulebook did not compile, so no BNL rule was checked: "
                        + r.stderr.strip().splitlines()[0][:300])]
    out = []
    for ln in r.stderr.splitlines():
        m = RULE_LINE.match(ln)
        if m:
            line = int(m.group(2))
            level = "finding" if m.group(3) == "BNL-4" else "error"
            out.append(_result(level, m.group(3), m.group(4), line, akn.eid_at(index, line)))
    return out


ROMAN_VALUES = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}
ROMAN_KINDS = {"subclause", "chapter", "part", "subchapter"}      # (i), (ii); CHAPTER IV
ALPHA_KINDS = {"clause", "point", "item"}                          # (a), (b); (A), (B)


def _roman(tok):
    total, prev = 0, 0
    for ch in reversed(tok.lower()):
        if ch not in ROMAN_VALUES:
            return None
        v = ROMAN_VALUES[ch]
        total = total - v if v < prev else total + v
        prev = max(prev, v)
    return total


def _seq_value(kind: str, token: str):
    """The position of a number in its sequence, read by the kind of provision, or None
    when the number is not a plain member (8A, (aa), a heading-style number)."""
    if token.isdigit():
        return int(token)
    if kind in ROMAN_KINDS:
        return _roman(token)
    if kind in ALPHA_KINDS and len(token) == 1 and token.isalpha():
        return ord(token.lower()) - 96
    return None


def editor(root, is_bill: bool) -> list:
    out = []
    eids = {}
    for el in root.iter():
        e = el.get("eId")
        if e:
            eids.setdefault(e, []).append(el)
    for e, els in eids.items():
        if len(els) > 1:
            out.append(_result("error", "ED-1", f"The identifier {e} is used {len(els)} times; identifiers must be unique.", eid=e))

    parent = {c: p for p in root.iter() for c in p}
    for el in root.iter():
        name = akn.local(el.tag)
        if name not in akn.ABBR or name in akn.UNNUMBERED or name == "list":
            continue
        if any(akn.local(a.tag) == "meta" for a in _ancestors(el, parent)):
            continue
        num = el.find(akn.q("num"))
        if num is None or not "".join(num.itertext()).strip():
            out.append(_result("warning", "ED-2", f"This {name} has no number.", eid=el.get("eId")))
        has_text = any("".join(p.itertext()).strip() for p in el.iter(akn.q("p")))
        if not has_text and el.find(akn.q("heading")) is None:
            out.append(_result("warning", "ED-6", f"This {name} has no text.", eid=el.get("eId")))

    # Numbering runs in order among siblings of the same kind.
    for p in root.iter():
        prev = {}
        for c in p:
            name = akn.local(c.tag)
            if name not in akn.ABBR or name in akn.UNNUMBERED:
                continue
            num = c.find(akn.q("num"))
            if num is None:
                continue
            tok = akn.num_token("".join(num.itertext()))
            v = _seq_value(name, tok)
            last = prev.get(name)
            if v is not None and last is not None and v != last[0] + 1:
                level = "warning" if is_bill else "info"
                out.append(_result(level, "ED-3", f"{name.capitalize()} {tok} follows {last[1]}: the numbering is out of sequence.",
                                   eid=c.get("eId")))
            if v is not None:
                prev[name] = (v, tok)

    for e_now, e_num in akn.expected_eid_mismatches(root):
        if e_now.startswith("tmp_"):
            continue
        out.append(_result("warning" if is_bill else "info", "ED-8",
                           f"The identifier {e_now} no longer matches the number (it would be {e_num}). "
                           "Identifiers are permanent: use Update IDs only while the Bill is a draft.", eid=e_now))

    # Amendments this instrument makes.
    made = [tm for am in root.iter(akn.q("activeModifications")) for tm in am.iter(akn.q("textualMod"))]
    for tm in made:
        eid = tm.get("eId")
        src = tm.find(akn.q("source"))
        dests = tm.findall(akn.q("destination"))
        if src is None or not src.get("href"):
            out.append(_result("error", "ED-4", "An amendment does not say which provision of this instrument makes it.", eid=eid))
        elif src.get("href").startswith("#") and src.get("href")[1:] not in eids:
            out.append(_result("error", "ED-4", f"An amendment is made by {src.get('href')}, which does not exist.", eid=eid))
        for d in dests:
            h = d.get("href") or ""
            if not (h.startswith("/akn/in") and "~" in h) and not h.startswith("#"):
                out.append(_result("warning", "ED-5", f"The provision amended ({h or 'none'}) is not a full BNL name "
                                   "like /akn/in/act/1940/23/~sec_27.", eid=eid))
        typ = tm.get("type")
        if typ in ("substitution", "insertion") and tm.find(akn.q("new")) is None:
            out.append(_result("warning", "ED-7", f"{'An' if typ[0] in 'aeiou' else 'A'} {typ} gives no new text.", eid=eid))
        if typ == "substitution" and tm.find(akn.q("old")) is None:
            out.append(_result("warning", "ED-7", "A substitution does not say which words it replaces.", eid=eid))

    seen = {}
    for tm in made:
        key = (tm.get("type"), tuple(sorted((c.tag, c.get("href") or "", "".join(c.itertext()).strip()) for c in tm)))
        if key in seen:
            out.append(_result("warning", "ED-10", f"This amendment repeats {seen[key]}: the same change is recorded twice.",
                               eid=tm.get("eId")))
        else:
            seen[key] = tm.get("eId")

    sources = {(s.get("href") or "")[1:] for tm in made for s in tm.findall(akn.q("source"))}
    for att in root.iter(akn.q("attachment")):
        for el in att.iter():
            if akn.local(el.tag) in ("paragraph", "item") and el.find(f".//{akn.q('mod')}") is not None \
                    and el.get("eId") not in sources:
                out.append(_result("warning", "ED-11", "This Schedule entry amends another law, but no amendment "
                                   "is recorded for it (use Record an amendment).", eid=el.get("eId")))

    prof = root.find(f".//{akn.q('proprietary')}/{{{akn.BNL}}}profile")
    if prof is None:
        out.append(_result("warning", "ED-9", "The instrument does not declare which version of BNL it follows."))
    elif prof.get("version") != BNL_VERSION:
        out.append(_result("error", "ED-9", f"The instrument declares BNL {prof.get('version')}; this editor checks BNL {BNL_VERSION}."))

    for el in root.iter():
        b = el.get(f"{{{akn.BNL}}}basis")
        if b in ("inferred", "contested"):
            target = el.get("eId") or _nearest_eid(el, parent)
            out.append(_result("info", "REVIEW", f"A link marked {b}: confirm it.", eid=target))

    # Notes on clauses: once a Bill has them, every section has one, and every note says something.
    noc = [d for d in root.iter(akn.q("doc")) if d.get("name") == "notesOnClauses"]
    if noc:
        noted, notes = set(), [h for h in noc[0].iter(akn.q("hcontainer")) if h.get("name") == "noteOnClause"]
        for n in notes:
            head = n.find(akn.q("heading"))
            ref = head.find(akn.q("ref")) if head is not None else None
            if ref is not None:
                noted.add((ref.get("href") or "")[1:])
            if not any("".join(p.itertext()).strip() for p in n.iter(akn.q("p"))):
                out.append(_result("warning", "ED-12", "This note on clauses has no text.", eid=n.get("eId")))
        body = root.find(f".//{akn.q('body')}")
        for s in (body.iter(akn.q("section")) if body is not None else []):
            if s.get("eId") and s.get("eId") not in noted:
                out.append(_result("warning", "ED-12", "This clause has no note in the Notes on Clauses.", eid=s.get("eId")))
    return out


def _ancestors(el, parent):
    while el in parent:
        el = parent[el]
        yield el


def _nearest_eid(el, parent):
    for a in _ancestors(el, parent):
        if a.get("eId"):
            return a.get("eId")
    return None


ORDER = {"error": 0, "warning": 1, "finding": 2, "info": 3}


def run(path: Path) -> list:
    data = path.read_bytes()
    try:
        root = akn.parse(data)
    except Exception as e:  # not even XML
        return [_result("error", "XML", f"The file is not well-formed XML: {e}")]
    index = akn.line_index(data)
    is_bill = any(akn.local(c.tag) == "bill" for c in root)
    res = schema(path, index) + rules(path, index) + editor(root, is_bill)
    res.sort(key=lambda r: (ORDER[r["level"]], r["line"] or 0))
    return res


def summary(results: list) -> dict:
    s = {k: 0 for k in ORDER}
    for r in results:
        s[r["level"]] += 1
    return s
