/* Publication: a BNL (Akoma Ntoso) document as a web page anyone can read. The same page, printed,
   is the PDF; the XML it was made from is published beside it, and the page names that file and its
   SHA-256 so a reader can check that the two are the same text. Browser only (DOMParser). */

const AKN = "http://docs.oasis-open.org/legaldocml/ns/akn/3.0";
const GROUPS = new Set(["part", "chapter", "subchapter", "subpart", "title", "book", "division"]);
const HEADED = new Set(["section", "article", "rule"]);
const HIER = new Set(["part", "chapter", "subchapter", "subpart", "section", "subsection", "clause", "subclause",
  "point", "paragraph", "subparagraph", "rule", "subrule", "article", "proviso", "hcontainer", "item", "list",
  "title", "book", "division", "level", "alinea", "indent", "sublist"]);
const BLOCKS = new Set(["intro", "content", "wrapUp", "longTitle", "formula", "recitals", "recital", "citations",
  "citation", "blockContainer", "container", "div", "preamble", "preface", "conclusions", "mainBody", "body"]);
const SKIP = new Set(["meta", "num", "heading", "subheading"]);
const INLINE_TAG = { b: "b", i: "i", u: "u", sup: "sup", sub: "sub", del: "del", ins: "ins", abbr: "abbr" };

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const kids = x => Array.from(x.children);
const kid = (x, n) => kids(x).find(c => c.localName === n && c.namespaceURI === AKN) || null;
const txt = x => x ? x.textContent.replace(/\s+/g, " ").trim() : "";
const idAttr = x => x.getAttribute && x.getAttribute("eId") ? ` id="${esc(x.getAttribute("eId"))}"` : "";

export function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80); }

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}

/* What the files are called and what the page says about the instrument. */
export function describe(doc) {
  const top = doc.documentElement.children[0];
  const val = (frbr, tag) => { const f = doc.getElementsByTagNameNS(AKN, frbr)[0]; const t = f && kid(f, tag); return t ? (t.getAttribute("value") || t.getAttribute("date") || "") : ""; };
  const title = val("FRBRWork", "FRBRalias") || txt(doc.getElementsByTagNameNS(AKN, "docTitle")[0]) || "Untitled";
  const date = val("FRBRExpression", "FRBRdate");
  return { type: top ? top.localName : "", title, work: val("FRBRWork", "FRBRuri"), expression: val("FRBRExpression", "FRBRuri"),
    date, base: `${slug(title)}${date ? "-" + date : ""}` };
}

function inline(x, ctx) {
  let out = "";
  for (const n of Array.from(x.childNodes)) {
    if (n.nodeType === 3) { out += esc(n.nodeValue); continue; }
    if (n.nodeType !== 1) continue;
    const name = n.localName;
    if (INLINE_TAG[name]) out += `<${INLINE_TAG[name]}>${inline(n, ctx)}</${INLINE_TAG[name]}>`;
    else if (name === "ref" || name === "rref" || name === "mref") {
      const href = n.getAttribute("href") || "";
      if (href.startsWith("#") && !href.startsWith("#deleted__")) out += `<a class="ref" href="${esc(href)}">${inline(n, ctx)}</a>`;
      else if (href) out += `<span class="xref" title="${esc(href)}">${inline(n, ctx)}</span>`;
      else out += inline(n, ctx);
    }
    else if (name === "eol" || name === "br") out += "<br>";
    else if (name === "def") out += `<dfn>${inline(n, ctx)}</dfn>`;
    else if (name === "authorialNote") {
      ctx.notes.push(blocks(n, ctx));
      const k = ctx.notes.length;
      out += `<sup class="fn"><a id="fnref${k}" href="#fn${k}">${k}</a></sup>`;
    }
    else if (name === "noteRef") out += "";
    else if (name === "quotedStructure" || name === "embeddedStructure") out += `<span class="qs">${blocks(n, ctx)}</span>`;
    else if (name === "quotedText" && /namely:\s*[—–-]+\s*$/.test((n.previousSibling && n.previousSibling.nodeValue) || "")) {
      // the text inserted, on its own lines, with the stop or semicolon after it kept on its last line
      const nx = n.nextSibling, tail = nx && nx.nodeType === 3 && /^\s*[.;,:]+\s*$/.test(nx.nodeValue) ? nx.nodeValue.trim() : "";
      if (tail) nx.nodeValue = "";
      out += `<span class="qs"${idAttr(n)}>${inline(n, ctx)}${esc(tail)}</span>`;
    }
    else if (name === "img") out += `<img src="${esc(n.getAttribute("src") || "")}" alt="${esc(n.getAttribute("alt") || "")}">`;
    else out += `<span class="${esc(name)}"${idAttr(n)}>${inline(n, ctx)}</span>`;
  }
  return out;
}

function table(x, ctx) {
  let out = `<table${idAttr(x)}>`;
  for (const tr of kids(x).filter(c => c.localName === "tr")) {
    out += "<tr>";
    for (const c of kids(tr)) {
      const tag = c.localName === "th" ? "th" : "td";
      const span = ["rowspan", "colspan"].map(a => c.getAttribute(a) ? ` ${a}="${esc(c.getAttribute(a))}"` : "").join("");
      out += `<${tag}${span}>${blocks(c, ctx)}</${tag}>`;
    }
    out += "</tr>";
  }
  return out + "</table>";
}

/* Block content: paragraphs, tables, lists and provisions, in order. */
function blocks(x, ctx) {
  let out = "";
  for (const c of kids(x)) {
    const name = c.localName;
    if (c.namespaceURI !== AKN || SKIP.has(name)) continue;
    if (name === "p") out += `<p${c.getAttribute("class") ? ` class="${esc(c.getAttribute("class"))}"` : ""}${idAttr(c)}>${inline(c, ctx)}</p>`;
    else if (name === "table") out += table(c, ctx);
    else if (name === "blockList") out += `<div class="blist"${idAttr(c)}>${blocks(c, ctx)}</div>`;
    else if (name === "listIntroduction" || name === "listWrapUp") out += `<p>${inline(c, ctx)}</p>`;
    else if (HIER.has(name) || name === "item") out += prov(c, ctx);
    else if (BLOCKS.has(name)) out += `<div class="${esc(name)}"${idAttr(c)}>${blocks(c, ctx)}</div>`;
    else if (name === "tblock" || name === "foreign" || name === "block") out += `<div class="${esc(name)}">${blocks(c, ctx) || inline(c, ctx)}</div>`;
    else out += kids(c).length ? blocks(c, ctx) : `<p>${inline(c, ctx)}</p>`;
  }
  return out;
}

/* A provision. Chapters and sections have a heading line; below them the number hangs in the margin of
   the first line ("(1) This Act may be called …"). Every provision has its eId as its id, so a reference
   in the text, or a link from elsewhere (page.html#sec_14__subsec_2), lands on it. */
function prov(x, ctx) {
  const name = x.localName, id = x.getAttribute("eId") || "";
  const num = txt(kid(x, "num")), head = kid(x, "heading");
  const self = id ? `<a class="num" href="#${esc(id)}">${esc(num)}</a>` : `<span class="num">${esc(num)}</span>`;
  if (GROUPS.has(name)) {
    if (ctx.toc && id) ctx.toc.push({ id, grp: true, label: `${num} ${txt(head)}`.trim() });
    return `<section class="grp k-${name}"${idAttr(x)}><h2>${num ? `<span class="gnum">${self}</span>` : ""}` +
      `${head ? `<span class="ghead">${inline(head, ctx)}</span>` : ""}</h2>${blocks(x, ctx)}</section>`;
  }
  if (HEADED.has(name) || (head && name !== "hcontainer")) {
    if (ctx.toc && id && HEADED.has(name)) ctx.toc.push({ id, label: `${num} ${txt(head)}`.trim() });
    return `<section class="sec k-${name}"${idAttr(x)}><h3>${num ? self + " " : ""}${head ? inline(head, ctx) : ""}</h3>${blocks(x, ctx)}</section>`;
  }
  if (name === "hcontainer" && x.getAttribute("name") === "noteOnClause" && head) {
    // "Clause 7.—This clause seeks to provide for …", as Notes on Clauses are printed
    const lead = `<b>${inline(head, ctx)}.</b>—`;
    const b = blocks(x, ctx);
    return `<div class="noc"${idAttr(x)}>${/^<div class="content"[^>]*><p[^>]*>/.test(b) ? b.replace(/^(<div class="content"[^>]*><p[^>]*>)/, `$1${lead}`) : `<p>${lead}</p>${b}`}</div>`;
  }
  let body = blocks(x, ctx);
  let lead = name === "hcontainer" && head ? `<span class="xhead">${inline(head, ctx)}</span>` : "";
  if (num) lead = self + " " + lead;
  if (lead) body = /^<div class="(intro|content)"[^>]*><p[^>]*>/.test(body)
    ? body.replace(/^(<div class="(?:intro|content)"[^>]*><p[^>]*>)/, `$1${lead}`)
    : `<p>${lead}</p>` + body;
  return `<div class="prov k-${name}${num ? " numbered" : ""}"${idAttr(x)}>${body}</div>`;
}

const CSS = `
:root { --ink:#1b1a18; --muted:#6b675f; --line:#dcd8cf; --bg:#fdfcf9; --accent:#1f5f8b; --law:"Iowan Old Style","Charter","Georgia",serif; --ui:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
@media (prefers-color-scheme: dark) { :root { --ink:#ecebe7; --muted:#a29e95; --line:#3a3936; --bg:#1b1b1a; --accent:#8cc4ec; } }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 16px; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 17px/1.6 var(--law); }
.wrap { display: grid; grid-template-columns: 270px minmax(0, 1fr); max-width: 1180px; margin: 0 auto; }
nav.toc { position: sticky; top: 0; height: 100vh; overflow: auto; padding: 24px 14px; font: 13px/1.4 var(--ui); border-right: 1px solid var(--line); }
nav.toc a { display: block; color: var(--ink); text-decoration: none; padding: 2px 6px; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
nav.toc a:hover { background: rgba(127,127,127,.12); }
nav.toc a.g { margin-top: 10px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
nav.toc .tools { display: flex; gap: 6px; margin-bottom: 14px; }
nav.toc .tools a { border: 1px solid var(--line); padding: 4px 9px; display: inline-block; }
main { padding: 40px 32px 80px; max-width: 800px; }
.preface { text-align: center; }
.preface .title, h1 { font-size: 24px; font-weight: 700; letter-spacing: .02em; margin: 0 0 14px; }
.longTitle p { font-style: italic; margin: 0 0 18px; }
.preamble p { margin: 0 0 10px; }
.formula { margin: 18px 0 10px; text-indent: 2em; }
section.grp > h2 { text-align: center; font-size: 17px; font-weight: 700; margin: 34px 0 14px; line-height: 1.4; }
section.grp > h2 .gnum, section.grp > h2 .ghead { display: block; }
section.sec > h3 { font-size: 17px; font-weight: 700; margin: 20px 0 6px; }
p { margin: 0 0 6px; }
.prov.numbered { padding-left: 2.6em; }
.prov.numbered > div > p:first-child > a.num:first-child, .prov.numbered > p:first-child > a.num:first-child { display: inline-block; width: 2.6em; margin-left: -2.6em; }
.prov .prov { margin-top: 2px; }
.k-proviso, .k-hcontainer { margin-top: 4px; }
.k-proviso p:first-child { text-indent: 2em; }
.xhead { font-style: italic; }
a.num { color: inherit; text-decoration: none; }
a.num:hover { color: var(--accent); }
a.ref { color: var(--accent); text-decoration: underline; text-decoration-color: rgba(31,95,139,.35); text-underline-offset: 2px; }
.xref { border-bottom: 1px dotted var(--muted); }
:target { background: rgba(255, 214, 102, .28); border-radius: 3px; }
table { border-collapse: collapse; margin: 10px 0; width: 100%; }
td, th { border: 1px solid var(--line); padding: 4px 8px; vertical-align: top; }
.attachment { margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--line); }
.attachment .preface p { margin: 0 0 6px; }
.attachment .preface .title { font-weight: 700; font-size: 18px; }
.noc { margin: 0 0 10px; }
.noc p { text-indent: 2em; }
p.place, p.date { margin: 18px 0 0; }
p.date { margin-top: 0; }
p.signature { text-align: right; font-weight: 700; margin-top: 0; }
.qs { display: block; margin: 6px 0 6px 2em; }
.notes { margin-top: 30px; border-top: 1px solid var(--line); padding-top: 8px; font-size: 14px; }
footer.colophon { margin-top: 56px; padding-top: 14px; border-top: 1px solid var(--line); font: 12px/1.5 var(--ui); color: var(--muted); }
footer.colophon code { font: 11px ui-monospace, Menlo, monospace; word-break: break-all; }
footer.colophon dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0; }
footer.colophon dt { font-weight: 600; }
footer.colophon dd { margin: 0; }
@media (max-width: 860px) { .wrap { display: block; } nav.toc { position: static; height: auto; border: 0; border-bottom: 1px solid var(--line); max-height: 40vh; } main { padding: 24px 16px 60px; } }
@page { size: A4; margin: 22mm 20mm 20mm; @bottom-center { content: counter(page); font: 10pt Georgia, serif; } }
@media print {
  :root { --ink:#000; --muted:#444; --line:#999; --bg:#fff; }
  body { font-size: 11.5pt; line-height: 1.45; }
  nav.toc { display: none; }
  .wrap { display: block; max-width: none; }
  main { padding: 0; max-width: none; }
  a.ref { color: inherit; text-decoration: none; }
  :target { background: none; }
  h2, h3 { break-after: avoid; }
  .attachment { break-before: page; border: 0; }
  footer.colophon { break-inside: avoid; }
}`;

/* The page. opts: xmlName (the published XML file beside it), sha (its SHA-256), published (date). */
export function toHtml(xml, opts = {}) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror")[0]) throw new Error("The document is not well-formed XML.");
  const d = describe(doc);
  const top = doc.documentElement.children[0];
  const ctx = { notes: [], toc: [] };
  let main = "";
  for (const c of kids(top)) {
    const name = c.localName;
    if (name === "meta") continue;
    if (name === "attachments") {
      for (const att of kids(c)) {
        const inner = kids(att).find(k => k.localName === "doc") || att;
        if (att.getAttribute("eId")) ctx.toc.push({ id: att.getAttribute("eId"), grp: true, label: txt(inner.getElementsByTagNameNS(AKN, "p")[0]) || "Schedule" });
        main += `<section class="attachment"${idAttr(att)}>${blocks(inner, ctx)}</section>`;
      }
      continue;
    }
    main += `<div class="${esc(name)}"${idAttr(c)}>${blocks(c, ctx)}</div>`;
  }
  if (ctx.notes.length) main += `<ol class="notes">${ctx.notes.map((n, i) => `<li id="fn${i + 1}">${n} <a href="#fnref${i + 1}">↩</a></li>`).join("")}</ol>`;
  const toc = ctx.toc.map(t => `<a${t.grp ? ' class="g"' : ""} href="#${esc(t.id)}">${esc(t.label)}</a>`).join("");
  const kind = { bill: "Bill", act: "Act", doc: "Document" }[d.type] || d.type;
  const colophon = `<footer class="colophon"><dl>
    <dt>${esc(kind)}</dt><dd>${esc(d.title)}</dd>
    ${d.work ? `<dt>Work</dt><dd><code>${esc(d.work)}</code></dd>` : ""}
    ${d.expression ? `<dt>Version</dt><dd><code>${esc(d.expression)}</code></dd>` : ""}
    ${opts.published ? `<dt>Published</dt><dd>${esc(opts.published)}</dd>` : ""}
    ${opts.xmlName ? `<dt>Source</dt><dd>This text is generated from the BNL (Akoma Ntoso) file <a href="${esc(opts.xmlHref || opts.xmlName)}">${esc(opts.xmlName)}</a>.</dd>` : ""}
    ${opts.sha ? `<dt>SHA-256</dt><dd><code>${esc(opts.sha)}</code></dd>` : ""}
  </dl></footer>`;
  const tools = `<div class="tools">${opts.xmlName ? `<a href="${esc(opts.xmlHref || opts.xmlName)}" download="${esc(opts.xmlName)}">BNL XML</a>` : ""}<a href="#" onclick="print();return false">Print / PDF</a></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title || d.title)}</title>
${d.expression ? `<link rel="alternate" type="application/akn+xml" href="${esc(opts.xmlHref || opts.xmlName || "")}" title="BNL XML">
<meta name="dcterms.identifier" content="${esc(d.expression)}">` : ""}
${opts.sha ? `<meta name="bnl:sha256" content="${esc(opts.sha)}">` : ""}
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<nav class="toc">${tools}${toc}</nav>
<main>${main}${colophon}</main>
</div>
</body>
</html>`;
}
