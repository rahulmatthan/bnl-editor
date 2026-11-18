/* Read the Indian amending formulae into BNL amendments (port of bnl/amend.py).
   Each result names the provision affected in BNL (sec_5__subsec_1A). What it cannot read it leaves
   for the drafter: check ED-11 lists every Schedule entry with no amendment recorded. */

const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const LEVEL = { "sub-clause": "subcl", "sub-section": "subsec", "sub-rule": "subrule", clause: "cl",
  section: "sec", rule: "rule", paragraph: "para", item: "item" };
const UNIT = String.raw`(sub-clause|sub-section|sub-rule|clause|section|rule|paragraph|item)\s+\(?([0-9]+[A-Z]*|[a-zA-Z]{1,4})\)?`;
const QUOTE = /[“"]([^”"]+)[”"]/g;

const abbr = w => LEVEL[w.toLowerCase()];

function path(t) {
  const out = [];
  for (const m of t.matchAll(new RegExp(String.raw`\b(?:in|In)\s+` + UNIT, "g"))) out.push(`${abbr(m[1])}_${m[2]}`);
  const m = /^\s*(Section|Rule|Article)\s+([0-9]+[A-Z]*)\b/.exec(t);
  if (m && !out.length) out.push({ Section: "sec", Rule: "rule", Article: "art" }[m[1]] + "_" + m[2]);
  return out;
}

function numOf(quoted) {
  const m = /^\s*[“"]?\s*\(([0-9]+[A-Z]*|[a-z]{1,4})\)/.exec(quoted || "");
  return m ? m[1] : null;
}

export function parse(instruction, quoted) {
  const t = instruction.split(/\s+/).filter(Boolean).join(" ");
  let base = path(t.includes(" the following") ? t.split(" the following")[0] : t);
  const res = [];

  let m = new RegExp(String.raw`(Section|section|Rule|rule)\s+([0-9]+[A-Z]*)\s+shall be renumbered as\s+` + UNIT).exec(t);
  if (m) {
    const p = [(m[1].toLowerCase() === "rule" ? "rule" : "sec") + "_" + m[2]];
    res.push({ type: "renumbering", path: p, old: null, new: `${m[3]} (${m[4]}) of ${m[1].toLowerCase()} ${m[2]}` });
    base = p;
  }

  const words = Array.from(t.matchAll(QUOTE), x => x[1]);
  if (/\bfor the words?\b.*\bthe words?\b.*shall be substituted/.test(t) && words.length >= 2) {
    res.push({ type: "substitution", path: base, old: words[0], new: words[1] }); return res;
  }
  if (/\bthe words?\b.*shall be omitted/.test(t) && words.length) {
    res.push({ type: "repeal", path: base, old: words[0], new: null }); return res;
  }
  m = new RegExp(UNIT + String.raw`\s+shall be omitted`).exec(t);
  if (m) { res.push({ type: "repeal", path: [...base, `${abbr(m[1])}_${m[2]}`], old: null, new: null }); return res; }

  if (!quoted) return res;
  const nw = quoted.trim();
  if (/shall be added at the end/.test(t)) { res.push({ type: "insertion", path: base, old: null, new: nw }); return res; }

  m = /the following\s+(sub-section|sub-clause|clause|section|sub-rule|rule|proviso|Explanation|explanation|paragraph|item)s?\s+shall be (inserted|substituted)/.exec(t);
  if (m) {
    const kind = m[1].toLowerCase(), action = m[2];
    let last;
    if (kind === "proviso") {
      const after = /after the (?:(first|second|third|fourth|fifth)\s+)?proviso/.exec(t);
      last = `proviso_${after ? (after[1] ? ORD[after[1]] : 1) + 1 : 1}`;
    } else if (kind === "explanation") last = "hcontainer_1";
    else { const n = numOf(nw); last = n ? `${abbr(kind)}_${n}` : null; }
    if (action === "substituted") {
      const f = new RegExp(String.raw`\bfor\s+` + UNIT).exec(t);
      res.push({ type: "substitution", path: [...base, ...(f ? [`${abbr(f[1])}_${f[2]}`] : [])], old: null, new: nw });
    } else if (last) res.push({ type: "insertion", path: [...base, last], old: null, new: nw });
  }
  return res;
}

/* 'THE GENERAL CLAUSES ACT, 1897 (10 OF 1897)' -> ['The General Clauses Act, 1897', '1897', '10'] */
export function actOf(heading) {
  const m = /^(.*?,\s*(\d{4}))\s*\((\d+)\s+of\s+(\d{4})\)/i.exec((heading || "").trim());
  if (!m) return null;
  const small = new Set(["of", "and", "to", "the", "for", "in", "on", "by"]);
  const name = m[1].toLowerCase().split(/\s+/).map((w, i) => (i && small.has(w)) ? w : w.slice(0, 1).toUpperCase() + w.slice(1)).join(" ");
  return [name, m[4], m[3]];
}
