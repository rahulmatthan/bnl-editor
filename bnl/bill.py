"""Make a new BNL Bill, from nothing or from the plain text of a Bill.

The importer reads Indian drafting conventions: CHAPTER / PART headings, "8. Heading" or
"8. Heading.—(1) text", "(1)" subsections, "(a)" clauses, "(i)" sub-clauses (an "(i)" after "(h)"
is a clause), "(A)" points, "Provided that" provisos, "Explanation.—", and a closing SCHEDULE.
What it cannot place goes in as plain paragraphs of the nearest provision, for the drafter to fix
in the editor: nothing is dropped.
"""

from __future__ import annotations

import datetime as dt
import re
import xml.etree.ElementTree as ET

from . import akn
from . import amend as amend_mod
from .akn import q

BNL_VERSION = "0.1"


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def work_uri(year, number):
    return f"/akn/in/bill/{year}/{number}"


def sub(parent, tag, text=None, **attrs):
    el = ET.SubElement(parent, q(tag), {k.rstrip("_"): str(v) for k, v in attrs.items() if v is not None})
    if text is not None:
        el.text = text
    return el


def meta_block(parent, title, year, number, date):
    uri = work_uri(year, number)
    today = dt.date.today().isoformat()
    meta = sub(parent, "meta")
    ident = sub(meta, "identification", source="#bnl-editor")
    w = sub(ident, "FRBRWork")
    sub(w, "FRBRthis", value=f"{uri}/!main")
    sub(w, "FRBRuri", value=uri)
    sub(w, "FRBRalias", value=title, name="title")
    sub(w, "FRBRdate", date=date, name="draft")
    sub(w, "FRBRauthor", href="#parliament")
    sub(w, "FRBRcountry", value="in")
    sub(w, "FRBRnumber", value=str(number))
    e = sub(ident, "FRBRExpression")
    sub(e, "FRBRthis", value=f"{uri}/eng@{date}/!main")
    sub(e, "FRBRuri", value=f"{uri}/eng@{date}")
    sub(e, "FRBRdate", date=date, name="version")
    sub(e, "FRBRauthor", href="#parliament")
    sub(e, "FRBRlanguage", language="eng")
    m = sub(ident, "FRBRManifestation")
    sub(m, "FRBRthis", value=f"{uri}/eng@{date}/!main.xml")
    sub(m, "FRBRuri", value=f"{uri}/eng@{date}.akn")
    sub(m, "FRBRdate", date=today, name="transform")
    sub(m, "FRBRauthor", href="#bnl-editor")
    refs = sub(meta, "references", source="#bnl-editor")
    sub(refs, "TLCOrganization", eId="parliament", href="/ontology/organization/in/parliament", showAs="Parliament of India")
    sub(refs, "TLCOrganization", eId="bnl-editor", href="/ontology/organization/in/bnl-editor", showAs="BNL Editor")
    prop = sub(meta, "proprietary", source="#bnl-editor")
    ET.SubElement(prop, f"{{{akn.BNL}}}profile", {"version": BNL_VERSION})
    return meta


# -- the text model ----------------------------------------------------------------------------------

LEVEL = {"part": 0, "chapter": 0, "section": 1, "subsection": 2, "clause": 3, "subclause": 4, "point": 5}


class Node:
    def __init__(self, kind, num=None, heading=None, name=None):
        self.kind, self.num, self.heading, self.name = kind, num, heading, name
        self.paras, self.children, self.wrap = [], [], []

    def add_text(self, text):
        (self.wrap if self.children else self.paras).append(text)


CHAPTER = re.compile(r"^(CHAPTER|PART)\s+([IVXLC]+|[A-Z]|\d+)\b\s*[:.\-–—]*\s*(.*)$", re.I)
SCHEDULE = re.compile(r"^(THE\s+)?((FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH)\s+)?SCHEDULE\b\s*(.*)$", re.I)
SECTION = re.compile(r"^(\d+[A-Z]{0,3})\.\s*(.*)$")
BRACKET = re.compile(r"^\(([0-9]+[A-Z]{0,3}|[a-z]{1,3}|[A-Z]{1,2})\)\s*(.*)$")
PROVISO = re.compile(r"^Provided\b")
EXPLANATION = re.compile(r"^(Explanation|Illustrations?)(\s+[IVX0-9]+)?\s*[.:]?\s*[—–-]+\s*(.*)$")
HEAD_SPLIT = re.compile(r"^(.{2,160}?)\.\s*[—–]+-?\s*(.*)$")
ROMAN = re.compile(r"^[ivxl]+$")
TITLE = re.compile(r"\bBILL\b.*\d{4}")
DASHES = re.compile(r"[–—]{1,2}|--")


def clean(line: str) -> str:
    line = line.strip()
    line = re.sub(r"^#+\s*", "", line)
    line = re.sub(r"^[-*]\s+(?=\()", "", line)
    line = line.replace("**", "").replace("__", "")
    line = re.sub(r"(?<=[.;:,”\"])\[[a-z]{1,2}\]", "", line)   # Google Docs comment anchors: "Act.[a]"
    line = line.lstrip("\ufeff")
    if re.fullmatch(r"_{3,}", line.strip()):
        return ""
    line = re.sub(r"\s+", " ", line)
    return line.strip()


def _prev_letter(tok):
    if len(tok) != 1:
        return None
    return chr(ord(tok) - 1)


def parse_text(text: str):
    """-> (preface lines, body nodes, schedules [(title, lines)])."""
    lines = [clean(l) for l in text.splitlines()]
    lines = [l for l in lines if l]
    preface, body, schedules = [], [], []
    stack = []          # open nodes, outermost first
    group = None        # the open chapter/part
    started = False
    i = 0

    def container():
        return group.children if group else body

    def innermost():
        return stack[-1] if stack else None

    def open_at(node):
        lvl = LEVEL[node.kind]
        while stack and LEVEL[stack[-1].kind] >= lvl:
            stack.pop()
        (stack[-1].children if stack else container()).append(node)
        stack.append(node)

    while i < len(lines):
        line = lines[i]
        m = SCHEDULE.match(line)
        if m and started and (line.isupper() or line.lower().startswith("the schedule") or m.group(4) == ""):
            sched_lines = lines[i + 1:]
            schedules.append((line, sched_lines))
            break
        m = CHAPTER.match(line)
        if m and (line.split()[0].isupper()):
            started = True
            kind = m.group(1).lower()
            heading = m.group(3).strip()
            if not heading and i + 1 < len(lines) and not SECTION.match(lines[i + 1]) and not BRACKET.match(lines[i + 1]):
                heading = lines[i + 1]
                i += 1
            group = Node(kind, num=f"{m.group(1).upper()} {m.group(2)}", heading=heading)
            body.append(group)
            stack.clear()
            i += 1
            continue
        m = SECTION.match(line)
        if m and (started or not TITLE.search(line)):
            started = True
            num, rest = m.group(1), m.group(2)
            node = Node("section", num=f"{num}.")
            stack.clear()
            container().append(node)
            stack.append(node)
            hm = HEAD_SPLIT.match(rest)
            if rest.startswith("("):
                _bracket(rest, stack, open_at)
            elif hm and not rest.startswith("("):
                node.heading = hm.group(1).strip()
                after = hm.group(2).strip()
                if after:
                    if BRACKET.match(after):
                        _bracket(after, stack, open_at)
                    else:
                        node.add_text(after)
            elif rest and len(rest) < 120 and not re.search(r"[.;:,—–-]$", rest):
                node.heading = rest
            elif rest:
                node.add_text(rest)
            i += 1
            continue
        if not started:
            preface.append(line)
            i += 1
            continue
        if BRACKET.match(line):
            _bracket(line, stack, open_at)
            i += 1
            continue
        if PROVISO.match(line):
            host = innermost()
            pv = Node("proviso")
            pv.paras.append(line)
            if host:
                host.children.append(pv)
            else:
                container().append(pv)
            i += 1
            continue
        m = EXPLANATION.match(line)
        if m:
            host = innermost()
            hc = Node("hcontainer", name=m.group(1).lower().rstrip("s"),
                      heading=(m.group(1) + (m.group(2) or "")).strip())
            if m.group(3):
                hc.paras.append(m.group(3))
            if host:
                host.children.append(hc)
            else:
                container().append(hc)
            i += 1
            continue
        host = innermost()
        if host is None:
            if group is not None:
                group.paras.append(line)
            else:
                preface.append(line)
        elif line[:1].islower() and len(stack) >= 2 and LEVEL[host.kind] >= 3:
            stack[-2].wrap.append(line)       # text after the clauses: the parent's wrap-up
        elif host.children and host.children[-1].kind in ("proviso", "hcontainer") and not host.wrap:
            host.children[-1].paras.append(line)
        else:
            host.add_text(line)
        i += 1
    return preface, body, schedules


def _bracket(line, stack, open_at):
    m = BRACKET.match(line)
    tok, rest = m.group(1), m.group(2)
    if tok[0].isdigit():
        kind = "subsection"
    elif tok.isupper():
        kind = "point"
    elif ROMAN.match(tok):
        # "(i)" after "(h)", "(v)" after "(u)", "(x)" after "(w)" are clauses.
        prev = _prev_letter(tok)
        siblings = [n for n in stack if n.kind == "clause"]
        kind = "clause" if (prev and siblings and siblings[-1].num == f"({prev})") else "subclause"
    else:
        kind = "clause"
    node = Node(kind, num=f"({tok})")
    open_at(node)
    rest = rest.strip()
    if rest:
        inner = BRACKET.match(rest)
        if inner and kind == "subsection" and rest.startswith("("):
            _bracket(rest, stack, open_at)
        else:
            node.add_text(rest)


# -- to Akoma Ntoso ------------------------------------------------------------------------------------

def _p(parent, text, cls=None):
    return sub(parent, "p", text, class_=cls)


def emit(parent, node):
    attrs = {}
    if node.kind == "hcontainer":
        attrs["name"] = node.name or "hcontainer"
    el = sub(parent, node.kind, eId="tmp_import", **attrs)
    if node.num:
        sub(el, "num", node.num)
    if node.heading:
        sub(el, "heading", node.heading)
    if node.children:
        if node.paras:
            intro = sub(el, "intro")
            for t in node.paras:
                _p(intro, t)
        for c in node.children:
            emit(el, c)
        if node.wrap:
            wu = sub(el, "wrapUp")
            for t in node.wrap:
                _p(wu, t)
    elif node.kind in ("chapter", "part"):
        pass
    else:
        content = sub(el, "content")
        for t in (node.paras + node.wrap) or [""]:
            _p(content, t)
    return el


RECITAL = re.compile(r"^(AND\s+)?WHEREAS\b", re.I)
QUOTED = re.compile(r"^\s*([“\"].*[”\"])(\W*)$", re.S)
SCHED_PART = re.compile(r"^PART\s+([IVXLC]+|[A-Z]|\d+)\s*[:.\-–—]*\s*(.*)$")


def _preface(bill, preface_lines, title):
    preface = sub(bill, "preface")
    title_seen = False
    if not any(TITLE.search(l) for l in preface_lines):
        sub(_p(preface, None, "title"), "docTitle", title.upper())
        title_seen = True
    long_title, recitals, formula = [], [], []
    for line in preface_lines:
        if not title_seen and TITLE.search(line):
            title_seen = True
            sub(_p(preface, None, "title"), "docTitle", line)
        elif re.match(r"^Bill No\.", line, re.I):
            sub(_p(preface, None, "number"), "docNumber", line)
        elif RECITAL.match(line):
            recitals.append(line)
        elif re.match(r"^BE\s+it\s+enacted", line, re.I) or formula:
            formula.append(line)
        elif re.match(r"^A\s+BILL\b", line, re.I) or (long_title and not recitals):
            long_title.append(line)
        elif recitals:
            recitals[-1] += " " + line
        else:
            _p(preface, line)
    if long_title:
        lt = sub(preface, "longTitle")
        for t in long_title:
            _p(lt, t)
    if recitals or formula:
        pre = sub(bill, "preamble")
        if recitals:
            rs = sub(pre, "recitals")
            for t in recitals:
                _p(sub(rs, "recital"), t)
        if formula:
            f = sub(pre, "formula", name="enactingFormula")
            for t in formula:
                _p(f, t)


def _schedule_meta(doc, title, stitle, year, number, date, k):
    uri = work_uri(year, number)
    meta = sub(doc, "meta")
    ident = sub(meta, "identification", source="#bnl-editor")
    for tag, val in (("FRBRWork", uri), ("FRBRExpression", f"{uri}/eng@{date}"),
                     ("FRBRManifestation", f"{uri}/eng@{date}.akn")):
        part = sub(ident, tag)
        sub(part, "FRBRthis", value=f"{val}/!schedule_{k}")
        sub(part, "FRBRuri", value=val)
        if tag == "FRBRWork":
            sub(part, "FRBRalias", value=f"{title}: {stitle}", name="title")
        sub(part, "FRBRdate", date=date, name="draft" if tag == "FRBRWork" else "version")
        sub(part, "FRBRauthor", href="#parliament" if tag != "FRBRManifestation" else "#bnl-editor")
        if tag == "FRBRWork":
            sub(part, "FRBRcountry", value="in")
        if tag == "FRBRExpression":
            sub(part, "FRBRlanguage", language="eng")


def _schedule(atts, title, stitle, slines, year, number, date, k, pending):
    """A Schedule: optional Parts (one per Act amended), numbered paragraphs, quoted amending text.
    pending collects (paragraph, act, instruction, quoted) for the amendments recorded afterwards."""
    att = sub(atts, "attachment", eId="tmp_import")
    doc = sub(att, "doc", name="schedule")
    _schedule_meta(doc, title, stitle, year, number, date, k)
    spre = sub(doc, "preface")
    _p(spre, stitle, "title")
    main = sub(doc, "mainBody")
    host, act, cur = main, None, None
    items = []                                  # (paragraph element, act, [lines], [quoted])
    for line in slines:
        if re.fullmatch(r"_+", line):
            continue
        m = SCHED_PART.match(line)
        if m:
            host = sub(main, "part", eId="tmp_import")
            sub(host, "num", f"PART {m.group(1)}")
            if m.group(2):
                sub(host, "heading", m.group(2))
            act = amend_mod.act_of(m.group(2))
            cur = None
            continue
        m = SECTION.match(line)
        if m:
            el = sub(host, "paragraph", eId="tmp_import")
            sub(el, "num", f"{m.group(1)}.")
            cur = (el, act, [m.group(2)] if m.group(2) else [], [])
            items.append(cur)
            continue
        if cur is None:
            cls = "reference" if re.match(r"^[\[(].*[\])]$", line) else "heading" if line.isupper() else None
            _p(spre, line, cls)
            continue
        if QUOTED.match(line):
            cur[3].append(line)
        else:
            cur[2].append(line)
    for el, act, lines, quoted in items:
        content = sub(el, "content")
        instruction = " ".join(lines)
        if quoted:
            p = sub(content, "p")
            mod = sub(p, "mod", eId="tmp_mod")
            mod.text = instruction + " "
            for qline in quoted:
                qm = QUOTED.match(qline)
                qt = sub(mod, "quotedText", qm.group(1), eId="tmp_qt")
                qt.tail = qm.group(2) or None
            pending.append((el, act, instruction, " ".join(QUOTED.match(x).group(1) for x in quoted)))
        else:
            _p(content, instruction)
            pending.append((el, act, instruction, None))


def _strip_quotes(t):
    return re.sub(r"^[“\"]|[”\"]$", "", (t or "").strip()).strip() if t else t


def _record_amendments(bill_el, pending):
    """One textualMod per change each Schedule entry makes, in the Bill's own metadata."""
    from xml.etree.ElementTree import SubElement
    meta = bill_el.find(q("meta"))
    refs = meta.find(q("references"))
    analysis = meta.makeelement(q("analysis"), {"source": "#bnl-editor"})
    meta.insert(list(meta).index(refs), analysis)
    am = sub(analysis, "activeModifications")
    n, acts = 0, {}
    for el, act, instruction, quoted in pending:
        eid = el.get("eId")
        mod = el.find(f".//{q('mod')}")
        if mod is not None:
            mod.set("eId", f"{eid}__mod_1")
            for i, qt in enumerate(mod.findall(q("quotedText")), start=1):
                qt.set("eId", f"{eid}__mod_1__qtext_{i}")
        if not act:
            continue
        name, year, num = act
        work = f"/akn/in/act/{year}/{num}"
        acts[work] = name
        for ch in amend_mod.parse(instruction, quoted):
            n += 1
            tm = sub(am, "textualMod", type=ch["type"], eId=f"amod_{n}")
            tm.set(f"{{{akn.BNL}}}extent", "IN")
            tm.set(f"{{{akn.BNL}}}basis", "stated")
            sub(tm, "source", href=f"#{eid}")
            sub(tm, "destination", href=f"{work}/~{'__'.join(ch['path'])}")
            for which in ("old", "new"):
                if ch[which]:
                    w = sub(tm, which, eId=f"amod_{n}__{which}")
                    hp = SubElement(w, f"{{{akn.XH}}}p")
                    hp.text = _strip_quotes(ch[which])
    if not len(am):
        meta.remove(analysis)
    for i, (work, name) in enumerate(acts.items()):
        r = refs.makeelement(q("activeRef"), {"eId": "ref_" + re.sub(r"[^A-Za-z0-9]+", "_", work.replace("/akn/", "")).strip("_"),
                                               "href": work, "showAs": name})
        refs.insert(i, r)


# -- cross-references -----------------------------------------------------------------------------

# References in the text, in the order they are tried at each position (web/engine/bill.js has the
# same list). Internal ones link to the provision's eId, only if it exists; a reference to another Act
# that gives the Act's number ("section 70 of the Information Technology Act, 2000 (21 of 2000)")
# links to its BNL name. A bare "section 5 of the X Act" with no number is left alone.
NOT_EXT = r"(?! of the (?:[A-Z]|principal\b))"   # "of the principal Act" is another Act too
XREF = re.compile("|".join([
    r"(?P<ext>(?:clause \((?P<x1>\w+)\) of )?(?:sub-section \((?P<x2>\w+)\) of )?[Ss]ection (?P<x3>\d+[A-Z]*))(?P<xact> of the [A-Z][^,()]*?, \d{4} \((?P<xnum>\d+) of (?P<xyear>\d{4})\))",
    r"(?P<this>this (?P<thisk>Chapter|Section|section|sub-section))\b",
    r"(?P<a>clause \((?P<a1>\w+)\) of sub-section \((?P<a2>\w+)\) of [Ss]ection (?P<a3>\d+[A-Z]*))" + NOT_EXT,
    r"(?P<b>sub-section \((?P<b1>\w+)\) of [Ss]ection (?P<b2>\d+[A-Z]*))" + NOT_EXT,
    r"(?P<h>sub-sections (?P<hl>\(\w+\)(?:, \(\w+\))*,? and \(\w+\))(?: of [Ss]ection (?P<hs>\d+[A-Z]*))?)" + NOT_EXT,
    r"(?P<c>clause \((?P<c1>\w+)\) of sub-section \((?P<c2>\w+)\))(?! of [Ss]ection)",
    r"(?P<d>[Ss]ections (?P<d1>\d+[A-Z]*(?:, \d+[A-Z]*)*,? and \d+[A-Z]*))" + NOT_EXT,
    r"(?P<e>[Ss]ection (?P<e1>\d+[A-Z]*))\b" + NOT_EXT,
    r"(?P<f>sub-section \((?P<f1>\w+)\))(?! of [Ss]ection)",
    r"(?P<k>clause \((?P<k1>\w+)\))(?! of )",
    r"(?P<g>Chapter (?P<g1>[IVXL]+))\b",
    r"(?P<s>the Schedule)\b",
]), re.A)


def _link_text(text, ctx, ids):
    out, pos = [], 0

    def want(a, b, href):
        nonlocal pos
        if a >= pos and (not href.startswith("#") or href[1:] in ids):
            out.append((a, b, href))
            pos = b

    for m in XREF.finditer(text):
        if m["ext"]:
            path = "__".join([f"sec_{m['x3']}"] + ([f"subsec_{m['x2']}"] if m["x2"] else []) + ([f"cl_{m['x1']}"] if m["x1"] else []))
            want(m.start("ext"), m.end("ext"), f"/akn/in/act/{m['xyear']}/{m['xnum']}/~{path}")
        elif m["this"]:
            t = {"Chapter": ctx.get("chapter"), "Section": ctx.get("section"), "section": ctx.get("section"),
                 "sub-section": ctx.get("subsection")}[m["thisk"]]
            if t:
                want(m.start("this"), m.end("this"), f"#{t}")
        elif m["a"]:
            want(m.start("a"), m.end("a"), f"#sec_{m['a3']}__subsec_{m['a2']}__cl_{m['a1']}")
        elif m["b"]:
            want(m.start("b"), m.end("b"), f"#sec_{m['b2']}__subsec_{m['b1']}")
        elif m["h"]:
            sec = f"sec_{m['hs']}" if m["hs"] else ctx.get("section")
            if sec:
                for nm in re.finditer(r"\((\w+)\)", m["hl"]):
                    want(m.start("hl") + nm.start(), m.start("hl") + nm.end(), f"#{sec}__subsec_{nm.group(1)}")
        elif m["c"]:
            if ctx.get("section"):
                want(m.start("c"), m.end("c"), f"#{ctx['section']}__subsec_{m['c2']}__cl_{m['c1']}")
        elif m["d"]:
            for nm in re.finditer(r"\d+[A-Z]*", m["d1"]):
                want(m.start("d1") + nm.start(), m.start("d1") + nm.end(), f"#sec_{nm.group(0)}")
        elif m["e"]:
            want(m.start("e"), m.end("e"), f"#sec_{m['e1']}")
        elif m["f"]:
            if ctx.get("section"):
                want(m.start("f"), m.end("f"), f"#{ctx['section']}__subsec_{m['f1']}")
        elif m["k"]:
            t = next((f"{x}__cl_{m['k1']}" for x in (ctx.get("subsection"), ctx.get("section")) if x and f"{x}__cl_{m['k1']}" in ids), None)
            if t:
                want(m.start("k"), m.end("k"), f"#{t}")
        elif m["g"]:
            want(m.start("g"), m.end("g"), f"#chp_{m['g1']}")
        elif m["s"]:
            if ctx.get("schedule"):
                want(m.start("s"), m.end("s"), f"#{ctx['schedule']}")
    return out


def link_refs(root):
    """Turn references in the body's text into <ref>s. Words already inside a reference are left alone,
    so it can run again after every edit. Returns the number of references made."""
    ids = {e.get("eId") for e in root.iter() if e.get("eId")}
    body = root.find(f".//{q('body')}")
    if body is None:
        return 0
    parent = {c: p for p in root.iter() for c in p}
    atts = list(root.iter(q("attachment")))
    count = 0
    for p in list(body.iter(q("p"))):
        ctx = {"schedule": atts[0].get("eId")} if len(atts) == 1 else {}
        y = parent.get(p)
        while y is not None:
            n, i = akn.local(y.tag), y.get("eId")
            if n in ("subsection", "section", "chapter") and n not in ctx:
                ctx[n] = i
            y = parent.get(y)
        # the paragraph as a list of pieces: strings and its existing children
        pieces = [p.text or ""]
        for c in list(p):
            pieces += [c, c.tail or ""]
            c.tail = None
        out, made = [], 0
        for piece in pieces:
            if not isinstance(piece, str):
                out.append(piece)
                continue
            at = 0
            for a, b, href in _link_text(piece, ctx, ids):
                out.append(piece[at:a])
                r = ET.Element(q("ref"), {"href": href})
                r.text = piece[a:b]
                out.append(r)
                at = b
                made += 1
            out.append(piece[at:])
        for c in list(p):
            p.remove(c)
        p.text, last = "", None
        for piece in out:
            if isinstance(piece, str):
                if last is None:
                    p.text += piece
                else:
                    last.tail = (last.tail or "") + piece
            else:
                p.append(piece)
                last = piece
        p.text = p.text or None
        if last is not None and not last.tail:
            last.tail = None
        count += made
    return count


def add_notes(root, notes):
    """Drafting notes (comments on the draft) go in the metadata, pointing at their provision:
    s.10(2) of the Bill keeps metadata out of the text."""
    if not notes:
        return
    meta = next(iter(root)).find(q("meta"))
    parent = {c: p for p in root.iter() for c in p}
    holder = meta.makeelement(q("notes"), {"source": "#bnl-editor"})
    prop = meta.find(q("proprietary"))
    meta.insert(list(meta).index(prop) if prop is not None else len(meta), holder)
    for i, (anchor, text, author) in enumerate(notes, start=1):
        target = None
        for p in root.iter(q("p")):
            if anchor and anchor in "".join(p.itertext()):
                target = p
                while target in parent and not target.get("eId"):
                    target = parent[target]
                break
        note = sub(holder, "note", eId=f"note_{i}", class_="drafting")
        if target is not None:
            note.set("refersTo", f"#{target.get('eId')}")
        _p(note, f"{author}: {text}" if author else text)


def build(title, year, number, date=None, preface_lines=(), body_nodes=(), schedules=(), notes=()):
    date = date or dt.date.today().isoformat()
    root = ET.Element(q("akomaNtoso"))
    bill_el = sub(root, "bill", name="bill", contains="originalVersion")
    meta_block(bill_el, title, year, number, date)
    _preface(bill_el, preface_lines, title)

    body = sub(bill_el, "body")
    if not body_nodes:
        s = Node("section", num="1.", heading="Short title and commencement")
        s1 = Node("subsection", num="(1)")
        act_name = re.sub(r"(?i)\s*\bbill\b", " Act", title).strip()
        s1.paras.append(f"This Act may be called the {re.sub(r'(?i)^the\s+', '', act_name)}.")
        s.children.append(s1)
        body_nodes = [s]
    for n in body_nodes:
        emit(body, n)

    pending = []
    if schedules:
        atts = sub(bill_el, "attachments")
        for k, (stitle, slines) in enumerate(schedules, start=1):
            _schedule(atts, title, stitle, slines, year, number, date, k, pending)

    akn.assign_eids(root)
    if pending:
        _record_amendments(bill_el, pending)
    link_refs(root)
    add_notes(root, notes)
    return root


def new_bill(title, year, number=None, date=None):
    number = number or slug(re.sub(r"(?i)^the\s+|,?\s*\d{4}$", "", title)) or "draft"
    return build(title, year, number, date)


COMMENT_LINE = re.compile(r"^\s*\[([a-z]{1,2})\]\s*(.+)$")


def gdocs_comments(text):
    """A Google Docs plain-text export marks a comment with "[a]" in the text and puts the comment
    itself on a line "[a]comment" at the end. -> (text without those lines, [(anchor text, comment)])."""
    lines = text.splitlines()
    comments = {}
    while lines and (not lines[-1].strip() or COMMENT_LINE.match(lines[-1])):
        m = COMMENT_LINE.match(lines.pop())
        if m:
            comments[m.group(1)] = m.group(2).strip()
    notes = []
    for key, body in sorted(comments.items()):
        mark = f"[{key}]"
        for l in lines:
            if mark in l:
                anchor = clean(l.split(mark)[0])
                anchor = re.sub(r"^(\(\w+\)|\d+[A-Z]*\.)\s*", "", anchor)   # drop the provision's own number
                notes.append((anchor[-120:], body))
                break
    return "\n".join(lines), notes


def import_text(text, title=None, year=None, number=None, date=None, notes=(), author=None):
    text, found = gdocs_comments(text)
    notes = list(notes) + [(a, b, author or "Comment on the draft") for a, b in found]
    preface, body, schedules = parse_text(text)
    if not title:
        t = next((l for l in preface if TITLE.search(l)), None)
        title = t.title().replace(" Of ", " of ").replace(" And ", " and ") if t else "Untitled Bill"
    if not year:
        m = re.search(r"(\d{4})", title)
        year = m.group(1) if m else str(dt.date.today().year)
    number = number or slug(re.sub(r"(?i)^the\s+|,?\s*\d{4}$", "", title)) or "draft"
    return build(title, year, number, date, preface, body, schedules, notes)
