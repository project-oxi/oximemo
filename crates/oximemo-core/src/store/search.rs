//! Full-text search index backed by `tantivy` (§5.1, §7.5). BM25 over the note
//! body and tags.
//!
//! The writer (and its heap arena) is created lazily, so read-only consumers —
//! `oximemo search` from a CLI alongside the GUI — never allocate it and never
//! contend on tantivy's single-writer lock.

use std::sync::Mutex;

use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{Field, STORED, STRING, Schema, TEXT};
use tantivy::{Index, IndexReader, IndexWriter, ReloadPolicy, Term, doc};

use crate::error::{CoreError, Result};
use crate::memo::MemoId;

/// A single search upsert, used for batched reindex commits (§5.6).
pub struct Upsert<'a> {
    pub id: MemoId,
    pub body: &'a str,
    pub title: Option<&'a str>,
    pub tags: &'a [String],
    /// Alias values (Obsidian-convention `aliases` property) — indexed so
    /// searching a synonym finds the note (design 2026-08-23 §5.2).
    pub aliases: &'a str,
}

/// Swappable search boundary (§5.1).
pub trait SearchIndex: Send + Sync {
    fn upsert(
        &self,
        id: MemoId,
        body: &str,
        title: Option<&str>,
        tags: &[String],
        aliases: &str,
    ) -> Result<()>;
    /// Upsert many notes in one transaction. The default loops [`Self::upsert`];
    /// `TantivySearch` overrides it to commit once for fast bulk reindex.
    fn upsert_batch(&self, notes: &[Upsert<'_>]) -> Result<()> {
        for n in notes {
            self.upsert(n.id, n.body, n.title, n.tags, n.aliases)?;
        }
        Ok(())
    }
    fn remove(&self, id: MemoId) -> Result<()>;
    fn search(&self, query: &str, limit: u32) -> Result<Vec<MemoId>>;
    fn clear(&self) -> Result<()>;
}

pub struct TantivySearch {
    index: Index,
    writer: Mutex<Option<IndexWriter>>,
    reader: IndexReader,
    id_field: Field,
    title_field: Field,
    body_field: Field,
    tags_field: Field,
    aliases_field: Field,
}

impl TantivySearch {
    /// Open the index, creating if absent. The writer is created on first
    /// mutating call, so a process that only searches pays nothing for it.
    ///
    /// Schema evolution: if an on-disk index was built with an older
    /// schema (no `aliases` field), the directory is wiped and rebuilt —
    /// tantivy cannot open an index under a different schema. The next
    /// `reindex` repopulates it (design 2026-08-23 §5.2/§9).
    pub fn open(dir: &std::path::Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let schema = build_schema();
        let (id_field, title_field, body_field, tags_field, aliases_field) = fields(&schema);
        let index = if dir.join("meta.json").exists() {
            let existing = Index::open_in_dir(dir)?;
            if existing.schema() != schema {
                tracing::info!("search index schema changed; wiping for rebuild");
                clear_dir(dir)?;
                Index::create_in_dir(dir, schema.clone())?
            } else {
                existing
            }
        } else {
            Index::create_in_dir(dir, schema)?
        };
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;
        Ok(Self {
            index,
            writer: Mutex::new(None),
            reader,
            id_field,
            title_field,
            body_field,
            tags_field,
            aliases_field,
        })
    }

    fn ensure_writer(&self) -> Result<std::sync::MutexGuard<'_, Option<IndexWriter>>> {
        let mut guard = self
            .writer
            .lock()
            .map_err(|e| CoreError::other(e.to_string()))?;
        if guard.is_none() {
            // 15 MB is tantivy's long-standing minimum arena size.
            *guard = Some(self.index.writer(15_000_000)?);
        }
        Ok(guard)
    }

    fn id_term(&self, id: MemoId) -> Term {
        Term::from_field_text(self.id_field, &id.to_string())
    }
}

impl SearchIndex for TantivySearch {
    fn upsert(
        &self,
        id: MemoId,
        body: &str,
        title: Option<&str>,
        tags: &[String],
        aliases: &str,
    ) -> Result<()> {
        let mut guard = self.ensure_writer()?;
        let writer = guard.as_mut().expect("writer initialized");
        writer.delete_term(self.id_term(id));
        let mut doc = doc!(
            self.id_field => id.to_string(),
            self.body_field => body,
            self.tags_field => tags.join(" "),
            self.aliases_field => aliases,
        );
        if let Some(t) = title {
            doc.add_text(self.title_field, t);
        }
        writer.add_document(doc)?;
        writer.commit()?;
        self.reader.reload()?;
        Ok(())
    }
    fn upsert_batch(&self, notes: &[Upsert<'_>]) -> Result<()> {
        if notes.is_empty() {
            return Ok(());
        }
        let mut guard = self.ensure_writer()?;
        let writer = guard.as_mut().expect("writer initialized");
        for n in notes {
            writer.delete_term(self.id_term(n.id));
            let mut doc = doc!(
                self.id_field => n.id.to_string(),
                self.body_field => n.body,
                self.tags_field => n.tags.join(" "),
                self.aliases_field => n.aliases,
            );
            if let Some(t) = n.title {
                doc.add_text(self.title_field, t);
            }
            writer.add_document(doc)?;
        }
        writer.commit()?;
        self.reader.reload()?;
        Ok(())
    }

    fn remove(&self, id: MemoId) -> Result<()> {
        let mut guard = self.ensure_writer()?;
        let writer = guard.as_mut().expect("writer initialized");
        writer.delete_term(self.id_term(id));
        writer.commit()?;
        self.reader.reload()?;
        Ok(())
    }
    fn search(&self, query: &str, limit: u32) -> Result<Vec<MemoId>> {
        let searcher = self.reader.searcher();
        let parser = QueryParser::for_index(
            &self.index,
            vec![
                self.title_field,
                self.body_field,
                self.tags_field,
                self.aliases_field,
            ],
        );
        let q = parser.parse_query(query)?;
        let hits: Vec<(tantivy::Score, tantivy::DocAddress)> =
            searcher.search(&q, &TopDocs::with_limit(limit as usize))?;
        let mut out = Vec::with_capacity(hits.len());
        for (_score, addr) in hits {
            let d: tantivy::TantivyDocument = searcher.doc(addr)?;
            if let Some(v) = d.get_first(self.id_field)
                && let tantivy::schema::OwnedValue::Str(s) = v
                && let Ok(id) = MemoId::parse(s)
            {
                out.push(id);
            }
        }
        Ok(out)
    }

    fn clear(&self) -> Result<()> {
        let mut guard = self.ensure_writer()?;
        let writer = guard.as_mut().expect("writer initialized");
        writer.delete_all_documents()?;
        writer.commit()?;
        self.reader.reload()?;
        Ok(())
    }
}

fn build_schema() -> Schema {
    let mut b = Schema::builder();
    b.add_text_field("id", STRING | STORED);
    b.add_text_field("title", TEXT);
    b.add_text_field("body", TEXT);
    b.add_text_field("tags", TEXT);
    b.add_text_field("aliases", TEXT);
    b.build()
}

fn fields(schema: &Schema) -> (Field, Field, Field, Field, Field) {
    let id = schema.get_field("id").expect("id field");
    let title = schema.get_field("title").expect("title field");
    let body = schema.get_field("body").expect("body field");
    let tags = schema.get_field("tags").expect("tags field");
    let aliases = schema.get_field("aliases").expect("aliases field");
    (id, title, body, tags, aliases)
}

/// Remove every file inside `dir` (the index rebuild path). Tantivy owns
/// several files (meta.json, segments, locks); a plain recursive removal
/// is the documented way to discard an index directory.
fn clear_dir(dir: &std::path::Path) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            std::fs::remove_dir_all(&path)?;
        } else {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn index_and_search() {
        let dir = TempDir::new().unwrap();
        let s = TantivySearch::open(dir.path()).unwrap();
        let id = MemoId::now();
        s.upsert(
            id,
            "the quick brown fox",
            Some("Fox Story"),
            &["animal".into()],
            "",
        )
        .unwrap();
        let hits = s.search("quick", 10).unwrap();
        assert!(hits.contains(&id));
        // Title is also searchable.
        let title_hits = s.search("Fox", 10).unwrap();
        assert!(title_hits.contains(&id));
    }

    #[test]
    fn remove_drops_from_results() {
        let dir = TempDir::new().unwrap();
        let s = TantivySearch::open(dir.path()).unwrap();
        let id = MemoId::now();
        s.upsert(id, "sphinx of black quartz", None, &[], "")
            .unwrap();
        s.remove(id).unwrap();
        assert!(s.search("quartz", 10).unwrap().is_empty());
    }
}
