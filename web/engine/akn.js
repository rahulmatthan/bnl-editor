/* Read and write BNL files in the browser (port of bnl/akn.py).
   Writing indents only structural elements (those holding other elements and no text),
   so the words of the law are never touched by formatting. */

export const AKN = "http://docs.oasis-open.org/legaldocml/ns/akn/3.0";
export const BNL = "urn:bnl:1.0";
export const XH = "http://www.w3.org/1999/xhtml";
const XMLNS = "http://www.w3.org/2000/xmlns/";

export const MIXED = new Set(["p", "heading", "subheading", "num", "span", "ref", "i", "b", "u", "sup", "sub", "a",
  "docTitle", "docNumber", "docDate", "shortTitle", "docType", "docStage", "docProponent", "term", "def", "inline",
  "mref", "rref", "noteRef", "td", "th", "li", "signature", "person", "role", "location", "date", "entity", "concept",
  "object", "event", "quantity", "omissis", "placeholder", "fillIn"]);

export const ABBR = { part: "part", chapter: "chp", section: "sec", subsection: "subsec", clause: "cl",
  subclause: "subcl", point: "point", paragraph: "para", subparagraph: "subpara", article: "art", rule: "rule",
  subrule: "subrule", item: "item", list: "list", proviso: "proviso", hcontainer: "hcontainer", title: "title",
  book: "book", division: "dvs", subdivision: "subdvs", tome: "tome", subchapter: "subchp", subpart: "subpart",
  subtitle: "subtitle", indent: "indent", alinea: "al", level: "lvl", transitional: "transitional" };
export const UNNUMBERED = new Set(["proviso", "hcontainer"]);
export const GROUPS = new Set(["part", "chapter", "subchapter", "subpart", "division", "subdivision", "title", "book", "tome"]);

export const kids = x => Array.from(x.children);
export const local = x => x.localName;
export function kid(x, name) { return kids(x).find(c => c.localName === name && c.namespaceURI === AKN) || null; }
export function text(x) { return x ? x.textContent : ""; }
export function* iter(root) {           // every element, document order, root included
  yield root;
  for (const el of root.getElementsByTagName("*")) yield el;
}
export function byName(root, name) { return Array.from(root.getElementsByTagNameNS(AKN, name)); }

export function parse(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) throw new Error(err.textContent.replace(/\s+/g, " ").trim().slice(0, 300));
  return doc;
}

function structural(el) {
  if (MIXED.has(el.localName) || el.children.length === 0) return false;
  for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return false;
  if (Array.from(el.childNodes).some(n => n.nodeType === 4)) return false;   // CDATA
  return true;
}

function indent(el, depth = 0, step = "  ") {
  if (!structural(el)) return;
  const doc = el.ownerDocument;
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) el.removeChild(n);
  const kidsNow = Array.from(el.childNodes);
  const pad = "\n" + step.repeat(depth + 1);
  for (const c of kidsNow) {
    el.insertBefore(doc.createTextNode(pad), c);
    if (c.nodeType === 1) indent(c, depth + 1, step);
  }
  el.appendChild(doc.createTextNode("\n" + step.repeat(depth)));
}

export function serialize(doc) {
  const root = doc.documentElement;
  if (root.namespaceURI === AKN) {
    if (!root.hasAttribute("xmlns:bnl") && doc.getElementsByTagNameNS("*", "*") &&
        Array.from(iter(root)).some(e => Array.from(e.attributes).some(a => a.namespaceURI === BNL) || e.namespaceURI === BNL))
      root.setAttributeNS(XMLNS, "xmlns:bnl", BNL);
  }
  indent(root);
  let body = new XMLSerializer().serializeToString(root);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + body + "\n";
}

/* -- eIds --------------------------------------------------------------------------------------- */

export function numToken(t) {
  t = (t || "").trim().replace(/^(CHAPTER|PART|SCHEDULE|ARTICLE|RULE|SECTION)\s+/i, "");
  return t.replace(/[^\w]/g, "");
}

function isProvision(el) { return el.localName !== "list" || kid(el, "num") !== null; }

/* Give provisions their eIds and rewrite local references to match. Existing eIds are permanent:
   only provisions without one (or with an editor 'tmp_' id) get one, unless renumber is true.
   Returns {old: new} for every eId that changed. */
export function assignEids(doc, renumber = false) {
  const root = doc.documentElement || doc;
  const renamed = {}, used = new Set();
  if (!renumber) for (const e of iter(root)) { const v = e.getAttribute("eId"); if (v && !v.startsWith("tmp_")) used.add(v); }
  const keep = c => !renumber && c.getAttribute("eId") && !c.getAttribute("eId").startsWith("tmp_");
  const fresh = base => { let eid = base, n = 1; while (used.has(eid)) { n++; eid = `${base}_${n}`; } used.add(eid); return eid; };
  const set = (c, eid) => { const old = c.getAttribute("eId"); if (old !== eid) { if (old) renamed[old] = eid; c.setAttribute("eId", eid); } };

  function walk(el, prefix, counters, inAtt) {
    for (const c of kids(el)) {
      const name = c.localName;
      if (name === "meta") continue;
      if (name === "attachment") {
        counters.sched = (counters.sched || 0) + 1;
        if (!keep(c)) set(c, fresh(`sched_${counters.sched}`));
        walk(c, c.getAttribute("eId") + "__", {}, true);
      } else if (name in ABBR && isProvision(c)) {
        const abbr = ABBR[name];
        counters[abbr] = (counters[abbr] || 0) + 1;
        if (!keep(c)) {
          const num = kid(c, "num");
          let token = num ? numToken(num.textContent) : "";
          if (UNNUMBERED.has(name) || !token) token = String(counters[abbr]);
          set(c, fresh(`${prefix}${abbr}_${token}`));
        }
        // Sections run through the whole instrument, so chapters and parts do not prefix them
        // in the body; in a schedule numbering restarts in each part, so there they do.
        if (GROUPS.has(name) && !inAtt) walk(c, prefix, counters, inAtt);
        else walk(c, c.getAttribute("eId") + "__", {}, inAtt);
      } else walk(c, prefix, counters, inAtt);
    }
  }
  for (const d of kids(root)) walk(d, "", {}, false);

  if (Object.keys(renamed).length)
    for (const el of iter(root)) for (const a of ["href", "refersTo", "period"]) {
      const v = el.getAttribute(a);
      if (v && v.startsWith("#") && renamed[v.slice(1)]) el.setAttribute(a, "#" + renamed[v.slice(1)]);
    }
  return renamed;
}

export function expectedEidMismatches(doc) {
  const twin = doc.cloneNode(true);
  return Object.entries(assignEids(twin, true)).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

/* -- line -> provision, for pointing at schema errors ------------------------------------------- */

export function lineIndex(xml) {
  const out = new Map(), stack = [];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([^\s>\/!?]+)([^>]*?)(\/?)>/g;
  let line = 1, pos = 0, m;
  while ((m = re.exec(xml))) {
    for (let i = pos; i < m.index; i++) if (xml.charCodeAt(i) === 10) line++;
    pos = m.index;
    if (m[2]) {
      if (m[1]) stack.pop();
      else {
        const e = /\beId="([^"]*)"/.exec(m[3]);
        const cur = e ? e[1] : (stack.length ? stack[stack.length - 1] : null);
        if (!out.has(line)) out.set(line, cur);
        if (!m[4]) stack.push(cur);
      }
    }
  }
  return out;
}

export function eidAt(index, line) {
  while (line > 0) { const v = index.get(line); if (v) return v; line--; }
  return null;
}
