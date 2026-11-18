"""Run: python3 -m unittest discover -s tests"""

import glob
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from bnl import akn, bill, checks, stages  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "test-bill.txt"
LEX = Path(os.path.expanduser("~/Coding/lex-kernel/out/akn"))


def write(tmp, root, name="x.xml"):
    p = Path(tmp) / name
    p.write_bytes(akn.serialize(root))
    return p


class Lossless(unittest.TestCase):
    @unittest.skipUnless(LEX.exists(), "lex-kernel not on this machine")
    def test_lex_kernel_files_round_trip(self):
        for f in sorted(glob.glob(str(LEX / "*.xml"))):
            data = Path(f).read_bytes()
            r = akn.parse(data)
            words = ["".join(e.itertext()) for e in r.iter(akn.q("p"))]
            attrs = sorted((e.tag, tuple(sorted(e.attrib.items()))) for e in r.iter())
            self.assertEqual(akn.assign_eids(r), {}, f"{f}: saving must not rename existing eIds")
            r2 = akn.parse(akn.serialize(r))
            self.assertEqual(words, ["".join(e.itertext()) for e in r2.iter(akn.q("p"))], f)
            self.assertEqual(attrs, sorted((e.tag, tuple(sorted(e.attrib.items()))) for e in r2.iter()), f)

    def test_mixed_content_untouched(self):
        x = (b'<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0"><act><body><section eId="sec_1">'
             b'<content><p><ref href="#a">s. 2</ref> and <i>x</i></p></content></section></body></act></akomaNtoso>')
        out = akn.serialize(akn.parse(x))
        self.assertIn(b'<p><ref href="#a">s. 2</ref> and <i>x</i></p>', out)


class Import(unittest.TestCase):
    def setUp(self):
        self.root = bill.import_text(FIXTURE.read_text())
        self.ids = [e.get("eId") for e in self.root.iter() if e.get("eId")]

    def test_structure(self):
        for e in ("chp_I", "sec_1__subsec_2", "chp_V", "sec_21__subsec_1__cl_c", "sec_35", "sched_1__para_1"):
            self.assertIn(e, self.ids)
        s21 = next(e for e in self.root.iter(akn.q("subsection")) if e.get("eId") == "sec_21__subsec_1")
        self.assertIsNotNone(s21.find(akn.q("intro")))

    def test_valid_bnl(self):
        with tempfile.TemporaryDirectory() as t:
            res = checks.run(write(t, self.root))
            self.assertEqual([r for r in res if r["level"] == "error"], [])
            # the fixture really does skip chapters II-III and sections 24-34
            self.assertEqual(sorted(r["code"] for r in res if r["level"] == "warning"), ["ED-3", "ED-3"])

    def test_clause_i_after_h(self):
        r = bill.import_text("THE X BILL, 2026\n1. Definitions.—In this Act,—\n(g) g;\n(h) h;\n(i) i;\n(j) j.\n")
        ids = [e.get("eId") for e in r.iter() if e.get("eId")]
        self.assertIn("sec_1__cl_i", ids)
        r = bill.import_text("THE X BILL, 2026\n1. Heading.—(1) It—\n(a) a, namely:—\n(i) one;\n(ii) two.\n")
        ids = [e.get("eId") for e in r.iter() if e.get("eId")]
        self.assertIn("sec_1__subsec_1__cl_a__subcl_ii", ids)


class Ids(unittest.TestCase):
    def test_new_provisions_get_ids_existing_keep_theirs(self):
        root = bill.import_text(FIXTURE.read_text())
        body = root.find(f".//{akn.q('body')}")
        ch = body.find(akn.q("chapter"))
        s = ch.makeelement(akn.q("section"), {"eId": "tmp_9"})
        n = s.makeelement(akn.q("num"), {}); n.text = "2."; s.append(n)
        ch.append(s)
        ren = akn.assign_eids(root)
        self.assertEqual(ren, {"tmp_9": "sec_2"})
        # renumbering a section does not move its eId on save; the check reports it
        sec8 = next(e for e in root.iter(akn.q("section")) if e.get("eId") == "sec_8")
        sec8.find(akn.q("num")).text = "9."
        self.assertEqual(akn.assign_eids(root), {})
        self.assertIn(("sec_8", "sec_9"), akn.expected_eid_mismatches(root))


class Stages(unittest.TestCase):
    def test_authenticate_verify_tamper(self):
        with tempfile.TemporaryDirectory() as t:
            folder = Path(t)
            write(folder, bill.import_text(FIXTURE.read_text()), "b.xml")
            entry, refused = stages.authenticate(folder, "b.xml", "vetted", "Test Officer", "2026-11-17")
            self.assertIsNone(refused)
            entry2, _ = stages.authenticate(folder, "b.xml", "introduced-ls", "Test Officer", "2026-11-18")
            self.assertEqual(entry2["prev"], entry["hash"])
            self.assertTrue(all(v["ok"] for v in stages.verify(folder)))
            snap = folder / entry["file"]
            os.chmod(snap, 0o644)
            snap.write_bytes(snap.read_bytes().replace(b"Bharat Niti Lipi", b"Bharat Niti Lip"))
            v = stages.verify(folder)
            self.assertFalse(v[0]["ok"])
            self.assertTrue(v[1]["ok"])

    def test_refused_with_errors(self):
        with tempfile.TemporaryDirectory() as t:
            folder = Path(t)
            root = bill.import_text(FIXTURE.read_text())
            p = next(root.iter(akn.q("p")))
            r = p.makeelement(akn.q("ref"), {"href": "#sec_99"}); r.text = "nowhere"; p.append(r)
            write(folder, root, "b.xml")
            entry, refused = stages.authenticate(folder, "b.xml", "vetted", "Test Officer")
            self.assertIsNone(entry)
            self.assertIn("BNL-8", [c["code"] for c in refused])
            self.assertFalse((folder / "stages.jsonl").exists())


class Rulebook(unittest.TestCase):
    def test_compiles(self):
        with tempfile.TemporaryDirectory() as t:
            res = checks.rules(write(t, bill.new_bill("The Y Bill, 2026", "2026")), {})
            self.assertNotIn("RULEBOOK", [r["code"] for r in res])


if __name__ == "__main__":
    unittest.main()
