/* Check a BNL file in the browser: the Akoma Ntoso schema (libxml2's validator, compiled to
   WebAssembly), the BNL rulebook (rules.sch, run by a small Schematron interpreter on the browser's
   XPath), and the editor's own checks (port of bnl/checks.py).

   Each result is {level, code, message, line, eId}; levels error / warning / finding / info. */

import { AKN, BNL, ABBR, UNNUMBERED, kid, iter, lineIndex, eidAt, numToken, expectedEidMismatches } from "./akn.js";

export const BNL_VERSION = "0.1";
const r = (level, code, message, line = null, eId = null) => ({ level, code, message, line, eId });
const ORDER = { error: 0, warning: 1, finding: 2, info: 3 };

/* -- the spec files ----------------------------------------------------------------------------------- */

let specFiles = null;
export async function spec(base) {
  if (!specFiles) {
    const names = ["validate.xsd", "akomantoso30.xsd", "xml.xsd", "bnl.xsd", "rules.sch"];
    const texts = await Promise.all(names.map(n => fetch(base + n).then(x => { if (!x.ok) throw new Error(`${n}: ${x.status}`); return x.text(); })));
    specFiles = Object.fromEntries(names.map((n, i) => [n, texts[i]]));
  }
  return specFiles;
}

/* -- AKN: the schema ------------------------------------------------------------------------------------ */

let xmllint = null;
export async function schema(xml, files, vendor) {
  try {
    xmllint = xmllint || await import(vendor + "index-browser.mjs");
  } catch (e) {
    return [r("error", "AKN", "The schema check could not load: " + e.message)];
  }
  const rd = n => ({ fileName: n, contents: files[n] });
  let res;
  try {
    res = await xmllint.validateXML({
      xml: { fileName: "doc.xml", contents: xml }, schema: [rd("validate.xsd")],
      preload: [rd("akomantoso30.xsd"), rd("xml.xsd"), rd("bnl.xsd")], maxMemoryPages: 4096,
    });
  } catch (e) {
    return [r("error", "AKN", "The schema check could not run: " + String(e.message || e).slice(0, 300))];
  }
  if (res.valid) return [];
  const index = lineIndex(xml), out = [];
  for (const e of res.errors) {
    if (!e.loc) continue;
    let msg = e.message.replace(/^(element \S+: )?Schemas validity error : /, "").replace(/\{[^}]*\}/g, "").replace("Element '", "'");
    out.push(r("error", "AKN", msg, e.loc.lineNumber, eidAt(index, e.loc.lineNumber)));
  }
  if (!out.length) out.push(r("error", "AKN", "The schema check failed: " + (res.rawOutput || "").slice(0, 300)));
  return out;
}

/* -- BNL-n: the rulebook ------------------------------------------------------------------------------- */

const SCH = "http://www.ascc.net/xml/schematron";
function nearestEid(el) { for (let x = el; x && x.nodeType === 1; x = x.parentNode) if (x.getAttribute("eId")) return x.getAttribute("eId"); return null; }

/* A Schematron (ASCC 1.5) interpreter: within a pattern each node is caught by the first rule whose
   context matches it; every assert of that rule is evaluated on it. */
export function rules(doc, schText) {
  let sch;
  try { sch = new DOMParser().parseFromString(schText, "application/xml"); }
  catch (e) { return [r("error", "RULEBOOK", "The BNL rulebook could not be read, so no BNL rule was checked.")]; }
  if (sch.getElementsByTagName("parsererror").length) return [r("error", "RULEBOOK", "The BNL rulebook could not be read, so no BNL rule was checked.")];
  const ns = {};
  for (const n of sch.getElementsByTagNameNS(SCH, "ns")) ns[n.getAttribute("prefix")] = n.getAttribute("uri");
  const resolver = p => ns[p] || null;
  const out = [];
  try {
    for (const pat of sch.getElementsByTagNameNS(SCH, "pattern")) {
      const caught = new Set();
      for (const rule of Array.from(pat.children).filter(c => c.localName === "rule")) {
        const ctx = rule.getAttribute("context").split("|").map(s => s.trim()).map(s => s.startsWith("/") ? s : "//" + s).join(" | ");
        const nodes = doc.evaluate(ctx, doc, resolver, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const asserts = Array.from(rule.children).filter(c => c.localName === "assert");
        for (let i = 0; i < nodes.snapshotLength; i++) {
          const node = nodes.snapshotItem(i);
          if (caught.has(node)) continue;
          caught.add(node);
          for (const a of asserts) {
            if (doc.evaluate(a.getAttribute("test"), node, resolver, XPathResult.BOOLEAN_TYPE, null).booleanValue) continue;
            const msg = a.textContent.replace(/\s+/g, " ").trim();
            const code = (/^(BNL-\d+)/.exec(msg) || [, "BNL"])[1];
            out.push(r(code === "BNL-4" ? "finding" : "error", code, msg.replace(/^BNL-\d+\s*/, ""), null, nearestEid(node)));
          }
        }
      }
    }
  } catch (e) {
    return [r("error", "RULEBOOK", "The BNL rulebook did not run, so no BNL rule was checked: " + e.message)];
  }
  return out;
}

/* -- ED-n: the editor's checks ----------------------------------------------------------------------- */

const RV = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
const ROMAN_KINDS = new Set(["subclause", "chapter", "part", "subchapter"]);
const ALPHA_KINDS = new Set(["clause", "point", "item"]);
function roman(tok) {
  let total = 0, prev = 0;
  for (const ch of tok.toLowerCase().split("").reverse()) {
    if (!(ch in RV)) return null;
    const v = RV[ch]; total += v < prev ? -v : v; prev = Math.max(prev, v);
  }
  return total;
}
function seqValue(kind, tok) {
  if (/^\d+$/.test(tok)) return parseInt(tok, 10);
  if (ROMAN_KINDS.has(kind)) return roman(tok);
  if (ALPHA_KINDS.has(kind) && /^[A-Za-z]$/.test(tok)) return tok.toLowerCase().charCodeAt(0) - 96;
  return null;
}
const inMeta = el => { for (let x = el.parentNode; x && x.nodeType === 1; x = x.parentNode) if (x.localName === "meta") return true; return false; };
const cap = s => s[0].toUpperCase() + s.slice(1);

export function editor(doc, isBill) {
  const out = [], root = doc.documentElement, eids = new Map();
  for (const el of iter(root)) { const e = el.getAttribute("eId"); if (e) eids.set(e, (eids.get(e) || 0) + 1); }
  for (const [e, n] of eids) if (n > 1) out.push(r("error", "ED-1", `The identifier ${e} is used ${n} times; identifiers must be unique.`, null, e));

  for (const el of iter(root)) {
    const name = el.localName;
    if (!(name in ABBR) || UNNUMBERED.has(name) || name === "list" || inMeta(el)) continue;
    const num = kid(el, "num");
    if (!num || !num.textContent.trim()) out.push(r("warning", "ED-2", `This ${name} has no number.`, null, el.getAttribute("eId")));
    const hasText = Array.from(el.getElementsByTagNameNS(AKN, "p")).some(p => p.textContent.trim()) || el.localName === "p" && el.textContent.trim();
    if (!hasText && !kid(el, "heading")) out.push(r("warning", "ED-6", `This ${name} has no text.`, null, el.getAttribute("eId")));
  }

  for (const p of iter(root)) {
    const prev = {};
    for (const c of p.children) {
      const name = c.localName;
      if (!(name in ABBR) || UNNUMBERED.has(name)) continue;
      const num = kid(c, "num");
      if (!num) continue;
      const tok = numToken(num.textContent), v = seqValue(name, tok), last = prev[name];
      if (v !== null && last && v !== last[0] + 1)
        out.push(r(isBill ? "warning" : "info", "ED-3", `${cap(name)} ${tok} follows ${last[1]}: the numbering is out of sequence.`, null, c.getAttribute("eId")));
      if (v !== null) prev[name] = [v, tok];
    }
  }

  for (const [now, want] of expectedEidMismatches(doc)) {
    if (now.startsWith("tmp_")) continue;
    out.push(r(isBill ? "warning" : "info", "ED-8", `The identifier ${now} no longer matches the number (it would be ${want}). ` +
      "Identifiers are permanent: use Update IDs only while the Bill is a draft.", null, now));
  }

  const made = Array.from(root.getElementsByTagNameNS(AKN, "activeModifications")).flatMap(am => Array.from(am.getElementsByTagNameNS(AKN, "textualMod")));
  for (const tm of made) {
    const eid = tm.getAttribute("eId"), src = kid(tm, "source");
    const dests = Array.from(tm.children).filter(c => c.localName === "destination");
    if (!src || !src.getAttribute("href")) out.push(r("error", "ED-4", "An amendment does not say which provision of this instrument makes it.", null, eid));
    else if (src.getAttribute("href").startsWith("#") && !eids.has(src.getAttribute("href").slice(1)))
      out.push(r("error", "ED-4", `An amendment is made by ${src.getAttribute("href")}, which does not exist.`, null, eid));
    for (const d of dests) {
      const h = d.getAttribute("href") || "";
      if (!(h.startsWith("/akn/in") && h.includes("~")) && !h.startsWith("#"))
        out.push(r("warning", "ED-5", `The provision amended (${h || "none"}) is not a full BNL name like /akn/in/act/1940/23/~sec_27.`, null, eid));
    }
    const typ = tm.getAttribute("type");
    if ((typ === "substitution" || typ === "insertion") && !kid(tm, "new"))
      out.push(r("warning", "ED-7", `${"aeiou".includes(typ[0]) ? "An" : "A"} ${typ} gives no new text.`, null, eid));
    if (typ === "substitution" && !kid(tm, "old")) out.push(r("warning", "ED-7", "A substitution does not say which words it replaces.", null, eid));
  }

  const seen = new Map();
  for (const tm of made) {
    const key = tm.getAttribute("type") + "|" + Array.from(tm.children).map(c => [c.localName, c.getAttribute("href") || "", c.textContent.trim()].join("\u0001")).sort().join("\u0002");
    if (seen.has(key)) out.push(r("warning", "ED-10", `This amendment repeats ${seen.get(key)}: the same change is recorded twice.`, null, tm.getAttribute("eId")));
    else seen.set(key, tm.getAttribute("eId"));
  }

  const sources = new Set(made.flatMap(tm => Array.from(tm.children).filter(c => c.localName === "source").map(s => (s.getAttribute("href") || "").slice(1))));
  for (const att of root.getElementsByTagNameNS(AKN, "attachment"))
    for (const el of att.getElementsByTagName("*"))
      if ((el.localName === "paragraph" || el.localName === "item") && el.getElementsByTagNameNS(AKN, "mod").length && !sources.has(el.getAttribute("eId")))
        out.push(r("warning", "ED-11", "This Schedule entry amends another law, but no amendment is recorded for it (use Record an amendment).", null, el.getAttribute("eId")));

  const prop = Array.from(root.getElementsByTagNameNS(AKN, "proprietary")).flatMap(p => Array.from(p.children)).find(c => c.namespaceURI === BNL && c.localName === "profile");
  if (!prop) out.push(r("warning", "ED-9", "The instrument does not declare which version of BNL it follows."));
  else if (prop.getAttribute("version") !== BNL_VERSION) out.push(r("error", "ED-9", `The instrument declares BNL ${prop.getAttribute("version")}; this editor checks BNL ${BNL_VERSION}.`));

  for (const el of iter(root)) {
    const b = el.getAttributeNS(BNL, "basis");
    if (b === "inferred" || b === "contested") out.push(r("info", "REVIEW", `A link marked ${b}: confirm it.`, null, nearestEid(el)));
  }

  // Notes on clauses: once a Bill has them, every section has one, and every note says something.
  const noc = Array.from(root.getElementsByTagNameNS(AKN, "doc")).find(d => d.getAttribute("name") === "notesOnClauses");
  if (noc) {
    const noted = new Set();
    for (const n of Array.from(noc.getElementsByTagNameNS(AKN, "hcontainer")).filter(h => h.getAttribute("name") === "noteOnClause")) {
      const head = kid(n, "heading"), ref = head && kid(head, "ref");
      if (ref) noted.add((ref.getAttribute("href") || "").slice(1));
      if (!Array.from(n.getElementsByTagNameNS(AKN, "p")).some(p => p.textContent.trim()))
        out.push(r("warning", "ED-12", "This note on clauses has no text.", null, n.getAttribute("eId")));
    }
    const body = root.getElementsByTagNameNS(AKN, "body")[0];
    for (const s of body ? body.getElementsByTagNameNS(AKN, "section") : [])
      if (s.getAttribute("eId") && !noted.has(s.getAttribute("eId")))
        out.push(r("warning", "ED-12", "This clause has no note in the Notes on Clauses.", null, s.getAttribute("eId")));
  }
  return out;
}

export async function run(xml, { specBase, vendor }) {
  let doc;
  try { doc = new DOMParser().parseFromString(xml, "application/xml"); } catch (e) { doc = null; }
  if (!doc || doc.getElementsByTagName("parsererror").length)
    return [r("error", "XML", "The file is not well-formed XML.")];
  const files = await spec(specBase);
  const isBill = Array.from(doc.documentElement.children).some(c => c.localName === "bill");
  const res = [...await schema(xml, files, vendor), ...rules(doc, files["rules.sch"]), ...editor(doc, isBill)];
  res.sort((a, b) => (ORDER[a.level] - ORDER[b.level]) || ((a.line || 0) - (b.line || 0)));
  return res;
}

export function summary(results) {
  const s = { error: 0, warning: 0, finding: 0, info: 0 };
  for (const x of results) s[x.level]++;
  return s;
}
