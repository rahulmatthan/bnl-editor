/* BNL Editor. The model is the XML document itself (DOMParser): the page renders it, edits change it
   in place, and anything the page does not understand is carried through untouched. */
"use strict";

const AKN = "http://docs.oasis-open.org/legaldocml/ns/akn/3.0";
const BNL = "urn:bnl:1.0";
const XH = "http://www.w3.org/1999/xhtml";

const HIER = new Set(["part", "chapter", "section", "subsection", "clause", "subclause", "point", "paragraph",
  "subparagraph", "rule", "subrule", "article", "proviso", "hcontainer", "item", "subchapter", "subpart"]);
const GROUP = new Set(["part", "chapter", "subchapter", "subpart"]);
const TEXTBLOCK = new Set(["content", "intro", "wrapUp"]);
const FMT = new Set(["b", "i", "u", "sup", "sub"]);
const SPANLIKE = new Set(["docTitle", "docNumber", "docDate", "shortTitle", "docType", "docStage", "docProponent",
  "term", "def", "span", "inline", "date", "person", "role", "organization", "location", "entity", "concept",
  "object", "event", "quantity", "mref", "rref", "mod", "quotedText"]);
const CHILD_KIND = { part: "chapter", chapter: "section", subchapter: "section", section: "subsection",
  subsection: "clause", clause: "subclause", subclause: "point", point: "point", paragraph: "subparagraph",
  subparagraph: "clause", rule: "subrule", subrule: "clause", proviso: "clause", hcontainer: "paragraph",
  article: "paragraph", item: "item" };
const FIRST_NUM = { part: "PART I", chapter: "CHAPTER I", section: "1.", subsection: "(1)", clause: "(a)",
  subclause: "(i)", point: "(A)", paragraph: "1.", subparagraph: "(a)", rule: "1.", subrule: "(1)", article: "1.", item: "1." };
const KIND_LABEL = { section: "Section", subsection: "Sub-section", clause: "Clause", subclause: "Sub-clause",
  point: "Item", chapter: "Chapter", part: "Part", paragraph: "Paragraph", subparagraph: "Sub-paragraph",
  proviso: "Proviso", hcontainer: "Explanation / other", rule: "Rule", subrule: "Sub-rule", article: "Article", item: "Item" };
const MOD_TYPES = { substitution: "Substitution", insertion: "Insertion", repeal: "Omission", renumbering: "Renumbering" };

const S = { id: null, doc: null, spec: null, sel: null, mode: "edit", checks: [], dirty: false, saving: false,
  pending: new Set(), undo: [], tmp: 0, saveTimer: null, view: null, stages: null };
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

/* ---------------------------------------------------------------- helpers */

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}
const kids = x => Array.from(x.children);
const ln = x => x.localName;
const isAkn = x => x.namespaceURI === AKN;
function kid(x, name) { return kids(x).find(c => ln(c) === name && isAkn(c)) || null; }
function mk(name, text) { const e = S.doc.createElementNS(AKN, name); if (text !== undefined) e.textContent = text; return e; }
function txt(x) { return x ? x.textContent.replace(/\s+/g, " ").trim() : ""; }
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
/* The same API is answered by server.py (on the Mac) or, with no server, by engine/local.js in the
   browser itself (the web version: drafts are kept in this browser's storage). */
let LOCAL = null;
async function backend() {
  if (backend.done) return;
  backend.done = true;
  const forced = /[?&]local\b/.test(location.search);
  if (!forced) {
    try { const r = await fetch("api/spec"); if (r.ok && (r.headers.get("Content-Type") || "").includes("json")) return; } catch (e) {}
  }
  LOCAL = await import("./engine/local.js");
  document.body.classList.add("local");
}
async function api(path, opts = {}) {
  await backend();
  if (LOCAL) return LOCAL.api(path, opts);
  const r = await fetch("api/" + path, opts);
  const ct = r.headers.get("Content-Type") || "";
  const body = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) { const e = new Error((body && body.error) || r.statusText); e.body = body; e.status = r.status; throw e; }
  return body;
}
function newTmp() { return "tmp_" + (++S.tmp) + "_" + Date.now().toString(36); }
function root() { return S.doc.documentElement; }
function docEl() { return kids(root())[0]; }
function meta() { return kid(docEl(), "meta"); }
function provOf(x) { while (x && !(x.nodeType === 1 && HIER.has(ln(x)))) x = x.parentNode; return x; }
function hierKids(x) { return kids(x).filter(c => HIER.has(ln(c))); }
function serialize() { return new XMLSerializer().serializeToString(S.doc); }
function snapshot() { S.undo.push(serialize()); if (S.undo.length > 60) S.undo.shift(); $("#undo").hidden = false; }

/* numbers: "(3)" -> "(4)", "(c)" -> "(d)", "(iii)" -> "(iv)", "12." -> "13.", "CHAPTER IV" -> "CHAPTER V" */
const ROMAN = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
function toRoman(n) { let s = ""; for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; } return s; }
function fromRoman(s) { const m = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 }; let t = 0, p = 0;
  for (const ch of s.toLowerCase().split("").reverse()) { const v = m[ch]; if (!v) return null; t += v < p ? -v : v; p = Math.max(p, v); } return t; }
function nextNum(num, kind) {
  const m = /^(\D*?)([0-9]+|[A-Za-z]+)(\W*)$/.exec(num || "");
  if (!m) return FIRST_NUM[kind] || "";
  let [, pre, tok, post] = m;
  if (/^\d+$/.test(tok)) tok = String(+tok + 1);
  else if (["subclause", "chapter", "part"].includes(kind) && fromRoman(tok)) {
    const up = tok === tok.toUpperCase(); tok = toRoman(fromRoman(tok) + 1); if (up) tok = tok.toUpperCase();
  } else if (tok.length === 1) tok = String.fromCharCode(tok.charCodeAt(0) + 1);
  else tok = tok + "a";
  return pre + tok + post;
}

/* The n-th number in the style of a template number of the same kind: ("(c)", clause, 5) -> "(e)",
   ("CHAPTER II", chapter, 4) -> "CHAPTER IV", ("12.", section, 3) -> "3." */
const ROMAN_KINDS = new Set(["subclause", "chapter", "part", "subchapter", "subpart"]);
const ALPHA_KINDS = new Set(["clause", "point", "subparagraph"]);
function numAt(tmpl, kind, n) {
  const m = /^(\D*?)([0-9]+[A-Z]*|[A-Za-z]+)(\W*)$/.exec((tmpl || "").trim());
  if (!m) return null;
  const [, pre, tok, post] = m, up = tok === tok.toUpperCase() && /[A-Za-z]/.test(tok);
  let t;
  if (/^\d/.test(tok)) t = String(n);
  else if (ROMAN_KINDS.has(kind) || (!ALPHA_KINDS.has(kind) && fromRoman(tok) && tok.length > 1)) t = toRoman(n);
  else t = (n > 26 ? "z".repeat(Math.floor((n - 1) / 26)) : "") + String.fromCharCode(97 + (n - 1) % 26);
  return pre + (up ? t.toUpperCase() : t) + post;
}

/* ---------------------------------------------------------------- inline: AKN <-> HTML */

function attrsJSON(x) {
  return JSON.stringify(Array.from(x.attributes).map(a => [a.namespaceURI, a.name, a.value]));
}
function setAttrsJSON(x, json) {
  for (const [ns, name, value] of JSON.parse(json || "[]")) {
    if (ns && name.startsWith("xmlns")) continue;
    ns ? x.setAttributeNS(ns, name, value) : x.setAttribute(name, value);
  }
}
function inlineToHtml(x, out) {
  let skip = null;
  for (const n of Array.from(x.childNodes)) {
    if (n === skip) continue;
    if (n.nodeType === 3) { out.append(document.createTextNode(n.nodeValue)); continue; }
    if (n.nodeType !== 1) continue;
    const name = ln(n);
    if (isAkn(n) && FMT.has(name)) { const e = h(name); inlineToHtml(n, e); out.append(e); }
    else if (isAkn(n) && name === "ref") {
      const e = h("a", { class: "ref", "data-attrs": attrsJSON(n), title: n.getAttribute("href") || "" });
      inlineToHtml(n, e); out.append(e);
    } else if (isAkn(n) && SPANLIKE.has(name) && !kids(n).some(c => !FMT.has(ln(c)) && !SPANLIKE.has(ln(c)) && ln(c) !== "ref")) {
      const e = h("span", { class: "ai", "data-akn": name, "data-attrs": attrsJSON(n), title: name });
      inlineToHtml(n, e); out.append(e);
      // the stop or semicolon after a quoted provision is shown on its last line (and saved after it)
      const nx = n.nextSibling;
      if (name === "quotedText" && nx && nx.nodeType === 3 && /^[\s.;,:]+$/.test(nx.nodeValue) && nx.nodeValue.trim()) {
        e.append(h("span", { class: "qend" }, nx.nodeValue.trim())); skip = nx;
        if (/\s$/.test(nx.nodeValue)) out.append(document.createTextNode(" "));
      }
    } else {
      const label = name === "authorialNote" ? "note" : name === "noteRef" ? "note " + (n.getAttribute("marker") || "") : name;
      out.append(h("span", { class: "chip", contenteditable: "false", "data-xml": new XMLSerializer().serializeToString(n),
        title: txt(n) || name }, label));
    }
  }
}
function htmlToInline(hEl, x) {
  while (x.firstChild) x.removeChild(x.firstChild);
  const walk = (src, dst) => {
    for (const n of Array.from(src.childNodes)) {
      if (n.nodeType === 3) { dst.appendChild(S.doc.createTextNode(n.nodeValue.replace(/ /g, " "))); continue; }
      if (n.nodeType !== 1) continue;
      const t = n.tagName.toLowerCase();
      if (n.classList.contains("chip")) {
        const frag = new DOMParser().parseFromString(n.dataset.xml, "application/xml").documentElement;
        dst.appendChild(S.doc.importNode(frag, true));
      } else if (t === "a" && n.classList.contains("ref")) {
        const e = mk("ref"); setAttrsJSON(e, n.dataset.attrs); walk(n, e); dst.appendChild(e);
      } else if (n.classList.contains("qend")) {
        dst._tail = (dst._tail || "") + n.textContent;
      } else if (t === "span" && n.dataset.akn) {
        const e = mk(n.dataset.akn); setAttrsJSON(e, n.dataset.attrs); walk(n, e); dst.appendChild(e);
        if (e._tail) { dst.appendChild(S.doc.createTextNode(e._tail)); e._tail = null; }
      } else if (FMT.has(t) || t === "strong" || t === "em") {
        const e = mk(t === "strong" ? "b" : t === "em" ? "i" : t); walk(n, e); dst.appendChild(e);
      } else if (t === "br") { dst.appendChild(S.doc.createTextNode(" ")); }
      else walk(n, dst);   // browser wrappers: keep the words, drop the wrapper
    }
  };
  walk(hEl, x);
}

/* ---------------------------------------------------------------- rendering */

function editable(attrs) { return S.mode === "edit" ? Object.assign({ contenteditable: "true", spellcheck: "true" }, attrs) : attrs; }

function renderP(x, cls) {
  const e = h("p", editable({ class: "t " + (x.getAttribute("class") || "") + (cls ? " " + cls : ""), "data-ph": "Text" }));
  inlineToHtml(x, e);
  e._x = x; x._h = e;
  return e;
}

function renderTable(x) {
  const t = h("table", { class: "akn" });
  for (const tr of kids(x).filter(c => ln(c) === "tr")) {
    const r = h("tr");
    for (const cell of kids(tr)) {
      const c = h(ln(cell) === "th" ? "th" : "td");
      const ps = kids(cell).filter(k => ln(k) === "p");
      if (ps.length) ps.forEach(p => c.append(renderP(p)));
      else { c.append(renderGeneric(cell, true)); }
      r.append(c);
    }
    t.append(r);
  }
  t._x = x;
  return t;
}

function renderBlocks(x, into) {
  for (const c of kids(x)) into.append(renderNode(c));
}

function renderNode(x) {
  const name = ln(x);
  if (!isAkn(x)) return renderGeneric(x);
  if (HIER.has(name)) return renderProv(x);
  if (name === "p") return renderP(x);
  if (name === "table") return renderTable(x);
  if (TEXTBLOCK.has(name)) { const d = h("div", { class: "cb " + name }); renderBlocks(x, d); d._x = x; return d; }
  if (["preface", "preamble", "longTitle", "formula", "blockContainer", "container", "div", "recitals", "recital", "citations", "citation",
       "conclusions", "mainBody", "body"].includes(name)) {
    const d = h("div", { class: name }); renderBlocks(x, d); d._x = x; return d;
  }
  return renderGeneric(x);
}

function renderGeneric(x, bare) {
  // Something the editor does not lay out: show it, keep it exactly.
  const hasText = Array.from(x.childNodes).some(n => n.nodeType === 3 && n.nodeValue.trim());
  if (hasText || !kids(x).length) {
    return h("span", { class: "chip", contenteditable: "false", title: new XMLSerializer().serializeToString(x).slice(0, 400) },
      ln(x) + (txt(x) ? ": " + txt(x).slice(0, 80) : ""));
  }
  const d = h("div", { class: bare ? "" : "generic" }, bare ? null : h("div", { class: "box-label" }, ln(x)));
  renderBlocks(x, d);
  return d;
}

function renderProv(x) {
  const name = ln(x);
  const d = h("div", { class: `prov k-${name}`, "data-eid": x.getAttribute("eId") || "" });
  d._x = x; x._h = d;
  const num = kid(x, "num"), head = kid(x, "heading");
  const hd = h("div", { class: "hd" });
  if (name !== "proviso") {
    const n = h("span", editable({ class: "num", "data-ph": name === "hcontainer" ? "" : "No." }));
    if (num) inlineToHtml(num, n);
    n._numOf = x; hd.append(n);
  }
  const wantsHeading = GROUP.has(name) || name === "section" || name === "rule" || name === "article" || name === "hcontainer" || head;
  if (wantsHeading) {
    const hh = h("span", editable({ class: "heading", "data-ph": "Heading" }));
    if (head) inlineToHtml(head, hh);
    hh._headOf = x; hd.append(hh);
  }
  if (draftingNotes(x.getAttribute("eId")).length) hd.append(h("span", { class: "mods-mark note-mark", title: "Drafting note", onclick: () => select(x, true) }, "✎ note"));
  const mods = modsFrom(x.getAttribute("eId"));
  if (mods.length) hd.append(h("span", { class: "mods-mark", title: "Amendments this provision makes", onclick: () => select(x, true) },
    `⟶ amends ${mods.length}`));
  d.append(hd);
  // Sub-sections and clauses read on one line with their number: "(1) The Ministry …".
  let inlined = wantsHeading;
  for (const c of kids(x)) {
    const cn = ln(c);
    if (cn === "num" || cn === "heading") continue;
    const blk = renderNode(c);
    if (!inlined && (cn === "content" || cn === "intro")) { blk.classList.add("lead"); hd.append(blk); inlined = true; continue; }
    d.append(blk);
  }
  return d;
}

function renderAll() {
  const page = $("#page"), wrap = $("#pagewrap"), top = wrap.scrollTop;
  page.style.minHeight = page.offsetHeight + "px";      // keep the scroll position while rebuilding
  page.innerHTML = "";
  requestAnimationFrame(() => { page.style.minHeight = ""; });
  setTimeout(() => { if (Math.abs(wrap.scrollTop - top) > 2 && !S.scrolling) wrap.scrollTop = top; }, 0);
  document.body.classList.toggle("read", S.mode === "read");
  $("#tools").hidden = false;
  $$("#tools button:not(#t-contents)").forEach(b => (b.hidden = S.mode !== "edit" || !!S.view));
  if (S.mode === "xml") { renderXml(); return; }
  const d = docEl();
  for (const c of kids(d)) {
    const name = ln(c);
    if (name === "meta") continue;
    if (name === "attachments") {
      for (const att of kids(c)) {
        const w = h("section", { class: "attachment", "data-eid": att.getAttribute("eId") || "" });
        w._x = att;
        for (const inner of kids(att)) {           // <doc name="schedule">
          for (const part of kids(inner)) if (ln(part) !== "meta") {
            const blk = renderNode(part);
            if (ln(part) === "preface") blk.classList.add("preface");
            w.append(blk);
          }
        }
        page.append(w);
      }
      continue;
    }
    const blk = renderNode(c);
    if (name === "preface" || name === "preamble") {
      blk.classList.add(name);
      if (name === "preface") renderPrefaceInto(c, blk);
    }
    if (name === "body") blk.classList.add("body");
    page.append(blk);
  }
  markChecks();
  renderOutline();
}

function renderPrefaceInto(x, blk) {
  blk.innerHTML = "";
  for (const c of kids(x)) blk.append(renderNode(c));
}

async function renderXml() {
  const page = $("#page");
  await flush();
  page.append(h("pre", { class: "xml" }, serialize().replace(/></g, ">\n<").slice(0, 2_000_000)));
  try { const saved = await api("i/" + S.id); page.innerHTML = ""; page.append(h("p", { class: "note" },
    "The file as saved on disk (the editor saves before showing it)."), h("pre", { class: "xml" }, saved)); } catch (e) {}
}

/* The contents: chapters and sections, each section opening to its sub-sections and clauses. The box at
   the top finds a provision by its number ("14(2)(b)") or by its words. While a cross-reference is being
   made (S.pick), a click puts the reference at the cursor instead of going to the provision. */
const CITE_SKIP = new Set(["proviso", "hcontainer"]);
function numbered(x) { return !!x && x.nodeType === 1 && HIER.has(ln(x)) && !CITE_SKIP.has(ln(x)) && isAkn(x) && !!txt(kid(x, "num")); }
/* "14(2)(b)" for clause (b) of sub-section (2) of section 14; "Chapter III" for a chapter. */
function citeOf(x) {
  if (ln(x) === "attachment") return "Schedule";
  const tok = y => S.akn ? S.akn.numToken(txt(kid(y, "num"))) : txt(kid(y, "num")).replace(/[^\w]/g, "");
  if (GROUP.has(ln(x))) return `${KIND_LABEL[ln(x)] || ln(x)} ${tok(x)}`;
  const chain = [];
  for (let y = x; y && y.nodeType === 1 && HIER.has(ln(y)) && !GROUP.has(ln(y)); y = y.parentNode) if (numbered(y)) chain.unshift(y);
  return chain.map((y, i) => i === 0 && ["section", "rule", "article", "paragraph"].includes(ln(y)) ? tok(y) : `(${tok(y)})`).join("");
}
function outlineIndex() {
  const out = [];
  const walk = (x, depth, sec) => {
    for (const c of kids(x)) {
      const name = ln(c);
      if (name === "meta" || !isAkn(c) || name === "p" || TEXTBLOCK.has(name)) continue;
      if (GROUP.has(name) && numbered(c)) { out.push({ x: c, grp: true }); walk(c, 0, null); }
      else if (name === "attachment") { out.push({ x: c, grp: true, att: true }); walk(c, 0, null); }
      else if (numbered(c)) { out.push({ x: c, depth, sec: sec || c, top: !sec }); walk(c, depth + 1, sec || c); }
      else walk(c, depth, sec);
    }
  };
  walk(docEl(), 0, null);
  return out;
}
function provWords(x) { return txt(kid(x, "heading")) || firstWords(x); }
function renderOutline() {
  const o = $("#otree"); if (!o) return; o.innerHTML = "";
  S.open = S.open || new Set(); S.shut = S.shut || new Set();
  const counts = {};
  for (const c of S.checks) if (c.eId && (c.level === "error" || c.level === "warning")) {
    const sec = c.eId.split("__")[0];
    counts[sec] = counts[sec] === "error" ? "error" : c.level;
  }
  const idx = outlineIndex();
  const cur = idx.find(e => !e.grp && S.sel && e.x.contains(S.sel));   // the section holding the selection
  const curSec = cur && cur.sec;
  const go = (e, ev) => {
    ev.preventDefault();
    if (S.pick) { insertRef(e.x); return; }
    if (e.att) { scrollToEid(e.x.getAttribute("eId")); return; }
    select(e.x, true);
    document.body.classList.remove("contents");
  };
  const row = (e, cls, style, ...inner) => h("a", { href: "#", class: cls, style, "data-eid": e.x.getAttribute("eId") || "", onclick: ev => go(e, ev) }, ...inner);
  const q = ($("#ofind").value || "").trim();
  if (q) {
    const hits = findProvisions(idx, q);
    if (!hits.length) o.append(h("p", { class: "note" }, "Nothing matches."));
    for (const e of hits.slice(0, 150))
      o.append(row(e, "hit", null, h("span", { class: "cite" }, e.grp ? txt(kid(e.x, "num")) : citeOf(e.x)), " ", e.grp ? txt(kid(e.x, "heading")) : provWords(e.x)));
  } else {
    const isOpen = sec => !S.shut.has(sec) && (S.open.has(sec) || sec === curSec);
    for (const e of idx) {
      if (e.grp) {
        o.append(row(e, "grp", null, e.att ? (txt(e.x.getElementsByTagNameNS(AKN, "p")[0]) || "Schedule") : `${txt(kid(e.x, "num"))} ${txt(kid(e.x, "heading"))}`));
        continue;
      }
      const open = isOpen(e.sec);
      if (!e.top && !open) continue;
      const eid = e.x.getAttribute("eId") || "";
      const hasKids = e.top && idx.some(f => f.sec === e.x && !f.top);
      const tog = h("span", { class: "tog" }, hasKids ? (open ? "▾" : "▸") : "");
      if (hasKids) tog.addEventListener("click", ev => {
        ev.preventDefault(); ev.stopPropagation();
        if (open) { S.open.delete(e.sec); S.shut.add(e.sec); } else { S.open.add(e.sec); S.shut.delete(e.sec); }
        renderOutline();
      });
      o.append(row(e, e.top ? "sec" : "sub", `padding-left:${4 + e.depth * 16}px`, tog,
        h("span", { class: "n" }, txt(kid(e.x, "num"))), " ", provWords(e.x),
        counts[eid] ? h("span", { class: "dot " + counts[eid] }) : null));
    }
  }
  if (S.sel) $$(`#otree a[data-eid="${CSS.escape(S.sel.getAttribute("eId") || "")}"]`).forEach(a => a.classList.add("on"));
}
/* "14", "14(2)", "s. 14(2)(b)", "section 14 (2)" find by number; anything else by words, every word. */
function findProvisions(idx, q) {
  const flat = s => s.toLowerCase().replace(/\s+/g, "");
  const cite = flat(q.replace(/^(section|sec\.?|s\.|clause|sub-section|sub-clause)\s*/i, "")).replace(/\.$/, "");
  if (/^\d+[a-z]*(\([0-9a-z]*\)?)*$/.test(cite)) {
    const cands = idx.filter(e => !e.grp);
    const exact = cands.filter(e => flat(citeOf(e.x)) === cite);
    const secOf = s => s.split("(")[0];      // "14" finds 14, 14(1), 14(2)(b), not 140
    const pre = cands.filter(e => { const c = flat(citeOf(e.x)); return !exact.includes(e) && c.startsWith(cite) && secOf(c) === secOf(cite); });
    return [...exact, ...pre];
  }
  const ws = q.toLowerCase().split(/\s+/).filter(Boolean);
  return idx.filter(e => {
    if (e.att) return false;
    const own = e.grp ? `${txt(kid(e.x, "num"))} ${txt(kid(e.x, "heading"))}` :
      [txt(kid(e.x, "num")), txt(kid(e.x, "heading")), ...kids(e.x).filter(c => TEXTBLOCK.has(ln(c))).map(txt)].join(" ");
    const t = own.toLowerCase();
    return ws.every(w => t.includes(w));
  });
}
function firstWords(x) { const t = txt(x.getElementsByTagNameNS(AKN, "p")[0]); return t.length > 48 ? t.slice(0, 48) + "…" : t; }
function scrollToEid(eid) { const el = $(`#page [data-eid="${CSS.escape(eid || "")}"]`); if (el) el.scrollIntoView({ block: "center", behavior: "smooth" }); }

/* ---------------------------------------------------------------- selection and the inspector */

function select(x, scroll) {
  if (!x) return;
  S.sel = x;
  $$("#page .prov.sel").forEach(e => e.classList.remove("sel"));
  if (x._h) { x._h.classList.add("sel"); if (scroll) x._h.scrollIntoView({ block: "center", behavior: "smooth" }); }
  // the contents open at the section being worked in, and mark the provision itself
  let top = x; while (top && top.parentNode && numbered(top.parentNode)) top = top.parentNode;
  if (top !== S.selTop) { S.selTop = top; renderOutline(); }
  $$("#otree a.on").forEach(a => a.classList.remove("on"));
  $$(`#otree a[data-eid="${CSS.escape(x.getAttribute("eId") || "")}"]`).forEach(a => { a.classList.add("on"); a.scrollIntoView({ block: "nearest" }); });
  renderInspector();
}

function tab(name) {
  $$(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === name));
  $$(".tab").forEach(t => (t.hidden = t.id !== "tab-" + name));
  if (name === "inst") renderInstrument();
  if (name === "checks") renderChecks();
  if (name === "stages") renderStages();
  if (name === "prov") renderInspector();
}

function renderInspector() {
  const t = $("#tab-prov"); t.innerHTML = "";
  const x = S.sel;
  if (!x) { t.append(h("p", { class: "note" }, "Click a provision to see its identifier, its BNL attributes and the amendments it makes.")); return; }
  const name = ln(x), eid = x.getAttribute("eId") || "";
  const ro = S.mode !== "edit";

  t.append(h("h3", {}, KIND_LABEL[name] || name));
  const kindSel = h("select", { disabled: ro, onchange: e => { snapshot(); const nx = renameEl(x, e.target.value); changed(true); select(nx, false); } },
    ...Object.keys(KIND_LABEL).map(k => h("option", { value: k, selected: k === name }, KIND_LABEL[k])));
  t.append(h("div", { class: "kv" },
    h("span", { class: "k" }, "Kind"), kindSel,
    h("span", { class: "k" }, "Identifier"), h("span", { class: "mono" }, eid.startsWith("tmp_") ? "(given on save)" : eid),
    h("span", { class: "k" }, "BNL name"), h("span", { class: "mono" }, eid && !eid.startsWith("tmp_") ? `${workUri()}/~${eid}` : "")));

  if (!ro) {
    t.append(h("div", { class: "btns" },
      h("button", { onclick: () => addSibling(x) }, "Add after"),
      h("button", { onclick: () => addChild(x) }, "Add inside"),
      h("button", { onclick: () => addSpecial(x, "proviso") }, "Proviso"),
      h("button", { onclick: () => addSpecial(x, "explanation") }, "Explanation"),
      h("button", { onclick: () => demote(x), title: "Tab" }, "Indent"),
      h("button", { onclick: () => promote(x), title: "Shift-Tab" }, "Outdent"),
      h("button", { onclick: () => move(x, -1), title: "⌥↑" }, "↑"),
      h("button", { onclick: () => move(x, 1), title: "⌥↓" }, "↓"),
      confirmButton("Delete", () => removeProv(x))));
  }

  const nb = noteBox(x, ro); if (nb) t.append(nb);

  // BNL attributes
  t.append(h("h3", {}, "BNL attributes"));
  const ext = x.getAttributeNS(BNL, "extent"), basis = x.getAttributeNS(BNL, "basis");
  t.append(h("div", { class: "kv" },
    h("span", { class: "k" }, "Extent"), extentPicker(ext, v => setBnl(x, "extent", v), ro),
    h("span", { class: "k" }, "Basis"), selectOf([["", "—"], ...S.spec.basis.map(b => [b.value, b.value])], basis || "",
      v => setBnl(x, "basis", v), ro)));
  const others = Array.from(x.attributes).filter(a => !["eId", "xmlns"].includes(a.name) && !(a.namespaceURI === BNL && ["extent", "basis"].includes(a.localName)) && !a.name.startsWith("xmlns"));
  if (others.length) t.append(h("div", { class: "kv" }, ...others.flatMap(a => [h("span", { class: "k mono" }, a.name), h("span", { class: "mono" }, a.value)])));

  // amendments
  t.append(h("h3", {}, "Amendments this provision makes"));
  const mods = modsFrom(eid);
  if (!mods.length) t.append(h("p", { class: "note" }, "None recorded."));
  mods.forEach(m => t.append(modCard(m, ro)));
  if (!ro) t.append(h("div", { class: "btns" }, h("button", { onclick: () => modForm(x, null) }, "Record an amendment")));

  const effects = effectsOn(eid);
  if (effects.length) {
    t.append(h("h3", {}, "Recorded effects on this provision"));
    effects.forEach(m => t.append(h("div", { class: "mod" }, h("span", { class: "ty" }, ln(m) + " " + (m.getAttribute("type") || "")),
      " from ", h("span", { class: "mono" }, (kid(m, "source") || { getAttribute: () => "" }).getAttribute("href")))));
  }

  const notes = draftingNotes(eid);
  if (notes.length) {
    t.append(h("h3", {}, "Drafting notes"));
    notes.forEach(n => t.append(h("div", { class: "mod note-card" }, txt(n),
      h("div", { class: "note" }, "Kept in the metadata, not the text (s.10(2)). Remove it before the Bill is vetted."),
      ro ? null : h("div", { class: "btns" }, confirmButton("Remove note", () => { snapshot(); const holder = n.parentNode; n.remove(); if (!kids(holder).length) holder.remove(); changed(true); renderAll(); select(x); })))));
  }

  const mine = S.checks.filter(c => c.eId && (c.eId === eid));
  if (mine.length) { t.append(h("h3", {}, "Checks")); mine.forEach(c => t.append(checkRow(c))); }
}

function confirmButton(label, fn) {
  const b = h("button", { class: "danger" }, label);
  b.addEventListener("click", () => {
    if (b.dataset.armed) { fn(); return; }
    b.dataset.armed = "1"; b.textContent = "Click again to delete";
    setTimeout(() => { delete b.dataset.armed; b.textContent = label; }, 2500);
  });
  return b;
}
function selectOf(options, value, onchange, ro) {
  return h("select", { disabled: ro, onchange: e => onchange(e.target.value) },
    ...options.map(([v, l]) => h("option", { value: v, selected: v === value }, l)));
}
function extentPicker(value, onchange, ro) {
  const wrap = h("div");
  const vals = (value || "").split(/\s+/).filter(Boolean);
  const chips = h("div", { class: "chips" }, ...vals.map(v => h("span", { title: ro ? "" : "Remove", onclick: () => !ro && onchange(vals.filter(z => z !== v).join(" ")) },
    `${v} ${S.spec.states[v] ? "· " + S.spec.states[v] : ""}`)));
  wrap.append(chips);
  if (!ro) {
    const sel = h("select", { onchange: e => { if (e.target.value) onchange([...vals.filter(v => v !== "IN" && e.target.value !== "IN"), e.target.value].join(" ")); } },
      h("option", { value: "" }, vals.length ? "Add a State…" : "Not set (applies as the instrument does)"),
      ...Object.entries(S.spec.states).map(([k, v]) => h("option", { value: k }, `${v} (${k})`)));
    wrap.append(sel);
  }
  return wrap;
}
function setBnl(x, name, v) {
  snapshot();
  ensureBnlNs();
  if (v) x.setAttributeNS(BNL, "bnl:" + name, v); else x.removeAttributeNS(BNL, name);
  changed(false); renderInspector();
}
function ensureBnlNs() { const r = root(); if (!r.getAttribute("xmlns:bnl")) r.setAttributeNS("http://www.w3.org/2000/xmlns/", "xmlns:bnl", BNL); }

/* ---------------------------------------------------------------- amendments (activeModifications) */

function analysis(create) {
  const m = meta();
  let a = kid(m, "analysis");
  if (!a && create) {
    a = mk("analysis"); a.setAttribute("source", "#bnl-editor");
    const after = ["identification", "publication", "classification", "lifecycle", "workflow"];
    let ref = null;
    for (const c of kids(m)) if (!after.includes(ln(c))) { ref = c; break; }
    m.insertBefore(a, ref);
  }
  return a;
}
function activeMods(create) {
  const a = analysis(create); if (!a) return null;
  let am = kid(a, "activeModifications");
  if (!am && create) { am = mk("activeModifications"); a.insertBefore(am, a.firstElementChild); }
  return am;
}
function allMods() { const am = activeMods(false); return am ? kids(am) : []; }
function modsFrom(eid) {
  if (!eid) return [];
  return allMods().filter(m => { const s = kid(m, "source"); return s && s.getAttribute("href") === "#" + eid; });
}
function effectsOn(eid) {
  if (!eid) return [];
  const a = analysis(false); if (!a) return [];
  return Array.from(a.getElementsByTagNameNS(AKN, "destination")).filter(d => d.getAttribute("href") === "#" + eid).map(d => d.parentNode);
}
function draftingNotes(eid) {
  if (!eid) return [];
  return Array.from(meta().getElementsByTagNameNS(AKN, "note")).filter(n => n.getAttribute("refersTo") === "#" + eid);
}
function words(m, which) { const w = kid(m, which); return w ? txt(w) : ""; }
function modCard(m, ro) {
  const typ = m.getAttribute("type");
  const dest = (kid(m, "destination") || { getAttribute: () => "" }).getAttribute("href");
  const ext = m.getAttributeNS(BNL, "extent"), basis = m.getAttributeNS(BNL, "basis");
  const actName = actNameOf(dest);
  const card = h("div", { class: "mod" },
    h("div", {}, h("span", { class: "ty" }, MOD_TYPES[typ] || typ), " in ", h("span", {}, actName ? actName + ", " : ""),
      h("span", {}, describeProv(dest))),
    h("div", { class: "mono" }, dest),
    words(m, "old") ? h("div", { class: "words" }, h("del", {}, words(m, "old"))) : null,
    words(m, "new") ? h("div", { class: "words" }, h("ins", {}, words(m, "new"))) : null,
    h("div", { class: "note" }, `extent ${ext || "not set"} · basis ${basis || "not set"} · ${m.getAttribute("eId")}`));
  if (!ro) card.append(h("div", { class: "btns" }, h("button", { onclick: () => modForm(S.sel, m) }, "Edit"),
    confirmButton("Delete", () => { snapshot(); m.remove(); changed(true); renderAll(); select(S.sel); })));
  return card;
}
function actNameOf(uri) {
  const work = (uri || "").split("/~")[0];
  const refs = kid(meta(), "references"); if (!refs) return "";
  const r = kids(refs).find(c => c.getAttribute("href") === work);
  return r ? r.getAttribute("showAs") : "";
}
function describeProv(uri) {
  const p = (uri || "").split("/~")[1]; if (!p) return "";
  const map = { sec: "section", subsec: "sub-section", cl: "clause", subcl: "sub-clause", para: "paragraph", sched: "Schedule", rule: "rule", subrule: "sub-rule", art: "article" };
  const parts = p.split("__").map(s => { const i = s.indexOf("_"); return [s.slice(0, i), s.slice(i + 1)]; });
  if (parts[0][0] === "sec") {
    let s = "section " + parts[0][1];
    for (const [a, n] of parts.slice(1)) s += `(${n})`;
    return s;
  }
  return parts.map(([a, n]) => `${map[a] || a} ${n}`).join(", ");
}
/* "section 27(1)(a)" -> "sec_27__subsec_1__cl_a"; "rule 3(1)(b)(v)" -> "rule_3__subrule_1__cl_b__subcl_v"; already a name -> as is */
function provName(s) {
  s = (s || "").trim();
  if (/^[a-z]+_[A-Za-z0-9]+(__[a-z]+_[A-Za-z0-9]+)*$/.test(s)) return s;
  const m = /^(section|sec\.?|s\.|rule|r\.|article|art\.?|paragraph|para\.?)\s*([0-9]+[A-Z]*)\s*((?:\([^)]+\))*)/i.exec(s);
  if (!m) return null;
  const head = /^r/i.test(m[1]) ? "rule" : /^a/i.test(m[1]) ? "art" : /^p/i.test(m[1]) ? "para" : "sec";
  const levels = head === "rule" ? ["subrule", "cl", "subcl", "point"] : ["subsec", "cl", "subcl", "point"];
  const subs = Array.from(m[3].matchAll(/\(([^)]+)\)/g)).map(x => x[1]);
  let out = `${head}_${m[2]}`, li = 0;
  for (const t of subs) {
    // the first bracket after a section is a sub-section only when it is a number
    if (li === 0 && !/^\d/.test(t)) li = 1;
    out += `__${levels[Math.min(li, levels.length - 1)]}_${t}`; li++;
  }
  return out;
}

function modForm(x, m) {
  const t = $("#tab-prov"); t.innerHTML = "";
  const eid = x.getAttribute("eId");
  const dest = m ? (kid(m, "destination") || { getAttribute: () => "" }).getAttribute("href") : "";
  const work = dest.split("/~")[0], prov = dest.split("/~")[1] || "";
  const wm = /^\/akn\/(in(?:-[a-z]{2})?)\/act\/(\d{4})\/([^/]+)/.exec(work) || [];
  const f = h("form", { class: "card" });
  const fld = (label, el) => h("label", {}, label, el);
  const typ = h("select", { name: "type" }, ...Object.entries(MOD_TYPES).map(([k, v]) => h("option", { value: k, selected: m ? m.getAttribute("type") === k : k === "substitution" }, v)));
  const act = h("input", { name: "act", placeholder: "Registration Act, 1908", value: actNameOf(dest) || "" });
  const year = h("input", { name: "year", placeholder: "1908", value: wm[2] || "" });
  const number = h("input", { name: "number", placeholder: "16", value: wm[3] || "" });
  const juris = h("select", { name: "juris" }, h("option", { value: "in" }, "Central Act"),
    ...Object.entries(S.spec.states).filter(([k]) => k !== "IN").map(([k, v]) => h("option", { value: k.toLowerCase(), selected: wm[1] === k.toLowerCase() }, `${v} State Act`)));
  const provIn = h("input", { name: "prov", placeholder: "section 2(1)(a)", value: prov });
  const shown = h("div", { class: "mono note" });
  const oldW = h("textarea", { name: "old", rows: 2, placeholder: "the words being replaced or omitted" }, m ? words(m, "old") : "");
  const newW = h("textarea", { name: "new", rows: 3, placeholder: "the words substituted or inserted" }, m ? words(m, "new") : "");
  const ext = { v: m ? (m.getAttributeNS(BNL, "extent") || "IN") : "IN" };
  const extBox = h("div");
  const drawExt = () => { extBox.innerHTML = ""; extBox.append(extentPicker(ext.v, v => { ext.v = v || "IN"; drawExt(); }, false)); };
  drawExt();
  const basis = selectOf(S.spec.basis.map(b => [b.value, `${b.value}${b.note ? " — " + b.note : ""}`]), m ? (m.getAttributeNS(BNL, "basis") || "stated") : "stated", () => {}, false);
  const uri = () => {
    const p = provName(provIn.value);
    return year.value && number.value ? `/akn/${juris.value}/act/${year.value.trim()}/${number.value.trim()}${p ? "/~" + p : ""}` : "";
  };
  const upd = () => { const p = provName(provIn.value); shown.textContent = (uri() || "(year and number of the Act)") + (provIn.value && !p ? "  ← cannot read the provision; write e.g. section 27(1)(a)" : ""); };
  [year, number, provIn, juris].forEach(i => i.addEventListener("input", upd)); upd();
  f.append(h("h2", {}, m ? "Edit amendment" : "Record an amendment"),
    h("p", { class: "note" }, `Made by ${describeOwn(x)} of this instrument. Recorded once, as a textualMod in its metadata.`),
    fld("What it does", typ), fld("Act amended (name as cited)", act),
    h("div", { class: "kv" }, h("span", { class: "k" }, "Year"), year, h("span", { class: "k" }, "Act number"), number, h("span", { class: "k" }, "Legislature"), juris),
    fld("Provision amended", provIn), shown, fld("Old words", oldW), fld("New words", newW),
    h("label", {}, "Extent (where the change applies)"), extBox, fld("Basis", basis),
    h("div", { class: "row" }, h("button", { type: "button", onclick: () => renderInspector() }, "Cancel"), h("button", { class: "primary" }, "Save amendment")));
  f.addEventListener("submit", e => {
    e.preventDefault();
    const u = uri();
    if (!u || !provName(provIn.value)) { toast("Give the Act's year and number and the provision amended."); return; }
    snapshot();
    const am = activeMods(true);
    let mod = m;
    if (!mod) {
      mod = mk("textualMod");
      const n = Math.max(0, ...allMods().map(z => +((z.getAttribute("eId") || "").match(/(\d+)$/) || [0, 0])[1])) + 1;
      mod.setAttribute("eId", "amod_" + n);
      am.appendChild(mod);
    }
    mod.setAttribute("type", typ.value);
    while (mod.firstChild) mod.removeChild(mod.firstChild);
    const src = mk("source"); src.setAttribute("href", "#" + eid); mod.appendChild(src);
    const dst = mk("destination"); dst.setAttribute("href", u); mod.appendChild(dst);
    for (const [which, ta] of [["old", oldW], ["new", newW]]) {
      if (!ta.value.trim()) continue;
      const w = mk(which); w.setAttribute("eId", `${mod.getAttribute("eId")}__${which}`);
      const p = S.doc.createElementNS(XH, "h:p"); p.textContent = ta.value.trim(); w.appendChild(p); mod.appendChild(w);
    }
    ensureBnlNs();
    mod.setAttributeNS(BNL, "bnl:extent", ext.v || "IN");
    mod.setAttributeNS(BNL, "bnl:basis", basis.value || "stated");
    if (act.value.trim()) recordActRef(u.split("/~")[0], act.value.trim());
    changed(true);
    renderAll(); select(x);
  });
  t.append(f);
}
function describeOwn(x) { const p = []; for (let y = x; y && HIER.has(ln(y)); y = y.parentNode) if (!GROUP.has(ln(y))) p.unshift(txt(kid(y, "num"))); return p.join("") || ln(x); }
function recordActRef(work, name) {
  const m = meta();
  let refs = kid(m, "references");
  if (!refs) { refs = mk("references"); refs.setAttribute("source", "#bnl-editor"); m.insertBefore(refs, kid(m, "notes") || kid(m, "proprietary") || kid(m, "presentation")); }
  let r = kids(refs).find(c => ln(c) === "activeRef" && c.getAttribute("href") === work);
  if (!r) {
    r = mk("activeRef"); r.setAttribute("eId", "ref_" + work.replace(/^\/akn\//, "").replace(/[^A-Za-z0-9]+/g, "_"));
    r.setAttribute("href", work);
    // activeRef comes after <original> and before the TLC entries
    const firstTlc = kids(refs).find(c => /^TLC/.test(ln(c)));
    refs.insertBefore(r, firstTlc || null);
  }
  r.setAttribute("showAs", name);
}

/* ---------------------------------------------------------------- the instrument tab */

function ident(part) { return kid(kid(meta(), "identification"), part); }
function workUri() { const w = ident("FRBRWork"); return w ? (kid(w, "FRBRuri") || { getAttribute: () => "" }).getAttribute("value") : ""; }
function renderInstrument() {
  const t = $("#tab-inst"); t.innerHTML = "";
  const w = ident("FRBRWork"), e = ident("FRBRExpression");
  const alias = kid(w, "FRBRalias");
  const prof = Array.from(meta().getElementsByTagNameNS(BNL, "profile"))[0];
  const ro = S.mode !== "edit";
  const titleIn = h("input", { value: alias ? alias.getAttribute("value") : "", disabled: ro || !!(S.stages && S.stages.entries.length) });
  titleIn.addEventListener("change", () => { snapshot(); alias.setAttribute("value", titleIn.value); $("#doctitle").textContent = titleIn.value; changed(false); });
  t.append(h("h3", {}, "Instrument"),
    h("label", {}, "Title", titleIn),
    h("div", { class: "kv" },
      h("span", { class: "k" }, "Type"), h("span", {}, ln(docEl())),
      h("span", { class: "k" }, "Work"), h("span", { class: "mono" }, workUri()),
      h("span", { class: "k" }, "Expression"), h("span", { class: "mono" }, (kid(e, "FRBRuri") || { getAttribute: () => "" }).getAttribute("value")),
      h("span", { class: "k" }, "BNL"), h("span", {}, prof ? prof.getAttribute("version") : "not declared"),
      h("span", { class: "k" }, "Amendments"), h("span", {}, String(allMods().length))));

  const life = kid(meta(), "lifecycle");
  t.append(h("h3", {}, "Lifecycle"));
  if (!life || !kids(life).length) t.append(h("p", { class: "note" }, "No events yet. Authenticating a stage records one."));
  else kids(life).forEach(ev => t.append(h("div", { class: "kv" }, h("span", { class: "k" }, ev.getAttribute("date")),
    h("span", {}, refShowAs(ev.getAttribute("refersTo")) || ev.getAttribute("eId")))));

  if (allMods().length) {
    t.append(h("h3", {}, "All amendments made"));
    allMods().forEach(m => {
      const src = (kid(m, "source") || { getAttribute: () => "" }).getAttribute("href").slice(1);
      const c = modCard(m, true);
      c.style.cursor = "pointer";
      c.addEventListener("click", () => { const el = byEid(src); if (el) { tab("prov"); select(el, true); } });
      t.append(c);
    });
  }

  if (S.base) {
    t.append(h("h3", {}, "Amendments"),
      h("p", { class: "note" }, "This is a mark-up: a copy of the Act to edit until it reads as the Act should after amendment. " +
        "Change words, add provisions (they take inserted numbers like 8A and (1A)), delete what is to be omitted. " +
        "The Act itself is not changed."),
      h("div", { class: "btns" }, h("button", { onclick: showChanges }, "Show changes"),
        h("button", { onclick: makeAmendingBill }, "Generate the amending Bill")));
    // or as a Part of the Schedule of a Bill that amends several enactments
    const pick = h("select", {}, h("option", { value: "" }, "A new Bill…"));
    const title = h("input", { placeholder: "The Data Laws (Amendment) Bill, 2026" });
    const titleRow = h("label", {}, "Title of the new Bill", title);
    pick.addEventListener("change", () => { titleRow.hidden = !!pick.value; });
    api("instruments").then(items => items.filter(i => i.type === "bill").forEach(i => pick.append(h("option", { value: i.id }, i.title))));
    t.append(h("h3", {}, "Amendments in a Schedule"),
      h("p", { class: "note" }, "For a Bill that amends several Acts: these amendments go into its Schedule as a Part for this Act " +
        "(\u201cThe enactments specified in the Schedule shall be amended in the manner specified therein.\u201d). " +
        "Adding the same mark-up again remakes its Part."),
      h("label", {}, "Bill", pick), titleRow,
      h("div", { class: "btns" }, h("button", { onclick: () => addToScheduleOf(pick.value, title.value) }, "Add to the Schedule")));
  } else if (ln(docEl()) === "bill" && S.explain) {
    const X = S.explain, sor = X.attachmentOf(S.doc, X.SOR), noc = X.attachmentOf(S.doc, X.NOC);
    t.append(h("h3", {}, "Why the Bill is needed"),
      h("p", { class: "note" }, "An Indian Bill carries, after its text, a Statement of Objects and Reasons (why the law is needed and what " +
        "it does, signed by the Minister) and Notes on Clauses (what each clause provides and why). Both are published with the Bill."),
      ro ? null : h("div", { class: "btns" },
        h("button", { onclick: makeStatement }, sor ? "Go to the Statement of Objects and Reasons" : "Begin the Statement of Objects and Reasons"),
        h("button", { onclick: makeNotes }, noc ? "Update the Notes on Clauses" : "Begin the Notes on Clauses")),
      noc ? h("p", { class: "note" }, "Each clause's note is also in the Provision tab when you select the clause. Notes follow their clauses when " +
        "clauses are moved or renumbered, and go when a clause is deleted. A clause without a note is shown as a warning (ED-12).") : null);
  } else if (ln(docEl()) === "act") {
    t.append(h("h3", {}, "Amend this Act"),
      h("p", { class: "note" }, "Make a mark-up: a copy of this Act that you edit as it should read after amendment. " +
        "The editor then writes the amending Bill, section by section, in the form Parliament passes."),
      h("div", { class: "btns" }, h("button", { onclick: startMarkup }, "Mark up for amendment")));
  }
  t.append(h("h3", {}, "Identifiers"));
  t.append(h("p", { class: "note" }, "Identifiers are permanent names for provisions. New provisions get one when you save; existing ones never change by themselves. While a Bill is still a draft you can regenerate them all from the current numbers."));
  if (!ro) t.append(h("div", { class: "btns" }, confirmButton("Update IDs from numbers", renumberIds)));
  if (!ro && ln(docEl()) === "bill" && !(S.stages && S.stages.entries && S.stages.entries.length)) {
    const cb = h("input", { type: "checkbox" }); cb.checked = autoRenumberOn();
    cb.addEventListener("change", () => { try { localStorage.setItem("bnl-renumber-" + S.id, cb.checked ? "on" : "off"); } catch (e) {} });
    t.append(h("label", { class: "check" }, cb, " Renumber automatically: adding, moving or deleting a provision renumbers the ones after it and corrects references to them."));
  }
  t.append(h("h3", {}, "File"));
  t.append(h("div", { class: "btns" }, h("button", { onclick: downloadXml }, "Download XML")));
}
async function downloadXml() {
  await save(true);
  const xml = await api("i/" + S.id);
  const a = h("a", { href: URL.createObjectURL(new Blob([xml], { type: "application/xml" })), download: S.id + ".xml" });
  document.body.append(a); a.click(); a.remove();
  S.downloaded = true;
}
/* ---------------------------------------------------------------- objects and reasons, notes on clauses */

function goToAttachment(att) {
  renderAll();
  const w = att && $(`#page section.attachment[data-eid="${CSS.escape(att.getAttribute("eId") || "")}"]`);
  if (w) w.scrollIntoView({ block: "start", behavior: "smooth" });
}
function makeStatement() {
  const had = S.explain.attachmentOf(S.doc, S.explain.SOR);
  if (!had) { snapshot(); S.explain.makeStatement(S.doc); changed(true); toast("Statement begun. Paragraphs 1 and 2 are for why the law is needed; paragraph 3 lists what it provides, from the chapters.", 8000); }
  goToAttachment(S.explain.attachmentOf(S.doc, S.explain.SOR));
}
function makeNotes() {
  snapshot();
  const r = S.explain.updateNotes(S.doc);
  changed(true);
  toast(r.added || r.removed ? `${r.added} note${r.added === 1 ? "" : "s"} begun${r.removed ? `, ${r.removed} removed (their clauses are gone)` : ""}. ` +
    "Each starts with what the clause provides; add why it is needed." : "Every clause has a note.", 8000);
  goToAttachment(r.att);
}
/* The note on a clause, in the Provision tab: what it provides and why it is there. */
function noteBox(x, ro) {
  const X = S.explain; if (!X || ln(x) !== "section" || ln(docEl()) !== "bill" || !up(x, ["body"])) return null;
  const note = X.noteFor(S.doc, x.getAttribute("eId"));
  const box = h("div", {}, h("h3", {}, "Note on this clause"));
  if (!note) {
    box.append(h("p", { class: "note" }, "No note yet: say what this clause provides and why it is needed. It is published in the Notes on Clauses."));
    if (!ro) box.append(h("div", { class: "btns" }, h("button", { onclick: () => {
      snapshot(); X.addNote(S.doc, x); changed(true); renderAll(); select(x); setTimeout(() => { const ta = $("#tab-prov textarea.noteta"); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }, 50);
    } }, "Add a note")));
    return box;
  }
  const content = kid(note, "content");
  const ta = h("textarea", { class: "noteta", rows: 6, disabled: ro });
  ta.value = content ? kids(content).filter(p => ln(p) === "p").map(p => p.textContent).join("\n\n") : "";
  ta.addEventListener("change", () => {
    snapshot();
    let c = kid(note, "content"); if (!c) { c = mk("content"); note.appendChild(c); }
    while (c.firstChild) c.removeChild(c.firstChild);
    const paras = ta.value.split(/\n\s*\n/).map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    (paras.length ? paras : [""]).forEach(s => c.appendChild(mk("p", s)));
    changed(true); renderAll(); select(x);
  });
  box.append(ta, h("div", { class: "btns" },
    h("button", { class: "ghost", onclick: () => { const blk = note._h; if (blk) { blk.scrollIntoView({ block: "center", behavior: "smooth" }); } } }, "Show in the Notes on Clauses")));
  return box;
}

/* ---------------------------------------------------------------- publication */

/* Save keeps the draft. Publish turns the saved, checked text into what the public reads: a web page,
   the same page as a PDF, and the BNL XML both are made from. A document with errors is not published. */
function saveFile(name, data, type) {
  const a = h("a", { href: URL.createObjectURL(new Blob([data], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}
async function openPublish() {
  if (!S.doc || S.view) return;
  const dlg = $("#pubdlg"), b = $("#pubbody");
  b.innerHTML = ""; b.append(h("h2", {}, "Publish"), h("p", { class: "note" }, "Saving and checking…"));
  if (!dlg.open) dlg.showModal();
  await save(true);
  let P, xml, d, sha;
  try {
    P = await import("./engine/publish.js");
    xml = await api("i/" + S.id);
    d = P.describe(parseXml(xml));
    sha = await P.sha256(xml);
  } catch (e) { b.append(h("p", { class: "err" }, "Could not prepare the publication: " + e.message)); return; }
  const today = new Date().toISOString().slice(0, 10);
  const names = { xml: d.base + ".xml", html: d.base + ".html" };
  const page = (extra = {}) => P.toHtml(xml, { xmlName: names.xml, sha, published: today, ...extra });
  const errors = S.checks.filter(c => c.level === "error"), warnings = S.checks.filter(c => c.level === "warning");
  const blocked = errors.length > 0;
  const row = (title, about, ...btns) => h("div", { class: "pubrow" },
    h("div", {}, h("b", {}, title), h("p", { class: "note" }, about)), h("div", { class: "pubbtns" }, ...btns));
  const btn = (label, fn, primary) => h("button", { class: primary ? "primary" : "", disabled: blocked, onclick: fn }, label);
  b.innerHTML = "";
  b.append(
    h("div", { class: "pubhead" }, h("h2", {}, "Publish"), h("button", { class: "ghost", onclick: () => dlg.close() }, "Close")),
    h("p", {}, h("b", {}, d.title), h("br"), h("span", { class: "mono note" }, d.expression || "")),
    blocked ? h("div", { class: "pubwarn err" }, `${errors.length} error${errors.length > 1 ? "s" : ""} must be fixed before this can be published. `,
        h("button", { onclick: () => { dlg.close(); tab("checks"); } }, "Show the checks"))
      : h("div", { class: "pubwarn ok" }, "Valid BNL. " + (warnings.length ? `${warnings.length} warning${warnings.length > 1 ? "s" : ""} to review; they do not stop publication.` : "No warnings.")),
    problems().length ? h("div", { class: "publist" }, ...problems().slice(0, 30).map(c =>
      h("div", { class: "chk " + c.level, title: "Go to it", onclick: () => { dlg.close(); goToCheck(c); } },
        h("span", { class: "code" }, c.code), c.message, h("span", { class: "go" }, "Go to it →")))) : null,
    row("Web page", "A page anyone can read in a browser: contents, links between provisions, and a link to every provision (…html#sec_14__subsec_2).",
      btn("Preview", () => {
        const xmlUrl = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
        window.open(URL.createObjectURL(new Blob([page({ xmlHref: xmlUrl })], { type: "text/html" })), "_blank");
      }),
      btn("Download .html", () => saveFile(names.html, page(), "text/html"), true)),
    row("PDF", "The same page laid out on A4 with page numbers. In the print window choose Save as PDF.",
      btn("Save PDF…", () => {
        const f = h("iframe", { style: "position:fixed;width:0;height:0;border:0;right:0;bottom:0" });
        f.srcdoc = page({ title: d.base });
        f.onload = () => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 60000); };
        document.body.append(f);
      }, true)),
    row("BNL XML", "The machine-readable text (Akoma Ntoso with the BNL attributes) that the page and the PDF are made from.",
      btn("Download .xml", () => saveFile(names.xml, xml, "application/xml"), true)),
    h("p", { class: "note" }, "To put it online, upload the .html and the .xml to the same folder of any website: the page links to the XML. " +
      "The page and the PDF give the XML's SHA-256, so anyone can check they carry the same text:"),
    h("p", { class: "mono note sha" }, sha));
}
$("#publish").addEventListener("click", openPublish);
$("#status").addEventListener("click", e => { if (problems().length) nextProblem(e.shiftKey); });
document.addEventListener("keydown", e => {
  if (e.key === "F8" && !$("#editor").hidden) { e.preventDefault(); nextProblem(e.shiftKey); }
});

function refShowAs(ref) { const refs = kid(meta(), "references"); if (!refs || !ref) return ""; const r = kids(refs).find(c => "#" + c.getAttribute("eId") === ref); return r ? r.getAttribute("showAs") : ""; }
function byEid(eid) { if (!eid) return null; for (const el of S.doc.getElementsByTagName("*")) if (el.getAttribute("eId") === eid) return el; return null; }

async function startMarkup() {
  await save(true);
  try { const r = await api(`i/${S.id}/markup`, { method: "POST" }); location.hash = "#/i/" + r.id; toast("Mark-up made. Edit it as the Act should read; the Act itself stays as it is.", 5000); }
  catch (e) { toast(e.message, 5000); }
}
async function showChanges() {
  await save(true);
  const page = $("#page"); page.innerHTML = "";
  banner("Changes in this mark-up, against the Act as it stands.");
  page.append(diffView(S.base, S.doc));
  S.view = { saved: { doc: S.doc, mode: S.mode }, diff: true };
}
async function makeAmendingBill() {
  await save(true);
  if (!S.amend) { toast("The Bill generator did not load."); return; }
  let res;
  try { res = S.amend.generate(S.base, S.doc); } catch (e) { toast("Could not write the Bill: " + e.message, 8000); console.error(e); return; }
  if (!res.changes) { toast("The mark-up says the same as the Act: there is nothing to amend."); return; }
  const xml = S.akn.serialize(res.doc);
  const r = await api("open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: S.bill.slug(res.title), xml }) });
  toast(`${res.title}: ${res.changes} amendment${res.changes > 1 ? "s" : ""}.`, 5000);
  location.hash = "#/i/" + r.id;
}
async function addToScheduleOf(billId, title) {
  await save(true);
  if (!S.amend) { toast("The Bill generator did not load."); return; }
  try {
    let id = billId, doc;
    if (id) doc = parseXml(await api("i/" + id));
    else {
      if (!title.trim()) { toast("Give the new Bill a title."); return; }
      doc = S.amend.scheduleBill(title.trim());
    }
    const res = S.amend.addToSchedule(doc, S.base, S.doc, { markupId: S.id });
    if (!res.changes) { toast("The mark-up says the same as the Act: there is nothing to amend."); return; }
    const xml = S.akn.serialize(doc);
    if (id) await api("i/" + id, { method: "PUT", headers: { "Content-Type": "application/xml" }, body: xml });
    else id = (await api("open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: S.bill.slug(title), xml }) })).id;
    toast(`${res.part} of the Schedule: ${res.changes} amendment${res.changes > 1 ? "s" : ""}.`, 5000);
    location.hash = "#/i/" + id;
  } catch (e) { toast("Could not add to the Schedule: " + e.message, 8000); console.error(e); }
}
async function renumberIds() {
  await save(true);
  try {
    const r = await api(`i/${S.id}/renumber`, { method: "POST" });
    toast(`${Object.keys(r.renamed).length} identifiers updated.`);
    await load(S.id, true);
  } catch (e) { toast(e.message, 5000); }
}

/* ---------------------------------------------------------------- checks */

/* Errors and warnings in the order they come in the text, errors first. */
function problems() {
  const order = new Map(); let i = 0;
  for (const el of S.doc.getElementsByTagName("*")) { const e = el.getAttribute("eId"); if (e) order.set(e, i++); }
  const rank = { error: 0, warning: 1 };
  return S.checks.filter(c => c.level in rank)
    .sort((a, b) => rank[a.level] - rank[b.level] || (order.get(a.eId) ?? 1e9) - (order.get(b.eId) ?? 1e9) || (a.line || 0) - (b.line || 0));
}
/* Where a check points in the text: its provision, or for an amendment the provision that makes it. */
function checkTarget(c) {
  let el = byEid(c.eId);
  if (el && !provOf(el)) { const src = kid(el, "source"); el = src ? byEid((src.getAttribute("href") || "").slice(1)) : el; }
  if (!el && c.eId && c.eId.startsWith("deleted__")) return null;
  return el;
}
function goToCheck(c) {
  if (S.view) closeView();
  if (S.mode === "xml") { S.mode = "edit"; $$("#modes button").forEach(z => z.classList.toggle("on", z.dataset.mode === "edit")); renderAll(); }
  const el = checkTarget(c), p = el && provOf(el);
  S.curCheck = c;
  $$(".chk.cur").forEach(r => r.classList.remove("cur"));
  if (p) {
    tab("prov"); select(p, true);
    if (p._h) { p._h.classList.remove("flash"); void p._h.offsetWidth; p._h.classList.add("flash"); }
    // a reference to something deleted: put the cursor on it
    const bad = p._h && $('a.ref[title^="#deleted__"]', p._h);
    if (bad && c.code === "BNL-8") { const r = document.createRange(); r.selectNodeContents(bad); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    return true;
  }
  if (el && meta().contains(el)) { tab("inst"); toast(`${c.code}: this is in the instrument's details (the Instrument tab), not the text.`, 6000); return true; }
  if (el && el._h) { el._h.scrollIntoView({ block: "center", behavior: "smooth" }); return true; }
  tab("checks");
  toast(c.line ? `${c.code} is at line ${c.line} of the XML. Open the XML view to see it.` : `${c.code} is about the document as a whole.`, 6000);
  return false;
}
/* The status badge and F8 step through the problems; Shift steps back. */
function nextProblem(back) {
  const list = problems();
  if (!list.length) { toast("No errors or warnings."); return; }
  let i = S.curCheck ? list.findIndex(c => c.code === S.curCheck.code && c.eId === S.curCheck.eId && c.message === S.curCheck.message) : -1;
  i = i < 0 ? (back ? list.length - 1 : 0) : (i + (back ? -1 : 1) + list.length) % list.length;
  const c = list[i];
  goToCheck(c);
  toast(`${c.level === "error" ? "Error" : "Warning"} ${i + 1} of ${list.length} · ${c.code}: ${plainMessage(c, provOf(checkTarget(c)))}`, 9000);
}
/* A check's message, said about this place where that helps. */
function plainMessage(c, p) {
  if (c.code === "BNL-8" && p && p._h) {
    const bad = $$('a.ref[title^="#deleted__"]', p._h).map(a => `“${a.textContent}”`);
    if (bad.length) return `${bad.join(", ")} refers to a provision that has been deleted. Click in it and press Cross-reference (⌘K) to point it somewhere else, or delete the words.`;
  }
  return c.message;
}
function checkRow(c) {
  const where = c.eId ? c.eId : c.line ? "line " + c.line : "";
  return h("div", { class: "chk " + c.level, title: "Go to it", onclick: () => goToCheck(c) },
    h("span", { class: "code" }, c.code), c.message, where ? h("div", { class: "where mono" }, where) : null);
}
function renderChecks() {
  const t = $("#tab-checks"); t.innerHTML = "";
  const by = { error: 0, warning: 0, finding: 0, info: 0 };
  S.checks.forEach(c => by[c.level]++);
  t.append(h("div", { class: "counts" }, ...Object.entries(by).map(([k, v]) => h("span", {}, `${v} ${k}${v === 1 ? "" : "s"}`))),
    h("p", { class: "note" }, `Every save runs the Akoma Ntoso 3.0 schema (AKN), the BNL ${S.spec.version} rulebook (BNL-n) and the editor's own checks (ED-n). Errors stop authentication; warnings do not.`),
    h("div", { class: "btns" }, h("button", { onclick: async () => { await save(true); renderChecks(); } }, "Save and check now")));
  if (!S.checks.length) t.append(h("p", { class: "status ok" }, "Valid BNL. No problems found."));
  const probs = problems();
  if (probs.length) t.append(h("div", { class: "btns" },
    h("button", { onclick: () => nextProblem(true), title: "Shift-F8" }, "↑ Previous"),
    h("button", { onclick: () => nextProblem(false), title: "F8" }, "↓ Next problem")));
  [...probs, ...S.checks.filter(c => !probs.includes(c))].forEach(c => t.append(checkRow(c)));
}
function markChecks() {
  $$("#page .prov.has-error, #page .prov.has-warning").forEach(e => e.classList.remove("has-error", "has-warning"));
  $$("#page .issue").forEach(e => e.remove());
  for (const c of S.checks) {
    if (!c.eId || !(c.level === "error" || c.level === "warning")) continue;
    const el = checkTarget(c);
    const p = el && provOf(el);
    if (p && p._h) {
      p._h.classList.add(c.level === "error" ? "has-error" : "has-warning");
      // the problem is said where it is, under the provision's number and heading
      const note = h("div", { class: "issue " + c.level, contenteditable: "false", title: "Show it in Checks",
        onclick: () => { tab("checks"); } }, h("b", {}, c.code), " ", plainMessage(c, p));
      const hd = $(":scope > .hd", p._h);
      if (hd) hd.after(note); else p._h.prepend(note);
    }
  }
  const n = S.checks.filter(c => c.level === "error").length, w = S.checks.filter(c => c.level === "warning").length;
  const cc = $("#checkcount"); cc.textContent = n ? `(${n})` : w ? `(${w})` : ""; cc.className = n ? "err" : "";
}
function setStatus(kind, text) { const s = $("#status"); s.className = "status " + kind; s.textContent = text; }
function markupChecks(list) {
  if (!S.base) return list;
  return list.map(c => c.code === "BNL-1" ? { ...c, level: "info", message: c.message + " (In a mark-up, new provisions come into force with the amending Act.)" } : c);
}
function statusFromChecks() {
  const n = S.checks.filter(c => c.level === "error").length, w = S.checks.filter(c => c.level === "warning").length;
  if (n) setStatus("err", `${n} error${n > 1 ? "s" : ""}${w ? ` · ${w} warning${w > 1 ? "s" : ""}` : ""} ›`);
  else if (w) setStatus("warn", `Valid BNL · ${w} warning${w > 1 ? "s" : ""} ›`);
  else setStatus("ok", "Valid BNL");
  $("#status").title = n || w ? "Go to the next problem (F8; Shift goes back)" : "";
  $("#status").classList.toggle("go", !!(n || w));
}

/* ---------------------------------------------------------------- stages (Chapter V) */

async function renderStages() {
  const t = $("#tab-stages"); t.innerHTML = "";
  try { S.stages = await api(`i/${S.id}/stages`); } catch (e) { t.append(h("p", {}, e.message)); return; }
  const { entries, verify } = S.stages;
  t.append(h("h3", {}, "Authenticated stages"),
    h("p", { class: "note" }, "Each stage fixes the text as it stood: the file is kept read-only with its SHA-256, and each entry carries the hash of the one before, so no entry can be changed or removed without breaking the chain. Officers are recorded by name; electronic signatures come next."));
  if (!entries.length) t.append(h("p", { class: "note" }, "None yet."));
  entries.forEach(e => {
    const v = verify.find(z => z.n === e.n) || {};
    t.append(h("div", { class: "stage" },
      h("div", {}, h("b", {}, `${e.n}. ${e.label}`), " ", v.ok ? h("span", { class: "ok" }, "✓ verified") : h("span", { class: "bad" }, "✗ " + (v.problems || []).join("; "))),
      h("div", { class: "note" }, `${e.date} · ${e.officer} · BNL ${e.bnl}`),
      h("div", { class: "mono note" }, e.sha256),
      h("div", { class: "btns" }, h("button", { onclick: () => showStage(e) }, "Read"), h("button", { onclick: () => compareStage(e) }, "Compare with the current draft"))));
  });
  if (S.mode === "edit") {
    const f = h("form", { class: "card" });
    const stage = selectOf(Object.entries(S.spec.stages), "vetted", () => {}, false);
    const officer = h("input", { placeholder: "Name and designation", required: true });
    const date = h("input", { type: "date", value: new Date().toISOString().slice(0, 10) });
    f.append(h("h2", {}, "Authenticate this text"), h("label", {}, "Stage", stage), h("label", {}, "Authenticating officer", officer),
      h("label", {}, "Date", date), h("p", { class: "note" }, "Refused if the instrument has any error."),
      h("div", { class: "row" }, h("span"), h("button", { class: "primary" }, "Authenticate")));
    f.addEventListener("submit", async ev => {
      ev.preventDefault();
      await save(true);
      try {
        const r = await api(`i/${S.id}/authenticate`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage: stage.value, officer: officer.value, date: date.value }) });
        toast(`Authenticated: ${r.entry.label}.`);
        await load(S.id, true); tab("stages");
      } catch (e) {
        if (e.body && e.body.checks) { S.checks = e.body.checks; markChecks(); statusFromChecks(); tab("checks"); }
        toast(e.message, 5000);
      }
    });
    t.append(f);
  }
}
async function showStage(e) {
  const xml = await api(`i/${S.id}/stages/${e.n}`);
  S.view = { stage: e, saved: { doc: S.doc, mode: S.mode } };
  S.doc = parseXml(xml); S.mode = "read";
  banner(`Reading the text authenticated at stage ${e.n}: ${e.label} (${e.date}). Read only.`);
  renderAll(); select(null);
}
async function compareStage(e) {
  await flush();
  const old = parseXml(await api(`i/${S.id}/stages/${e.n}`));
  const page = $("#page"); page.innerHTML = "";
  banner(`Changes since stage ${e.n}: ${e.label} (${e.date}).`);
  page.append(diffView(old, S.doc));
  S.view = { stage: e, saved: { doc: S.doc, mode: S.mode }, diff: true };
}
function banner(text) {
  const b = $("#banner"); b.innerHTML = ""; b.hidden = false;
  b.append(h("span", {}, text), h("span", { class: "spacer" }), h("button", { onclick: closeView }, "Back to the draft"));
}
function closeView() {
  if (S.view) { S.doc = S.view.saved.doc; S.mode = S.view.saved.mode; S.view = null; }
  $("#banner").hidden = true; renderAll(); select(S.sel);
}

/* provision-level comparison */
function provTexts(doc) {
  const out = new Map();
  for (const el of doc.getElementsByTagNameNS(AKN, "*")) {
    if (!HIER.has(el.localName) || !el.getAttribute("eId")) continue;
    if (el.closest && el.closest("meta")) continue;
    let s = "";
    const own = n => { for (const c of n.childNodes) { if (c.nodeType === 3) s += c.nodeValue; else if (c.nodeType === 1 && !HIER.has(c.localName)) own(c); } };
    own(el);
    out.set(el.getAttribute("eId"), s.replace(/\s+/g, " ").trim());
  }
  return out;
}
function wordDiff(a, b) {
  const A = a.split(" "), B = b.split(" ");
  if (A.length * B.length > 400000) return [["del", a], ["ins", b]];
  const dp = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  const push = (k, w) => { if (out.length && out[out.length - 1][0] === k) out[out.length - 1][1] += " " + w; else out.push([k, w]); };
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { push("eq", A[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push("del", A[i++]); else push("ins", B[j++]);
  }
  while (i < A.length) push("del", A[i++]); while (j < B.length) push("ins", B[j++]);
  return out;
}
function humanName(eid) {
  if (/^sched_/.test(eid)) return eid.replace(/^sched_(\d+)/, "Schedule $1").replace(/__para_/g, ", paragraph ").replace(/__/g, " ");
  if (/^(chp|part)_/.test(eid)) return eid.replace(/^chp_/, "Chapter ").replace(/^part_/, "Part ");
  return describeProv("x/~" + eid) || eid;
}
function diffView(oldDoc, newDoc) {
  const a = provTexts(oldDoc), b = provTexts(newDoc);
  const d = h("div", { class: "diff" });
  let n = 0;
  for (const [eid, t] of b) {
    if (!a.has(eid)) { d.append(h("div", { class: "d added" }, h("div", { class: "lbl" }, humanName(eid) + " · added"), h("ins", {}, t))); n++; }
    else if (a.get(eid) !== t) {
      const row = h("div", { class: "d changed" }, h("div", { class: "lbl" }, humanName(eid) + " · changed"));
      const body = h("div");
      for (const [k, w] of wordDiff(a.get(eid), t)) body.append(k === "eq" ? w + " " : h(k, {}, w), k === "eq" ? "" : " ");
      row.append(body); d.append(row); n++;
    }
  }
  for (const [eid, t] of a) if (!b.has(eid)) { d.append(h("div", { class: "d removed" }, h("div", { class: "lbl" }, humanName(eid) + " · removed"), h("del", {}, t))); n++; }
  if (!n) d.append(h("p", {}, "No change in the text of any provision."));
  return d;
}

/* ---------------------------------------------------------------- structural editing */

function renameEl(x, name) {
  if (ln(x) === name) return x;
  const n = mk(name);
  // the same provision under another kind: it keeps its identifier, so references to it follow it
  for (const a of Array.from(x.attributes)) n.setAttributeNode(a.cloneNode());
  if (name === "hcontainer" && !n.getAttribute("name")) n.setAttribute("name", "explanation");
  if (name !== "hcontainer") n.removeAttribute("name");
  while (x.firstChild) n.appendChild(x.firstChild);
  x.parentNode.replaceChild(n, x);
  return n;
}
function newProv(kind, num, text) {
  const x = mk(kind); x.setAttribute("eId", newTmp());
  if (kind === "hcontainer") x.setAttribute("name", "explanation");
  if (kind !== "proviso") x.appendChild(mk("num", num || ""));
  if (GROUP.has(kind) || kind === "section") x.appendChild(mk("heading", ""));
  if (!GROUP.has(kind)) { const c = mk("content"); c.appendChild(mk("p", text || "")); x.appendChild(c); }
  return x;
}
function contentToIntro(x) {
  const c = kid(x, "content"); if (!c) return;
  const intro = mk("intro"); while (c.firstChild) intro.appendChild(c.firstChild);
  x.replaceChild(intro, c);
}
function introToContent(x) {
  if (hierKids(x).length) return;
  const intro = kid(x, "intro"), wu = kid(x, "wrapUp");
  if (!intro && !wu) { if (!kid(x, "content") && !GROUP.has(ln(x))) { const c = mk("content"); c.appendChild(mk("p", "")); x.appendChild(c); } return; }
  const c = mk("content");
  for (const part of [intro, wu]) if (part) { while (part.firstChild) c.appendChild(part.firstChild); part.remove(); }
  x.appendChild(c);
}
function insertChild(parent, child, before) {
  const wu = kid(parent, "wrapUp");
  parent.insertBefore(child, before || wu || null);
}
/* In a mark-up of an Act, a provision put between two others takes an inserted number (8A, (1A), (ba)),
   as an amending Act would give it; one added at the end takes the next number. */
function siblingNum(x, kind) {
  if (kind === "proviso" || kind === "hcontainer") return "";
  const prev = txt(kid(x, "num"));
  let nx = x.nextElementSibling; while (nx && ln(nx) !== kind) nx = nx.nextElementSibling;
  if (!nx && (kind === "section" || GROUP.has(kind))) {      // these run on through the whole Act
    const all = Array.from(docEl().getElementsByTagNameNS(AKN, kind));
    nx = all[all.indexOf(x) + 1] || null;
  }
  if (S.base && nx && S.amend) return S.amend.insertedNum(prev) || nextNum(prev, kind);
  return nextNum(prev, kind);
}
function addSibling(x, text) {
  snapshot();
  const kind = ln(x);
  const n = newProv(kind, siblingNum(x, kind), text);
  x.parentNode.insertBefore(n, x.nextSibling);
  structural(n);
  return n;
}
function addSiblingBefore(x) {
  snapshot();
  const kind = ln(x);
  const n = newProv(kind, kind === "proviso" || kind === "hcontainer" ? "" : txt(kid(x, "num")), "");
  x.parentNode.insertBefore(n, x);
  structural(n);
  return n;
}
function addChild(x) {
  snapshot();
  const kind = CHILD_KIND[ln(x)] || "clause";
  const last = hierKids(x).filter(c => ln(c) === kind).pop();
  const n = newProv(kind, last ? nextNum(txt(kid(last, "num")), kind) : FIRST_NUM[kind]);
  if (!GROUP.has(ln(x))) contentToIntro(x);
  insertChild(x, n);
  structural(n);
}
function addSpecial(x, what) {
  snapshot();
  let n;
  if (what === "proviso") { n = mk("proviso"); n.setAttribute("eId", newTmp()); const c = mk("content"); c.appendChild(mk("p", "Provided that ")); n.appendChild(c); }
  else { n = mk("hcontainer"); n.setAttribute("eId", newTmp()); n.setAttribute("name", "explanation"); n.appendChild(mk("heading", "Explanation.—")); const c = mk("content"); c.appendChild(mk("p", "")); n.appendChild(c); }
  if (!GROUP.has(ln(x))) contentToIntro(x);
  insertChild(x, n);
  structural(n);
}
function demote(x) {
  let prev = x.previousElementSibling;
  while (prev && !HIER.has(ln(prev))) prev = prev.previousElementSibling;
  if (!prev || ["proviso", "hcontainer"].includes(ln(prev))) { toast("Nothing above to indent under."); return; }
  snapshot();
  const kind = CHILD_KIND[ln(prev)] || "clause";
  const last = hierKids(prev).filter(c => ln(c) === kind).pop();
  if (!GROUP.has(ln(prev))) contentToIntro(prev);
  let nx = renameEl(x, kind);
  const num = kid(nx, "num");
  if (num) num.textContent = last ? nextNum(txt(kid(last, "num")), kind) : FIRST_NUM[kind];
  if (kind !== "section" && !GROUP.has(kind)) { const hd = kid(nx, "heading"); if (hd && !txt(hd)) hd.remove(); }
  insertChild(prev, nx);
  structural(nx);
}
function promote(x) {
  const parent = x.parentNode;
  if (!parent || !HIER.has(ln(parent)) || GROUP.has(ln(parent))) { toast("This is already at the top level."); return; }
  snapshot();
  const nx = renameEl(x, ln(parent));
  const num = kid(nx, "num");
  if (num) num.textContent = nextNum(txt(kid(parent, "num")), ln(parent));
  parent.parentNode.insertBefore(nx, parent.nextSibling);
  if ((ln(nx) === "section") && !kid(nx, "heading")) nx.insertBefore(mk("heading", ""), num ? num.nextSibling : nx.firstChild);
  introToContent(parent);
  structural(nx);
}
function move(x, dir) {
  let sib = dir < 0 ? x.previousElementSibling : x.nextElementSibling;
  while (sib && !HIER.has(ln(sib))) sib = dir < 0 ? sib.previousElementSibling : sib.nextElementSibling;
  if (!sib) return;
  snapshot();
  if (dir < 0) x.parentNode.insertBefore(x, sib); else x.parentNode.insertBefore(x, sib.nextSibling);
  structural(x);
}
function removeProv(x) {
  snapshot();
  const parent = x.parentNode;
  let next = x.previousElementSibling || x.nextElementSibling;
  // amendments made by this provision go with it
  const eid = x.getAttribute("eId");
  modsFrom(eid).forEach(m => m.remove());
  // References to what is deleted must not slide onto whatever takes its number: they are marked,
  // and the check BNL-8 lists them until the words are rewritten.
  const gone = new Set([x, ...x.getElementsByTagName("*")].map(e => e.getAttribute("eId")).filter(Boolean));
  let broken = 0;
  for (const r of Array.from(S.doc.getElementsByTagNameNS(AKN, "ref"))) {
    const href = r.getAttribute("href") || "";
    if (href[0] !== "#" || !gone.has(href.slice(1)) || x.contains(r)) continue;
    const note = up(r, ["hcontainer"]);
    if (note && note.getAttribute("name") === "noteOnClause") { note.remove(); continue; }   // its note goes with the clause
    r.setAttribute("href", "#deleted__" + href.slice(1)); broken++;
  }
  if (broken) setTimeout(() => toast(`${broken} reference${broken > 1 ? "s" : ""} pointed at what you deleted: see Checks.`, 6000), 1200);
  x.remove();
  if (HIER.has(ln(parent))) introToContent(parent);
  structural(provOf(next) || (HIER.has(ln(parent)) ? parent : null));
}
/* Renumbering. In a draft Bill, adding, moving or removing a provision renumbers what follows, gives
   every provision the identifier its new number implies, and corrects the words of every reference
   to a provision whose number changed ("Section 2" becomes "Section 3"). Sections, chapters and parts
   run through the whole body; everything else, and everything in a Schedule, runs within its parent.
   Not once the Bill has been authenticated at a stage: identifiers are then permanent. */
function autoRenumberOn() {
  if (ln(docEl()) !== "bill") return false;
  if (S.stages && S.stages.entries && S.stages.entries.length) return false;
  try { return localStorage.getItem("bnl-renumber-" + S.id) !== "off"; } catch (e) { return true; }
}
function renumberAll() {
  const lists = new Map();                       // parent element (or "body") -> kind -> [elements]
  const push = (key, kind, el) => { if (!lists.has(key)) lists.set(key, new Map()); const m = lists.get(key);
    if (!m.has(kind)) m.set(kind, []); m.get(kind).push(el); };
  const walk = (el, inBody, topLevel) => {
    for (const c of kids(el)) {
      const name = ln(c);
      if (name === "meta") continue;
      if (name === "attachments" || name === "attachment") { walk(c, false, false); continue; }
      if (name === "body") { walk(c, true, true); continue; }
      if (HIER.has(name) && isAkn(c)) {
        if (name !== "proviso" && name !== "hcontainer" && kid(c, "num")) push(inBody && topLevel ? "body" : c.parentNode, name, c);
        walk(c, inBody, inBody && topLevel && GROUP.has(name));
      } else walk(c, inBody, topLevel);
    }
  };
  walk(docEl(), false, false);
  let changedNums = 0;
  for (const byKind of lists.values()) for (const [kind, els] of byKind) {
    const tmpl = txt(kid(els[0], "num"));
    els.forEach((el, i) => {
      const want = numAt(tmpl, kind, i + 1), num = kid(el, "num");
      if (want && txt(num) !== want) { num.textContent = want; changedNums++; }
    });
  }
  if (!S.akn) return { nums: changedNums, refs: 0 };
  const refs = Array.from(S.doc.getElementsByTagNameNS(AKN, "ref")).map(r => [r, r.getAttribute("href")]);
  S.akn.assignEids(S.doc, true);
  let refsFixed = 0;
  for (const [r, before] of refs) {
    const now = r.getAttribute("href");
    if (now && now !== before && now[0] === "#" && fixRefWords(r, byEid(now.slice(1)))) refsFixed++;
  }
  return { nums: changedNums, refs: refsFixed };
}
/* The numbers in a reference's words, innermost first ("clause (f) of sub-section (1) of Section 10"),
   set from the provision it points at. */
function fixRefWords(r, target) {
  if (!target || r.children.length) return false;
  const chain = [];
  for (let y = target; y && y.nodeType === 1 && HIER.has(ln(y)); y = y.parentNode) {
    if (GROUP.has(ln(y)) && y !== target) break;
    const n = kid(y, "num"); if (n) chain.push(S.akn.numToken(txt(n)));
  }
  let k = 0;
  const words = r.textContent.replace(/\(([0-9]+[A-Z]*|[a-zA-Z]{1,5})\)|\b([0-9]+[A-Z]*|[IVXLC]+)\b/g, (m, inP, bare) => {
    const t = chain[k++]; if (t === undefined) return m;
    return inP !== undefined ? `(${t})` : t;
  });
  if (words === r.textContent) return false;
  r.textContent = words;
  return true;
}
/* Link references as they are written: "Section 26", "clause (f) of sub-section (1) of Section 10",
   "this Chapter", "the Schedule", "section 70 of the Information Technology Act, 2000 (21 of 2000)".
   Not in the paragraph being typed in; it is linked when the caret leaves it. */
function autoLink() {
  if (!S.bill || !S.doc || S.view || S.mode !== "edit" || ln(docEl()) !== "bill") return 0;
  const typing = p => p._h && (p._h === document.activeElement || p._h.contains(document.activeElement));
  const changedPs = S.bill.linkRefs(S.doc, typing);
  for (const p of changedPs) if (p._h) { p._h.innerHTML = ""; inlineToHtml(p, p._h); }
  return changedPs.length;
}
function structural(focusX) {
  if (autoRenumberOn()) {
    const res = renumberAll();
    if (res.nums) toast(`Renumbered ${res.nums} provision${res.nums > 1 ? "s" : ""}` +
      (res.refs ? ` and corrected ${res.refs} reference${res.refs > 1 ? "s" : ""}.` : "."));
  }
  if (S.explain) S.explain.syncNotes(S.doc);      // notes in the order of their clauses
  changed(true);
  if (focusX) { S.scrolling = true; setTimeout(() => (S.scrolling = false), 60); }   // go to the new provision
  renderAll();
  if (focusX) {
    select(focusX, true);
    const p = focusX._h && $(".t[contenteditable], .num[contenteditable]", focusX._h);
    const target = focusX._h && (firstText(focusX._h) || p);
    if (target) placeCaret(target, false);
  }
}
function firstText(block) {
  return $(":scope > .hd > .cb .t[contenteditable], :scope > .cb .t[contenteditable]", block) || $(".t[contenteditable]", block);
}
function placeCaret(el, atEnd) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest" });
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(!atEnd);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}

/* ---------------------------------------------------------------- the toolbar: new provisions */

function up(x, names) { for (let y = x; y && y.nodeType === 1; y = y.parentNode) if (names.includes(ln(y))) return y; return null; }
/* The provision being worked in: where the cursor is, else the one selected. */
function here() {
  const a = document.activeElement, blk = a && a.closest && a.closest("#page .prov");
  return (blk && blk._x) || S.sel;
}
function addChildOf(x, kind) {
  snapshot();
  const last = hierKids(x).filter(c => ln(c) === kind).pop();
  const n = newProv(kind, last ? nextNum(txt(kid(last, "num")), kind) : FIRST_NUM[kind]);
  if (!GROUP.has(ln(x))) contentToIntro(x);
  insertChild(x, n);
  structural(n);
  return n;
}
function newSection() {
  const x = here();
  const sec = x && up(x, ["section"]);
  if (sec) return addSibling(sec);
  const grp = x && up(x, [...GROUP]);
  if (grp) return addChildOf(grp, "section");
  const body = kid(docEl(), "body");
  if (!body) { toast("This instrument has no body to add a section to."); return; }
  const secs = Array.from(body.getElementsByTagNameNS(AKN, "section"));
  if (secs.length) return addSibling(secs[secs.length - 1]);
  snapshot();
  const n = newProv("section", "1."); body.appendChild(n); structural(n); return n;
}
function newSubsection() {
  const x = here(), sec = x && up(x, ["section"]);
  if (!sec) { toast("Click in the section the sub-section belongs to."); return; }
  const sub = up(x, ["subsection"]);
  if (sub && sec.contains(sub)) return addSibling(sub);
  if (!hierKids(sec).length) {
    // A section of plain words: the words become sub-section (1), and the new one is (2).
    snapshot();
    const c = kid(sec, "content");
    const s1 = mk("subsection"); s1.setAttribute("eId", newTmp()); s1.appendChild(mk("num", "(1)"));
    if (c && txt(c)) {
      sec.replaceChild(s1, c); s1.appendChild(c);
      const s2 = newProv("subsection", "(2)"); insertChild(sec, s2); structural(s2); return s2;
    }
    if (c) c.remove();
    const cc = mk("content"); cc.appendChild(mk("p", "")); s1.appendChild(cc); insertChild(sec, s1);
    structural(s1); return s1;
  }
  return addChildOf(sec, "subsection");
}
function newClause() {
  const x = here();
  const cl = x && up(x, ["clause"]);
  if (cl) return addSibling(cl);
  const parent = x && (up(x, ["subsection", "subrule", "paragraph"]) || up(x, ["section", "rule", "article"]));
  if (!parent) { toast("Click in the sub-section the clause belongs to."); return; }
  if (hierKids(parent).some(c => ["subsection", "subrule"].includes(ln(c)))) { toast("Click in the sub-section the clause belongs to."); return; }
  return addChildOf(parent, "clause");
}

/* ---------------------------------------------------------------- cross-references */

/* Put the cursor in the text (or select the words to link), press Cross-reference or ⌘K, and choose the
   provision in the contents. The words follow Indian drafting: "clause (b) of sub-section (2) of
   section 14", leaving out what the reference sits in ("clause (b)" within the same sub-section). They are
   kept right by renumbering like every other reference. */
const REF_WORD = { section: "section", subsection: "sub-section", clause: "clause", subclause: "sub-clause", point: "item",
  paragraph: "paragraph", subparagraph: "sub-paragraph", rule: "rule", subrule: "sub-rule", article: "article", item: "item",
  chapter: "Chapter", part: "Part", subchapter: "Sub-Chapter", subpart: "Sub-Part" };
function capitalSection() {          // write "Section 5" if the document already does, else "section 5"
  let upper = 0, lower = 0;
  for (const r of S.doc.getElementsByTagNameNS(AKN, "ref")) { const t = r.textContent; if (/^Section\b/.test(t)) upper++; else if (/^section\b/.test(t)) lower++; }
  return upper > lower;
}
function refWords(target, from) {
  if (ln(target) === "attachment") return S.explain && !S.explain.isSchedule(target) ? txt(target.getElementsByTagNameNS(AKN, "p")[0]) : "the Schedule";
  const cap = capitalSection();
  const word = y => ln(y) === "section" && cap ? "Section" : (REF_WORD[ln(y)] || ln(y));
  const tok = y => { const n = txt(kid(y, "num")); const t = S.akn ? S.akn.numToken(n) : n.replace(/[^\w]/g, ""); return /^\(/.test(n) ? `(${t})` : t; };
  if (from && target.contains(from)) return `this ${word(target)}`;
  if (GROUP.has(ln(target))) return `${word(target)} ${tok(target)}`;
  const chain = [];
  for (let y = target; y && y.nodeType === 1 && HIER.has(ln(y)) && !GROUP.has(ln(y)); y = y.parentNode) {
    if (!numbered(y)) continue;
    if (y !== target && from && y.contains(from)) break;     // what the reference is written in is not named
    chain.push(`${word(y)} ${tok(y)}`);
  }
  return chain.join(" of ");
}
function textOffset(el, node, off) { const r = document.createRange(); r.setStart(el, 0); r.setEnd(node, off); return r.toString().length; }
function rangeAt(el, start, end) {
  const r = document.createRange(), w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let pos = 0, n, s = null;
  while ((n = w.nextNode())) {
    const len = n.nodeValue.length;
    if (!s && start <= pos + len) { r.setStart(n, start - pos); s = n; }
    if (s && end <= pos + len) { r.setEnd(n, end - pos); return r; }
    pos += len;
  }
  r.selectNodeContents(el); r.collapse(false); return r;
}
function startPick() {
  if (S.mode !== "edit" || S.view) return;
  const sel = getSelection(), r = sel.rangeCount ? sel.getRangeAt(0) : null;
  const node = r && (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode);
  const el = node && node.closest && node.closest("#page [contenteditable]");
  if (!el || !el._x) { toast("Click in the text where the reference goes (or select the words to link), then press Cross-reference."); return; }
  // in an existing reference: point it somewhere else (how a broken one is mended)
  const old = node.closest("a.ref");
  const repoint = old ? $$("a.ref", el).indexOf(old) : -1;
  S.pick = { p: el._x, start: textOffset(el, r.startContainer, r.startOffset), end: textOffset(el, r.endContainer, r.endOffset), words: r.toString(), repoint };
  if (old) $("#picknote b").textContent = "Choose what this reference should point to.";
  else $("#picknote b").textContent = "Choose what to refer to.";
  document.body.classList.add("picking", "contents");
  $("#picknote").hidden = false;
  const f = $("#ofind"); f.value = ""; renderOutline(); f.focus();
}
function endPick() {
  S.pick = null;
  document.body.classList.remove("picking", "contents");
  $("#picknote").hidden = true;
  if ($("#ofind").value) { $("#ofind").value = ""; renderOutline(); }
}
function insertRef(target) {
  const pk = S.pick; endPick();
  const el = pk && pk.p._h;
  if (!el || !el.isConnected) { toast("The place for the reference has gone. Click in the text and try again."); return; }
  const eid = target.getAttribute("eId");
  if (!eid) { toast("That provision has no identifier yet. Save, then try again."); return; }
  const from = provOf(pk.p);
  if (pk.repoint >= 0) {
    const old = $$("a.ref", el)[pk.repoint];
    if (old) {
      const words = refWords(target, from);
      old.dataset.attrs = JSON.stringify([[null, "href", "#" + eid]]); old.title = "#" + eid; old.textContent = words;
      syncEl(el); changed(false); markChecks();
      toast(`The reference now reads “${words}”.`);
      return;
    }
  }
  const words = pk.words.trim() ? pk.words : refWords(target, from);
  const r = rangeAt(el, pk.start, pk.end);
  if (!r.collapsed) r.deleteContents();
  const a = h("a", { class: "ref", "data-attrs": JSON.stringify([[null, "href", "#" + eid]]), title: "#" + eid }, words);
  r.insertNode(a);
  const before = a.previousSibling, after = a.nextSibling;
  if (before && before.nodeType === 3 && /[^\s(“‘—-]$/.test(before.nodeValue)) before.nodeValue += " ";
  let caretNode = a;
  if (after && after.nodeType === 3 && /^[\w(]/.test(after.nodeValue)) after.nodeValue = " " + after.nodeValue;
  else if (!after || (after.nodeType === 3 && after.nodeValue === "")) { caretNode = document.createTextNode(" "); a.after(caretNode); }
  syncEl(el); changed(false);
  el.focus({ preventScroll: true });
  const c = document.createRange(); c.setStartAfter(caretNode); c.collapse(true);
  const s = getSelection(); s.removeAllRanges(); s.addRange(c);
  el.scrollIntoView({ block: "nearest" });
  toast(`Linked “${words}” to ${citeOf(target) || "the Schedule"}.`);
}

for (const [id, fn] of [["#t-sec", newSection], ["#t-sub", newSubsection], ["#t-cl", newClause], ["#t-ref", startPick]]) {
  $(id).addEventListener("mousedown", e => e.preventDefault());      // keep the cursor where it is
  $(id).addEventListener("click", async () => { await flush(); fn(); });
}
$("#t-contents").addEventListener("click", () => document.body.classList.toggle("contents"));
$("#pickcancel").addEventListener("click", endPick);
$("#pagewrap").addEventListener("mousedown", e => { if (!S.pick && !e.target.closest("#tools")) document.body.classList.remove("contents"); });
$("#ofind").addEventListener("input", () => renderOutline());
$("#ofind").addEventListener("keydown", e => {
  if (e.key === "Escape") { e.preventDefault(); if (S.pick) endPick(); else { e.target.value = ""; renderOutline(); } }
  if (e.key === "Enter") { e.preventDefault(); const a = $("#otree a"); if (a) a.click(); }
  if (e.key === "ArrowDown") { e.preventDefault(); const a = $("#otree a"); if (a) a.focus(); }
});
$("#otree").addEventListener("keydown", e => {
  const a = e.target.closest("a"); if (!a) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const all = $$("#otree a"), i = all.indexOf(a), nx = all[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (nx) nx.focus(); else if (e.key === "ArrowUp") $("#ofind").focus();
  }
  if (e.key === "Escape" && S.pick) { e.preventDefault(); endPick(); }
});
document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !$("#editor").hidden) { e.preventDefault(); flush().then(startPick); }
  if (e.key === "Escape" && document.body.classList.contains("contents") && !S.pick) document.body.classList.remove("contents");
}, true);

$("#undo").addEventListener("click", () => {
  const prev = S.undo.pop(); if (!prev) return;
  const eid = S.sel && S.sel.getAttribute("eId");
  S.doc = parseXml(prev); changed(true); renderAll(); select(byEid(eid));
  if (!S.undo.length) $("#undo").hidden = true;
});

/* ---------------------------------------------------------------- typing */

document.addEventListener("input", e => {
  const el = e.target.closest && e.target.closest("[contenteditable]");
  if (!el || !$("#page").contains(el)) return;
  S.pending.add(el);
  changed(false);
});
document.addEventListener("focusin", e => {
  const blk = e.target.closest && e.target.closest(".prov");
  if (blk && blk._x && blk._x !== S.sel) select(blk._x, false);
});
document.addEventListener("paste", e => {
  const el = e.target.closest && e.target.closest("[contenteditable]");
  if (!el) return;
  e.preventDefault();
  const text = (e.clipboardData.getData("text/plain") || "").replace(/\s*\n\s*/g, " ");
  document.execCommand("insertText", false, text);
});
document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(true); return; }
  const el = e.target.closest && e.target.closest("#page [contenteditable]");
  if (!el || S.mode !== "edit") return;
  const prov = provOf(el._x || el._numOf || el._headOf || (el.closest(".prov") || {})._x);
  if (e.key === "Tab" && prov) { e.preventDefault(); syncEl(el); e.shiftKey ? promote(prov) : demote(prov); return; }
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && prov) { e.preventDefault(); syncEl(el); move(prov, e.key === "ArrowUp" ? -1 : 1); return; }
  if (e.key === "Enter") {
    e.preventDefault();
    if (el._numOf || el._headOf) { const t = prov && prov._h && firstText(prov._h); if (t) placeCaret(t, false); return; }
    if (!el._x) return;
    // split at the caret: Enter makes the next provision, Shift-Enter the next paragraph
    const r = getSelection().getRangeAt(0);
    // At the very start of a provision's text, Enter puts a new provision above it. The provision itself
    // (its identifier, and every reference to it) stays with its words.
    const head = document.createRange(); head.setStart(el, 0); head.setEnd(r.startContainer, r.startOffset);
    const parentBlock = el._x.parentNode;
    if (!e.shiftKey && !head.toString().trim() && el.textContent.trim() && prov && !GROUP.has(ln(prov)) &&
        parentBlock && ln(parentBlock) === "content" && el._x === kids(parentBlock)[0]) {
      syncEl(el);
      const n = addSiblingBefore(prov);
      const t = n._h && firstText(n._h); if (t) placeCaret(t, false);
      return;
    }
    const tail = document.createRange(); tail.setStart(r.endContainer, r.endOffset); tail.setEnd(el, el.childNodes.length);
    const frag = tail.extractContents();
    const holder = document.createElement("p"); holder.append(frag);
    syncEl(el);
    const container = el._x.parentNode;
    const inContent = container && ln(container) === "content" && prov && !GROUP.has(ln(prov));
    if (!e.shiftKey && inContent) {
      const n = addSibling(prov);
      const p = n.getElementsByTagNameNS(AKN, "p")[0];
      htmlToInline(holder, p); renderAll(); select(n, false);
      const t = n._h && firstText(n._h); if (t) placeCaret(t, false);
    } else {
      snapshot();
      const p = mk("p"); htmlToInline(holder, p);
      container.insertBefore(p, el._x.nextSibling);
      changed(true); renderAll();
      if (p._h) placeCaret(p._h, false);
    }
    return;
  }
  if (e.key === "Backspace" && el._x && !el.textContent && prov && !hierKids(prov).length) {
    const ps = prov.getElementsByTagNameNS(AKN, "p");
    if (ps.length === 1 && !txt(prov)) { e.preventDefault(); removeProv(prov); }
  }
});

function syncEl(el) {
  if (el._x) htmlToInline(el, el._x);
  else if (el._numOf) setChildText(el._numOf, "num", el);
  else if (el._headOf) setChildText(el._headOf, "heading", el);
  S.pending.delete(el);
}
function setChildText(x, name, el) {
  let c = kid(x, name);
  const empty = !el.textContent.trim();
  if (!c) {
    if (empty) return;
    c = mk(name);
    if (name === "num") x.insertBefore(c, x.firstChild);
    else { const num = kid(x, "num"); x.insertBefore(c, num ? num.nextSibling : x.firstChild); }
  }
  htmlToInline(el, c);
  if (empty && name === "heading" && !GROUP.has(ln(x)) && ln(x) !== "section") c.remove();
}
async function flush() { for (const el of Array.from(S.pending)) if (el.isConnected) syncEl(el); S.pending.clear(); }

/* ---------------------------------------------------------------- load / save */

function parseXml(text) {
  const d = new DOMParser().parseFromString(text, "application/xml");
  const err = d.getElementsByTagName("parsererror")[0];
  if (err) throw new Error("The file is not well-formed XML: " + err.textContent.slice(0, 200));
  return d;
}
function changed(structuralChange) {
  if (S.view) return;
  S.dirty = true; setStatus("busy", "Edited");
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => save(false), structuralChange ? 600 : 1500);
}
async function save(force) {
  if (S.view || !S.doc) return;
  if (!S.dirty && !force) return;
  if (S.saving) { S.again = true; return; }
  clearTimeout(S.saveTimer);
  S.saving = true; setStatus("busy", "Saving…");
  await flush();
  autoLink();
  const body = serialize();
  S.dirty = false;
  try {
    const r = await api("i/" + S.id, { method: "PUT", headers: { "Content-Type": "application/xml" }, body });
    applyRenames(r.renamed || {});
    S.checks = markupChecks(r.checks); markChecks(); statusFromChecks(); renderOutline();
    if (!$("#tab-checks").hidden) renderChecks();
    if (!$("#tab-prov").hidden && !$("#tab-prov form")) renderInspector();
  } catch (e) { S.dirty = true; setStatus("err", "Not saved"); toast(e.message, 6000); }
  S.saving = false;
  if (S.again) { S.again = false; save(false); }
}
function applyRenames(map) {
  const keys = Object.keys(map); if (!keys.length) return;
  for (const el of S.doc.getElementsByTagName("*")) {
    const id = el.getAttribute("eId");
    if (id && map[id] !== undefined) { el.setAttribute("eId", map[id]); if (el._h && el._h.dataset) el._h.dataset.eid = map[id]; }
    for (const a of ["href", "refersTo"]) { const v = el.getAttribute(a); if (v && v[0] === "#" && map[v.slice(1)] !== undefined) el.setAttribute(a, "#" + map[v.slice(1)]); }
  }
}
async function load(id, keepView) {
  const xml = await api("i/" + id);
  S.id = id; S.doc = parseXml(xml); S.undo = []; $("#undo").hidden = true; S.dirty = false;
  S.base = null;
  try { S.base = parseXml(await api(`i/${id}/base`)); } catch (e) { S.base = null; }
  if (S.mode === "edit" && autoLink()) changed(false);     // references written before linking existed
  if (!keepView) { S.mode = "edit"; S.sel = null; }
  const prevEid = S.sel && S.sel.getAttribute("eId");
  const alias = Array.from(S.doc.getElementsByTagNameNS(AKN, "FRBRalias"))[0];
  $("#doctitle").textContent = (alias ? alias.getAttribute("value") : id) + (S.base ? " · mark-up" : "");
  renderAll();
  S.sel = byEid(prevEid); if (S.sel) select(S.sel); else renderInspector();
  try { S.stages = await api(`i/${id}/stages`); } catch (e) { S.stages = null; }
  const r = await api(`i/${id}/checks`); S.checks = markupChecks(r.checks); markChecks(); statusFromChecks(); renderOutline();
}

/* ---------------------------------------------------------------- library and routing */

async function showLibrary() {
  $("#library").hidden = false; $("#editor").hidden = true;
  ["#modes", "#save", "#undo", "#publish"].forEach(s => ($(s).hidden = true));
  $("#doctitle").textContent = ""; setStatus("", "");
  $("#libver").textContent = S.spec.version;
  const items = await api("instruments");
  const ul = $("#items"); ul.innerHTML = "";
  if (!items.length) ul.append(h("li", {}, h("p", { class: "note" }, "No instruments yet.")));
  for (const it of items) ul.append(h("li", {}, h("a", { href: "#/i/" + it.id },
    h("span", { class: "t" }, it.title), h("span", { class: "m mono" }, it.uri || ""),
    h("span", { class: "m" }, it.markup ? "mark-up" : it.stages ? `${it.stages} stage${it.stages > 1 ? "s" : ""} authenticated` : it.type === "act" ? "Act" : "draft")),
    LOCAL ? h("button", { class: "ghost del", title: "Delete from this browser", onclick: ev => removeItem(it, ev) }, "Delete") : null));
  $("#localnote").hidden = !LOCAL;
}
async function removeItem(it, ev) {
  const btn = ev.currentTarget;
  if (!btn.classList.contains("arm")) { btn.classList.add("arm"); btn.textContent = "Delete for good?"; return; }
  await api("i/" + it.id, { method: "DELETE" });
  showLibrary();
}
/* ?open=<url of a BNL file>: copy it into this browser's library and open it (a link can share a draft). */
async function openFromUrl() {
  const u = new URLSearchParams(location.search).get("open");
  if (!u) return false;
  const q = new URLSearchParams(location.search); q.delete("open");
  history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash);
  try {
    const x = await fetch(u);
    if (!x.ok) throw new Error(`Could not fetch ${u} (${x.status})`);
    const name = decodeURIComponent(new URL(u, location.href).pathname.split("/").pop() || "instrument");
    const r = await api("open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, xml: await x.text() }) });
    const target = "#/i/" + r.id;
    if (location.hash === target) route(); else location.hash = target;   // hashchange routes
    return true;
  } catch (e) { toast(e.message, 6000); return false; }
}
async function route() {
  if (S.dirty) await save(true);
  const m = /^#\/i\/([a-z0-9-]+)/.exec(location.hash);
  if (!m) return showLibrary();
  $("#library").hidden = true; $("#editor").hidden = false;
  ["#modes", "#save", "#publish"].forEach(s => ($(s).hidden = false));
  try { await load(m[1]); tab("prov"); }
  catch (e) { $("#page").innerHTML = ""; $("#page").append(h("p", {}, e.message)); }
}
$("#save").addEventListener("click", () => save(true));
$("#page").addEventListener("focusout", async () => { await flush(); if (autoLink()) changed(false); });
$$("#modes button").forEach(b => b.addEventListener("click", async () => {
  if (S.view) closeView();
  await save(false);
  S.mode = b.dataset.mode;
  $$("#modes button").forEach(z => z.classList.toggle("on", z === b));
  renderAll(); if (S.sel) select(byEid(S.sel.getAttribute("eId")));
}));
$$(".tabs button").forEach(b => b.addEventListener("click", () => tab(b.dataset.tab)));
$("#newform").addEventListener("submit", async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await api("new", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(f)) });
  location.hash = "#/i/" + r.id;
});
$("#importfile").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    if (/\.docx$/i.test(file.name)) {
      const { docxText } = await import("./engine/local.js");
      $("#importform textarea").value = await docxText(await file.arrayBuffer());
    } else $("#importform textarea").value = await file.text();
  } catch (err) { toast(err.message, 6000); }
});
$("#openfile").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const r = await api("open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, xml: await file.text() }) });
    location.hash = "#/i/" + r.id;
  } catch (err) { toast(err.message, 6000); }
  e.target.value = "";
});
$("#importform").addEventListener("submit", async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (!String(f.get("text") || "").trim()) { toast("Paste the Bill's text first."); return; }
  try {
    const r = await api("import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: f.get("text"), title: f.get("title") }) });
    location.hash = "#/i/" + r.id;
  } catch (err) { toast(err.message, 6000); }
});
window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", () => {
  if (!S.dirty) return;
  flush();
  if (LOCAL) save(true);
  else fetch("api/i/" + S.id, { method: "PUT", body: serialize(), keepalive: true });
});

(async () => {
  try { S.akn = await import("./engine/akn.js"); S.bill = await import("./engine/bill.js"); S.amend = await import("./engine/amendbill.js"); S.explain = await import("./engine/explain.js"); }
  catch (e) { S.akn = S.bill = S.amend = S.explain = null; }
  S.spec = await api("spec");
  if (LOCAL) { $('.tabs button[data-tab="stages"]').hidden = true; $("#openwrap").hidden = false; }
  if (LOCAL && await openFromUrl()) return;
  route();
})();
