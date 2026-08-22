# `oxi-frontmatter` — Specification (grammar v2)

This document is normative for the oxi ecosystem vault file format.
The Rust crate `oxi-frontmatter` is the reference implementation of
this grammar; any divergence between this document and the crate is
a bug in the crate.

## 1. Scope

A single note carries two regions:

- **Frontmatter** — a structured key/value block used for schema-
  validated metadata (id, timestamps, tags, oxi-specific keys).
- **Body** — the full text of the note (Markdown or HTML).

Notes without a frontmatter block are valid; notes with a malformed
frontmatter block are **not** — the parser returns an error rather
than silently dropping the block.

## 2. Transport

Two transports are accepted:

- **Markdown** — frontmatter is fenced by lines containing exactly
  three dashes (`---`). The opening fence is the first line of the
  note (after BOM stripping — see §6). The closing fence is the next
  line whose content, after stripping trailing whitespace, equals
  `---`. (Trailing spaces do not break fence detection.)
- **HTML** — frontmatter is wrapped in an HTML comment. The opening
  token is the line `<!--` immediately followed by a line that is
  exactly `---`. The closing fence is a line that is exactly `---`,
  immediately followed by a line that is exactly `-->`.

A note in the wrong transport (e.g. `<!--...-->` block in a Markdown
note, or `---` fences in an HTML note) is **not** a frontmatter block;
the parser returns [`Parsed::BodyOnly`].

## 3. Block body grammar

The grammar accepted inside the fences is a constrained YAML subset.
Lines use LF (`\n`) on emit; CRLF is normalized to LF on parse.

### 3.1 Indentation

Two indentation levels are allowed:

- **Level 0** — no leading whitespace. Top-level keys.
- **Level 1** — exactly two spaces of indentation. Children of a
  level-0 key.

Indentation of one space, three or more spaces, or tabs is rejected
**outside** of block scalars (see §3.5). Inside a block scalar,
deeper indentation is accepted and preserved relative to the 2-space
base.

A level-1 key under a level-0 key that does not declare a sequence or
nested map is rejected.

### 3.2 Entries

Three entry shapes are allowed at level 0:

```yaml
key: value           # flat scalar
key:                 # opens a nested map or block sequence
  child: value
  - list item
key: [a, b]          # flow sequence (single-line only)
key: |               # block scalar (multi-line string)
  line one
  line two
```

A `key:` line at level 0 with **no** continuation is an empty value
and is rejected.

### 3.3 Scalars

- `true` and `false` (after trimming surrounding whitespace) map to
  [`Value::Bool`].
- Everything else bare-or-quoted maps to [`Value::Str`]. This includes
  RFC3339 timestamps, dates (`YYYY-MM-DD`), integers, and floats.
  Schema validation (RFC3339 parsing, type coercion) is the schema
  layer's responsibility (Task 11), not this parser's.
- Double-quoted strings (`"..."`) and single-quoted strings (`'...'`)
  are accepted; quoted scalars must not span lines. Inside a quoted
  scalar, `#` is treated as a literal character (not a comment).
  Unterminated quotes are a hard parse error.

### 3.4 Sequences

- **Flow form**: `[a, b, c]` on a single line. Splitting is
  quote-aware: a comma inside `"..."` or `'...'` does not end an
  item. Unbalanced quotes are a hard parse error.
- **Block form**: `key:` at level 0, then level-1 lines beginning with
  `- `. Block-sequence items are subject to the same bare-scalar
  rules as inline scalars (see §5); `- a: b` is rejected because
  `:` is forbidden in bare scalars.

Mixing flow and block in the same key is rejected. Sequences of maps
or nested sequences are rejected (only flat string sequences are
allowed).

### 3.5 Block scalars

The `|` marker begins a literal block scalar. Lines following the
marker at indentation ≥ 2 spaces are concatenated with `\n` until a
line at level 0 or end of block is encountered. Indentation beyond
the 2-space base is preserved in the output (so `      foo` under
`notes: |` becomes the string `  foo`, not `foo`). Trailing blank
lines are trimmed.

### 3.6 Nested maps

A level-1 key under a level-0 key opens a [`Value::Map`]. The level-1
key must itself be `key: value` or `key: [...]`; block sequences under
a map key are not allowed. Maps under maps (depth ≥ 3) are rejected.

## 4. Forbidden YAML features

The following YAML features are explicitly rejected:

- Anchors (`&name`).
- Aliases (`*name`).
- Tags (`!tag`).
- Multi-document streams (`---` without a matching opener).
- Complex keys (non-string keys).
- Tab indentation.
- Comments (full-line `# ...` or inline ` # ...`).
- Multi-line flow collections (`[a,\n b]`).
- Empty values (`key:` with no continuation).
- Empty block bodies (no entries between fences).

## 5. Quoting and characters

Bare scalars may contain any printable character **except**:

- `: ` (colon followed by space)
- `#` (always — comments are forbidden, so `#` is only legal inside
  a quoted scalar)
- `'`, `"`, `,`, `[`, `]`, `{`, `}`, `&`, `*`, `!`, `|`, `>`,
  `%`, `@`, `` ` ``, and any control character

Use single or double quotes to embed any of the above. Quoted
scalars may contain any printable character except a literal newline.
Unterminated quotes are a hard parse error.

## 6. Edge cases

- **BOM** (`U+FEFF`) at the start of the input is a hard parse error.
  The parser does not silently strip it.
- **CRLF** (`\r\n`) line endings are normalized to LF **inside** the
  frontmatter block path. For notes parsed as
  [`Parsed::BodyOnly`], the original input is returned verbatim — line
  endings, indentation, and everything else are preserved so a Task
  2 write-back does not silently rewrite untouched notes.
- **Duplicate keys** (same key appearing twice at the same level) are a
  hard parse error.
- **Unclosed fence** (opening `---` without a matching closing `---`
  before EOF) is a hard parse error. The error reason contains the
  literal `"horizontal rule"` to nudge authors who mistype the fence
  as a Markdown horizontal rule (`---`).
- **Empty block** (no entries between fences) is a hard parse error.
- **Depth ≥ 3** is rejected.

## 7. Data model

The parser produces:

```rust
pub enum Value { Bool(bool), Str(String), Array(Vec<String>), Map(Table) }
pub type Table = indexmap::IndexMap<String, Value>;
pub enum Parsed {
    Memo { table: Table, body: String },
    BodyOnly { body: String },
}
pub struct ParseError { pub line: usize, pub reason: String }
```

`Table` preserves insertion order. `Array` values are always
`Vec<String>`; richer sequence element types are out of scope.

## 8. Versioning

This document defines **grammar v2**. Future grammar revisions MUST
add a major version to `oxi-frontmatter` and MUST NOT silently accept
v2 syntax in v3.