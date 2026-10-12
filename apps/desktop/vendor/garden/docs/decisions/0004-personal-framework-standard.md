# Personal framework standard

Date: 2026-09-27

Status: accepted

## Problem

Garden already supplied tokens, controls, a document editor, query tools and
templates, but the framework's intended defaults were scattered. The playground
implemented its own titlebar controls while the shared shell displayed an app
name by default. The starter still used a welcome paragraph and body-only editor.
Property editing was an internal part of the document editor. Adopters could
pass configuration checks without declaring which framework rules they followed.

## Decision

Adopt `garden-personal/1`, governed by `contracts/framework/README.md` and the
`garden-framework/1` rule registry. This is a personal hard framework: React,
TypeScript, Vite, shared shadcn/Radix controls, Rust/Tauri desktop hosting and Bun
services are starting decisions. Layout and product copy rules are normative.

The default `GAppShell` provides pane toggles and an upper-right command launcher.
App names/logos do not appear in chrome, and page headers have no filler subtitle.
The shell retains context slots and an explicit custom titlebar mode. Allowed
deviations require a scoped rule ID, reason and local ADR in the manifest; they
do not require a separate interactive approval flow.

The document plane continues to use PDC 2 and PDC Query 1. Expose the property
sheet as `GDocumentProperties` and compose it in `GDocumentEditor`; retain the
same guarded source model. This separation enables property panels without
duplicating types or serializers. It does not add a new document format or claim
complete vault/HTML support. The desktop starter uses the full document editor
with a canonical sample in memory and makes no persistence claim.

`garden doctor` verifies manifest/exception structure, applicable stack/adoption
and native configuration, plus its existing pin/generated/snapshot checks.
The registry names the remaining runtime, review and conformance obligations.
Human copy quality and visual composition are not reduced to source-string lint.

## Consequences

New personal apps start with the complete standard and shared controls. Existing
apps add the manifest profile and migrate their app composition deliberately;
their domain state and user documents are not rewritten. Versioned source
snapshots remain useful for reproducibility despite public distribution being
out of scope. Historical verification records remain historical evidence; this
decision supersedes earlier app-identity and sidebar command-entry recommendations.
