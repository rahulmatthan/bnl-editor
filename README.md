# BNL Editor

An editor for legislation in **Bharat Niti Lipi (BNL)**, the India profile of Akoma Ntoso 3.0
(OASIS LegalDocML). It drafts and amends Bills in BNL from the start, checks every save against the
Akoma Ntoso schema and the BNL rulebook, and authenticates the text at each stage in an
append-only, hash-chained record. Licensed under Apache-2.0.

**Use it in the browser: https://exmachina.in/bnl-editor/** (nothing to install; drafts stay in your browser).

## Run

```
bnl serve                 # run it on your own machine: http://127.0.0.1:47650/
bnl import bill.docx      # a Bill from .docx, .txt or .md
bnl check <id|file.xml>
bnl verify <id>
python3 -m unittest discover -s tests
```

Needs Python 3.12+ and `xmllint` (part of macOS). No other dependencies, no database, no network.

## The web version

The same page runs with no server at all: `web/engine/` answers the page's API in the browser
(import from Word, .txt or pasted text; save; every check), and keeps drafts in that browser's own
storage. Nothing is sent anywhere. People keep or share a draft by downloading its XML, and open
one sent to them with *Open a BNL file*. Stages are not offered there: authentication will need
DSC signatures and a server.

- Try it locally: `http://127.0.0.1:47650/?local`
- Publish: enable GitHub Pages (source: GitHub Actions), then run the *Publish web version*
  workflow by hand. It publishes `web/` and the spec, never `instruments/`.
- The schema check uses libxml2 compiled to WebAssembly (xmllint-wasm 5.3.0, MIT, vendored in
  `web/vendor/`); the rulebook runs on the browser's own XPath. The browser engine is a port of
  `bnl/`: importing a Bill gives the same XML in both, and the checks agree.

## Amending an Act

Open an Act in BNL (on the Mac, `bnl add act.xml`; on the web, *Open a BNL file*), and in the
Instrument tab choose **Mark up for amendment**. That makes a copy to edit until it reads as the Act
should after amendment; the Act itself is not touched. In the mark-up, a provision put between two
others takes an inserted number (8A, (1A), (ba), (iia)); deleting a provision omits it; references to
it elsewhere are flagged so the consequential amendments are not missed.

**Show changes** compares the mark-up with the Act. **Generate the amending Bill** writes the Bill
(`web/engine/amendbill.js`): title, long title ("A BILL further to amend …"), enacting formula,
section 1 (short title and commencement), then one section per section amended, in the forms of
Indian amending Acts ("In section 2 of the … Act, 2023 (22 of 2023) (hereinafter referred to as the
principal Act),— (a) after clause (b), the following clause shall be inserted, namely:— …; (b) clause
(e) shall be omitted;", "Insertion of new section 10A.", "Omission of section 17."). Words changed
are changed a whole sentence at a time (the sentence as it stands, and as amended, inner quotes printed as ‘ ’); a provision whose whole text changes is substituted
whole. Each change is also recorded as a `textualMod` naming the provision amended
(`/akn/in/act/2023/22/~sec_2__cl_ba`) with its old and new text. The Bill opens as a draft to edit.

### Amendments in a Schedule

A Bill that amends several Acts (as the Jan Vishwas Acts do) carries them in a Schedule. From a
mark-up, **Add to the Schedule** puts its amendments into a Bill's Schedule as a Part for that Act
(PART V — THE DIGITAL PERSONAL DATA PROTECTION ACT, 2023 (22 OF 2023)), one numbered paragraph per
section amended ("1. In section 2, for clause (f), …", "3. Section 17 shall be omitted."). If the Bill
has no Schedule, it gets one, with the section that gives it effect ("The enactments specified in the
Schedule shall be amended in the manner specified therein."); or choose *A new Bill…* and give a
title. Adding the same mark-up again remakes its Part in place. Each paragraph is the source of its
textualMods, so the check ED-11 is satisfied.

## Objects and reasons, notes on clauses

An Indian Bill explains itself after its text. In the Instrument tab of a Bill:

- **Begin the Statement of Objects and Reasons** adds the Statement: two paragraphs for why the law is
  needed, a third listing what the Bill provides (from its chapters), the closing sentence, and the
  place, date and Minister's signature.
- **Begin / Update the Notes on Clauses** gives every clause a note, its first sentence written from
  the clause's heading ("This clause seeks to provide for establishment of the Digital Gazette."). The
  reasons are the drafter's to add, in the note itself or in the *Note on this clause* box of the
  Provision tab. Notes follow their clauses when clauses move or are renumbered, and go when a clause
  is deleted; a clause with no note is a warning (ED-12).

Both are attachments of the Bill (`<doc name="objectsAndReasons">`, `<doc name="notesOnClauses">`),
after any Schedule, and are published with it.

## Publishing

*Save* keeps the draft. *Publish* saves, checks, and (if there are no errors) gives the three forms
the public reads, all made from the same saved file:

- **Web page** (.html): one self-contained file with a contents list, links between provisions, and a
  link to every provision by its eId (`…html#sec_14__subsec_2`). *Preview* opens it in a new tab.
- **PDF**: the same page laid out on A4 with page numbers; the print window's *Save as PDF*.
- **BNL XML** (.xml): the Akoma Ntoso file with the BNL attributes that the other two are made from.

The page and the PDF name the XML file and give its SHA-256, so anyone can check that they carry the
same text. To put a law online, upload the .html and the .xml to the same folder of any website.

## How it works

- **The file is the truth.** Each instrument is `instruments/<id>/<id>.xml`. The page loads it into
  the browser's own XML parser and edits that document in place, so any markup the page does not
  lay out (BNL attributes, metadata, unfamiliar elements) is carried through unchanged. The server
  re-indents only elements that hold no text, so the words of the law are never touched by
  formatting. All eighteen lex-kernel instruments round-trip unchanged (`tests/`).
- **Identifiers are permanent.** A new provision gets its eId (`sec_21__subsec_1__cl_d`) when it is
  saved. Existing eIds never change by themselves; a check (ED-8) says when one no longer matches its
  number, and **Update IDs** regenerates them only while the Bill is unauthenticated.
- **Checks on every save** (`bnl/checks.py`): the Akoma Ntoso 3.0 schema (AKN), the BNL rulebook
  (BNL-1 to BNL-10), and the editor's own checks (ED-1 to ED-10: unique ids, numbering, amendment
  targets and wording, the declared BNL version). Errors block authentication; warnings do not.
- **Amendments are BNL, not prose.** For an amending provision (such as each entry in the Schedule
  of a Bill amending several Acts), *Record an amendment* writes a `textualMod` with the BNL name of the
  provision amended (`/akn/in/act/1908/16/~sec_2`), the old and new words, `bnl:extent` and
  `bnl:basis`.
- **Stages** (`bnl/stages.py`, Mac version only): an instrument with errors is refused; the text
  authenticated at a stage is kept read-only with its SHA-256; each entry in `stages.jsonl` carries
  the hash of the one before, so the record can only be added to. Officers are
  named, not yet signed: electronic signatures, trusted time-stamps and the register of officers
  are the next step.

## Drafting keys

Enter: the next provision (split at the caret) · Shift-Enter: a new paragraph · Tab / Shift-Tab:
indent / outdent · Option-↑/↓: move · ⌘S: save and check (it also saves by itself).

## The spec

`spec/bnl-0.1/` is this editor's copy of BNL 0.1 from lex-kernel, with two rulebook fixes
documented in `spec/bnl-0.1/SOURCE.md`.

## Not yet

Electronic signatures; Hindi texts; tables and schedules beyond simple numbered paragraphs (they
are kept and shown, not yet edited structurally); multi-user editing; consolidation (lex-kernel
does that); applying a Bill's amendments to the Acts it amends.

Indigo (Laws.Africa) was studied for design only; no code from it is used.
