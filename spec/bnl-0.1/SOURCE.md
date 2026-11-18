# BNL 0.1 as this editor checks it

Copied on 17 November 2026 from lex-kernel, which holds the BNL spec, the attribute schema
(`bnl.xsd`) and the rulebook (`rules.sch`). The editor carries its own copy so that it states
exactly which version of BNL it checks.

| File | From | Changed? |
|---|---|---|
| `akomantoso30.xsd`, `xml.xsd` | `lex-kernel/schema/` (OASIS Akoma Ntoso 3.0) | no |
| `bnl.xsd` | `lex-kernel/bnl/bnl.xsd` | no |
| `validate.xsd` | `lex-kernel/bnl/validate.xsd` | schema paths point at this folder |
| `rules.sch` | `lex-kernel/bnl/rules.sch` | **two changes, below** |

## Changes to the rulebook, to take back to lex-kernel

1. **Succession rule (BNL-9, BNL-10) did not compile.** libxml2 (`xmllint --schematron`) does
   not accept predicates in a rule context, so `a:forceMod[@type='reEnactment'] | a:forceMod[@bnl:fidelity]`
   failed, and with it the whole rulebook. Here the context is `a:forceMod` and the condition
   moved into the test; the editor treats a rulebook that does not compile as an error.
2. **BNL-1 (commencement) skips Bills.** A Bill has no commencement until it is an Act.

## A proposal, not yet in the spec

The editor records which BNL version an instrument follows as
`<proprietary source="#bnl-editor"><bnl:profile version="0.1"/></proprietary>` and checks it
(ED-9). BNL 0.1 has no such element; the spec should decide where the version is declared.
