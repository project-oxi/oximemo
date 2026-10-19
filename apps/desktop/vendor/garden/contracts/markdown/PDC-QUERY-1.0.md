# PDC Query Contract 1

Status: public draft 1

Date: 2026-09-14

Contract identifier: `pdc-query/1`

Host document contract: `pdc-document/2`

This document is normative. The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** describe conformance requirements.

## 1. Scope

`pdc-query/1` defines executable, read-only projections over a vault's documents and envelope properties. It is versioned separately from `pdc-document/2`: a query-contract change that alters evaluation semantics MUST use a new minor or major identifier and MUST NOT require a change to `pdc-document/2`.

Queries are untrusted input. A query is a saved search, never a program.

## 2. Declaration

A vault enables the query contract by declaring it in the vault manifest:

```json
{
  "format": "pdc-vault/1",
  "id": "018f47c6-1199-72b3-87de-344e5a493e27",
  "created": "2026-09-14T12:34:56.789Z",
  "query": "pdc-query/1"
}
```

- An app MAY implement document contracts without the query contract.
- A `.base` file in a vault whose manifest does not declare `query: pdc-query/1` is still visible, but an app MUST NOT execute it as a `pdc-query/1` query; it classifies the file as an unexecuted query document.

## 3. Transports

A query is carried by exactly one of two transports. Implementations MUST NOT invent a third surface.

### 3.1 `.base` files

- The extension is `.base`, lowercase. Media type: `application/vnd.pdc.query+yaml;version=1`.
- UTF-8, no byte-order mark, at most 1 MiB, LF line endings.
- The file is a single safe-general-YAML 1.2 Core document under the same restrictions as the `pdc-document/2` envelope (section 5 of `PDC-2.0.md`): root mapping, unique string keys, JSON-compatible values only, no anchors/aliases/tags/complex keys/multi-document streams, nesting cap 32, node cap 10,000, comments permitted.
- The query scope is the whole vault.

### 3.2 Fenced `base` code blocks

- Inside a `pdc-markdown/1` body, a fenced code block whose info string is exactly `base` carries an inline query with the same YAML grammar and restrictions.
- The query scope is the whole vault unless the implementing app documents a narrower scope; the block content itself does not change scope.
- The block is body content: preservation rules of `PDC-2.0.md` section 10 apply. An app that does not implement the query contract shows the block as an ordinary code block.

## 4. Grammar (Obsidian Bases-compatible portable subset)

The serialized shape and expression syntax in this section are a conservative subset of the [Obsidian Bases syntax](https://obsidian.md/help/bases/syntax). A conforming implementation MUST NOT substitute SQL, Dataview, JavaScript, or an app-specific expression language. In particular, there is no `from` or `source` key.

The query source is a mapping with these known top-level keys. Unknown keys MUST be preserved and displayed; an implementation without semantics for them MUST NOT execute them.

| Key | Type | Semantics |
|---|---|---|
| `filters` | filter expression | Which documents match |
| `formulas` | mapping of name → string | Derived values computed per document |
| `properties` | mapping of property reference → display metadata | How note, file, and formula properties are presented |
| `summaries` | mapping of name → string | Named summary formulas evaluated over `values` |
| `views` | sequence of view mappings | Named result presentations |

### 4.1 Filter expressions

A filter expression is either:

- a YAML string containing one Bases expression; or
- a recursive mapping containing exactly one of `and`, `or`, or `not`, whose value is a heterogeneous sequence of expression strings or recursive filter mappings. `and` requires every item, `or` requires at least one item, and `not` negates the conjunction of its items.

The portable expression subset contains:

- note-property references as `note.name`, `note["name"]`, or bare `name` shorthand;
- file-property references `file.name`, `file.path`, `file.folder`, `file.ext`, `file.size`, `file.ctime`, `file.mtime`, `file.tags`, `file.links`, `file.embeds`, and `file.properties`;
- formula-property references as `formula.name`;
- string, finite-number, Boolean, and `null` literals;
- arithmetic `+`, `-`, `*`, `/`, `%`, parentheses, comparisons `==`, `!=`, `<`, `<=`, `>`, `>=`, and Boolean operators `!`, `&&`, `||`;
- side-effect-free calls `if(condition, trueResult, falseResult)`, `list(value)`, `min(...)`, `max(...)`, `number(value)`, and value methods `isEmpty()`, `isTruthy()`, `isType(type)`, `toString()`, `contains(...)`, `containsAll(...)`, `containsAny(...)`, `startsWith(string)`, `endsWith(string)`, `lower()`, `trim()`, `abs()`, `ceil()`, `floor()`, `round(digits)`, and `toFixed(precision)` when defined for the receiver type; value fields include `length`; and
- file predicates `file.hasTag(tag)`, `file.hasLink(link)`, and `file.inFolder(folder)`.

These names, call shapes, operators, and property namespaces have Obsidian Bases semantics. A reference to an absent note property evaluates to null. Implementations MAY support additional official Bases expressions, but section 4.6 applies to the whole expression if any construct is unsupported.

### 4.2 Formulas

Each `formulas` entry maps a name to a string containing one expression from section 4.1. Evaluation is per matching document and side-effect-free. A formula property MAY reference another formula as `formula.name`; circular references are invalid and MUST make the affected formula unexecuted.

### 4.3 Properties display metadata

Each `properties` entry maps a note, file, or formula property reference to a mapping whose portable key is `displayName` (string), the presentation label. Unknown display keys are preserved but not executed.

### 4.4 Summary formulas

Each top-level `summaries` entry maps a name to a string containing one expression. Inside that expression, `values` is the list of values for the property across the result set. The portable subset supports `values.length`, `values.sum()`, `values.mean()`, `values.min()`, `values.max()`, and `values.unique().length`, optionally followed by numeric `round(digits)`. The formula MUST return one value.

### 4.5 Views

Each `views` entry is a mapping with:

| Key | Type | Requirement |
|---|---|---|
| `type` | `table` or `list` | Required |
| `name` | string | Required |
| `limit` | non-negative integer | Optional; default unbounded |
| `groupBy` | mapping `{property, direction}` | Optional; `direction` is `ASC` or `DESC` |
| `filters` | filter expression | Optional; narrows the view further than top-level `filters` |
| `order` | sequence of property references | Optional; visible property/column order, **not** row sort order |
| `summaries` | mapping of property reference → summary name | Optional; assigns a built-in or top-level named summary to a property |

Portable summary names are `Average`, `Min`, `Max`, `Sum`, `Range`, `Median`, `Stddev`, `Earliest`, `Latest`, `Checked`, `Unchecked`, `Empty`, `Filled`, and `Unique`, plus names declared by top-level `summaries`.

A view type other than `table` or `list`, or a view-specific key not defined here, is an **unknown view**: preserve it, display its source, and do not execute it under the portable subset. Obsidian or another implementation MAY execute it as its own supported Bases extension.

### 4.6 Unknown functions and keys

An expression or view that uses a function, operator, or view type outside this subset MUST be preserved and displayed (as source or with an explicit unsupported marker) but MUST NOT be partially executed. An implementation that cannot evaluate a whole expression tree reports the query as unexecuted for the affected part; it MUST NOT silently return empty results.

## 5. Evaluation and security

- A query is a **read-only projection**. Evaluating a query MUST NOT mutate documents, the vault, the manifest, or any file.
- A query MUST NOT be treated as authorization for any action, and MUST NOT serve as approval state, permission source, or workflow gate.
- Queries MUST NOT execute scripts, formulas with side effects, network requests, subprocesses, or filesystem writes. Expression evaluation is confined to in-memory values parsed from envelope properties.
- Query results SHOULD resolve document identity by document ID; presentation MAY show paths and titles.
- A malformed query (invalid YAML, duplicate keys, forbidden YAML features, wrong root type) is `invalid_query` with a visible diagnostic; the file remains visible and untouched.
- Indexing or evaluating one invalid query MUST NOT affect other documents or queries.

## 6. Versioning and change governance

- `pdc-query/1` is identified by exact, case-sensitive string comparison wherever a version is declared.
- Adding optional known keys or functions with readable fallbacks MAY extend this contract without a major change; changing evaluation semantics of existing syntax MUST use a new identifier.
- A change is complete only when it updates this specification, the conformance corpus (`pdc-document-conformance/2`), and participating implementations' pinned corpus revision in the same change.
