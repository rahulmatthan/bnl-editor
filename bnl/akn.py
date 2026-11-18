"""Read and write BNL files (Akoma Ntoso 3.0 plus the bnl: attributes), losslessly.

The file on disk is the truth. Everything here keeps what it does not understand: unknown elements,
attributes from any namespace, comments. Writing indents only structural elements (those holding
other elements and no text), so the words of the law are never touched by formatting.
"""

from __future__ import annotations

import io
import re
import xml.etree.ElementTree as ET
import xml.parsers.expat

AKN = "http://docs.oasis-open.org/legaldocml/ns/akn/3.0"
BNL = "urn:bnl:1.0"
XH = "http://www.w3.org/1999/xhtml"
PREFIXES = {"": AKN, "bnl": BNL, "h": XH}
for _p, _u in PREFIXES.items():
    ET.register_namespace(_p, _u)

# Elements whose whitespace belongs to the text: never re-indented.
MIXED = {"p", "heading", "subheading", "num", "span", "ref", "i", "b", "u", "sup", "sub", "a", "docTitle",
         "docNumber", "docDate", "shortTitle", "docType", "docStage", "docProponent", "term", "def",
         "inline", "mref", "rref", "noteRef", "td", "th", "li", "signature", "person", "role", "location",
         "date", "entity", "concept", "object", "event", "quantity", "omissis", "placeholder", "fillIn"}

# Hierarchical provisions and their eId abbreviations (Akoma Ntoso naming convention).
ABBR = {"part": "part", "chapter": "chp", "section": "sec", "subsection": "subsec", "clause": "cl",
        "subclause": "subcl", "point": "point", "paragraph": "para", "subparagraph": "subpara",
        "article": "art", "rule": "rule", "subrule": "subrule", "item": "item", "list": "list",
        "proviso": "proviso", "hcontainer": "hcontainer", "title": "title", "book": "book",
        "division": "dvs", "subdivision": "subdvs", "tome": "tome", "subchapter": "subchp",
        "subpart": "subpart", "subtitle": "subtitle", "indent": "indent", "alinea": "al",
        "level": "lvl", "transitional": "transitional"}
UNNUMBERED = {"proviso", "hcontainer"}   # counted, not named by a number
GROUPS = {"part", "chapter", "subchapter", "subpart", "division", "subdivision", "title", "book", "tome"}


def q(tag):
    return f"{{{AKN}}}{tag}"


def local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def parse(data: bytes) -> ET.Element:
    """Parse, keeping comments and processing instructions, and registering every prefix used."""
    for _ev, (prefix, uri) in ET.iterparse(io.BytesIO(data), events=("start-ns",)):
        if prefix and uri not in PREFIXES.values():
            ET.register_namespace(prefix, uri)
    parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True, insert_pis=True))
    parser.feed(data)
    return parser.close()


def _structural(el) -> bool:
    if local(el.tag) in MIXED or len(el) == 0:
        return False
    if el.text and el.text.strip():
        return False
    return all(not (c.tail and c.tail.strip()) for c in el)


def _indent(el, depth=0, step="  "):
    if not _structural(el):
        return
    pad = "\n" + step * (depth + 1)
    el.text = pad
    for c in el:
        c.tail = pad
        _indent(c, depth + 1, step)
    el[-1].tail = "\n" + step * depth


def serialize(root: ET.Element) -> bytes:
    _indent(root)
    root.tail = "\n"
    body = ET.tostring(root, encoding="unicode")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n' + body).encode("utf-8")


# -- eIds ------------------------------------------------------------------------------------------

def num_token(num_text: str) -> str:
    """'(1)' -> '1', '8A.' -> '8A', 'CHAPTER IV' -> 'IV', '[2.]' -> '2'."""
    t = (num_text or "").strip()
    t = re.sub(r"^(CHAPTER|PART|SCHEDULE|ARTICLE|RULE|SECTION)\s+", "", t, flags=re.I)
    t = re.sub(r"[^\w]", "", t)
    return t


def _parent_map(root):
    return {c: p for p in root.iter() for c in p}


def assign_eids(root: ET.Element, renumber: bool = False) -> dict:
    """Give provisions their eIds, and rewrite local references to match.

    eIds are permanent identifiers, so by default only provisions without one (or with a temporary
    'tmp_' id from the editor) get one, derived from their number and their parent's eId. With
    renumber=True every eId is regenerated from the numbers (for a Bill still being drafted).
    Returns {old eId: new eId} for every element whose eId changed.
    """
    renamed, used = {}, set()
    if not renumber:
        used = {e.get("eId") for e in root.iter() if e.get("eId") and not e.get("eId").startswith("tmp_")}

    def keep(c):
        return not renumber and c.get("eId") and not c.get("eId").startswith("tmp_")

    def fresh(base):
        eid, n = base, 1
        while eid in used:
            n += 1
            eid = f"{base}_{n}"
        used.add(eid)
        return eid

    def _set(c, eid):
        old = c.get("eId")
        if old != eid:
            if old:
                renamed[old] = eid
            c.set("eId", eid)

    def walk(el, prefix, counters, in_attachment):
        for c in el:
            name = local(c.tag)
            if name == "meta":
                continue
            if name == "attachment":
                counters["sched"] = counters.get("sched", 0) + 1
                if not keep(c):
                    _set(c, fresh(f"sched_{counters['sched']}"))
                walk(c, c.get("eId") + "__", {}, True)
            elif name in ABBR and _is_provision(c):
                abbr = ABBR[name]
                counters[abbr] = counters.get(abbr, 0) + 1
                if not keep(c):
                    num = c.find(q("num"))
                    token = num_token("".join(num.itertext())) if num is not None else ""
                    if name in UNNUMBERED or not token:
                        token = str(counters[abbr])
                    _set(c, fresh(f"{prefix}{abbr}_{token}"))
                # Sections are numbered through the whole instrument, so chapters and parts do not
                # prefix them (sec_18, not chp_V__sec_18). In a schedule, numbering restarts in each
                # part, so there they do.
                if name in GROUPS and not in_attachment:
                    walk(c, prefix, counters, in_attachment)
                else:
                    walk(c, c.get("eId") + "__", {}, in_attachment)
            else:
                walk(c, prefix, counters, in_attachment)

    for doc in root:
        walk(doc, "", {}, False)

    if renamed:
        for el in root.iter():
            for attr in ("href", "refersTo", "period"):
                v = el.get(attr)
                if v and v.startswith("#") and v[1:] in renamed:
                    el.set(attr, "#" + renamed[v[1:]])
    return renamed


def expected_eid_mismatches(root: ET.Element) -> list:
    """[(eId now, eId its number implies)] for provisions whose number changed since the eId was set."""
    import copy
    twin = copy.deepcopy(root)
    renamed = assign_eids(twin, renumber=True)
    return sorted(renamed.items())


def _is_provision(el) -> bool:
    # A list/indent only counts when it is a hierarchical container (has num or children provisions).
    return local(el.tag) not in ("list",) or el.find(q("num")) is not None


# -- line -> provision, for pointing at check results ---------------------------------------------

def line_index(data: bytes) -> dict:
    """{line number: eId of the innermost provision open on that line}."""
    p = xml.parsers.expat.ParserCreate(namespace_separator="}")
    stack, out = [], {}

    def start(name, attrs):
        eid = attrs.get("eId")
        stack.append(eid if eid else (stack[-1] if stack else None))
        out.setdefault(p.CurrentLineNumber, stack[-1])

    def end(name):
        stack.pop()

    p.StartElementHandler = start
    p.EndElementHandler = end
    p.Parse(data, True)
    return out


def eid_at(index: dict, line: int):
    while line > 0:
        if line in index and index[line]:
            return index[line]
        line -= 1
    return None
