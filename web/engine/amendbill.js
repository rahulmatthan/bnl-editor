/* From a mark-up to an amending Bill.

   The drafter edits a copy of an Act (the mark-up) until it reads as the Act should after amendment.
   generate(base, markup) compares the two provision by provision (by eId, which never changes in an
   Act) and writes the Bill Parliament would pass, in the form of Indian amending Acts:

     2. Amendment of section 5.—In section 5 of the X Act, 2023 (22 of 2023) (hereinafter referred to
        as the principal Act), in sub-section (1), for the words “thirty days”, the words “fifteen
        days” shall be substituted.
     3. Insertion of new section 8A.—After section 8 of the principal Act, the following section
        shall be inserted, namely:— “8A. …”.
     4. Omission of section 12.—Section 12 of the principal Act shall be omitted.

   Every change is also recorded in BNL: a textualMod naming the provision amended
   (/akn/in/act/2023/22/~sec_5__subsec_1), with the old and new text. */

import { AKN, BNL, XH, kid, kids, assignEids, numToken } from "./akn.js";
import { sub, skeleton, slug, scheduleMeta } from "./bill.js";

const PROV = new Set(["part", "chapter", "subchapter", "subpart", "section", "subsection", "clause", "subclause",
  "point", "paragraph", "subparagraph", "article", "rule", "subrule", "item", "proviso", "hcontainer"]);
const GROUP = new Set(["part", "chapter", "subchapter", "subpart"]);
const NOUN = { part: "Part", chapter: "Chapter", subchapter: "Sub-chapter", section: "section", subsection: "sub-section",
  clause: "clause", subclause: "sub-clause", point: "item", paragraph: "paragraph", subparagraph: "sub-paragraph",
  article: "article", rule: "rule", subrule: "sub-rule", item: "item" };
const ORD = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const L = "“", R = "”";
/* inside quoted text, its own double quotes become single ones, as the Gazette prints them */
const nest = t => (t || "").replace(/“/g, "‘").replace(/”/g, "’").replace(/"/g, "'");

const provKids = el => kids(el).filter(c => PROV.has(c.localName) && c.namespaceURI === AKN);
const isProv = el => el && el.nodeType === 1 && PROV.has(el.localName);

/* The words of a node, without footnotes and without the provisions inside it. */
function plain(node) {
  let s = "";
  const walk = n => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) s += c.nodeValue;
      else if (c.nodeType === 1 && c.localName !== "authorialNote" && !PROV.has(c.localName)) walk(c);
      else if (c.nodeType === 1 && c.localName === "p") { s += " "; walk(c); }
    }
  };
  if (node) walk(node);
  return s.replace(/\s+/g, " ").trim();
}
const blockText = (el, name) => {
  const b = kid(el, name);
  return b ? Array.from(b.childNodes).filter(c => c.nodeType === 1).map(plain).filter(Boolean).join(" ") : "";
};
const numOf = el => { const n = kid(el, "num"); return n ? plain(n) : ""; };
const headingOf = el => { const h = kid(el, "heading"); return h ? plain(h) : ""; };

/* -- naming provisions the way an amending Act does ---------------------------------------------- */

function name(el) {
  const k = el.localName;
  if (k === "proviso") {
    const all = provKids(el.parentNode).filter(c => c.localName === "proviso");
    return all.length > 1 ? `the ${ORD[all.indexOf(el) + 1] || (all.indexOf(el) + 1) + "th"} proviso` : "the proviso";
  }
  if (k === "hcontainer") {
    const h = headingOf(el).replace(/[.\s—–-]+$/, "");
    return h ? (/^Explanation$/i.test(h) ? "the Explanation" : h) : "the Explanation";
  }
  const tok = numToken(numOf(el));
  if (GROUP.has(k)) return `${NOUN[k]} ${tok}`;
  if (k === "section" || k === "article" || k === "rule") return `${NOUN[k]} ${tok}`;
  return `${NOUN[k] || k} (${tok})`;
}
const plural = (k, n) => n > 1 ? (k === "proviso" ? "provisos" : k === "hcontainer" ? "Explanations" : (NOUN[k] || k) + "s") : (k === "hcontainer" ? "Explanation" : (NOUN[k] || k));
const listNames = els => {
  const n = els.map(e => e.localName === "section" || GROUP.has(e.localName) ? numToken(numOf(e)) : `(${numToken(numOf(e))})`);
  return n.length === 1 ? n[0] : n.slice(0, -1).join(", ") + " and " + n[n.length - 1];
};

function sectionOf(el) { for (let y = el; isProv(y); y = y.parentNode) if (y.localName === "section" || y.localName === "rule" || y.localName === "article") return y; return null; }

/* "in sub-section (1), in clause (b)," from the section down to el (el included). */
function pathFrom(top, el) {
  const chain = [];
  for (let y = el; y && y !== top && isProv(y); y = y.parentNode) chain.unshift(y);
  return chain.map(y => `in ${name(y)}, `).join("");
}

/* -- the provision as quoted in an amending Act --------------------------------------------------- */

function quoteLines(el) {
  const k = el.localName, num = numOf(el), head = headingOf(el);
  const out = [];
  const blocks = name => { const b = kid(el, name); return b ? Array.from(b.childNodes).filter(c => c.nodeType === 1).map(plain).filter(Boolean) : []; };
  const body = [...blocks("intro"), ...blocks("content")];
  const rest = [...provKids(el).flatMap(quoteLines), ...blocks("wrapUp")];
  if (GROUP.has(k)) {
    out.push(num); if (head) out.push(head.toUpperCase());
    out.push(...body, ...rest);
  } else if (k === "section" || k === "rule" || k === "article") {
    const first = [...body, ...rest];
    out.push(`${num} ${head ? head.replace(/\.$/, "") + ".—" : ""}${first.shift() || ""}`.trim(), ...first);
  } else if (k === "hcontainer") {
    const all = [...body, ...rest];
    out.push(`${head || "Explanation.—"}${head && !/[—–-]$/.test(head) ? ".—" : ""}${all.shift() || ""}`, ...all);
  } else {
    const all = [...body, ...rest];
    out.push(`${num ? num + " " : ""}${all.shift() || ""}`.trim(), ...all);
  }
  return out;
}

/* -- word changes --------------------------------------------------------------------------------- */

function lcsOps(A, B, gap = 2) {
  if (A.length * B.length > 250000) return [["rep", 0, A.length, 0, B.length]];
  const dp = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const hunks = []; let i = 0, j = 0, cur = null;
  const close = () => { if (cur) { hunks.push(cur); cur = null; } };
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { close(); i++; j++; continue; }
    cur = cur || { i, j, i2: i, j2: j };
    if (j >= B.length || (i < A.length && dp[i + 1][j] >= dp[i][j + 1])) cur.i2 = ++i; else cur.j2 = ++j;
  }
  close();
  // changes a word or two apart read better as one
  const merged = [];
  for (const h of hunks) {
    const last = merged[merged.length - 1];
    if (last && h.i - last.i2 <= gap) { last.i2 = h.i2; last.j2 = h.j2; } else merged.push({ ...h });
  }
  return merged;
}

/* Changes of words are made a whole sentence at a time: the sentence as it stands is quoted, and the
   sentence as amended. -> {whole: true} when every sentence changed (the provision is substituted
   instead), else [{phrase, old, new}]. */
// a sentence ends at . ; : ? ! or a dash before a capital, a quote or a bracket; in a list run into the
// text ("…2008; and (iii) …") each item is its own sentence
const sentences = t => t.split(/(?<=[.;:?!—])\s+(?=[“"(\[A-Z])|(?<=;\s(?:and|or))\s+(?=\()/).filter(Boolean);
function sentenceChanges(oldText, newText) {
  const A = sentences(oldText), B = sentences(newText);
  const hunks = lcsOps(A, B, 0);
  if (hunks.length === 1 && hunks[0].i === 0 && hunks[0].i2 === A.length) return { whole: true };
  const out = [];
  // as many sentences changed as there are new ones: each is its own change
  const split = [];
  for (const h of hunks) {
    if (h.i2 - h.i === h.j2 - h.j && h.i2 - h.i > 1) for (let k = 0; k < h.i2 - h.i; k++) split.push({ i: h.i + k, i2: h.i + k + 1, j: h.j + k, j2: h.j + k + 1 });
    else split.push(h);
  }
  for (const h of split) {
    const o = A.slice(h.i, h.i2).join(" "), n = B.slice(h.j, h.j2).join(" ");
    if (!o) {
      const prev = A[h.i - 1];
      out.push(prev
        ? { phrase: `after the words ${L}${nest(prev)}${R}, the words ${L}${nest(n)}${R} shall be inserted`, old: null, new: n }
        : { phrase: `before the words ${L}${nest(A[0])}${R}, the words ${L}${nest(n)}${R} shall be inserted`, old: null, new: n });
    } else if (!n) out.push({ phrase: `the words ${L}${nest(o)}${R} shall be omitted`, old: o, new: null });
    else out.push({ phrase: `for the words ${L}${nest(o)}${R}, the words ${L}${nest(n)}${R} shall be substituted`, old: o, new: n });
  }
  return out;
}
/* -- comparing the mark-up with the Act ---------------------------------------------------------- */

/* Each change: {kind, el (in the mark-up) or base (in the Act), ...}. */
function compare(b, w, out) {
  const own = [];
  if (headingOf(b) !== headingOf(w)) own.push({ kind: "heading", el: w, base: b, old: headingOf(b), new: headingOf(w) });
  // the opening words (intro, or content when there is nothing under it) and the closing words
  const lead = el => (blockText(el, "intro") + " " + blockText(el, "content")).trim();
  for (const [block, get] of [["lead", lead], ["wrapUp", el => blockText(el, "wrapUp")]]) {
    const o = get(b), n = get(w);
    if (o === n) continue;
    if (!o || !n) { own.push({ kind: "substitute", el: w, base: b }); continue; }
    const ch = sentenceChanges(o, n);
    // the whole text changed: substitute the provision (one with provisions under it keeps them, so
    // there only its opening or closing words are substituted)
    if (ch.whole && !provKids(w).length) { own.push({ kind: "substitute", el: w, base: b }); continue; }
    if (ch.whole) { own.push({ kind: "words", el: w, base: b, block, changes: [{ phrase: `for the words ${L}${nest(o)}${R}, the words ${L}${nest(n)}${R} shall be substituted`, old: o, new: n }] }); continue; }
    own.push({ kind: "words", el: w, base: b, block, changes: ch });
  }
  if (own.some(c => c.kind === "substitute") && !GROUP.has(w.localName)) { out.push({ kind: "substitute", el: w, base: b }); return; }

  const kidsOut = [];
  const B = provKids(b), W = provKids(w);
  const bIds = new Set(B.map(x => x.getAttribute("eId"))), wIds = new Set(W.map(x => x.getAttribute("eId")));
  const bById = new Map(B.map(x => [x.getAttribute("eId"), x]));
  for (const x of B) if (!wIds.has(x.getAttribute("eId"))) kidsOut.push({ kind: "omit", base: x, parentEl: w });
  let run = [], prev = null;
  const flush = next => { if (run.length) kidsOut.push({ kind: "insert", els: run, after: prev, before: next, parentEl: w }); run = []; };
  for (const x of W) {
    if (!bIds.has(x.getAttribute("eId"))) { run.push(x); continue; }
    flush(x); prev = x;
    compare(bById.get(x.getAttribute("eId")), x, kidsOut);
  }
  flush(null);

  // a provision changed in many places is better substituted whole (not a Chapter: that is its sections)
  const n = own.length + kidsOut.length;
  if (n > 4 && !GROUP.has(w.localName) && w.localName !== "body" && kidsOut.length >= own.length && n > provKids(w).length) {
    out.push({ kind: "substitute", el: w, base: b }); return;
  }
  out.push(...own, ...kidsOut);
}

/* -- writing the Bill --------------------------------------------------------------------------- */

const REPUBLIC = ["", "First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth"];
const TENS = ["", "Tenth", "Twentieth", "Thirtieth", "Fortieth", "Fiftieth", "Sixtieth", "Seventieth", "Eightieth", "Ninetieth"];
const TENS_CARD = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const TEENS = ["Tenth", "Eleventh", "Twelfth", "Thirteenth", "Fourteenth", "Fifteenth", "Sixteenth", "Seventeenth", "Eighteenth", "Nineteenth"];
function ordinalWords(n) {
  if (n < 10) return REPUBLIC[n];
  if (n < 20) return TEENS[n - 10];
  const t = Math.floor(n / 10), u = n % 10;
  return u ? `${TENS_CARD[t]}-${REPUBLIC[u].toLowerCase()}` : TENS[t];
}
function republicYear(d = new Date()) {   // the Republic began on 26 January 1950
  const y = d.getFullYear() - 1950 + 1;
  return d.getMonth() === 0 && d.getDate() < 26 ? y - 1 : y;
}

/* One unit = one section of the amending Bill. */
function units(changes) {
  const bySection = new Map(), own = [];
  for (const c of changes) {
    const target = c.el || c.base || c.els[0];
    const topLevel = target.localName === "section" || GROUP.has(target.localName) || (c.kind === "insert" && (c.els[0].localName === "section" || GROUP.has(c.els[0].localName)));
    const wholeSection = topLevel && (c.kind !== "words" && c.kind !== "heading" || GROUP.has(target.localName));
    if (wholeSection) { own.push({ changes: [c] }); continue; }
    const sec = sectionOf(c.kind === "insert" || c.kind === "omit" ? c.parentEl : target);
    const key = sec ? sec.getAttribute("eId") : "?";
    if (!bySection.has(key)) bySection.set(key, { section: sec, changes: [] });
    bySection.get(key).changes.push(c);
  }
  return [...bySection.values(), ...own];
}

function sortKey(u, order) {
  const c = u.changes[0];
  if (u.section) return order.get(u.section.getAttribute("eId")) ?? 1e9;
  if (c.kind === "insert") return c.after ? (order.get(c.after.getAttribute("eId")) ?? 1e9) + 0.5 : (c.before ? (order.get(c.before.getAttribute("eId")) ?? 1e9) - 0.5 : 1e9);
  const t = c.el || c.base;
  return order.get(t.getAttribute("eId")) ?? 1e9;
}

/* The instruction for one change, relative to `top` (the section, or nothing for a whole section). */
function instruction(c, top) {
  const path = el => top ? pathFrom(top, el) : "";
  switch (c.kind) {
    case "words": {
      const portion = c.block === "lead" && provKids(c.el).length ? "in the opening portion, " : c.block === "wrapUp" ? "in the closing portion, " : "";
      return c.changes.map(ch => ({ prefix: path(c.el) + portion, text: ch.phrase, quoted: null, mod: { type: ch.new && ch.old ? "substitution" : ch.new ? "insertion" : "repeal", dest: c.el, old: ch.old, new: ch.new } }));
    }
    case "heading": {
      const what = c.el.localName === "section" ? "marginal heading" : "heading";
      return [{ text: `${path(c.el)}for the ${what}, the following ${what} shall be substituted, namely:—`, quoted: [/[.:;—–-]$/.test(c.new) ? c.new : c.new + "."], mod: { type: "substitution", dest: c.el, old: c.old, new: c.new } }];
    }
    case "substitute": {
      const nm = name(c.base), k = c.base.localName;
      const where = top && c.el !== top ? pathFrom(top, c.el.parentNode) : "";
      return [{ text: `${where}for ${nm}, the following ${plural(k, 1)} shall be substituted, namely:—`, quoted: quoteLines(c.el),
        mod: { type: "substitution", dest: c.el, old: quoteLines(c.base).join(" "), new: quoteLines(c.el).join(" ") } }];
    }
    case "omit": {
      const where = top ? pathFrom(top, c.parentEl) : "";
      return [{ text: `${where}${name(c.base)} shall be omitted`, quoted: null, mod: { type: "repeal", dest: c.base, old: quoteLines(c.base).join(" "), new: null } }];
    }
    case "insert": {
      const where = top ? pathFrom(top, c.parentEl) : "";
      const k = c.els[0].localName, anchor = c.after ? `after ${name(c.after)}` : c.before ? `before ${name(c.before)}` : "at the end";
      return [{ text: `${where}${anchor}, the following ${plural(k, c.els.length)} shall be inserted, namely:—`, quoted: c.els.flatMap(quoteLines),
        mod: { type: "insertion", dest: c.els[0], old: null, new: c.els.flatMap(quoteLines).join(" ") } }];
    }
  }
  return [];
}

function marginal(u) {
  const c = u.changes[0];
  if (u.section) return `Amendment of section ${numToken(numOf(u.section))}.`;
  const t = c.el || c.base;
  const what = n => GROUP.has(n.localName) ? NOUN[n.localName] : n.localName === "section" ? "section" : NOUN[n.localName] || n.localName;
  if (c.kind === "omit") return `Omission of ${what(c.base)} ${numToken(numOf(c.base))}.`;
  if (c.kind === "insert") return `Insertion of new ${c.els.length > 1 ? what(c.els[0]) + "s" : what(c.els[0])} ${listNames(c.els)}.`;
  if (c.kind === "substitute") return `Substitution of new ${what(c.base)} for ${what(c.base)} ${numToken(numOf(c.base))}.`;
  return `Amendment of ${what(t)} ${numToken(numOf(t))}.`;
}

const ROMANS = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv"];
function capFirst(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/* The changes a mark-up makes, ready to write: grouped one unit per section of the Act, in its order. */
function analyse(baseDoc, workDoc) {
  const bAct = kids(baseDoc.documentElement)[0], wAct = kids(workDoc.documentElement)[0];
  const changes = [];
  compare(kid(bAct, "body"), kid(wAct, "body"), changes);
  // a provision new in the mark-up is named by its number (8A -> sec_8A), whatever id it got while drafting
  const twin = workDoc.cloneNode(true), renamed = assignEids(twin, true);
  const baseIds = new Set(Array.from(bAct.getElementsByTagName("*"), e => e.getAttribute("eId")).filter(Boolean));
  const destOf = el => { const id = el.getAttribute("eId"); return baseIds.has(id) ? id : (renamed[id] || id); };

  const alias = (bAct.getElementsByTagNameNS(AKN, "FRBRalias")[0] || { getAttribute: () => "" }).getAttribute("value") || "the Act";
  const work = (bAct.getElementsByTagNameNS(AKN, "FRBRuri")[0] || { getAttribute: () => "" }).getAttribute("value");
  const m = /\/akn\/in\/act\/(\d{4})\/([^/]+)/.exec(work || "");
  const actName = alias.replace(/^The /, "the ");
  const act = { alias, work, actName, cite: m ? `${actName} (${m[2]} of ${m[1]})` : actName,
    heading: m ? `${alias.toUpperCase()} (${m[2]} OF ${m[1]})` : alias.toUpperCase(),
    short: alias.replace(/^The\s+/i, "").replace(/\s*Act,?\s*\d{4}$/i, "") };

  const order = new Map(); let i = 0;
  for (const e of wAct.getElementsByTagName("*")) if (e.getAttribute("eId")) order.set(e.getAttribute("eId"), i++);
  // what was omitted sits just after the provision before it
  for (const e of bAct.getElementsByTagName("*")) {
    const id = e.getAttribute("eId");
    if (!id || order.has(id)) continue;
    let p = e.previousElementSibling; while (p && !order.has(p.getAttribute("eId"))) p = p.previousElementSibling;
    order.set(id, p ? order.get(p.getAttribute("eId")) + 0.3 : (order.get(e.parentNode.getAttribute && e.parentNode.getAttribute("eId")) ?? i) + 0.1);
  }
  const at = c => { const t = c.kind === "insert" ? (c.after || c.before) : (c.el || c.base);
    const k = t ? order.get(t.getAttribute("eId")) ?? 1e9 : 1e9; return c.kind === "insert" ? k + (c.after ? 0.5 : -0.5) : k; };
  const us = units(changes).sort((a, b) => sortKey(a, order) - sortKey(b, order));
  for (const u of us) u.changes.sort((a, b) => at(a) - at(b));
  return { us, act, destOf, count: changes.length };
}

/* A writer of amending provisions into a document; it remembers each <mod> for the BNL record. */
function modWriter(doc) {
  const mods = [];
  const write = (parent, text, quoted, rec, end) => {
    const p = sub(parent, "p"), mod = sub(p, "mod", null, { eId: "tmp_mod" });
    mod.appendChild(doc.createTextNode(text + (quoted ? " " : end)));
    if (quoted) {
      quoted.forEach((line, k) => sub(mod, "quotedText", (k === 0 ? L : "") + nest(line) + (k === quoted.length - 1 ? R : ""), { eId: "tmp_qt" }));
      mod.appendChild(doc.createTextNode(end));
    }
    mods.push([mod, rec]);
  };
  return { write, mods };
}

/* One unit (the amendments to one section, or one whole-section change) into host: a section of the
   Bill (with "of the principal Act") or a paragraph of a Schedule (ofAct ""). */
function writeUnit(host, u, ofAct, write) {
  const tidy = t => t.replace(/\s+,/g, ",").replace(/\s{2,}/g, " ");
  const items = u.section ? u.changes.flatMap(c => instruction(c, u.section)) : instruction(u.changes[0], null);
  if (u.section) {
    const lead = tidy(`In ${name(u.section)} ${ofAct},`);
    // changes to the same provision go together: "in sub-section (1),— (i) …; (ii) …"
    const groups = [];
    for (const it of items) {
      const g = groups[groups.length - 1];
      if (g && it.prefix && g.prefix === it.prefix) g.items.push(it); else groups.push({ prefix: it.prefix || "", items: [it] });
    }
    const whole = it => (it.prefix || "") + it.text;
    const opening = prefix => prefix.replace(/,\s*$/, "") + ",—";
    const last = items[items.length - 1];
    const end = it => it === last ? "." : ";";
    if (items.length === 1) write(sub(host, "content"), `${lead} ${whole(items[0])}`, items[0].quoted, items[0].mod, ".");
    else if (groups.length === 1 && groups[0].prefix) {
      sub(sub(host, "intro"), "p", `${lead} ${opening(groups[0].prefix)}`);
      items.forEach((it, k) => {
        const cl = sub(host, "clause", null, { eId: "tmp_import" });
        sub(cl, "num", `(${String.fromCharCode(97 + k)})`);
        write(sub(cl, "content"), it.text, it.quoted, it.mod, end(it));
      });
    } else {
      sub(sub(host, "intro"), "p", `${lead}—`);
      groups.forEach((g, k) => {
        const cl = sub(host, "clause", null, { eId: "tmp_import" });
        sub(cl, "num", `(${String.fromCharCode(97 + k)})`);
        if (g.items.length === 1) { write(sub(cl, "content"), whole(g.items[0]), g.items[0].quoted, g.items[0].mod, end(g.items[0])); return; }
        sub(sub(cl, "intro"), "p", opening(g.prefix));
        g.items.forEach((it, z) => {
          const sc = sub(cl, "subclause", null, { eId: "tmp_import" });
          sub(sc, "num", `(${ROMANS[z + 1] || z + 1})`);
          write(sub(sc, "content"), it.text, it.quoted, it.mod, end(it));
        });
      });
    }
  } else {
    const c = u.changes[0], it = items[0];
    const target = c.kind === "insert" ? (c.after || c.before) : (c.el || c.base);
    let text;
    if (c.kind === "omit") text = `${capFirst(name(c.base))} ${ofAct} shall be omitted`;
    else if (c.kind === "insert") text = `${c.after ? "After" : c.before ? "Before" : "At the end of"} ${target ? name(target) : ""} ${ofAct}, the following ${plural(c.els[0].localName, c.els.length)} shall be inserted, namely:—`;
    else if (c.kind === "substitute") text = `For ${name(c.base)} ${ofAct}, the following ${plural(c.base.localName, 1)} shall be substituted, namely:—`;
    else text = `In ${name(target)} ${ofAct}, ${(it.prefix || "") + it.text}`;
    write(sub(host, "content"), tidy(text), it.quoted, it.mod, ".");
  }
}

/* The BNL record: a textualMod for every <mod>, in the Bill's activeModifications (added to what is
   there). sourceOf(mod) is the provision of the Bill that makes the change. */
function record(doc, billEl, mods, act, destOf, sourceOf) {
  const meta = kid(billEl, "meta"), refs = kid(meta, "references");
  let analysis = kid(meta, "analysis");
  if (!analysis) { analysis = doc.createElementNS(AKN, "analysis"); analysis.setAttribute("source", "#bnl-editor"); meta.insertBefore(analysis, refs); }
  let am = kid(analysis, "activeModifications");
  if (!am) { am = doc.createElementNS(AKN, "activeModifications"); analysis.insertBefore(am, analysis.firstChild); }
  let k = Math.max(0, ...Array.from(doc.getElementsByTagName("*"), e => +((/^amod_(\d+)$/.exec(e.getAttribute("eId") || "") || [])[1] || 0)));
  for (const [mod, rec] of mods) {
    let holder = mod.parentNode; while (holder && !holder.getAttribute("eId")) holder = holder.parentNode;
    const hid = holder.getAttribute("eId");
    mod.setAttribute("eId", `${hid}__mod_1`);
    kids(mod).filter(x => x.localName === "quotedText").forEach((qt, z) => qt.setAttribute("eId", `${hid}__mod_1__qtext_${z + 1}`));
    k++;
    const tm = sub(am, "textualMod", null, { type: rec.type, eId: `amod_${k}` });
    tm.setAttributeNS(BNL, "bnl:extent", "IN"); tm.setAttributeNS(BNL, "bnl:basis", "stated");
    sub(tm, "source", null, { href: `#${sourceOf(mod, hid)}` });
    sub(tm, "destination", null, { href: `${act.work}/~${destOf(rec.dest)}` });
    for (const which of ["old", "new"]) if (rec[which]) {
      const wEl = sub(tm, which, null, { eId: `amod_${k}__${which}` });
      const hp = doc.createElementNS(XH, "h:p"); hp.textContent = rec[which]; wEl.appendChild(hp);
    }
  }
  if (act.work && !kids(refs).some(r => r.getAttribute("href") === act.work)) {
    const r = doc.createElementNS(AKN, "activeRef");
    r.setAttribute("eId", "ref_" + act.work.replace("/akn/", "").replace(/[^A-Za-z0-9]+/g, "_"));
    r.setAttribute("href", act.work); r.setAttribute("showAs", act.alias);
    refs.insertBefore(r, refs.firstElementChild);
  }
}

function preamble(title, longTitle) {
  return [title.toUpperCase(), longTitle,
    `BE it enacted by Parliament in the ${ordinalWords(republicYear())} Year of the Republic of India as follows:—`];
}
function shortTitleSection(body, shortTitle) {
  const s1 = sub(body, "section", null, { eId: "tmp_import" });
  sub(s1, "num", "1."); sub(s1, "heading", "Short title and commencement");
  const ss1 = sub(s1, "subsection", null, { eId: "tmp_import" }); sub(ss1, "num", "(1)");
  sub(sub(ss1, "content"), "p", `This Act may be called ${shortTitle}.`);
  const ss2 = sub(s1, "subsection", null, { eId: "tmp_import" }); sub(ss2, "num", "(2)");
  sub(sub(ss2, "content"), "p", "It shall come into force on such date as the Central Government may, by notification in the Official Gazette, appoint.");
}

/* -> {doc, title, changes} or {changes: 0} when the mark-up says the same as the Act */
export function generate(baseDoc, workDoc, { year = String(new Date().getFullYear()), date } = {}) {
  const { us, act, destOf, count } = analyse(baseDoc, workDoc);
  if (!count) return { changes: 0 };
  const title = `The ${act.short} (Amendment) Bill, ${year}`;
  const { doc, billEl, body } = skeleton(title, year, slug(`${act.short} amendment`), date,
    preamble(title, `A BILL further to amend ${act.actName}.`));
  shortTitleSection(body, `the ${act.short} (Amendment) Act, ${year}`);
  const { write, mods } = modWriter(doc);
  us.forEach((u, k) => {
    const sec = sub(body, "section", null, { eId: "tmp_import" });
    sub(sec, "num", `${k + 2}.`); sub(sec, "heading", marginal(u).replace(/\.$/, ""));
    const ofAct = k === 0 && us.length > 1 ? `of ${act.cite} (hereinafter referred to as the principal Act)` : k === 0 ? `of ${act.cite}` : "of the principal Act";
    writeUnit(sec, u, ofAct, write);
  });
  assignEids(doc);
  record(doc, billEl, mods, act, destOf, (mod, hid) => hid);
  return { doc, title, changes: mods.length };
}

/* -- amendments in a Schedule ---------------------------------------------------------------------- */

const OPERATIVE = "The enactments specified in the Schedule shall be amended in the manner specified therein.";
const toRoman = n => { let s = ""; for (const [v, r] of [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]]) while (n >= v) { s += r; n -= v; } return s; };

/* A new Bill that amends enactments through its Schedule (filled by addToSchedule). */
export function scheduleBill(title, { year = String(new Date().getFullYear()), date } = {}) {
  const t = /\bBill\b/i.test(title) ? title : `${title} Bill, ${year}`;
  const { doc, body } = skeleton(t, year, slug(t.replace(/^the\s+|,?\s*\d{4}$/gi, "")), date,
    preamble(t, "A BILL to amend certain enactments."));
  shortTitleSection(body, t.replace(/^The /, "the ").replace(/\bBill\b/, "Act"));
  assignEids(doc);
  return doc;
}

/* Add a mark-up's amendments to the Schedule of a Bill, as a Part for the Act (made again, in place,
   when the same mark-up is added a second time). Creates the Schedule, and the section that gives it
   effect, if the Bill has none. -> {changes, part} */
export function addToSchedule(billDoc, baseDoc, workDoc, { markupId = "" } = {}) {
  const { us, act, destOf, count } = analyse(baseDoc, workDoc);
  if (!count) return { changes: 0 };
  const doc = billDoc, billEl = kids(doc.documentElement)[0], body = kid(billEl, "body");
  const uri = (kid(kid(kid(billEl, "meta"), "identification"), "FRBRWork").getElementsByTagNameNS(AKN, "FRBRuri")[0] || { getAttribute: () => "" }).getAttribute("value");
  const [, byear, bnum] = /\/akn\/in\/bill\/([^/]+)\/([^/]+)/.exec(uri) || [, String(new Date().getFullYear()), "draft"];
  const btitle = (billEl.getElementsByTagNameNS(AKN, "FRBRalias")[0] || { getAttribute: () => "" }).getAttribute("value");

  // the section that gives the Schedule effect
  let operative = Array.from(body.getElementsByTagNameNS(AKN, "section")).find(s => /specified in the (First |Second )?Schedule shall be amended/.test(s.textContent));
  if (!operative) {
    const secs = Array.from(body.getElementsByTagNameNS(AKN, "section"));
    const n = secs.length ? (parseInt(numToken(numOf(secs[secs.length - 1])), 10) || secs.length) + 1 : 1;
    operative = sub(body, "section", null, { eId: "tmp_import" });
    sub(operative, "num", `${n}.`); sub(operative, "heading", "Amendment of certain enactments");
    sub(sub(operative, "content"), "p", OPERATIVE);
  }

  // the Schedule
  let atts = kid(billEl, "attachments");
  if (!atts) atts = sub(billEl, "attachments");
  let att = kids(atts).find(a => a.localName === "attachment");
  let main;
  if (!att) {
    att = sub(atts, "attachment", null, { eId: "tmp_import" });
    const sd = sub(att, "doc", null, { name: "schedule" });
    scheduleMeta(sd, btitle, "THE SCHEDULE", byear, bnum, new Date().toLocaleDateString("en-CA"), 1);
    const pre = sub(sd, "preface");
    sub(pre, "p", "THE SCHEDULE", { class: "title" });
    sub(pre, "p", `(See section ${numToken(numOf(operative))})`, { class: "reference" });
    main = sub(sd, "mainBody");
  } else main = att.getElementsByTagNameNS(AKN, "mainBody")[0];

  // the Part for this Act: the one made from this mark-up before, or a new one
  const tag = markupId ? `markup-${markupId}` : null;
  const parts = kids(main).filter(p => p.localName === "part");
  let part = tag && parts.find(p => (p.getAttribute("class") || "").split(" ").includes(tag));
  if (part) {
    const pid = part.getAttribute("eId");
    for (const tm of Array.from(doc.getElementsByTagNameNS(AKN, "textualMod"))) {
      const src = (kid(tm, "source") || { getAttribute: () => "" }).getAttribute("href") || "";
      if (pid && src.startsWith(`#${pid}__`)) tm.remove();
    }
    for (const c of kids(part)) if (c.localName !== "num" && c.localName !== "heading") c.remove();
  } else {
    part = sub(main, "part", null, { eId: "tmp_import", class: tag || undefined });
    sub(part, "num", `PART ${toRoman(parts.length + 1)}`);
    sub(part, "heading", act.heading);
  }

  const { write, mods } = modWriter(doc);
  us.forEach((u, k) => {
    const para = sub(part, "paragraph", null, { eId: "tmp_import" });
    sub(para, "num", `${k + 1}.`);
    writeUnit(para, u, "", write);
  });
  assignEids(doc);
  // a Schedule entry is the provision that makes its amendments
  const entryOf = (mod, hid) => { let y = mod; while (y && y.localName !== "paragraph") y = y.parentNode; return y ? y.getAttribute("eId") : hid; };
  record(doc, billEl, mods, act, destOf, entryOf);
  return { changes: mods.length, part: numOf(part) };
}

/* -- numbering a provision inserted into an Act: 8 -> 8A, (1) -> (1A), (b) -> (ba), (ii) -> (iia) -- */
export function insertedNum(prev) {
  const m = /^(\D*?)([0-9]+[A-Z]*|[A-Za-z]+)(\W*)$/.exec((prev || "").trim());
  if (!m) return null;
  let [, pre, tok, post] = m;
  const bump = c => String.fromCharCode(c.charCodeAt(0) + 1);
  if (/^\d+$/.test(tok)) tok += "A";
  else if (/^\d+[A-Z]+$/.test(tok)) tok = tok.slice(0, -1) + bump(tok.slice(-1));
  else if (tok.length === 1 || /^[ivxlc]+$/.test(tok) || /^[IVXLC]+$/.test(tok)) tok += tok === tok.toUpperCase() ? "A" : "a";
  else tok = tok.slice(0, -1) + bump(tok.slice(-1));
  return pre + tok + post;
}
