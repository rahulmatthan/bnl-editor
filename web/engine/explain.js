/* What a Bill carries to explain itself, as an Indian Bill does after its text:
   - the Statement of Objects and Reasons: why the law is needed and what it does, signed by the Minister;
   - the Notes on Clauses: one note for each clause (section), saying what it provides and why.
   Both are attachments of the Bill (<doc name="objectsAndReasons">, <doc name="notesOnClauses">), after
   any Schedule. Each note's heading is a reference to its clause ("Clause 7"), so renumbering keeps it
   right, and a note follows its clause when clauses move. Browser only. */

import { AKN, kid, kids } from "./akn.js";
import { sub, scheduleMeta } from "./bill.js";

export const SOR = "objectsAndReasons", NOC = "notesOnClauses";
const TITLES = { [SOR]: "STATEMENT OF OBJECTS AND REASONS", [NOC]: "NOTES ON CLAUSES" };

const txt = x => x ? x.textContent.replace(/\s+/g, " ").trim() : "";
const top = doc => doc.documentElement.children[0];
const body = doc => kid(top(doc), "body");

export function attachmentOf(doc, name) {
  const atts = kid(top(doc), "attachments");
  return atts ? kids(atts).find(a => { const d = kid(a, "doc"); return d && d.getAttribute("name") === name; }) || null : null;
}
export function isSchedule(att) { const d = kid(att, "doc"); return !d || !d.getAttribute("name") || d.getAttribute("name") === "schedule"; }

function ensure(doc, name) {
  let att = attachmentOf(doc, name);
  if (att) return att;
  const billEl = top(doc);
  let atts = kid(billEl, "attachments");
  if (!atts) atts = sub(billEl, "attachments");
  att = sub(atts, "attachment", null, { eId: "tmp_explain_" + name });
  // Schedules first (they are part of the Bill), then the Statement, then the Notes.
  const after = name === SOR ? kids(atts).find(a => a !== att && kid(a, "doc") && kid(a, "doc").getAttribute("name") === NOC) : null;
  if (after) atts.insertBefore(att, after);
  const d = sub(att, "doc", null, { name });
  const ident = doc.getElementsByTagNameNS(AKN, "FRBRWork")[0];
  const uri = ident && kid(ident, "FRBRuri") ? kid(ident, "FRBRuri").getAttribute("value") : "/akn/in/bill/0000/bill";
  const [, year, number] = /\/(\d{4})\/([^/]+)$/.exec(uri) || [, "0000", "bill"];
  const alias = ident && kid(ident, "FRBRalias") ? kid(ident, "FRBRalias").getAttribute("value") : "Bill";
  const date = (() => { const e = doc.getElementsByTagNameNS(AKN, "FRBRExpression")[0]; const f = e && kid(e, "FRBRdate"); return f ? f.getAttribute("date") : new Date().toLocaleDateString("en-CA"); })();
  scheduleMeta(d, alias, TITLES[name], year, number, date, kids(atts).indexOf(att) + 1);
  for (const t of d.getElementsByTagNameNS(AKN, "FRBRthis")) t.setAttribute("value", t.getAttribute("value").replace(/!schedule_\d+$/, "!" + name));
  const pre = sub(d, "preface");
  sub(pre, "p", TITLES[name], { class: "title" });
  sub(d, "mainBody");
  return att;
}

/* Headings are often in Title Case; in a sentence their ordinary words go lower case, while the names the
   Bill itself writes with capitals (Digital Gazette, Jan Vishwas) keep them. */
function sentenceCase(heading, doc) {
  // the running text of the Bill (not its headings, which are capitalised anyway)
  const b = body(doc), t = b ? Array.from(b.getElementsByTagNameNS(AKN, "p"), p => txt(p)).join(" | ") : "";
  const all = kids(top(doc)).filter(c => !["meta", "attachments"].includes(c.localName))
    .flatMap(c => Array.from(c.getElementsByTagNameNS(AKN, "p"), p => txt(p))).join(" | ");
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const count = re => (t.match(re) || []).length;
  const midCaps = phrase => count(new RegExp(`[a-z,;]\\s${esc(phrase)}\\b`, "g"));     // capitals inside a sentence
  let words = heading.replace(/[.\s—–-]+$/, "").split(/\s+/).filter(Boolean);
  if (words.filter(w => /[a-z]/.test(w)).length === 0)                                   // A HEADING IN CAPITALS
    words = words.map(w => w.length > 1 && /^[A-Z]+$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w);
  const out = [];
  const isCap = w => /^[A-Z][a-z]/.test(w);
  for (let i = 0; i < words.length;) {
    if (!isCap(words[i])) { out.push(words[i]); i++; continue; }
    let j = i; while (j < words.length && isCap(words[j])) j++;
    let k = j;
    for (; k > i; k--) {
      const phrase = words.slice(i, k).join(" ");
      const lower = count(new RegExp(`\\b${esc(phrase.toLowerCase())}\\b`, "g"));
      if (midCaps(phrase) > lower) break;
      // a name the Bill never writes in small letters (Jan Vishwas, Siddhant) keeps its capitals
      if (k - i === 1 && !lower && !new RegExp(`\\b${esc(phrase.toLowerCase())}\\b`).test(all) && new RegExp(`\\b${esc(phrase)}\\b`).test(all)) break;
    }
    if (k > i) { out.push(...words.slice(i, k)); i = k; } else { out.push(words[i].toLowerCase()); i++; }
  }
  return out.join(" ");
}

/* The first words of a note: what the clause does, in the usual form. The reasons are the drafter's. */
export function stubNote(sec, doc) {
  const h = txt(kid(sec, "heading"));
  if (/short title/i.test(h)) return "This clause provides for the short title, extent and commencement of the proposed legislation.";
  if (/^definitions?$/i.test(h)) return "This clause defines certain expressions used in the proposed legislation.";
  if (/repeal/i.test(h)) return `This clause provides for ${sentenceCase(h, doc)}.`;
  if (/power to make rules|rule-making|rules$/i.test(h)) return "This clause empowers the appropriate Government to make rules for carrying out the provisions of the proposed legislation.";
  if (/power to remove difficulties/i.test(h)) return "This clause empowers the Central Government to remove difficulties that may arise in giving effect to the provisions of the proposed legislation.";
  return h ? `This clause seeks to provide for ${sentenceCase(h, doc)}.` : "This clause seeks to provide for ";
}

const clauseNo = sec => (txt(kid(sec, "num")).replace(/[^\w]/g, "")) || "?";
function notes(doc) {
  const att = attachmentOf(doc, NOC);
  return att ? Array.from(att.getElementsByTagNameNS(AKN, "hcontainer")).filter(h => h.getAttribute("name") === "noteOnClause") : [];
}
const target = n => { const hd = kid(n, "heading"), r = hd && kid(hd, "ref"); return r ? (r.getAttribute("href") || "").slice(1) : ""; };
export function noteFor(doc, eid) { return notes(doc).find(n => target(n) === eid) || null; }

function makeNote(doc, sec, text) {
  const n = doc.createElementNS(AKN, "hcontainer");
  n.setAttribute("name", "noteOnClause"); n.setAttribute("eId", "tmp_noc_" + Math.random().toString(36).slice(2, 8));
  const hd = sub(n, "heading");
  sub(hd, "ref", `Clause ${clauseNo(sec)}`, { href: "#" + sec.getAttribute("eId") });
  sub(sub(n, "content"), "p", text);
  return n;
}

/* The Notes on Clauses, made or brought up to date: a note for every clause that has none (its first
   words written), notes for clauses that no longer exist taken out, and all in the order of the clauses.
   What is written in a note is never changed. */
export function updateNotes(doc) {
  const att = ensure(doc, NOC), main = att.getElementsByTagNameNS(AKN, "mainBody")[0];
  const secs = body(doc) ? Array.from(body(doc).getElementsByTagNameNS(AKN, "section")) : [];
  const have = new Map(notes(doc).map(n => [target(n), n]));
  let added = 0, removed = 0;
  for (const [eid, n] of have) if (!secs.some(s => s.getAttribute("eId") === eid)) { n.remove(); have.delete(eid); removed++; }
  for (const s of secs) {
    let n = have.get(s.getAttribute("eId"));
    if (!n) { n = makeNote(doc, s, stubNote(s, doc)); added++; }
    main.appendChild(n);                               // appending in clause order puts them in order
  }
  return { att, added, removed };
}

/* Keep the notes in step after clauses are moved or deleted (no new notes are written). */
export function syncNotes(doc) {
  if (!attachmentOf(doc, NOC)) return 0;
  const main = attachmentOf(doc, NOC).getElementsByTagNameNS(AKN, "mainBody")[0];
  const secs = body(doc) ? Array.from(body(doc).getElementsByTagNameNS(AKN, "section")) : [];
  const ids = new Set(secs.map(s => s.getAttribute("eId")));
  let removed = 0;
  for (const n of notes(doc)) { const t = target(n); if (t && !ids.has(t)) { n.remove(); removed++; } }   // its clause is gone
  const byId = new Map(notes(doc).map(n => [target(n), n]));
  for (const s of secs) { const n = byId.get(s.getAttribute("eId")); if (n) main.appendChild(n); }
  return removed;
}

export function addNote(doc, sec) {
  const existing = noteFor(doc, sec.getAttribute("eId"));
  if (existing) return existing;
  ensure(doc, NOC);
  const n = makeNote(doc, sec, stubNote(sec, doc));
  attachmentOf(doc, NOC).getElementsByTagNameNS(AKN, "mainBody")[0].appendChild(n);
  syncNotes(doc);
  return n;
}

function ordinalDate(d) {
  const day = d.getDate(), s = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `The ${day}${s} ${d.toLocaleString("en-GB", { month: "long" })}, ${d.getFullYear()}.`;
}

/* The Statement of Objects and Reasons, begun: two paragraphs for the drafter to say why the law is
   needed, one listing what the Bill provides (from its chapters, or its clauses if it has none), the
   closing sentence, and the place, date and Minister's signature. */
export function makeStatement(doc) {
  const existing = attachmentOf(doc, SOR);
  if (existing) return { att: existing, made: false };
  const att = ensure(doc, SOR), main = att.getElementsByTagNameNS(AKN, "mainBody")[0];
  const para = (n, text) => { const p = sub(main, "paragraph", null, { eId: `tmp_sor_${n}` }); sub(p, "num", `${n}.`); if (text !== undefined) sub(sub(p, "content"), "p", text); return p; };
  para(1, ""); para(2, "");
  const alias = (() => { const w = doc.getElementsByTagNameNS(AKN, "FRBRWork")[0]; const a = w && kid(w, "FRBRalias"); return a ? a.getAttribute("value") : "The Bill"; })();
  const b = body(doc);
  const chapters = b ? kids(b).filter(c => c.localName === "chapter" || c.localName === "part") : [];
  const items = (chapters.length ? chapters : (b ? Array.from(b.getElementsByTagNameNS(AKN, "section")) : []))
    .map(c => sentenceCase(txt(kid(c, "heading")), doc)).filter(h => h && !/^preliminary$/i.test(h) && !/^miscellaneous$/i.test(h));
  const p3 = para(3);
  sub(sub(p3, "intro"), "p", `${alias}, inter alia, seeks to provide for—`);
  items.forEach((t, i) => {
    const sp = sub(p3, "subparagraph", null, { eId: `tmp_sor_3_${i}` });
    sub(sp, "num", `(${String.fromCharCode(97 + (i % 26))})`);
    sub(sub(sp, "content"), "p", t + (i === items.length - 1 ? "." : i === items.length - 2 ? "; and" : ";"));
  });
  para(4, "The Bill seeks to achieve the above objectives.");
  sub(main, "p", "NEW DELHI;", { class: "place" });
  sub(main, "p", ordinalDate(new Date()), { class: "date" });
  sub(main, "p", "MINISTER-IN-CHARGE", { class: "signature" });
  return { att, made: true };
}
