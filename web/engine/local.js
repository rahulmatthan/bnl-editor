/* The editor without a server: the same API the page uses with server.py, answered in the browser.
   Instruments live in this browser's IndexedDB; nothing leaves the machine. */

import * as akn from "./akn.js";
import * as bill from "./bill.js";
import * as checks from "./checks.js";

const BASE = new URL("../", import.meta.url).href;          // the web folder
const SPEC = BASE + "spec/";
const VENDOR = BASE + "vendor/xmllint-wasm-5.3.0/";
const CFG = { specBase: SPEC, vendor: VENDOR };

/* -- storage -------------------------------------------------------------------------------------- */

let dbp = null;
function db() {
  dbp = dbp || new Promise((res, rej) => {
    const q = indexedDB.open("bnl-editor", 1);
    q.onupgradeneeded = () => q.result.createObjectStore("instruments", { keyPath: "id" });
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction("instruments", mode), s = t.objectStore("instruments");
    const q = fn(s);
    t.oncomplete = () => res(q && q.result);
    t.onerror = () => rej(t.error);
  });
}
const getRec = id => tx("readonly", s => s.get(id));
const putRec = rec => tx("readwrite", s => s.put(rec));
const delRec = id => tx("readwrite", s => s.delete(id));
const allRecs = () => tx("readonly", s => s.getAll());

/* -- helpers -------------------------------------------------------------------------------------- */

class ApiError extends Error { constructor(status, msg, body) { super(msg); this.status = status; this.body = body || { error: msg }; } }

function describe(rec) {
  try {
    const doc = akn.parse(rec.xml);
    const alias = doc.getElementsByTagNameNS(akn.AKN, "FRBRalias")[0];
    const uri = doc.getElementsByTagNameNS(akn.AKN, "FRBRuri")[0];
    const top = doc.documentElement.children[0];
    return { id: rec.id, title: alias ? alias.getAttribute("value") : rec.id, uri: uri ? uri.getAttribute("value") : "",
      type: top ? top.localName : "", stages: 0, mtime: rec.mtime, markup: !!rec.base };
  } catch (e) { return { id: rec.id, title: rec.id, error: e.message, stages: 0, mtime: rec.mtime }; }
}

async function uniqueId(base) {
  base = (bill.slug(base || "") || "bill").slice(0, 60);
  let id = base, n = 1;
  while (await getRec(id)) { n++; id = `${base}-${n}`; }
  return id;
}

async function create(doc, base) {
  const id = await uniqueId(base);
  await putRec({ id, xml: akn.serialize(doc), mtime: Date.now() / 1000 });
  return id;
}

const STATES = { "IN": "All of India", "IN-AN": "Andaman and Nicobar Islands", "IN-AP": "Andhra Pradesh",
  "IN-AR": "Arunachal Pradesh", "IN-AS": "Assam", "IN-BR": "Bihar", "IN-CH": "Chandigarh", "IN-CT": "Chhattisgarh",
  "IN-DH": "Dadra and Nagar Haveli and Daman and Diu", "IN-DL": "Delhi", "IN-GA": "Goa", "IN-GJ": "Gujarat",
  "IN-HP": "Himachal Pradesh", "IN-HR": "Haryana", "IN-JH": "Jharkhand", "IN-JK": "Jammu and Kashmir",
  "IN-KA": "Karnataka", "IN-KL": "Kerala", "IN-LA": "Ladakh", "IN-LD": "Lakshadweep", "IN-MH": "Maharashtra",
  "IN-ML": "Meghalaya", "IN-MN": "Manipur", "IN-MP": "Madhya Pradesh", "IN-MZ": "Mizoram", "IN-NL": "Nagaland",
  "IN-OR": "Odisha", "IN-PB": "Punjab", "IN-PY": "Puducherry", "IN-RJ": "Rajasthan", "IN-SK": "Sikkim",
  "IN-TG": "Telangana", "IN-TN": "Tamil Nadu", "IN-TR": "Tripura", "IN-UP": "Uttar Pradesh", "IN-UT": "Uttarakhand",
  "IN-WB": "West Bengal" };

async function spec() {
  const files = await checks.spec(SPEC);
  const xsd = files["bnl.xsd"];
  const enumOf = attr => {
    const block = xsd.split(`name="${attr}"`)[1].split("</xs:attribute>")[0];
    return Array.from(block.matchAll(/value="([^"]+)"\/>\s*(?:<!--\s*(.*?)\s*-->)?/g), m => ({ value: m[1], note: m[2] || "" }));
  };
  return { version: checks.BNL_VERSION, basis: enumOf("basis"), fidelity: enumOf("fidelity"), states: STATES, stages: [], local: true };
}

async function save(id, xml) {
  if (!(await getRec(id))) throw new ApiError(404, "no such instrument");
  let doc;
  try { doc = akn.parse(xml); } catch (e) { throw new ApiError(400, `Not saved: the document is not well-formed XML (${e.message})`); }
  const renamed = akn.assignEids(doc);
  const out = akn.serialize(doc);
  const mtime = Date.now() / 1000;
  const prev = await getRec(id);
  await putRec({ ...prev, id, xml: out, mtime });
  const res = await checks.run(out, CFG);
  return { renamed, checks: res, summary: checks.summary(res), mtime };
}

/* -- the API -------------------------------------------------------------------------------------- */

const json = opts => { try { return JSON.parse(opts.body || "{}"); } catch (e) { return {}; } };

export async function api(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const parts = path.split("?")[0].split("/").filter(Boolean);
  if (parts[0] === "instruments" && method === "GET") return (await allRecs()).map(describe).sort((a, b) => b.mtime - a.mtime);
  if (parts[0] === "spec") return spec();
  if (parts[0] === "new" && method === "POST") {
    const d = json(opts);
    const title = (d.title || "").trim() || "Untitled Bill";
    const year = String(d.year || "").trim() || (/\d{4}/.exec(title + " " + new Date().getFullYear()) || [])[0];
    return { id: await create(bill.newBill(title, year, (d.number || "").trim() || null), title) };
  }
  if (parts[0] === "import" && method === "POST") {
    const d = json(opts);
    const doc = bill.importText(d.text || "", { title: d.title || null, year: d.year || null });
    const alias = doc.getElementsByTagNameNS(akn.AKN, "FRBRalias")[0].getAttribute("value");
    return { id: await create(doc, d.title || alias) };
  }
  if (parts[0] === "open" && method === "POST") {             // an XML file the user chose
    const d = json(opts);
    let doc;
    try { doc = akn.parse(d.xml || ""); } catch (e) { throw new ApiError(400, "That file is not well-formed XML: " + e.message); }
    if (doc.documentElement.namespaceURI !== akn.AKN) throw new ApiError(400, "That file is not Akoma Ntoso (BNL).");
    const base = bill.slug((d.name || "instrument").replace(/\.xml$/i, "")) || "instrument";
    const same = await getRec(base);
    if (same && same.xml === d.xml) return { id: base };          // already here, unchanged
    const id = await uniqueId(base);
    await putRec({ id, xml: d.xml, mtime: Date.now() / 1000 });   // kept exactly as it came
    return { id };
  }
  if (parts[0] === "i" && parts[1]) {
    const id = parts[1], rest = parts.slice(2);
    const rec = await getRec(id);
    if (!rec) throw new ApiError(404, "no such instrument");
    if (!rest.length && method === "GET") return rec.xml;
    if (!rest.length && method === "PUT") return save(id, opts.body);
    if (!rest.length && method === "DELETE") { await delRec(id); return { ok: true }; }
    if (rest[0] === "markup" && method === "POST") {
      const nid = await uniqueId(`${id}-markup`);
      await putRec({ id: nid, xml: rec.xml, base: rec.xml, mtime: Date.now() / 1000 });
      return { id: nid };
    }
    if (rest[0] === "base") { if (!rec.base) throw new ApiError(404, "not a mark-up"); return rec.base; }
    if (rest[0] === "checks") { const res = await checks.run(rec.xml, CFG); return { checks: res, summary: checks.summary(res) }; }
    if (rest[0] === "renumber" && method === "POST") {
      const doc = akn.parse(rec.xml);
      const renamed = akn.assignEids(doc, true);
      await putRec({ ...rec, xml: akn.serialize(doc), mtime: Date.now() / 1000 });
      return { renamed };
    }
    if (rest[0] === "stages") return { entries: [], verify: [] };
  }
  throw new ApiError(404, "not found");
}

/* -- Word files: the text of a .docx, paragraph by paragraph ------------------------------------------ */

export async function docxText(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("That is not a Word (.docx) file.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true), entry = null;
  for (let k = 0; k < count; k++) {
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    if (name === "word/document.xml") entry = { method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), off: dv.getUint32(p + 42, true) };
    p += 46 + nlen + xlen + clen;
  }
  if (!entry) throw new Error("That Word file has no document text.");
  const lh = entry.off, start = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
  let data = u8.subarray(start, start + entry.size);
  if (entry.method === 8) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
  const xml = new DOMParser().parseFromString(new TextDecoder().decode(data), "application/xml");
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const out = [];
  for (const para of xml.getElementsByTagNameNS(W, "p")) {
    let t = "";
    for (const n of para.getElementsByTagNameNS(W, "*")) {
      if (n.localName === "t") t += n.textContent;
      else if (n.localName === "tab") t += " ";
      else if (n.localName === "br") t += "\n";
    }
    out.push(t);
  }
  return out.join("\n");
}
