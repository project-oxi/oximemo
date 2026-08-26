//! Vault write-side of the oxi ecosystem frontmatter contract.
//!
//! `write_document` is the **only** path that should mutate a vault
//! `.md` / `.html` file's frontmatter block. The implementation is
//! deliberately simple:
//!
//! 1. Read the existing file (if any) and parse it.
//! 2. Build the *next* [`Table`] by carrying over the existing keys,
//!    synthesizing required ones (`id`, `created`), bumping `updated`
//!    when something semantic changes, and applying the typed
//!    [`Mutation`] the caller asked for.
//! 3. Emit the next block with [`crate::emit`]. If the new bytes are
//!    semantically equal to the existing bytes (parse-compare rather
//!    than byte-compare, so an Obsidian rewrite in block-sequence
//!    form is preserved), return [`WriteOutcome::NoOp`] and leave the
//!    file alone.
//! 4. Otherwise call [`atomic_write`] (tmp + fsync + rename +
//!    dir-fsync) to durably replace the file.
//!
//! ## NoOp semantics
//!
//! [`WriteOutcome::NoOp`] is **semantic**, not byte-level: if a
//! foreign tool has rewritten the file with different formatting but
//! an identical [`crate::Table`] + body, we do not touch the file.
//! This keeps mtime stable and prevents canonicalization passes from
//! silently stomping on non-canonical-but-valid formatting.
//!
//! ## Atomic write
//!
//! [`atomic_write`] is a direct port of the helper in
//! `oximemo-core/src/store/files.rs:377-403` — same tmp-in-same-dir
//! strategy. We cite the source in the function comment.
//!
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use indexmap::IndexMap;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::emit::emit;
use crate::parse::{NoteFormat, ParseError, Parsed, Table, Value, parse};

/// Typed mutation applied by [`write_document`].
#[derive(Debug, Default, Clone)]
pub struct Mutation {
    /// If `Some`, set the `favorite` key to this value. `None` means
    /// "no change".
    pub favorite: Option<bool>,
    /// If `Some`, set the `deleted` key. `Some(Some(t))` writes a
    /// tombstone at timestamp `t`; `Some(None)` removes the key
    /// (undelete). `None` (outer) means "no change".
    pub deleted: Option<Option<OffsetDateTime>>,
    /// Arbitrary (non-core) property changes. `Some(v)` sets `key` to
    /// `v`; `None` removes the key. Keys matching the core schema
    /// (`id`, `created`, `updated`, `favorite`, `deleted`) are ignored
    /// — core keys only change through their dedicated fields above.
    pub set_props: IndexMap<String, Option<Value>>,
}

/// Whether a missing or `BodyOnly` file is allowed to be
/// re-synthesized with a fresh frontmatter block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Synthesize {
    /// Synthesize a fresh frontmatter block (with `id` and `created`)
    /// when the existing file has none.
    Yes,
    /// Reject a body-only existing file as [`FrontmatterError::UnexpectedBodyOnly`].
    No,
}

/// Outcome of a successful [`write_document`] call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteOutcome {
    /// File was rewritten (new content differs from old).
    Written,
    /// File content is semantically unchanged; we did not touch it.
    NoOp,
}

/// Errors from [`write_document`] and [`atomic_write`].
#[derive(Debug, thiserror::Error)]
pub enum FrontmatterError {
    /// Underlying parse error.
    #[error(transparent)]
    Parse(ParseError),
    /// I/O error.
    #[error(transparent)]
    Io(std::io::Error),
    /// A note with no frontmatter block was passed under `Synthesize::No`.
    #[error("body-only note rejected without Synthesize::Yes: {path}")]
    UnexpectedBodyOnly {
        /// Path of the offending file.
        path: PathBuf,
    },
    /// The candidate frontmatter table contains a shape the emitter
    /// cannot write back to a file the parser can re-read (e.g. an
    /// empty `Array`, a `Str` ending in `\n` inside a block scalar
    /// that the parser trims). The file is NOT touched.
    #[error("cannot emit frontmatter table: {reason}")]
    Unemittable {
        /// Key + reason for the unemittable shape.
        reason: String,
    },
}

impl From<ParseError> for FrontmatterError {
    fn from(e: ParseError) -> Self {
        FrontmatterError::Parse(e)
    }
}

impl From<std::io::Error> for FrontmatterError {
    fn from(e: std::io::Error) -> Self {
        FrontmatterError::Io(e)
    }
}

/// Merge-write the canonical frontmatter block + body to `path`.
///
/// # Algorithm
///
/// 1. Read existing bytes (if the file is missing, treat it as
///    "nothing there").
/// 2. Parse with [`parse`] using `fmt`. A hard parse error short-
///    circuits — malformed frontmatter is never silently repaired.
/// 3. Carry the existing `Table` forward; apply the core key
///    invariant (`id`, `created`, `updated`) and the typed
///    [`Mutation`].
/// 4. Re-emit and compare the parsed result with the *new* bytes
///    against the *existing* parsed result. If they are equal, return
///    [`WriteOutcome::NoOp`] without writing — this preserves
///    foreign formatting and avoids spurious mtime churn.
/// 5. Otherwise call [`atomic_write`] to durably replace the file.
///
/// `synth = Yes` is required when the existing file is missing or
/// `Parsed::BodyOnly`; otherwise we return
/// [`FrontmatterError::UnexpectedBodyOnly`].
pub fn write_document(
    path: &Path,
    body: &str,
    fmt: NoteFormat,
    mutations: Mutation,
    synth: Synthesize,
    now: OffsetDateTime,
) -> Result<WriteOutcome, FrontmatterError> {
    // Step 1: read existing bytes (if any).
    let existing_bytes: Option<Vec<u8>> = match fs::read(path) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(FrontmatterError::Io(e)),
    };

    // Step 2: parse (or synthesize).
    let existing_table: Table = match &existing_bytes {
        Some(b) => {
            let s = match std::str::from_utf8(b) {
                Ok(s) => s,
                Err(_) => {
                    return Err(FrontmatterError::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("file at {} is not valid UTF-8", path.display()),
                    )));
                }
            };
            match parse(s, fmt)? {
                Parsed::Memo { table, .. } => table,
                Parsed::BodyOnly { .. } => {
                    if matches!(synth, Synthesize::No) {
                        return Err(FrontmatterError::UnexpectedBodyOnly {
                            path: path.to_path_buf(),
                        });
                    }
                    IndexMap::new()
                }
            }
        }
        None => {
            if matches!(synth, Synthesize::No) {
                return Err(FrontmatterError::UnexpectedBodyOnly {
                    path: path.to_path_buf(),
                });
            }
            IndexMap::new()
        }
    };

    // Step 3: build the candidate table (id, created, favorite,
    // deleted) WITHOUT bumping `updated` yet. `updated` is only set
    // when the file is actually going to be rewritten (see step 6).
    let mut next_table = build_next_table(existing_table, mutations, now);

    // Step 4: emit-then-compare for the semantic NoOp check. We
    // compare the parsed form of the old bytes against the parsed
    // form of the candidate emission; byte-equality would defeat the
    // whole point of letting foreign formatting survive.
    if let Some(existing) = &existing_bytes {
        let old_str = std::str::from_utf8(existing).ok();
        let same = match old_str.and_then(|a| parse(a, fmt).ok()) {
            Some(Parsed::Memo {
                table: t_old,
                body: b_old,
            }) => {
                let probe = emit(&next_table, body, fmt);
                match parse(&probe, fmt) {
                    Ok(Parsed::Memo {
                        table: t_new,
                        body: b_new,
                    }) => t_old == t_new && b_old == b_new,
                    _ => false,
                }
            }
            _ => false,
        };
        if same {
            return Ok(WriteOutcome::NoOp);
        }
    }

    // Step 5: about to write. Validate the candidate table so we
    // never persist a shape the parser cannot re-read.
    validate_emit_table(&next_table, "")?;

    // Step 6: bump `updated` (only when actually writing — a true
    // NoOp never bumps it).
    next_table.insert("updated".to_string(), Value::Str(format_offset(now)));
    // Re-validate after the bump — inserting `updated` cannot create
    // a new violation, but the order matters for canonical emission.
    validate_emit_table(&next_table, "")?;

    // Step 7: emit + durably replace.
    let new_bytes = emit(&next_table, body, fmt).into_bytes();
    atomic_write(path, &new_bytes)?;
    Ok(WriteOutcome::Written)
}

/// Build the candidate table by carrying the existing keys forward,
/// synthesizing required ones, and applying mutations.
///
/// `updated` is NOT set here — see the doc comment on
/// [`write_document`] for why.
fn build_next_table(mut existing: Table, mutations: Mutation, now: OffsetDateTime) -> Table {
    // id: carry or synthesize (UUID v7 — time-ordered).
    if !existing.contains_key("id") {
        let id = Uuid::now_v7().to_string();
        existing.insert("id".to_string(), Value::Str(id));
    }

    // created: carry or synthesize.
    if !existing.contains_key("created") {
        let ts = format_offset(now);
        existing.insert("created".to_string(), Value::Str(ts));
    }

    // favorite: explicit mutation wins; otherwise leave existing alone.
    if let Some(fav) = mutations.favorite {
        existing.insert("favorite".to_string(), Value::Bool(fav));
    }
    // deleted: `Some(Some(t))` writes tombstone; `Some(None)` removes.
    match mutations.deleted {
        Some(Some(ts)) => {
            existing.insert("deleted".to_string(), Value::Str(format_offset(ts)));
        }
        Some(None) => {
            existing.shift_remove("deleted");
        }
        None => {}
    }

    // Property changes: non-core keys only, applied after the core
    // fields so a hostile `set_props` cannot override id/created/etc.
    for (key, change) in mutations.set_props {
        if matches!(
            key.as_str(),
            "id" | "created" | "updated" | "favorite" | "deleted"
        ) {
            continue;
        }
        match change {
            Some(v) => {
                existing.insert(key, v);
            }
            None => {
                existing.shift_remove(&key);
            }
        }
    }

    existing
}

/// Validate that every shape in `table` can be emitted and then
///
/// `key_path` is the dotted prefix for nested-map diagnostics
/// (e.g. `"oxios.author"`).
fn validate_emit_table(table: &Table, key_path: &str) -> Result<(), FrontmatterError> {
    for (key, value) in table {
        let full = if key_path.is_empty() {
            key.clone()
        } else {
            format!("{key_path}.{key}")
        };
        match value {
            Value::Array(items) => {
                if items.is_empty() {
                    return Err(FrontmatterError::Unemittable {
                        reason: format!(
                            "{full}: empty array would emit `key: []` which the parser rejects"
                        ),
                    });
                }
                for item in items {
                    // Block scalars inside flow sequences would not
                    // round-trip; the array element can never carry
                    // a newline.
                    if item.contains('\n') {
                        return Err(FrontmatterError::Unemittable {
                            reason: format!(
                                "{full}: array item contains a newline; flow form is single-line"
                            ),
                        });
                    }
                    // A double quote inside an item desyncs the
                    // parser's quote-aware flow split: the emitter
                    // wraps items in `"` without escaping, so stored
                    // `a", b` emits `["a", b"]` (unbalanced quotes →
                    // unparseable file) and stored `a"b` emits
                    // `["a"b"]` (same failure, no comma needed).
                    // Such items only enter via single-quoted
                    // block-seq lines, which the emitter never
                    // produces; refuse loudly instead of corrupting.
                    if item.contains('"') {
                        return Err(FrontmatterError::Unemittable {
                            reason: format!(
                                "{full}: array item contains a double quote; flow form cannot re-read it"
                            ),
                        });
                    }
                }
            }
            Value::Str(s) => {
                if s.contains('\n') && s.ends_with('\n') {
                    // Block scalar form: the parser strips trailing
                    // blank lines, so `"l1\n"` would silently become
                    // `"l1"`. Refuse to write that shape.
                    return Err(FrontmatterError::Unemittable {
                        reason: format!(
                            "{full}: Str ends in `\\n`; parser would trim the trailing blank line"
                        ),
                    });
                }
            }
            Value::Map(sub) => {
                if sub.is_empty() {
                    return Err(FrontmatterError::Unemittable {
                        reason: format!(
                            "{full}: empty map would emit `key:` with no children (parser: empty value)"
                        ),
                    });
                }
                // Multiline strings under a level-0 key produce
                // level-1 `key: |` lines that the parser does not
                // accept (block scalars must be at the level of the
                // key marker, not nested).
                for (sub_key, sub_value) in sub {
                    if let Value::Str(s) = sub_value
                        && s.contains('\n')
                    {
                        return Err(FrontmatterError::Unemittable {
                            reason: format!(
                                "{full}.{sub_key}: multiline Str inside Map is unemittable (parser rejects level-1 block scalars)"
                            ),
                        });
                    }
                }
                validate_emit_table(sub, &full)?;
            }
            Value::Bool(_) => {}
        }
    }
    Ok(())
}

/// Format an `OffsetDateTime` as an RFC3339 string the parser will
/// keep verbatim. RFC3339 formatting of a well-formed
/// `OffsetDateTime` cannot fail — panicking is the loud-but-safe
/// choice here (silently writing `updated: ""` would be a worse
/// outcome than panicking).
fn format_offset(t: OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .expect("RFC3339 formatting of OffsetDateTime cannot fail")
}

/// Atomic file write: temp in same dir, fsync, rename, dir-fsync.
///
/// Ported from `oximemo-core/src/store/files.rs:377-403` (and its
/// `unique_temp` / `fsync_dir` helpers). Durability (C2): the file
/// is fsync'd, then the parent *directory* is fsync'd so the rename
/// survives power loss — otherwise a crash can leave the new content
/// written but the directory entry pointing at the old (or no) name.
/// Collision safety (C3): the temp name embeds pid + a per-process
/// counter so two processes writing the same memo concurrently
/// cannot stomp each other's temp file. The extension is preserved
/// and augmented so a stale temp file is never picked up by a note
/// walker.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let tmp = unique_temp(path);
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    fsync_dir(parent)?;
    Ok(())
}

/// Per-process counter for unique sibling temp file names.
static ATOMIC_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Build a unique sibling temp path for `target`:
/// `<target>.tmp.<pid>.<n>`.
fn unique_temp(target: &Path) -> PathBuf {
    let n = ATOMIC_COUNTER.fetch_add(1, Ordering::Relaxed);
    let suffix = format!("tmp.{}.{}", std::process::id(), n);
    let mut name = target
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(".");
    name.push(suffix);
    target.with_file_name(name)
}

/// fsync a directory so a recent rename/create is durable across
/// power loss.
fn fsync_dir(dir: &Path) -> std::io::Result<()> {
    let f = fs::File::open(dir)?;
    f.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::{Parsed, parse};
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn tmp() -> std::path::PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("oxi-frontmatter-test-{}-{}", std::process::id(), n));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn now() -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }

    #[test]
    fn synthesizes_new_document() {
        let p = tmp().join("n.md");
        let out = write_document(
            &p,
            "body",
            NoteFormat::Markdown,
            Mutation::default(),
            Synthesize::Yes,
            now(),
        )
        .unwrap();
        assert!(matches!(out, WriteOutcome::Written));
        let Parsed::Memo { table, .. } =
            parse(&fs::read_to_string(&p).unwrap(), NoteFormat::Markdown).unwrap()
        else {
            panic!("expected Memo")
        };
        assert!(table.contains_key("id"));
        assert!(table.contains_key("created"));
    }

    #[test]
    fn preserves_unknown_keys_and_bumps_updated() {
        let p = tmp().join("n.md");
        write_document(
            &p,
            "b1",
            NoteFormat::Markdown,
            Mutation::default(),
            Synthesize::Yes,
            now(),
        )
        .unwrap();
        fs::write(
            &p,
            fs::read_to_string(&p)
                .unwrap()
                .replace("---\n", "---\ncustom: keep-me\n"),
        )
        .ok();
        write_document(
            &p,
            "b2",
            NoteFormat::Markdown,
            Mutation::default(),
            Synthesize::No,
            now(),
        )
        .unwrap();
        let c = fs::read_to_string(&p).unwrap();
        assert!(c.contains("custom: keep-me"));
        assert!(c.contains("b2"));
    }

    #[test]
    fn set_props_sets_and_removes_and_preserves_unknown_keys() {
        let p = tmp().join("props.md");
        write_document(
            &p,
            "body",
            NoteFormat::Markdown,
            Mutation::default(),
            Synthesize::Yes,
            now(),
        )
        .unwrap();
        // Foreign key + a prop we will remove.
        let base = fs::read_to_string(&p).unwrap();
        fs::write(
            &p,
            base.replace("---\n", "---\nforeign: stay\nstatus: stub\ntags: [a]\n"),
        )
        .ok();

        let mut set_props = IndexMap::new();
        set_props.insert("status".to_string(), Some(Value::Str("understood".into())));
        set_props.insert("tags".to_string(), None); // remove
        set_props.insert(
            "domain".to_string(),
            Some(Value::Array(vec!["TECH".into()])),
        );
        set_props.insert(
            "updated".to_string(),
            Some(Value::Str("hostile-override".into())),
        ); // core key: ignored
        let out = write_document(
            &p,
            "body",
            NoteFormat::Markdown,
            Mutation {
                set_props,
                ..Default::default()
            },
            Synthesize::No,
            now(),
        )
        .unwrap();
        assert!(matches!(out, WriteOutcome::Written));

        let Parsed::Memo { table, .. } =
            parse(&fs::read_to_string(&p).unwrap(), NoteFormat::Markdown).unwrap()
        else {
            panic!("expected Memo");
        };
        assert_eq!(table.get("status"), Some(&Value::Str("understood".into())));
        assert_eq!(
            table.get("domain"),
            Some(&Value::Array(vec!["TECH".into()]))
        );
        assert!(!table.contains_key("tags"), "removed key must be gone");
        assert_eq!(table.get("foreign"), Some(&Value::Str("stay".into())));
        assert_ne!(
            table.get("updated"),
            Some(&Value::Str("hostile-override".into())),
            "core keys must be immune to set_props"
        );
    }

    #[test]
    fn set_props_with_same_value_is_noop() {
        let p = tmp().join("same.md");
        let mut set_props = IndexMap::new();
        set_props.insert("status".to_string(), Some(Value::Str("stub".into())));
        write_document(
            &p,
            "b",
            NoteFormat::Markdown,
            Mutation {
                set_props: set_props.clone(),
                ..Default::default()
            },
            Synthesize::Yes,
            now(),
        )
        .unwrap();
        let out = write_document(
            &p,
            "b",
            NoteFormat::Markdown,
            Mutation {
                set_props,
                ..Default::default()
            },
            Synthesize::No,
            now(),
        )
        .unwrap();
        assert!(
            matches!(out, WriteOutcome::NoOp),
            "re-setting the same property value must not touch the file"
        );
    }

    #[test]
    fn noop_when_nothing_changed() {
        let p = tmp().join("n.md");
        write_document(
            &p,
            "b",
            NoteFormat::Markdown,
            Mutation::default(),
            Synthesize::Yes,
            now(),
        )
        .unwrap();
        let before = fs::read_to_string(&p).unwrap();
        let out = write_document(
            &p,
            "b",
            NoteFormat::Markdown,
            Mutation::default(),
            Synthesize::No,
            now(),
        )
        .unwrap();
        assert!(matches!(out, WriteOutcome::NoOp));
        assert_eq!(before, fs::read_to_string(&p).unwrap());
    }

    #[test]
    fn noop_is_semantic_not_bytelevel() {
        let p = tmp().join("n.md");
        write_document(
            &p,
            "b",
            NoteFormat::Markdown,
            Mutation::default(),
            Synthesize::Yes,
            now(),
        )
        .unwrap();
        let canonical = fs::read_to_string(&p).unwrap();
        let obsidian_style = canonical.replacen("---\n", "---\ntags:\n  - a\n  - b\n", 1);
        fs::write(&p, &obsidian_style).unwrap();
        let out = write_document(
            &p,
            "b",
            NoteFormat::Markdown,
            Mutation::default(),
            Synthesize::No,
            now(),
        )
        .unwrap();
        assert!(matches!(out, WriteOutcome::NoOp));
        assert_eq!(obsidian_style, fs::read_to_string(&p).unwrap());
    }

    #[test]
    fn tombstone_and_undelete() {
        let p = tmp().join("n.md");
        write_document(
            &p,
            "b",
            NoteFormat::Markdown,
            Mutation::default(),
            Synthesize::Yes,
            now(),
        )
        .unwrap();
        write_document(
            &p,
            "b",
            NoteFormat::Markdown,
            Mutation {
                favorite: None,
                deleted: Some(Some(now())),
                set_props: IndexMap::new(),
            },
            Synthesize::No,
            now(),
        )
        .unwrap();
        assert!(fs::read_to_string(&p).unwrap().contains("\ndeleted: "));
        write_document(
            &p,
            "b",
            NoteFormat::Markdown,
            Mutation {
                favorite: None,
                deleted: Some(None),
                set_props: IndexMap::new(),
            },
            Synthesize::No,
            now(),
        )
        .unwrap();
        assert!(!fs::read_to_string(&p).unwrap().contains("\ndeleted: "));
    }

    #[test]
    fn bodyonly_with_synth_no_errors() {
        let p = tmp().join("n.md");
        fs::write(&p, "bare").unwrap();
        assert!(matches!(
            write_document(
                &p,
                "b",
                NoteFormat::Markdown,
                Mutation::default(),
                Synthesize::No,
                now(),
            ),
            Err(FrontmatterError::UnexpectedBodyOnly { .. })
        ));
    }
    /// Finding 2: a freshly synthesized document must include
    /// `updated` — it's not conditional on a typed mutation.
    #[test]
    fn synthesized_document_has_updated() {
        let p = tmp().join("n.md");
        write_document(
            &p,
            "body",
            NoteFormat::Markdown,
            Mutation::default(),
            Synthesize::Yes,
            now(),
        )
        .unwrap();
        let Parsed::Memo { table, .. } =
            parse(&fs::read_to_string(&p).unwrap(), NoteFormat::Markdown).unwrap()
        else {
            panic!("expected Memo")
        };
        assert!(table.contains_key("updated"), "missing updated: {table:?}");
    }

    /// Finding 2: changing the body of an existing note bumps
    /// `updated`. Default mutation + body change ⇒ write.
    #[test]
    fn body_edit_bumps_updated() {
        let p = tmp().join("n.md");
        write_document(
            &p,
            "b1",
            NoteFormat::Markdown,
            Mutation::default(),
            Synthesize::Yes,
            now(),
        )
        .unwrap();
        let before = {
            let Parsed::Memo { table, .. } =
                parse(&fs::read_to_string(&p).unwrap(), NoteFormat::Markdown).unwrap()
            else {
                panic!()
            };
            table["updated"].clone()
        };
        std::thread::sleep(std::time::Duration::from_millis(5));
        let out = write_document(
            &p,
            "b2",
            NoteFormat::Markdown,
            Mutation::default(),
            Synthesize::No,
            now(),
        )
        .unwrap();
        assert!(matches!(out, WriteOutcome::Written));
        let after = {
            let Parsed::Memo { table, .. } =
                parse(&fs::read_to_string(&p).unwrap(), NoteFormat::Markdown).unwrap()
            else {
                panic!()
            };
            table["updated"].clone()
        };
        assert_ne!(before, after);
        assert!(fs::read_to_string(&p).unwrap().contains("b2"));
    }

    /// Finding 1: a write_document cycle on a note whose value
    /// contains a literal `"` must (a) round-trip cleanly and (b)
    /// produce a NoOp on a second consecutive cycle with no
    /// mutation.
    #[test]
    fn write_cycle_with_embedded_quote_is_idempotent() {
        let p = tmp().join("n.md");
        let src = "---\nk: 'He said \"hi\"'\n---\nb";
        fs::write(&p, src).unwrap();
        let out1 = write_document(
            &p,
            "b",
            NoteFormat::Markdown,
            Mutation::default(),
            Synthesize::No,
            now(),
        )
        .unwrap();
        assert!(matches!(out1, WriteOutcome::Written));
        let Parsed::Memo { table, .. } =
            parse(&fs::read_to_string(&p).unwrap(), NoteFormat::Markdown).unwrap()
        else {
            panic!()
        };
        assert_eq!(table["k"], Value::Str("He said \"hi\"".into()));
        std::thread::sleep(std::time::Duration::from_millis(5));
        let out2 = write_document(
            &p,
            "b",
            NoteFormat::Markdown,
            Mutation::default(),
            Synthesize::No,
            now(),
        )
        .unwrap();
        assert!(
            matches!(out2, WriteOutcome::NoOp),
            "second cycle should be NoOp (was Written) — escaping regression"
        );
    }

    /// Finding 3: empty Array is unemittable.
    #[test]
    fn empty_array_is_unemittable() {
        let mut t: Table = IndexMap::new();
        t.insert("id".into(), Value::Str("id".into()));
        t.insert("created".into(), Value::Str("2026-01-01T00:00:00Z".into()));
        t.insert("tags".into(), Value::Array(vec![]));
        match validate_emit_table(&t, "") {
            Err(FrontmatterError::Unemittable { reason }) => {
                assert!(reason.contains("empty array"), "reason: {reason}");
            }
            other => panic!("expected Unemittable, got {other:?}"),
        }
    }

    /// Finding 5a: empty Map renders `key:` with no children
    /// (parser hard-rejects). Must be Unemittable.
    #[test]
    fn empty_map_is_unemittable() {
        let mut t: Table = IndexMap::new();
        t.insert("id".into(), Value::Str("id".into()));
        t.insert("created".into(), Value::Str("2026-01-01T00:00:00Z".into()));
        t.insert("oxios".into(), Value::Map(IndexMap::new()));
        match validate_emit_table(&t, "") {
            Err(FrontmatterError::Unemittable { reason }) => {
                assert!(reason.contains("empty map"), "reason: {reason}");
            }
            other => panic!("expected Unemittable, got {other:?}"),
        }
    }

    /// Finding 5b: multiline Str inside a Map (level-1 block
    /// scalar) is unemittable.
    #[test]
    fn multiline_str_inside_map_is_unemittable() {
        let mut sub = IndexMap::new();
        sub.insert("body".into(), Value::Str("l1\nl2".into()));
        let mut t: Table = IndexMap::new();
        t.insert("id".into(), Value::Str("id".into()));
        t.insert("created".into(), Value::Str("2026-01-01T00:00:00Z".into()));
        t.insert("oxios".into(), Value::Map(sub));
        match validate_emit_table(&t, "") {
            Err(FrontmatterError::Unemittable { reason }) => {
                assert!(
                    reason.contains("multiline Str inside Map"),
                    "reason: {reason}"
                );
            }
            other => panic!("expected Unemittable, got {other:?}"),
        }
    }

    /// Finding 5c: top-level Str ending in `\n` is unemittable
    /// (parser trims trailing blank lines).
    #[test]
    fn trailing_newline_str_is_unemittable() {
        let mut t: Table = IndexMap::new();
        t.insert("id".into(), Value::Str("id".into()));
        t.insert("created".into(), Value::Str("2026-01-01T00:00:00Z".into()));
        t.insert("notes".into(), Value::Str("l1\n".into()));
        match validate_emit_table(&t, "") {
            Err(FrontmatterError::Unemittable { reason }) => {
                assert!(reason.contains("ends in `\\n`"), "reason: {reason}");
            }
            other => panic!("expected Unemittable, got {other:?}"),
        }
    }

    /// Whole-branch P1: an Array item containing a double quote is
    /// unemittable. The flow emitter wraps items in `"` without
    /// escaping, so an inner quote desyncs the parser's quote-aware
    /// comma split (stored `a", b` emits `["a", b"]`, which
    /// re-parses as unbalanced quotes → unparseable file).
    #[test]
    fn quote_in_array_item_is_unemittable() {
        let mut t: Table = IndexMap::new();
        t.insert("id".into(), Value::Str("id".into()));
        t.insert("created".into(), Value::Str("2026-01-01T00:00:00Z".into()));
        t.insert("tags".into(), Value::Array(vec!["a\", b".into()]));
        match validate_emit_table(&t, "") {
            Err(FrontmatterError::Unemittable { reason }) => {
                assert!(reason.contains("double quote"), "reason: {reason}");
            }
            other => panic!("expected Unemittable, got {other:?}"),
        }
    }

    /// Whole-branch P1, repro: a note whose block-seq item stores
    /// `a", b` (via a single-quoted `- 'a", b'` line) parses fine,
    /// but a no-change `write_document` on it must refuse with
    /// `Unemittable` and leave the file byte-identical. The NoOp
    /// probe runs before validation and its own parse failure is
    /// treated as "changed" (`_ => false`) — that must not let the
    /// corrupt emission reach the disk.
    #[test]
    fn quote_in_array_item_blocks_noop_write() {
        let p = tmp().join("n.md");
        let original = "---\
                       \ncustom: keep\
                       \nid: 01928d3e-0000-7000-8000-000000000001\
                       \ncreated: 2026-01-01T00:00:00Z\
                       \ntags:\
                       \n  - 'a\", b'\
                       \n---\
                       \nbody";
        fs::write(&p, original).unwrap();
        // Sanity: the on-disk block-seq form is parseable and the
        // stored item carries the double quote.
        let Parsed::Memo { table, .. } = parse(original, NoteFormat::Markdown).unwrap() else {
            panic!("expected Memo");
        };
        assert_eq!(table["tags"], Value::Array(vec!["a\", b".into()]));
        let err = write_document(
            &p,
            "body",
            NoteFormat::Markdown,
            Mutation::default(),
            Synthesize::No,
            now(),
        )
        .unwrap_err();
        assert!(
            matches!(err, FrontmatterError::Unemittable { .. }),
            "got: {err:?}"
        );
        assert_eq!(fs::read_to_string(&p).unwrap(), original);
    }

    /// Same guard when a real mutation is requested: the write is
    /// refused loudly and the original bytes survive.
    #[test]
    fn quote_in_array_item_blocks_mutating_write() {
        let p = tmp().join("n.md");
        let original = "---\
                       \nid: 01928d3e-0000-7000-8000-000000000001\
                       \ncreated: 2026-01-01T00:00:00Z\
                       \ntags:\
                       \n  - 'a\", b'\
                       \n---\
                       \nbody";
        fs::write(&p, original).unwrap();
        let err = write_document(
            &p,
            "body",
            NoteFormat::Markdown,
            Mutation {
                favorite: Some(true),
                deleted: None,
                set_props: IndexMap::new(),
            },
            Synthesize::No,
            now(),
        )
        .unwrap_err();
        assert!(
            matches!(err, FrontmatterError::Unemittable { .. }),
            "got: {err:?}"
        );
        assert_eq!(fs::read_to_string(&p).unwrap(), original);
    }

    /// Whole-branch P1, variant (b) — a quote WITHOUT a comma is
    /// also not round-trip-safe, empirically: stored `a"b` emits
    /// `["a"b"]` whose inner quote closes the outer one and leaves
    /// the sequence unbalanced. The guard therefore rejects any
    /// double quote in an array item, comma or not.
    #[test]
    fn quote_in_array_item_without_comma_also_desyncs() {
        let src = "---\
                   \nid: 01928d3e-0000-7000-8000-000000000002\
                   \ncreated: 2026-01-01T00:00:00Z\
                   \ntags:\
                   \n  - 'a\"b'\
                   \n---\
                   \nbody";
        // The on-disk block-seq form parses…
        let Parsed::Memo { table, .. } = parse(src, NoteFormat::Markdown).unwrap() else {
            panic!("expected Memo");
        };
        assert_eq!(table["tags"], Value::Array(vec!["a\"b".into()]));
        // …but the canonical flow emission is unparseable.
        let probe = emit(&table, "body", NoteFormat::Markdown);
        assert!(
            parse(&probe, NoteFormat::Markdown).is_err(),
            "probe should be unparseable, got: {probe:?}"
        );
        // So write_document must refuse and leave the file alone.
        let p = tmp().join("n.md");
        fs::write(&p, src).unwrap();
        let err = write_document(
            &p,
            "body",
            NoteFormat::Markdown,
            Mutation::default(),
            Synthesize::No,
            now(),
        )
        .unwrap_err();
        assert!(
            matches!(err, FrontmatterError::Unemittable { .. }),
            "got: {err:?}"
        );
        assert_eq!(fs::read_to_string(&p).unwrap(), src);
    }

    /// Positive control: a comma WITHOUT a quote inside an array
    /// item round-trips through the double-quoted flow form and
    /// must keep writing.
    #[test]
    fn comma_in_array_item_without_quote_still_writes() {
        let p = tmp().join("n.md");
        let src = "---\ntags: [\"b, c\"]\n---\nbody";
        fs::write(&p, src).unwrap();
        let out = write_document(
            &p,
            "body",
            NoteFormat::Markdown,
            Mutation {
                favorite: Some(true),
                deleted: None,
                set_props: IndexMap::new(),
            },
            Synthesize::No,
            now(),
        )
        .unwrap();
        assert!(matches!(out, WriteOutcome::Written));
        let Parsed::Memo { table, .. } =
            parse(&fs::read_to_string(&p).unwrap(), NoteFormat::Markdown).unwrap()
        else {
            panic!("expected Memo");
        };
        assert_eq!(table["tags"], Value::Array(vec!["b, c".into()]));
    }
}
