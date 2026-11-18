/* Make a new BNL Bill, from nothing or from the plain text of a Bill (port of bnl/bill.py).

   The importer reads Indian drafting conventions: CHAPTER / PART headings, "8. Heading.—(1) text",
   "(1)" sub-sections, "(a)" clauses, "(i)" sub-clauses (an "(i)" after "(h)" is a clause), "(A)" points,
   "Provided that" provisos, "Explanation.—", and a closing SCHEDULE. What it cannot place goes in as
   plain paragraphs of the nearest provision, for the drafter to fix: nothing is dropped. */

import { AKN, BNL, XH, assignEids, kid, kids } from "./akn.js";
import * as amend from "./amend.js";

export const BNL_VERSION = "0.1";

export const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const workUri = (year, number) => `/akn/in/bill/${year}/${number}`;
const today = () => new Date().toLocaleDateString("en-CA");
const isUpper = s => s === s.toUpperCase() && s !== s.toLowerCase();
const isLowerChar = c => !!c && c === c.toLowerCase() && c !== c.toUpperCase();
const titleCase = s => s.toLowerCase().replace(/(^|[^A-Za-z])([a-z])/g, (_, a, b) => a + b.toUpperCase());

export function sub(parent, tag, text, attrs = {}) {
  const el = parent.ownerDocument.createElementNS(AKN, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  if (text !== null && text !== undefined) el.textContent = text;
  parent.appendChild(el);
  return el;
}
const p_ = (parent, text, cls) => sub(parent, "p", text, { class: cls });

function metaBlock(parent, title, year, number, date) {
  const uri = workUri(year, number);
  const meta = sub(parent, "meta");
  const ident = sub(meta, "identification", null, { source: "#bnl-editor" });
  const w = sub(ident, "FRBRWork");
  sub(w, "FRBRthis", null, { value: `${uri}/!main` });
  sub(w, "FRBRuri", null, { value: uri });
  sub(w, "FRBRalias", null, { value: title, name: "title" });
  sub(w, "FRBRdate", null, { date, name: "draft" });
  sub(w, "FRBRauthor", null, { href: "#parliament" });
  sub(w, "FRBRcountry", null, { value: "in" });
  sub(w, "FRBRnumber", null, { value: String(number) });
  const e = sub(ident, "FRBRExpression");
  sub(e, "FRBRthis", null, { value: `${uri}/eng@${date}/!main` });
  sub(e, "FRBRuri", null, { value: `${uri}/eng@${date}` });
  sub(e, "FRBRdate", null, { date, name: "version" });
  sub(e, "FRBRauthor", null, { href: "#parliament" });
  sub(e, "FRBRlanguage", null, { language: "eng" });
  const m = sub(ident, "FRBRManifestation");
  sub(m, "FRBRthis", null, { value: `${uri}/eng@${date}/!main.xml` });
  sub(m, "FRBRuri", null, { value: `${uri}/eng@${date}.akn` });
  sub(m, "FRBRdate", null, { date: today(), name: "transform" });
  sub(m, "FRBRauthor", null, { href: "#bnl-editor" });
  const refs = sub(meta, "references", null, { source: "#bnl-editor" });
  sub(refs, "TLCOrganization", null, { eId: "parliament", href: "/ontology/organization/in/parliament", showAs: "Parliament of India" });
  sub(refs, "TLCOrganization", null, { eId: "bnl-editor", href: "/ontology/organization/in/bnl-editor", showAs: "BNL Editor" });
  const prop = sub(meta, "proprietary", null, { source: "#bnl-editor" });
  const pr = parent.ownerDocument.createElementNS(BNL, "bnl:profile");
  pr.setAttribute("version", BNL_VERSION);
  prop.appendChild(pr);
  return meta;
}

/* -- the text model -------------------------------------------------------------------------------- */

const LEVEL = { part: 0, chapter: 0, section: 1, subsection: 2, clause: 3, subclause: 4, point: 5 };

class Node {
  constructor(kind, num = null, heading = null, name = null) {
    Object.assign(this, { kind, num, heading, name, paras: [], children: [], wrap: [] });
  }
  addText(t) { (this.children.length ? this.wrap : this.paras).push(t); }
}

const CHAPTER = /^(CHAPTER|PART)\s+([IVXLC]+|[A-Z]|\d+)\b\s*[:.\-–—]*\s*(.*)$/i;
const SCHEDULE = /^(THE\s+)?((FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH)\s+)?SCHEDULE\b\s*(.*)$/i;
const SECTION = /^(\d+[A-Z]{0,3})\.\s*(.*)$/;
const BRACKET = /^\(([0-9]+[A-Z]{0,3}|[a-z]{1,3}|[A-Z]{1,2})\)\s*(.*)$/;
const PROVISO = /^Provided\b/;
const EXPLANATION = /^(Explanation|Illustrations?)(\s+[IVX0-9]+)?\s*[.:]?\s*[—–-]+\s*(.*)$/;
const HEAD_SPLIT = /^(.{2,160}?)\.\s*[—–]+-?\s*(.*)$/;
const ROMAN = /^[ivxl]+$/;
const TITLE = /\bBILL\b.*\d{4}/;

export function clean(line) {
  line = line.trim().replace(/^#+\s*/, "").replace(/^[-*]\s+(?=\()/, "");
  line = line.replaceAll("**", "").replaceAll("__", "");
  line = line.replace(/(?<=[.;:,”"])\[[a-z]{1,2}\]/g, "");      // Google Docs comment anchors: "Act.[a]"
  line = line.replace(/^﻿+/, "");
  if (/^_{3,}$/.test(line.trim())) return "";
  return line.replace(/\s+/g, " ").trim();
}

function prevLetter(tok) { return tok.length === 1 ? String.fromCharCode(tok.charCodeAt(0) - 1) : null; }

export function parseText(text) {
  const lines = text.split(/\r\n|\r|\n/).map(clean).filter(Boolean);
  const preface = [], body = [], schedules = [], stack = [];
  let group = null, started = false, i = 0;
  const container = () => group ? group.children : body;
  const innermost = () => stack.length ? stack[stack.length - 1] : null;
  const openAt = node => {
    const lvl = LEVEL[node.kind];
    while (stack.length && LEVEL[stack[stack.length - 1].kind] >= lvl) stack.pop();
    (stack.length ? stack[stack.length - 1].children : container()).push(node);
    stack.push(node);
  };
  const bracket = line => {
    const m = BRACKET.exec(line); const tok = m[1]; const rest = m[2].trim();
    let kind;
    if (/^\d/.test(tok)) kind = "subsection";
    else if (isUpper(tok)) kind = "point";
    else if (ROMAN.test(tok)) {
      const prev = prevLetter(tok); const sib = stack.filter(n => n.kind === "clause");
      kind = (prev && sib.length && sib[sib.length - 1].num === `(${prev})`) ? "clause" : "subclause";
    } else kind = "clause";
    const node = new Node(kind, `(${tok})`);
    openAt(node);
    if (rest) {
      if (BRACKET.test(rest) && kind === "subsection" && rest.startsWith("(")) bracket(rest);
      else node.addText(rest);
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    let m = SCHEDULE.exec(line);
    if (m && started && (isUpper(line) || line.toLowerCase().startsWith("the schedule") || m[4] === "")) {
      schedules.push([line, lines.slice(i + 1)]);
      break;
    }
    m = CHAPTER.exec(line);
    if (m && isUpper(line.split(/\s+/)[0])) {
      started = true;
      let heading = m[3].trim();
      if (!heading && i + 1 < lines.length && !SECTION.test(lines[i + 1]) && !BRACKET.test(lines[i + 1])) { heading = lines[i + 1]; i++; }
      group = new Node(m[1].toLowerCase(), `${m[1].toUpperCase()} ${m[2]}`, heading);
      body.push(group); stack.length = 0; i++; continue;
    }
    m = SECTION.exec(line);
    if (m && (started || !TITLE.test(line))) {
      started = true;
      const rest = m[2];
      const node = new Node("section", `${m[1]}.`);
      stack.length = 0; container().push(node); stack.push(node);
      const hm = HEAD_SPLIT.exec(rest);
      if (rest.startsWith("(")) bracket(rest);
      else if (hm) {
        node.heading = hm[1].trim();
        const after = hm[2].trim();
        if (after) { if (BRACKET.test(after)) bracket(after); else node.addText(after); }
      } else if (rest && rest.length < 120 && !/[.;:,—–-]$/.test(rest)) node.heading = rest;
      else if (rest) node.addText(rest);
      i++; continue;
    }
    if (!started) { preface.push(line); i++; continue; }
    if (BRACKET.test(line)) { bracket(line); i++; continue; }
    if (PROVISO.test(line)) {
      const host = innermost(); const pv = new Node("proviso"); pv.paras.push(line);
      (host ? host.children : container()).push(pv); i++; continue;
    }
    m = EXPLANATION.exec(line);
    if (m) {
      const host = innermost();
      const hc = new Node("hcontainer", null, (m[1] + (m[2] || "")).trim(), m[1].toLowerCase().replace(/s$/, ""));
      if (m[3]) hc.paras.push(m[3]);
      (host ? host.children : container()).push(hc); i++; continue;
    }
    const host = innermost();
    if (!host) (group ? group.paras : preface).push(line);
    else if (isLowerChar(line[0]) && stack.length >= 2 && LEVEL[host.kind] >= 3) stack[stack.length - 2].wrap.push(line);
    else if (host.children.length && ["proviso", "hcontainer"].includes(host.children[host.children.length - 1].kind) && !host.wrap.length)
      host.children[host.children.length - 1].paras.push(line);
    else host.addText(line);
    i++;
  }
  return [preface, body, schedules];
}

/* -- to Akoma Ntoso -------------------------------------------------------------------------------- */

function emit(parent, node) {
  const attrs = { eId: "tmp_import" };
  if (node.kind === "hcontainer") attrs.name = node.name || "hcontainer";
  const el = sub(parent, node.kind, null, attrs);
  if (node.num) sub(el, "num", node.num);
  if (node.heading) sub(el, "heading", node.heading);
  if (node.children.length) {
    if (node.paras.length) { const intro = sub(el, "intro"); for (const t of node.paras) p_(intro, t); }
    for (const c of node.children) emit(el, c);
    if (node.wrap.length) { const wu = sub(el, "wrapUp"); for (const t of node.wrap) p_(wu, t); }
  } else if (node.kind !== "chapter" && node.kind !== "part") {
    const content = sub(el, "content");
    const all = [...node.paras, ...node.wrap];
    for (const t of all.length ? all : [""]) p_(content, t);
  }
  return el;
}

const RECITAL = /^(AND\s+)?WHEREAS\b/i;
const QUOTED = /^\s*([“"][\s\S]*[”"])(\W*)$/;
const SCHED_PART = /^PART\s+([IVXLC]+|[A-Z]|\d+)\s*[:.\-–—]*\s*(.*)$/;

function preface_(bill, lines, title) {
  const preface = sub(bill, "preface");
  let titleSeen = false;
  if (!lines.some(l => TITLE.test(l))) { sub(p_(preface, null, "title"), "docTitle", title.toUpperCase()); titleSeen = true; }
  const longTitle = [], recitals = [], formula = [];
  for (const line of lines) {
    if (!titleSeen && TITLE.test(line)) { titleSeen = true; sub(p_(preface, null, "title"), "docTitle", line); }
    else if (/^Bill No\./i.test(line)) sub(p_(preface, null, "number"), "docNumber", line);
    else if (RECITAL.test(line)) recitals.push(line);
    else if (/^BE\s+it\s+enacted/i.test(line) || formula.length) formula.push(line);
    else if (/^A\s+BILL\b/i.test(line) || (longTitle.length && !recitals.length)) longTitle.push(line);
    else if (recitals.length) recitals[recitals.length - 1] += " " + line;
    else p_(preface, line);
  }
  if (longTitle.length) { const lt = sub(preface, "longTitle"); for (const t of longTitle) p_(lt, t); }
  if (recitals.length || formula.length) {
    const pre = sub(bill, "preamble");
    if (recitals.length) { const rs = sub(pre, "recitals"); for (const t of recitals) p_(sub(rs, "recital"), t); }
    if (formula.length) { const f = sub(pre, "formula", null, { name: "enactingFormula" }); for (const t of formula) p_(f, t); }
  }
}

export function scheduleMeta(doc, title, stitle, year, number, date, k) {
  const uri = workUri(year, number);
  const ident = sub(sub(doc, "meta"), "identification", null, { source: "#bnl-editor" });
  for (const [tag, val] of [["FRBRWork", uri], ["FRBRExpression", `${uri}/eng@${date}`], ["FRBRManifestation", `${uri}/eng@${date}.akn`]]) {
    const part = sub(ident, tag);
    sub(part, "FRBRthis", null, { value: `${val}/!schedule_${k}` });
    sub(part, "FRBRuri", null, { value: val });
    if (tag === "FRBRWork") sub(part, "FRBRalias", null, { value: `${title}: ${stitle}`, name: "title" });
    sub(part, "FRBRdate", null, { date, name: tag === "FRBRWork" ? "draft" : "version" });
    sub(part, "FRBRauthor", null, { href: tag !== "FRBRManifestation" ? "#parliament" : "#bnl-editor" });
    if (tag === "FRBRWork") sub(part, "FRBRcountry", null, { value: "in" });
    if (tag === "FRBRExpression") sub(part, "FRBRlanguage", null, { language: "eng" });
  }
}

function schedule(atts, title, stitle, slines, year, number, date, k, pending) {
  const att = sub(atts, "attachment", null, { eId: "tmp_import" });
  const doc = sub(att, "doc", null, { name: "schedule" });
  scheduleMeta(doc, title, stitle, year, number, date, k);
  const spre = sub(doc, "preface");
  p_(spre, stitle, "title");
  const main = sub(doc, "mainBody");
  let host = main, act = null, cur = null;
  const items = [];
  for (const line of slines) {
    if (/^_+$/.test(line)) continue;
    let m = SCHED_PART.exec(line);
    if (m) {
      host = sub(main, "part", null, { eId: "tmp_import" });
      sub(host, "num", `PART ${m[1]}`);
      if (m[2]) sub(host, "heading", m[2]);
      act = amend.actOf(m[2]); cur = null; continue;
    }
    m = SECTION.exec(line);
    if (m) {
      const el = sub(host, "paragraph", null, { eId: "tmp_import" });
      sub(el, "num", `${m[1]}.`);
      cur = { el, act, lines: m[2] ? [m[2]] : [], quoted: [] };
      items.push(cur); continue;
    }
    if (!cur) {
      const cls = /^[\[(].*[\])]$/.test(line) ? "reference" : isUpper(line) ? "heading" : null;
      p_(spre, line, cls); continue;
    }
    (QUOTED.test(line) ? cur.quoted : cur.lines).push(line);
  }
  for (const { el, act, lines, quoted } of items) {
    const content = sub(el, "content");
    const instruction = lines.join(" ");
    if (quoted.length) {
      const p = sub(content, "p");
      const mod = sub(p, "mod", null, { eId: "tmp_mod" });
      mod.appendChild(p.ownerDocument.createTextNode(instruction + " "));
      for (const ql of quoted) {
        const qm = QUOTED.exec(ql);
        sub(mod, "quotedText", qm[1], { eId: "tmp_qt" });
        if (qm[2]) mod.appendChild(p.ownerDocument.createTextNode(qm[2]));
      }
      pending.push([el, act, instruction, quoted.map(x => QUOTED.exec(x)[1]).join(" ")]);
    } else {
      p_(content, instruction);
      pending.push([el, act, instruction, null]);
    }
  }
}

const stripQuotes = t => t ? t.trim().replace(/^[“"]|[”"]$/g, "").trim() : t;

function recordAmendments(billEl, pending) {
  const meta = kid(billEl, "meta"), refs = kid(meta, "references");
  const analysis = meta.ownerDocument.createElementNS(AKN, "analysis");
  analysis.setAttribute("source", "#bnl-editor");
  meta.insertBefore(analysis, refs);
  const am = sub(analysis, "activeModifications");
  let n = 0; const acts = new Map();
  for (const [el, act, instruction, quoted] of pending) {
    const eid = el.getAttribute("eId");
    const mod = el.getElementsByTagNameNS(AKN, "mod")[0];
    if (mod) {
      mod.setAttribute("eId", `${eid}__mod_1`);
      kids(mod).filter(c => c.localName === "quotedText").forEach((qt, i) => qt.setAttribute("eId", `${eid}__mod_1__qtext_${i + 1}`));
    }
    if (!act) continue;
    const [name, year, num] = act;
    const work = `/akn/in/act/${year}/${num}`;
    acts.set(work, name);
    for (const ch of amend.parse(instruction, quoted)) {
      n++;
      const tm = sub(am, "textualMod", null, { type: ch.type, eId: `amod_${n}` });
      tm.setAttributeNS(BNL, "bnl:extent", "IN");
      tm.setAttributeNS(BNL, "bnl:basis", "stated");
      sub(tm, "source", null, { href: `#${eid}` });
      sub(tm, "destination", null, { href: `${work}/~${ch.path.join("__")}` });
      for (const which of ["old", "new"]) if (ch[which]) {
        const w = sub(tm, which, null, { eId: `amod_${n}__${which}` });
        const hp = meta.ownerDocument.createElementNS(XH, "h:p");
        hp.textContent = stripQuotes(ch[which]);
        w.appendChild(hp);
      }
    }
  }
  if (!am.children.length) meta.removeChild(analysis);
  let i = 0;
  for (const [work, name] of acts) {
    const r = meta.ownerDocument.createElementNS(AKN, "activeRef");
    r.setAttribute("eId", "ref_" + work.replace("/akn/", "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, ""));
    r.setAttribute("href", work); r.setAttribute("showAs", name);
    refs.insertBefore(r, refs.children[i++] || null);
  }
}

/* -- cross-references ------------------------------------------------------------------------------ */

/* References in the text, in the order they are tried at each position. Internal ones link to the
   provision's eId (only if it exists); a reference to another Act that gives the Act's number,
   "section 70 of the Information Technology Act, 2000 (21 of 2000)", links to its BNL name. A bare
   "section 5 of the X Act" with no number is left alone. */
const NOT_EXT = String.raw`(?! of the (?:[A-Z]|principal\b))`;   // "of the principal Act" is another Act too
const XREF = new RegExp([
  String.raw`(?<ext>(?:clause \((?<x1>\w+)\) of )?(?:sub-section \((?<x2>\w+)\) of )?[Ss]ection (?<x3>\d+[A-Z]*))(?<xact> of the [A-Z][^,()]*?, \d{4} \((?<xnum>\d+) of (?<xyear>\d{4})\))`,
  String.raw`(?<this>this (?<thisk>Chapter|Section|section|sub-section))\b`,
  String.raw`(?<a>clause \((?<a1>\w+)\) of sub-section \((?<a2>\w+)\) of [Ss]ection (?<a3>\d+[A-Z]*))${NOT_EXT}`,
  String.raw`(?<b>sub-section \((?<b1>\w+)\) of [Ss]ection (?<b2>\d+[A-Z]*))${NOT_EXT}`,
  String.raw`(?<h>sub-sections (?<hl>\(\w+\)(?:, \(\w+\))*,? and \(\w+\))(?: of [Ss]ection (?<hs>\d+[A-Z]*))?)${NOT_EXT}`,
  String.raw`(?<c>clause \((?<c1>\w+)\) of sub-section \((?<c2>\w+)\))(?! of [Ss]ection)`,
  String.raw`(?<d>[Ss]ections (?<d1>\d+[A-Z]*(?:, \d+[A-Z]*)*,? and \d+[A-Z]*))${NOT_EXT}`,
  String.raw`(?<e>[Ss]ection (?<e1>\d+[A-Z]*))\b${NOT_EXT}`,
  String.raw`(?<f>sub-section \((?<f1>\w+)\))(?! of [Ss]ection)`,
  String.raw`(?<k>clause \((?<k1>\w+)\))(?! of )`,
  String.raw`(?<g>Chapter (?<g1>[IVXL]+))\b`,
  String.raw`(?<s>the Schedule)\b`,
].join("|"), "gd");


function linkText(text, ctx, ids) {
  const out = []; let pos = 0;
  const want = (a, b, href) => { if (a >= pos && (href[0] !== "#" || ids.has(href.slice(1)))) { out.push([a, b, href]); pos = b; } };
  for (const m of text.matchAll(XREF)) {
    const g = m.groups, ix = m.indices.groups;
    if (g.ext) {
      const path = [`sec_${g.x3}`, ...(g.x2 ? [`subsec_${g.x2}`] : []), ...(g.x1 ? [`cl_${g.x1}`] : [])].join("__");
      want(...ix.ext, `/akn/in/act/${g.xyear}/${g.xnum}/~${path}`);
    } else if (g.this) {
      const t = { Chapter: ctx.chapter, Section: ctx.section, section: ctx.section, "sub-section": ctx.subsection }[g.thisk];
      if (t) want(...ix.this, `#${t}`);
    } else if (g.a) want(...ix.a, `#sec_${g.a3}__subsec_${g.a2}__cl_${g.a1}`);
    else if (g.b) want(...ix.b, `#sec_${g.b2}__subsec_${g.b1}`);
    else if (g.h) {
      const sec = g.hs ? `sec_${g.hs}` : ctx.section;
      if (sec) for (const nm of g.hl.matchAll(/\((\w+)\)/g)) want(ix.hl[0] + nm.index, ix.hl[0] + nm.index + nm[0].length, `#${sec}__subsec_${nm[1]}`);
    } else if (g.c) { if (ctx.section) want(...ix.c, `#${ctx.section}__subsec_${g.c2}__cl_${g.c1}`); }
    else if (g.d) for (const nm of g.d1.matchAll(/\d+[A-Z]*/g)) want(ix.d1[0] + nm.index, ix.d1[0] + nm.index + nm[0].length, `#sec_${nm[0]}`);
    else if (g.e) want(...ix.e, `#sec_${g.e1}`);
    else if (g.f) { if (ctx.section) want(...ix.f, `#${ctx.section}__subsec_${g.f1}`); }
    else if (g.k) {
      const t = [ctx.subsection, ctx.section].filter(Boolean).map(x => `${x}__cl_${g.k1}`).find(x => ids.has(x));
      if (t) want(...ix.k, `#${t}`);
    } else if (g.g) want(...ix.g, `#chp_${g.g1}`);
    else if (g.s) { if (ctx.schedule) want(...ix.s, `#${ctx.schedule}`); }
  }
  return out;
}

function contextOf(p, doc) {
  const ctx = {};
  for (let y = p.parentNode; y && y.nodeType === 1; y = y.parentNode) {
    const n = y.localName, id = y.getAttribute("eId");
    if (n === "subsection" && !ctx.subsection) ctx.subsection = id;
    else if (n === "section" && !ctx.section) ctx.section = id;
    else if (n === "chapter" && !ctx.chapter) ctx.chapter = id;
  }
  const atts = doc.getElementsByTagNameNS(AKN, "attachment");
  if (atts.length === 1) ctx.schedule = atts[0].getAttribute("eId");
  return ctx;
}

/* Turn references in the body's text into <ref>s. Words already inside a reference (or quoted, or a
   title) are left alone, so it can run again after every edit; skip(p) leaves out a paragraph (the one
   being typed in). Returns the paragraphs changed. */
export function linkRefs(doc, skip) {
  const ids = new Set(Array.from(doc.getElementsByTagName("*"), e => e.getAttribute("eId")).filter(Boolean));
  const body = doc.getElementsByTagNameNS(AKN, "body")[0];
  if (!body) return [];
  const changed = [];
  for (const p of Array.from(body.getElementsByTagNameNS(AKN, "p"))) {
    if (skip && skip(p)) continue;
    let ctx = null, did = false;
    for (const tn of Array.from(p.childNodes)) {
      if (tn.nodeType !== 3 || !tn.nodeValue.trim()) continue;
      ctx = ctx || contextOf(p, doc);
      const text = tn.nodeValue, pieces = linkText(text, ctx, ids);
      if (!pieces.length) continue;
      const frag = doc.createDocumentFragment(); let at = 0;
      for (const [a, b, href] of pieces) {
        if (a > at) frag.appendChild(doc.createTextNode(text.slice(at, a)));
        const r = doc.createElementNS(AKN, "ref"); r.setAttribute("href", href); r.textContent = text.slice(a, b);
        frag.appendChild(r); at = b;
      }
      if (at < text.length) frag.appendChild(doc.createTextNode(text.slice(at)));
      p.replaceChild(frag, tn); did = true;
    }
    if (did) changed.push(p);
  }
  return changed;
}

/* Drafting notes (comments on the draft) go in the metadata, pointing at their provision. */
export function addNotes(doc, notes) {
  if (!notes.length) return;
  const docEl = kids(doc.documentElement)[0], meta = kid(docEl, "meta");
  const holder = doc.createElementNS(AKN, "notes");
  holder.setAttribute("source", "#bnl-editor");
  meta.insertBefore(holder, kid(meta, "proprietary"));
  notes.forEach(([anchor, text, author], i) => {
    let target = null;
    for (const p of doc.getElementsByTagNameNS(AKN, "p")) {
      if (anchor && p.textContent.includes(anchor)) {
        target = p;
        while (target.parentNode && target.parentNode.nodeType === 1 && !target.getAttribute("eId")) target = target.parentNode;
        break;
      }
    }
    const note = sub(holder, "note", null, { eId: `note_${i + 1}`, class: "drafting" });
    if (target && target.getAttribute("eId")) note.setAttribute("refersTo", `#${target.getAttribute("eId")}`);
    p_(note, author ? `${author}: ${text}` : text);
  });
}

/* An empty Bill: metadata, the preface (title, long title, recitals, enacting formula) and a body. */
export function skeleton(title, year, number, date, prefaceLines = []) {
  date = date || today();
  const doc = document.implementation.createDocument(AKN, "akomaNtoso", null);
  doc.documentElement.setAttributeNS("http://www.w3.org/2000/xmlns/", "xmlns:bnl", BNL);
  const billEl = sub(doc.documentElement, "bill", null, { name: "bill", contains: "originalVersion" });
  metaBlock(billEl, title, year, number, date);
  preface_(billEl, prefaceLines, title);
  return { doc, billEl, body: sub(billEl, "body"), date };
}

export function build(title, year, number, date, prefaceLines = [], bodyNodes = [], schedules = [], notes = []) {
  const sk = skeleton(title, year, number, date, prefaceLines);
  const { doc, billEl, body } = sk; date = sk.date;
  if (!bodyNodes.length) {
    const s = new Node("section", "1.", "Short title and commencement"), s1 = new Node("subsection", "(1)");
    const actName = title.replace(/\s*\bbill\b/i, " Act").trim();
    s1.paras.push(`This Act may be called the ${actName.replace(/^the\s+/i, "")}.`);
    s.children.push(s1); bodyNodes = [s];
  }
  for (const n of bodyNodes) emit(body, n);
  const pending = [];
  if (schedules.length) {
    const atts = sub(billEl, "attachments");
    schedules.forEach(([stitle, slines], k) => schedule(atts, title, stitle, slines, year, number, date, k + 1, pending));
  }
  assignEids(doc);
  if (pending.length) recordAmendments(billEl, pending);
  linkRefs(doc);
  addNotes(doc, notes);
  return doc;
}

const numberFor = title => slug(title.replace(/^the\s+|,?\s*\d{4}$/gi, "")) || "draft";

export function newBill(title, year, number, date) { return build(title, year, number || numberFor(title), date); }

const COMMENT_LINE = /^\s*\[([a-z]{1,2})\]\s*(.+)$/;

/* A Google Docs text export marks a comment "[a]" in the text and puts it on a line "[a]comment" at the end. */
export function gdocsComments(text) {
  const lines = text.split(/\r\n|\r|\n/), comments = {};
  while (lines.length && (!lines[lines.length - 1].trim() || COMMENT_LINE.test(lines[lines.length - 1]))) {
    const m = COMMENT_LINE.exec(lines.pop());
    if (m) comments[m[1]] = m[2].trim();
  }
  const notes = [];
  for (const key of Object.keys(comments).sort()) {
    const mark = `[${key}]`;
    const l = lines.find(x => x.includes(mark));
    if (l) {
      let anchor = clean(l.split(mark)[0]).replace(/^(\(\w+\)|\d+[A-Z]*\.)\s*/, "");
      notes.push([anchor.slice(-120), comments[key]]);
    }
  }
  return [lines.join("\n"), notes];
}

export function importText(text, { title, year, number, date, notes = [], author } = {}) {
  text = text.replace(/^﻿/, "");
  const [t2, found] = gdocsComments(text);
  notes = [...notes, ...found.map(([a, b]) => [a, b, author || "Comment on the draft"])];
  const [preface, body, schedules] = parseText(t2);
  if (!title) {
    const t = preface.find(l => TITLE.test(l));
    title = t ? titleCase(t).replaceAll(" Of ", " of ").replaceAll(" And ", " and ") : "Untitled Bill";
  }
  if (!year) { const m = /(\d{4})/.exec(title); year = m ? m[1] : String(new Date().getFullYear()); }
  return build(title, year, number || numberFor(title), date, preface, body, schedules, notes);
}
