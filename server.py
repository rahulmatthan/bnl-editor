#!/usr/bin/env python3
"""BNL Editor: draft and amend legislation in Bharat Niti Lipi. A local panel for Desk.

Serves web/ and the instruments in instruments/<id>/<id>.xml on 127.0.0.1:47650.
The XML file is the truth; the page edits it and every save is checked.

  GET  /api/instruments                       the library
  GET  /api/spec                              BNL version, attribute vocabularies, stages, State codes
  POST /api/new      {title, year, number?}   a new Bill
  POST /api/import   {text, title?, year?}    a Bill from its plain text
  GET  /api/i/<id>                            the XML
  PUT  /api/i/<id>                            save the XML (new provisions get eIds) -> {renamed, checks}
  GET  /api/i/<id>/checks                     check the saved file
  POST /api/i/<id>/renumber                   regenerate every eId from the numbers (drafts only)
  GET  /api/i/<id>/stages                     the authentication record and its verification
  GET  /api/i/<id>/stages/<n>                 the text authenticated at stage n
  POST /api/i/<id>/authenticate {stage, officer, date?}
"""

import json
import os
import re
import sys
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from bnl import akn, bill, checks, stages  # noqa: E402

LIB = Path(os.environ.get("BNL_LIBRARY", ROOT / "instruments"))
WEB = ROOT / "web"
SPEC_DIR = ROOT / "spec" / "bnl-0.1"
PORT = int(os.environ.get("BNL_PORT", "47650"))
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".mjs": "text/javascript; charset=utf-8", ".wasm": "application/wasm",
         ".xsd": "application/xml", ".sch": "application/xml",
         ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json"}
ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")

# ISO 3166-2:IN, as lex-kernel uses them. The renamed States' codes (Odisha OR, Uttarakhand UT,
# Chhattisgarh CT) are to be checked against the current ISO list before production use.
STATES = {
    "IN": "All of India", "IN-AN": "Andaman and Nicobar Islands", "IN-AP": "Andhra Pradesh",
    "IN-AR": "Arunachal Pradesh", "IN-AS": "Assam", "IN-BR": "Bihar", "IN-CH": "Chandigarh",
    "IN-CT": "Chhattisgarh", "IN-DH": "Dadra and Nagar Haveli and Daman and Diu", "IN-DL": "Delhi",
    "IN-GA": "Goa", "IN-GJ": "Gujarat", "IN-HP": "Himachal Pradesh", "IN-HR": "Haryana",
    "IN-JH": "Jharkhand", "IN-JK": "Jammu and Kashmir", "IN-KA": "Karnataka", "IN-KL": "Kerala",
    "IN-LA": "Ladakh", "IN-LD": "Lakshadweep", "IN-MH": "Maharashtra", "IN-ML": "Meghalaya",
    "IN-MN": "Manipur", "IN-MP": "Madhya Pradesh", "IN-MZ": "Mizoram", "IN-NL": "Nagaland",
    "IN-OR": "Odisha", "IN-PB": "Punjab", "IN-PY": "Puducherry", "IN-RJ": "Rajasthan",
    "IN-SK": "Sikkim", "IN-TG": "Telangana", "IN-TN": "Tamil Nadu", "IN-TR": "Tripura",
    "IN-UP": "Uttar Pradesh", "IN-UT": "Uttarakhand", "IN-WB": "West Bengal",
}


def spec():
    xsd = (checks.SPEC / "bnl.xsd").read_text()
    def enum(attr):
        block = xsd.split(f'name="{attr}"', 1)[1].split("</xs:attribute>", 1)[0]
        return re.findall(r'value="([^"]+)"/>\s*(?:<!--\s*(.*?)\s*-->)?', block)
    return {
        "version": checks.BNL_VERSION,
        "basis": [{"value": v, "note": n} for v, n in enum("basis")],
        "fidelity": [{"value": v, "note": n} for v, n in enum("fidelity")],
        "states": STATES,
        "stages": stages.STAGES,
    }


def folder(i):
    if not ID.match(i):
        raise KeyError(i)
    f = LIB / i
    if not (f / f"{i}.xml").exists():
        raise KeyError(i)
    return f


def xml_path(i):
    return folder(i) / f"{i}.xml"


def describe(f: Path):
    i = f.name
    p = f / f"{i}.xml"
    try:
        root = akn.parse(p.read_bytes())
        doc = next(iter(root))
        alias = doc.find(f"{akn.q('meta')}/{akn.q('identification')}/{akn.q('FRBRWork')}/{akn.q('FRBRalias')}")
        uri = doc.find(f"{akn.q('meta')}/{akn.q('identification')}/{akn.q('FRBRWork')}/{akn.q('FRBRuri')}")
        title = alias.get("value") if alias is not None else i
        return {"id": i, "title": title, "uri": uri.get("value") if uri is not None else "",
                "type": akn.local(doc.tag), "stages": len(stages.read_log(f)), "mtime": p.stat().st_mtime,
                "markup": (f / "base.xml").exists()}
    except Exception as e:
        return {"id": i, "title": i, "error": str(e), "stages": 0, "mtime": p.stat().st_mtime}


def library():
    LIB.mkdir(exist_ok=True)
    items = [describe(f) for f in sorted(LIB.iterdir()) if f.is_dir() and (f / f"{f.name}.xml").exists()]
    return sorted(items, key=lambda d: -d["mtime"])


def unique_id(base):
    base = (bill.slug(base) or "bill")[:60]
    i, n = base, 1
    while (LIB / i).exists():
        n += 1
        i = f"{base}-{n}"
    return i


def create(root, base):
    i = unique_id(base)
    (LIB / i).mkdir(parents=True)
    (LIB / i / f"{i}.xml").write_bytes(akn.serialize(root))
    return i


def write_atomic(p: Path, data: bytes):
    tmp = p.with_suffix(".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, p)


def save(i, data: bytes):
    root = akn.parse(data)              # raises on malformed XML
    renamed = akn.assign_eids(root)
    p = xml_path(i)
    write_atomic(p, akn.serialize(root))
    res = checks.run(p)
    return {"renamed": renamed, "checks": res, "summary": checks.summary(res), "mtime": p.stat().st_mtime}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n)

    def route(self, method):
        path = urlparse(self.path).path
        try:
            if method == "GET" and not path.startswith("/api/"):
                rel = "index.html" if path in ("/", "") else path.lstrip("/")
                # spec/ is served from the spec folder, as the web version publishes it beside the page
                base = SPEC_DIR if rel.startswith("spec/") else WEB
                f = (base / (rel[5:] if base is SPEC_DIR else rel)).resolve()
                if base.resolve() not in f.parents or not f.is_file():
                    return self.send(404, {"error": "not found"})
                return self.send(200, f.read_bytes(), TYPES.get(f.suffix, "application/octet-stream"))
            parts = path.strip("/").split("/")[1:]
            if parts == ["instruments"] and method == "GET":
                return self.send(200, library())
            if parts == ["spec"] and method == "GET":
                return self.send(200, spec())
            if parts == ["new"] and method == "POST":
                d = json.loads(self.body() or b"{}")
                title = (d.get("title") or "").strip() or "Untitled Bill"
                year = str(d.get("year") or "") or re.search(r"\d{4}", title + " 2026").group(0)
                root = bill.new_bill(title, year, (d.get("number") or "").strip() or None)
                return self.send(200, {"id": create(root, title)})
            if parts == ["open"] and method == "POST":
                # a BNL file (or a Bill the page generated), kept exactly as it came
                d = json.loads(self.body() or b"{}")
                data = (d.get("xml") or "").encode("utf-8")
                root = akn.parse(data)
                if not root.tag.startswith(f"{{{akn.AKN}}}"):
                    return self.send(400, {"error": "That file is not Akoma Ntoso (BNL)."})
                i = unique_id(re.sub(r"\.xml$", "", d.get("name") or "instrument"))
                (LIB / i).mkdir(parents=True)
                (LIB / i / f"{i}.xml").write_bytes(data)
                return self.send(200, {"id": i})
            if parts == ["import"] and method == "POST":
                d = json.loads(self.body() or b"{}")
                root = bill.import_text(d.get("text") or "", d.get("title") or None, d.get("year") or None)
                alias = root.find(f".//{akn.q('FRBRalias')}").get("value")
                return self.send(200, {"id": create(root, d.get("title") or alias)})
            if parts and parts[0] == "i" and len(parts) >= 2:
                i = parts[1]
                rest = parts[2:]
                if not rest and method == "GET":
                    return self.send(200, xml_path(i).read_bytes(), "application/xml; charset=utf-8")
                if not rest and method == "PUT":
                    try:
                        return self.send(200, save(i, self.body()))
                    except Exception as e:
                        return self.send(400, {"error": f"Not saved: the document is not well-formed XML ({e})"})
                if rest == ["markup"] and method == "POST":
                    # a copy of the Act to mark up; the Act as it stands is kept beside it as base.xml
                    src = xml_path(i).read_bytes()
                    j = unique_id(f"{i}-markup")
                    (LIB / j).mkdir(parents=True)
                    (LIB / j / f"{j}.xml").write_bytes(src)
                    (LIB / j / "base.xml").write_bytes(src)
                    return self.send(200, {"id": j})
                if rest == ["base"] and method == "GET":
                    b = folder(i) / "base.xml"
                    if not b.exists():
                        return self.send(404, {"error": "not a mark-up"})
                    return self.send(200, b.read_bytes(), "application/xml; charset=utf-8")
                if rest == ["checks"] and method == "GET":
                    res = checks.run(xml_path(i))
                    return self.send(200, {"checks": res, "summary": checks.summary(res)})
                if rest == ["renumber"] and method == "POST":
                    if stages.read_log(folder(i)):
                        return self.send(409, {"error": "This instrument has been authenticated; its identifiers are now permanent."})
                    root = akn.parse(xml_path(i).read_bytes())
                    renamed = akn.assign_eids(root, renumber=True)
                    write_atomic(xml_path(i), akn.serialize(root))
                    return self.send(200, {"renamed": renamed})
                if rest == ["stages"] and method == "GET":
                    f = folder(i)
                    return self.send(200, {"entries": stages.read_log(f), "verify": stages.verify(f)})
                if len(rest) == 2 and rest[0] == "stages" and method == "GET":
                    f = folder(i)
                    e = next((e for e in stages.read_log(f) if str(e["n"]) == rest[1]), None)
                    if not e:
                        return self.send(404, {"error": "no such stage"})
                    return self.send(200, (f / e["file"]).read_bytes(), "application/xml; charset=utf-8")
                if rest == ["authenticate"] and method == "POST":
                    d = json.loads(self.body() or b"{}")
                    f = folder(i)
                    try:
                        entry, refused = stages.authenticate(f, f"{i}.xml", d.get("stage", ""), d.get("officer", ""),
                                                             d.get("date") or None)
                    except ValueError as e:
                        return self.send(400, {"error": str(e)})
                    if refused is not None:
                        return self.send(422, {"error": "Refused: the instrument has errors.",
                                               "checks": refused})
                    return self.send(200, {"entry": entry})
            return self.send(404, {"error": "not found"})
        except KeyError:
            return self.send(404, {"error": "no such instrument"})
        except Exception as e:  # report, do not crash the panel
            return self.send(500, {"error": f"{type(e).__name__}: {e}"})

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")


def main():
    LIB.mkdir(exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    print(f"BNL Editor on http://127.0.0.1:{PORT}/  (library: {LIB})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
