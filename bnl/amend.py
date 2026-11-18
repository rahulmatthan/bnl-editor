"""Read the Indian amending formulae into BNL amendments (textualMod).

  "In section 3, in clause (39), the following shall be added at the end, namely:–– “…”"
  "In section 5, after sub-section (1), the following sub-section shall be inserted, namely:–– “(1A) …”"
  "In section 8, after the proviso, the following proviso shall be inserted, namely:–– “Provided further …”"
  "In section 4, in sub-section (1), after clause (b), the following Explanation shall be inserted …"
  "Section 81 shall be renumbered as sub-section (1) thereof, and after sub-section (1) as so renumbered,
   the following sub-section shall be inserted …"
  "In section 2, for the words “A”, the words “B” shall be substituted."
  "In section 2, the words “A” shall be omitted." / "clause (c) shall be omitted."

Each result names the provision affected in BNL (sec_5__subsec_1A). For an insertion, that is the
new provision's own name, taken from its number in the quoted text, or for a proviso or an
Explanation, counted the way lex-kernel counts them (proviso_2 after the first proviso,
hcontainer_1 for the first Explanation). What it cannot read, it leaves for the drafter: the
check ED-11 lists every Schedule entry with no amendment recorded.
"""

from __future__ import annotations

import re

ORD = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5}
LEVEL = [("sub-clause", "subcl"), ("sub-section", "subsec"), ("sub-rule", "subrule"), ("clause", "cl"),
         ("section", "sec"), ("rule", "rule"), ("paragraph", "para"), ("item", "item")]
UNIT = r"(sub-clause|sub-section|sub-rule|clause|section|rule|paragraph|item)\s+\(?([0-9]+[A-Z]*|[a-zA-Z]{1,4})\)?"
QUOTE = re.compile(r"[“\"]([^”\"]+)[”\"]")


def _abbr(word):
    return dict(LEVEL)[word.lower()]


def _path(text):
    """'In section 4, in sub-section (1)' -> ['sec_4', 'subsec_1']"""
    out = []
    for m in re.finditer(r"\b(?:in|In)\s+" + UNIT, text):
        out.append(f"{_abbr(m.group(1))}_{m.group(2)}")
    m = re.match(r"^\s*(Section|Rule|Article)\s+([0-9]+[A-Z]*)\b", text)
    if m and not out:
        out.append({"Section": "sec", "Rule": "rule", "Article": "art"}[m.group(1)] + "_" + m.group(2))
    return out


def _num_of(quoted):
    m = re.match(r"^\s*[“\"]?\s*\(([0-9]+[A-Z]*|[a-z]{1,4})\)", quoted or "")
    return m.group(1) if m else None


def parse(instruction: str, quoted: str | None = None) -> list:
    """-> [{type, path: [..], new, old}] (path relative to the Act amended)."""
    t = " ".join(instruction.split())
    base = _path(t.split(" the following")[0] if " the following" in t else t)
    res = []

    # renumbering: "Section 81 shall be renumbered as sub-section (1) thereof"
    m = re.search(r"(Section|section|Rule|rule)\s+([0-9]+[A-Z]*)\s+shall be renumbered as\s+" + UNIT, t)
    if m:
        p = [("rule" if m.group(1).lower() == "rule" else "sec") + "_" + m.group(2)]
        res.append({"type": "renumbering", "path": p, "old": None,
                    "new": f"{m.group(3)} ({m.group(4)}) of {m.group(1).lower()} {m.group(2)}"})
        base = p   # what follows ("after sub-section (1) as so renumbered") is placed within the section

    # substitution of words
    words = QUOTE.findall(t)
    if re.search(r"\bfor the words?\b.*\bthe words?\b.*shall be substituted", t) and len(words) >= 2:
        res.append({"type": "substitution", "path": base, "old": words[0], "new": words[1]})
        return res
    if re.search(r"\bthe words?\b.*shall be omitted", t) and words:
        res.append({"type": "repeal", "path": base, "old": words[0], "new": None})
        return res
    m = re.search(UNIT + r"\s+shall be omitted", t)
    if m:
        res.append({"type": "repeal", "path": base + [f"{_abbr(m.group(1))}_{m.group(2)}"], "old": None, "new": None})
        return res

    if not quoted:
        return res
    new = quoted.strip()

    if re.search(r"shall be added at the end", t):
        res.append({"type": "insertion", "path": base, "old": None, "new": new})
        return res

    m = re.search(r"the following\s+(sub-section|sub-clause|clause|section|sub-rule|rule|proviso|Explanation|explanation|paragraph|item)s?\s+shall be (inserted|substituted)", t)
    if m:
        kind, action = m.group(1).lower(), m.group(2)
        if kind == "proviso":
            after = re.search(r"after the (?:(first|second|third|fourth|fifth)\s+)?proviso", t)
            n = (ORD[after.group(1)] if after and after.group(1) else 1) + 1 if after else 1
            last = f"proviso_{n}"
        elif kind == "explanation":
            last = "hcontainer_1"
        else:
            num = _num_of(new)
            last = f"{_abbr(kind)}_{num}" if num else None
        if action == "substituted":
            # "for sub-section (2), the following sub-section shall be substituted"
            f = re.search(r"\bfor\s+" + UNIT, t)
            target = base + ([f"{_abbr(f.group(1))}_{f.group(2)}"] if f else [])
            res.append({"type": "substitution", "path": target, "old": None, "new": new})
        elif last:
            res.append({"type": "insertion", "path": base + [last], "old": None, "new": new})
    return res


def act_of(heading: str):
    """'THE GENERAL CLAUSES ACT, 1897 (10 OF 1897)' -> ('The General Clauses Act, 1897', '1897', '10')"""
    m = re.search(r"^(.*?,\s*(\d{4}))\s*\((\d+)\s+of\s+(\d{4})\)", heading.strip(), re.I)
    if not m:
        return None
    small = {"of", "and", "to", "the", "for", "in", "on", "by"}
    words = m.group(1).lower().split()
    name = " ".join(w if (i and w in small) else w[:1].upper() + w[1:] for i, w in enumerate(words))
    return name, m.group(4), m.group(3)
