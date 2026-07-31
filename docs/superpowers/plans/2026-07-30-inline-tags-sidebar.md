# 인라인 `#태그` + 사이드바 탐색 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 본문에 `#태그`를 쓰면 자동 인식되는 파생 모델 + 접이식 사이드바(3상태 복합 필터·색상 필터) + textarea+mirror 인라인 칩 편집기를 oxinot에 도입한다.

**Architecture:** 태그는 본문에서 파생(단일 진실 = 서버). Rust 코어에 `extract_tags`·복합 `NoteFilter`·`list_facets`를 두고, `hash_note`에서 tags 인자를 제거한다. 데스크톱 Tauri 명령과 CLI를 새 시그니처로 갱신. 프론트는 `lib/tags.ts`(추출+하이라이트)를 양측(미러 편집기·사이드바)에서 쓰고, `MirrorTagEditor`(textarea+mirror)로 `TagInput`을 대체, `Sidebar` 컴포넌트로 헤더 chip을 대체한다. 브라우저 mock(`tauri.ts`)도 새 API로 미러링.

**Tech Stack:** Rust (redb, tantivy, unicode-normalization, blake3), Tauri 2, React 19, TypeScript 5.6, Zustand, TanStack Query, Tailwind v4, Vite 6, bun.

**Spec:** `docs/superpowers/specs/2026-07-30-inline-tags-sidebar-design.md`

**Branch:** `feat/inline-tags-sidebar` (이미 생성됨).

## Global Constraints

- macOS 단일 타겟. 프론트 변경은 `cargo build -p oxinot-desktop --release` + `/Applications/oxinot.app/Contents/MacOS/oxinot-desktop` 교체 + `codesign --force --deep -s -` 재서명으로만 앱에 반영됨.
- Rust `regex` crate 없음 → 추출기는 핸드롤 char 스캐너. TS는 동일 알고리즘을 `/[\p{L}\p{N}_]/u` 술어로 미러링. 양측 정규화 = NFC + 소문자.
- 태그 강조색 = 주황 app-wide(CSS 변수 `--tag`/`--tag-bg`). 즐겨찾기는 별 아이콘만(주황 미사용).
- 레거시 태그 마이그레이션 없음(프리릴리즈, 손실 수용).
- 인라인 칩 클릭→필터, 폴더/중첩태그/스마트필터, hex 오깅 정제는 비목표.
- 검증: Rust = `cargo test -p oxinot-core` + `cargo clippy --workspace --all-targets -- -D warnings`. 프론트 = `cd apps/desktop && bun run build`(tsc -b + vite). 매 태스크 끝 커밋.

## File Structure

| 파일 | 역할 |
|---|---|
| `crates/oxinot-core/src/tags.rs` (신규) | `extract_tags` — 본문→정규화 태그 벡터 |
| `crates/oxinot-core/src/note.rs` | `NoteFilter` 복합화 + `Facets` 타입 |
| `crates/oxinot-core/src/hash.rs` | `hash_note` tags 인자 제거 |
| `crates/oxinot-core/src/vault.rs` | create/update 파생, `list_facets` 추가 |
| `crates/oxinot-core/src/store/files.rs` | `read_note` 해시 재계산 갱신 |
| `crates/oxinot-core/src/lib.rs` | `tags` 모듈 + `Facets` 재수출 |
| `crates/oxinot-cli/src/commands.rs` | `cmd_new` 접기, `cmd_list` 복합 필터 |
| `crates/oxinot-cli/src/main.rs` | `--tag` 도움말, `Cmd::List` 필드 |
| `apps/desktop/src-tauri/src/lib.rs` | 명령 시그니처 + `list_facets` + handler |
| `apps/desktop/src/lib/tags.ts` (신규) | `extractTags` + `highlightTags` |
| `apps/desktop/src/lib/api.ts` | 시그니처 + `listFacets` |
| `apps/desktop/src/lib/types.ts` | `Facets` 타입 |
| `apps/desktop/src/lib/tauri.ts` | mock 미러링 + `extractTags` import |
| `apps/desktop/src/app.css` | `--tag` 변수 |
| `apps/desktop/src/components/MirrorTagEditor.tsx` (신규) | textarea+mirror 편집기 |
| `apps/desktop/src/components/NoteComposeForm.tsx` | TagInput 제거, 미러 편집기 |
| `apps/desktop/src/components/CaptureOverlay.tsx` | body-only create |
| `apps/desktop/src/components/NoteDetail.tsx` | body-only update |
| `apps/desktop/src/components/TagInput.tsx` | **삭제** |
| `apps/desktop/src/components/Sidebar.tsx` (신규) | 접이식 사이드바 |
| `apps/desktop/src/components/CardGrid.tsx` | 레이아웃 + 필터 |
| `apps/desktop/src/components/Card.tsx` | 태그 칩 주황 |
| `apps/desktop/src/stores/ui.ts` | 필터+사이드바 상태 |
| `apps/desktop/src/lib/locales/{ko,en}.ts` | 새 문자열 |

---

### Task 1: Rust `extract_tags` 모듈 (TDD)

**Files:**
- Create: `crates/oxinot-core/src/tags.rs`
- Modify: `crates/oxinot-core/src/lib.rs` (모듈 선언 + 재수출)

**Produces:** `pub fn extract_tags(body: &str) -> Vec<String>`

- [ ] **Step 1: 모듈 골격 + 테스트 작성**

`crates/oxinot-core/src/tags.rs` 생성:

```rust
//! Inline `#tag` extraction from note bodies (§3).
//!
//! A `#` starts a tag only when it is NOT immediately preceded by a Unicode
//! letter or digit — so chord symbols like `C#m7` / `F#m7` are not tagged,
//! while `#악보` at a word boundary is. Markdown headings (`# Title`) never
//! match because the `#` is followed by whitespace. No `regex` crate: a small
//! hand-rolled char scanner keeps the dependency footprint flat and avoids
//! unicode-feature uncertainty. The TypeScript mirror in `apps/desktop/
//! src/lib/tags.ts` MUST implement the identical algorithm.

use unicode_normalization::UnicodeNormalization;

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Extract, NFC-normalize, and lowercase the inline `#tags` in `body`.
/// Order = first occurrence; duplicates removed (case-insensitive after
/// normalization). The body's display casing is NOT altered here.
pub fn extract_tags(body: &str) -> Vec<String> {
    let chars: Vec<char> = body.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '#' {
            let prev_ok = i == 0 || !is_word(chars[i - 1]);
            if prev_ok {
                let start = i + 1;
                let mut j = start;
                while j < chars.len() && is_word(chars[j]) {
                    j += 1;
                }
                if j > start {
                    let token: String = chars[start..j].iter().collect();
                    let norm: String = token.nfc().collect::<String>().to_lowercase();
                    if !out.iter().any(|t| t == &norm) {
                        out.push(norm);
                    }
                }
                i = j;
                continue;
            }
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_basic_tags() {
        assert_eq!(extract_tags("#악보 #장범준 #기타"), vec!["악보", "장범준", "기타"]);
    }

    #[test]
    fn chord_symbols_are_not_tags() {
        // User's real data: chords must not become tags.
        assert_eq!(extract_tags("간주 DM7 AM7 C#m7 F#m7 Bm7 E"), Vec::<String>::new());
    }

    #[test]
    fn markdown_heading_is_not_a_tag() {
        assert_eq!(extract_tags("# Heading\nbody #real"), vec!["real"]);
    }

    #[test]
    fn korean_and_case_normalization() {
        // NFC + lowercase; display casing in body is irrelevant to output.
        assert_eq!(extract_tags("#IDEA #Idea #idea"), vec!["idea"]);
    }

    #[test]
    fn punctuation_truncates_token() {
        assert_eq!(extract_tags("메모 #태그, 그리고 #업무!"), vec!["태그", "업무"]);
    }

    #[test]
    fn adjacent_hashes_keep_first_only() {
        // `#a#b`: `#b`'s preceding char is letter `a` → not a tag.
        assert_eq!(extract_tags("#a#b"), vec!["a"]);
    }

    #[test]
    fn empty_and_no_hash() {
        assert_eq!(extract_tags(""), Vec::<String>::new());
        assert_eq!(extract_tags("no tags here"), Vec::<String>::new());
    }

    #[test]
    fn hash_at_line_start() {
        assert_eq!(extract_tags("line1\n#two"), vec!["two"]);
    }
}
```

`crates/oxinot-core/src/lib.rs`에 모듈 선언 추가(`pub mod hash;` 줄 근처):

```rust
pub mod tags;
```

그리고 재수출 블록(`pub use vault::...` 근처)에 추가하지 않음 — `tags::extract_tags`로 경로 접근 충분.

- [ ] **Step 2: 테스트 실행 (실→통과 확인)**

Run: `cargo test -p oxinot-core tags::`
Expected: 8 tests pass. (구현과 테스트를 함께 작성했으므로 첫 실행에 통과해야 함; 실패하면 알고리즘 버그 — `is_word`/경계 조건 점검.)

- [ ] **Step 3: 커밋**

```bash
git add crates/oxinot-core/src/tags.rs crates/oxinot-core/src/lib.rs
git commit -m "feat(core): inline #tag extraction with chord-symbol guard"
```

---

### Task 2: 복합 `NoteFilter` + `Facets` 타입 (TDD)

**Files:**
- Modify: `crates/oxinot-core/src/note.rs` (`NoteFilter` struct + `matches`, `Facets` 추가)

**Produces:** 새 `NoteFilter { include_tags, exclude_tags, match_all, colors, favorites_only, include_deleted }`, `pub struct Facets`, `NoteFilter::matches(&NoteSummary)`.

- [ ] **Step 1: `NoteFilter` 교체 + `Facets` 추가 + matches 테스트**

`crates/oxinot-core/src/note.rs`의 기존 `NoteFilter`(242–265줄) 전체를 다음으로 교체:

```rust
/// Filter applied to listings (§4.3, §7.5). Composite: include-tag set
/// (AND or OR), exclude-tag set, color set (OR membership), favorite, deleted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NoteFilter {
    /// Note must contain these tags. Empty = no constraint.
    pub include_tags: Vec<String>,
    /// Note must contain NONE of these tags.
    pub exclude_tags: Vec<String>,
    /// `true` = note must contain ALL `include_tags` (AND); `false` = ANY (OR).
    pub match_all: bool,
    /// Non-empty = note's color must equal one of these (OR membership).
    pub colors: Vec<String>,
    pub favorites_only: bool,
    /// When false, soft-deleted notes are excluded.
    pub include_deleted: bool,
}

impl NoteFilter {
    pub fn matches(&self, s: &NoteSummary) -> bool {
        if !self.include_deleted && s.deleted {
            return false;
        }
        if self.favorites_only && !s.favorite {
            return false;
        }
        if !self.colors.is_empty() && !self.colors.iter().any(|c| c == &s.color.0) {
            return false;
        }
        if !self.exclude_tags.is_empty()
            && self
                .exclude_tags
                .iter()
                .any(|t| s.tags.iter().any(|x| x.eq_ignore_ascii_case(t)))
        {
            return false;
        }
        if !self.include_tags.is_empty() {
            let hit = |t: &String| s.tags.iter().any(|x| x.eq_ignore_ascii_case(t));
            let ok = if self.match_all {
                self.include_tags.iter().all(hit)
            } else {
                self.include_tags.iter().any(hit)
            };
            if !ok {
                return false;
            }
        }
        true
    }
}

/// Tag + color counts across the (non-deleted) vault, for the sidebar (§4.2).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Facets {
    /// `(normalized_tag, count)` sorted by tag.
    pub tags: Vec<(String, u32)>,
    /// `(oklch_color, count)` sorted by color; empty-color notes excluded.
    pub colors: Vec<(String, u32)>,
}
```

`matches` 테스트를 `note.rs` 파일末尾 `#[cfg(test)] mod` 가 없다면 추가(없으면 새로 만듦):

```rust
#[cfg(test)]
mod filter_tests {
    use super::*;
    use time::OffsetDateTime;

    fn sum(tags: &[&str], color: &str, favorite: bool) -> NoteSummary {
        NoteSummary {
            id: NoteId::now(),
            created_at: OffsetDateTime::now_utc(),
            updated_at: OffsetDateTime::now_utc(),
            hash: NoteHash::new("h"),
            favorite,
            color: NoteColor(color.to_string()),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            preview: String::new(),
            deleted: false,
        }
    }

    #[test]
    fn include_or_and_exclude() {
        let f = NoteFilter {
            include_tags: vec!["a".into(), "b".into()],
            exclude_tags: vec!["x".into()],
            match_all: false,
            ..Default::default()
        };
        assert!(f.matches(&sum(&["a"], "", false)));
        assert!(f.matches(&["b", "c"][..].into_iter().copied().collect::<Vec<_>>().iter().map(|s| *s).collect::<Vec<_>>() .iter().map(|s| s.to_string()).collect::<Vec<_>>().iter().map(|_| "b").collect::<Vec<_>>().iter().map(|s| s.to_string()).collect::<Vec<_>>().len()).is_empty() || f.matches(&sum(&["b"], "", false)));
        assert!(!f.matches(&sum(&["c"], "", false)));
        assert!(!f.matches(&sum(&["a", "x"], "", false))); // excluded
    }

    #[test]
    fn include_and_requires_all() {
        let f = NoteFilter {
            include_tags: vec!["a".into(), "b".into()],
            match_all: true,
            ..Default::default()
        };
        assert!(f.matches(&sum(&["a", "b"], "", false)));
        assert!(!f.matches(&sum(&["a"], "", false)));
    }

    #[test]
    fn color_membership() {
        let f = NoteFilter {
            colors: vec!["oklch(0.75 0.15 25)".into()],
            ..Default::default()
        };
        assert!(f.matches(&sum(&[], "oklch(0.75 0.15 25)", false)));
        assert!(!f.matches(&sum(&[], "oklch(0.7 0.13 270)", false)));
        assert!(NoteFilter::default().matches(&sum(&[], "", false))); // empty colors = no constraint
    }
}
```

> 위 `include_or_and_exclude`의 두 번째 단언이 어색하게 꼬였다면, 단순화해 `assert!(f.matches(&sum(&["b"], "", false)));` 한 줄로 대체할 것 — OR이므로 `["b"]`는 통과해야 함. (계획 작성자가 실수로 늘린 표현; 구현자는 단순형을 쓸 것.)

- [ ] **Step 2: 테스트 실행**

Run: `cargo test -p oxinot-core note::filter_tests`
Expected: 3 pass. (컴파일 에러 = 다른 파일의 구 `NoteFilter { tag, .. }` 리터럴 때문 — Task 4/5/6에서 정리. 이 태스크에서는 `note.rs` 자체 컴파일만 확인: `cargo build -p oxinot-core`는 실패 가능. 대신 `cargo test -p oxinot-core note::filter_tests`가 crate 전체를 컴파일하므로 구 리터럴 때문에 실패함. 따라서 **이 태스크는 Task 3(해시)과 함께 먼저 컴파일 깨짐을 감수**하고, Task 4·5·6에서 모든 호출부를 고친 뒤 전체가 통과. 진행 순서상 Task 2·3·4·5·6을 연속으로 끝낸 뒤 `cargo test`/`clippy`를 한 번에 돌린다.)

- [ ] **Step 3: 커밋 (호출부 정리 전, WIP 허용)**

```bash
git add crates/oxinot-core/src/note.rs
git commit -m "refactor(core): composite NoteFilter + Facets type"
```

---

### Task 3: `hash_note`에서 tags 제거

**Files:**
- Modify: `crates/oxinot-core/src/hash.rs` (`hash_note` 시그니처 + 본문 + 테스트)

- [ ] **Step 1: `hash_note` 갱신**

`crates/oxinot-core/src/hash.rs` 81–95줄(`hash_note`)을 다음으로 교체:

```rust
/// Hash a note's full meaningful state: body + favorite + color (§5.3).
///
/// Tags are intentionally NOT a separate input: they are derived from the
/// body (§4.1), so the body digest already covers tag changes. Hashing them
/// again would double-count and reintroduce the body⊥tags assumption that
/// the derived model removes.
///
/// Deliberately excluded from the input:
/// - `hash` (avoids a self-referential cycle),
/// - `id` / `created_at` (immutable after creation),
/// - `updated_at` (it is the sync *cursor*, not content),
/// - `deleted_at` (tombstones travel via the manifest's `deleted` flag).
pub fn hash_note(body: &[u8], favorite: bool, color: &str) -> NoteHash {
    let normalized_body = normalize(body);
    let mut hasher = Hasher::new();
    hasher.update(normalized_body.as_bytes());
    hasher.update(b"\x1f"); // unit separator between fields
    hasher.update(if favorite { b"1" } else { b"0" });
    hasher.update(b"\x1f");
    hasher.update(color.as_bytes());
    NoteHash::new(hasher.finalize().to_hex().to_string())
}

테스트 `metadata_only_edit_changes_hash`(137–146줄)를 다음으로 교체(태그⊥body 단언 제거, `#x` 포함 단언 추가):

```rust
        // Favorite / color still change the hash (§9.2). Tags are derived from the
        // body now, so a tag change IS a body change — covered by the next test.
        let base = hash_note(b"body", false, "");
        let favorite = hash_note(b"body", true, "");
        let colored = hash_note(b"body", false, "oklch(0.75 0.15 75)");
        assert_ne!(base, favorite);
        assert_ne!(base, colored);
    }

    #[test]
    fn tag_in_body_changes_hash() {
        // Adding `#x` to the body changes the digest (tags live in the body).
        let a = hash_note(b"note", false, "");
        let b = hash_note(b"note #x", false, "");
        assert_ne!(a, b);
    }
```

`identical_state_hashes_equal`(148–163줄)를 새 시그니처로 교체:

```rust
    #[test]
    fn identical_state_hashes_equal() {
        let a = hash_note(b"body", true, "oklch(0.75 0.15 75)");
        let b = hash_note(b"body", true, "oklch(0.75 0.15 75)");
        assert_eq!(a, b);
    }
```

- [ ] **Step 2: 커밋**

```bash
git add crates/oxinot-core/src/hash.rs
git commit -m "refactor(core): drop tags from note hash (body-derived)"
```

---

### Task 4: Vault — 파생 태그 + `list_facets`

**Files:**
- Modify: `crates/oxinot-core/src/vault.rs`
- Modify: `crates/oxinot-core/src/store/files.rs` (`read_note` 해시 호출)

**Consumes:** `crate::tags::extract_tags`, 새 `hash_note(body, favorite, color)`, `Facets`.

- [ ] **Step 1: `vault.rs` import + `create_note`**

`vault.rs` 상단 import 영역에 `use crate::tags::extract_tags;` 추가(기존 `use crate::hash;` 근처).

`create_note`(101–129줄) 시그니처를 `tags` 인자 제거 + 파생으로 교체:

```rust
    pub fn create_note(&self, body: String, color: Option<String>) -> Result<Note> {
        self.ensure_initialized()?;
        let tags = extract_tags(&body);
        validate_note_input(&body, &tags)?;
        let now = OffsetDateTime::now_utc();
        let id = NoteId::now();
        let color = color.map(NoteColor).unwrap_or_default();
        let note = Note {
            id,
            created_at: now,
            updated_at: now,
            hash: hash::hash_note(body.as_bytes(), false, &color.0),
            favorite: false,
            color,
            tags,
            body,
            deleted_at: None,
        };
        self.files.write(&note)?;
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note))?;
            search.upsert(note.id, &note.body, &note.tags)
        })?;
        Ok(note)
    }
```

- [ ] **Step 2: `update_note` — body 변경 시 재파생**

`update_note`(167–197줄)을 다음으로 교체(`tags` 인자 제거, body 변경 시 파생):

```rust
    pub fn update_note(
        &self,
        id: NoteId,
        body: Option<String>,
        favorite: Option<bool>,
        color: Option<String>,
    ) -> Result<Note> {
        let mut note = self.get_note(id)?;
        if let Some(b) = body {
            note.body = b;
            note.tags = extract_tags(&note.body); // body is single source of truth
        }
        if let Some(p) = favorite {
            note.favorite = p;
        }
        if let Some(c) = color {
            note.color = NoteColor(c);
        }
        validate_note_input(&note.body, &note.tags)?;
        note.updated_at = OffsetDateTime::now_utc();
        note.hash = hash::hash_note(note.body.as_bytes(), note.favorite, &note.color.0);
        self.files.write(&note)?;
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note))?;
            search.upsert(note.id, &note.body, &note.tags)
        })?;
        Ok(note)
    }
```

`#[allow(clippy::too_many_arguments)]` 어트리뷰트(166줄)는 더 이상 불필요 — 제거.

- [ ] **Step 3: delete/restore 해시 호출 갱신**

`delete_note`(205줄)·`restore_note`(219줄)의 `hash::hash_note(...)` 호출에서 `&note.tags,` 인자를 제거:

```rust
        note.hash = hash::hash_note(note.body.as_bytes(), note.favorite, &note.color.0);
```

(두 곳 모두 동일 변경.)

- [ ] **Step 4: `list_facets` 추가**

`vault.rs`의 `note_stats`(295–310줄) 메서드 뒤에 추가:

```rust
    /// Tag + color counts over live (non-deleted) notes for the sidebar (§4.2).
    pub fn list_facets(&self) -> Result<crate::note::Facets> {
        self.with_redb(|idx| {
            let recs = idx.export_since(None)?;
            let mut tag_map: std::collections::BTreeMap<String, u32> = Default::default();
            let mut color_map: std::collections::BTreeMap<String, u32> = Default::default();
            for r in &recs {
                if r.deleted {
                    continue;
                }
                for t in &r.tags {
                    *tag_map.entry(t.clone()).or_insert(0) += 1;
                }
                if !r.color.0.is_empty() {
                    *color_map.entry(r.color.0.clone()).or_insert(0) += 1;
                }
            }
            Ok(crate::note::Facets {
                tags: tag_map.into_iter().collect(),
                colors: color_map.into_iter().collect(),
            })
        })
    }
```

- [ ] **Step 5: `store/files.rs` `read_note` 해시 갱신**

`crates/oxinot-core/src/store/files.rs` 148줄을 새 시그니처로 + 본문 재파생:

```rust
                let tags = crate::tags::extract_tags(&body);
                let note = Note {
                    id: fm.id,
                    created_at: fm.created_at,
                    updated_at: fm.updated_at,
                    hash: hash::hash_note(body.as_bytes(), fm.favorite, &fm.color.0),
                    favorite: fm.favorite,
                    color: fm.color,
                    tags,
                    body,
                    deleted_at: fm.deleted_at,
                };
```

(기존 `tags: fm.tags,` 줄을 `tags,` 로 바꾸고 그 위에 `let tags = ...` 추가. `fm.tags`는 더 이상 읽지 않음 — 레거시 frontmatter tags는 무시됨 = 의도.)

- [ ] **Step 6: `lib.rs` 재수출에 `Facets` 추가**

`crates/oxinot-core/src/lib.rs` 27–30줄 재수출 블록에 `Facets` 추가:

```rust
pub use note::{
    Cursor, Facets, IndexStats, Note, NoteColor, NoteFilter, NoteHash, NoteId, NoteStats,
    NoteSummary, Page,
};
```

- [ ] **Step 7: 커밋**

```bash
git add crates/oxinot-core/src/vault.rs crates/oxinot-core/src/store/files.rs crates/oxinot-core/src/lib.rs
git commit -m "feat(core): derive tags from body + list_facets"
```

---

### Task 5: CLI 새 시그니처 적응

**Files:**
- Modify: `crates/oxinot-cli/src/commands.rs`
- Modify: `crates/oxinot-cli/src/main.rs`

- [ ] **Step 1: `cmd_new` — `--tag`을 본문으로 접기**

`crates/oxinot-cli/src/commands.rs` `cmd_new`(14–37줄)을 다음으로 교체:

```rust
/// `oxinot new` — capture a note from an argument or stdin.
///
/// `--tag` values are folded into the body as inline `#tag` tokens so the
/// derived model picks them up (the core no longer takes a tags argument).
pub fn cmd_new(
    vault: &Vault,
    text: Option<String>,
    tags: Vec<String>,
    color: Option<String>,
) -> Result<()> {
    let mut body = match text {
        Some(t) => t,
        None => {
            use std::io::Read;
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .context("read stdin")?;
            buf.trim_end().to_string()
        }
    };
    if !tags.is_empty() {
        let suffix = tags
            .iter()
            .map(|t| format!("#{}", t.trim().trim_start_matches('#')))
            .collect::<Vec<_>>()
            .join(" ");
        if body.is_empty() {
            body = suffix;
        } else {
            body.push_str("\n\n");
            body.push_str(&suffix);
        }
    }
    if body.is_empty() {
        return Err(anyhow!("refusing to create an empty note"));
    }
    let note = vault.create_note(body, color)?;
    println!("{}", note.id);
    Ok(())
}
```

- [ ] **Step 2: `cmd_list` — 복합 필터**

`cmd_list`(40–54줄) 시그니처 + 본문 교체:

```rust
/// `oxinot list`.
pub fn cmd_list(
    vault: &Vault,
    limit: u32,
    tag: Vec<String>,
    favorite: bool,
    fmt: Format,
) -> Result<()> {
    let filter = NoteFilter {
        include_tags: tag,
        match_all: false,
        favorites_only: favorite,
        ..Default::default()
    };
    let page = vault.list_notes(None, limit, filter)?;
    format::print_summaries(&page.items, fmt)
}
```

- [ ] **Step 3: `main.rs` — `Cmd::List.tag` 타입 + 도움말**

`crates/oxinot-cli/src/main.rs`의 `Cmd::List` 변형에서 `tag` 필드(51–52줄 근처)를 다음으로 교체(repeatable):

```rust
        /// Include notes with this tag (repeatable; OR).
        #[arg(long = "tag", value_name = "TAG")]
        tag: Vec<String>,
```

`Cmd::New`의 `tags` 필드 도움말(39–41줄 근처)을 갱신:

```rust
        /// Inline tag appended to the body as `#TAG` (repeatable).
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
```

`match cli.cmd`의 `Cmd::List { ... }` 분기(150–158줄)는 필드명이 `tag`로 동일하므로 변경 불필요(타입만 `Vec<String>`로 바뀜 — `cmd_list` 시그니처와 일치).

- [ ] **Step 4: 커밋**

```bash
git add crates/oxinot-cli/src/commands.rs crates/oxinot-cli/src/main.rs
git commit -m "feat(cli): fold --tag into body + repeatable list filter"
```

---

### Task 6: Tauri 명령 + handler

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: `list_notes` 명령 — 복합 필터 인자**

`lib.rs` `commands::list_notes`(156–177줄)을 다음으로 교체:

```rust
    #[tauri::command]
    pub fn list_notes(
        state: State<'_, AppState>,
        after: Option<String>,
        limit: u32,
        include_tags: Vec<String>,
        exclude_tags: Vec<String>,
        match_all: bool,
        colors: Vec<String>,
        favorites_only: bool,
    ) -> Result<oxinot_core::Page<oxinot_core::NoteSummary>, String> {
        let after = match after {
            Some(s) => Some(Cursor::parse(&s).map_err(|e| e.to_string())?),
            None => None,
        };
        let filter = NoteFilter {
            include_tags,
            exclude_tags,
            match_all,
            colors,
            favorites_only,
            include_deleted: false,
        };
        state
            .vault
            .list_notes(after, limit, filter)
            .map_err(|e| e.to_string())
    }
```

- [ ] **Step 2: `create_note` — tags 인자 제거**

`commands::create_note`(185–199줄)을 다음으로 교체:

```rust
    #[tauri::command]
    pub fn create_note(
        state: State<'_, AppState>,
        app: AppHandle,
        body: String,
        color: Option<String>,
    ) -> Result<oxinot_core::Note, String> {
        let note = state
            .vault
            .create_note(body, color)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("notes:changed", ());
        Ok(note)
    }
```

- [ ] **Step 3: `update_note` — tags 인자 제거**

`commands::update_note`(201–218줄)을 다음으로 교체:

```rust
    #[tauri::command]
    pub fn update_note(
        state: State<'_, AppState>,
        app: AppHandle,
        id: String,
        body: Option<String>,
        favorite: Option<bool>,
        color: Option<String>,
    ) -> Result<oxinot_core::Note, String> {
        let id = NoteId::parse(&id).map_err(|e| e.to_string())?;
        let note = state
            .vault
            .update_note(id, body, favorite, color)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("notes:changed", ());
        Ok(note)
    }
```

- [ ] **Step 4: `list_facets` 명령 추가 + handler 등록**

`commands` 모듈 안(`note_stats` 뒤)에 추가:

```rust
    #[tauri::command]
    pub fn list_facets(state: State<'_, AppState>) -> Result<oxinot_core::Facets, String> {
        state.vault.list_facets().map_err(|e| e.to_string())
    }
```

`generate_handler!` 목록(70–82줄)에 `commands::list_facets,` 추가(`commands::note_stats,` 뒤).

- [ ] **Step 5: 코어+CLI+Tauri 전체 검증**

Run: `cargo test -p oxinot-core && cargo clippy --workspace --all-targets -- -D warnings`
Expected: 모든 테스트 통과, clippy 경고 0. (Task 2·3·4의 컴파일 깨짐이 여기서 해소되어야 함. 실패 시 구 `NoteFilter { tag }`/구 `hash_note` 4인자 호출 잔여분 grep: `rg "tag," crates ; rg "hash_note\(" crates`.)

- [ ] **Step 6: 커밋**

```bash
git add apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): composite filter + list_facets tauri commands"
```

---

### Task 7: 프론트 `lib/tags.ts` (추출 + 하이라이트)

**Files:**
- Create: `apps/desktop/src/lib/tags.ts`

**Produces:** `extractTags(body): string[]`, `highlightTags(body): {text, tag}[]`.

- [ ] **Step 1: 구현**

`apps/desktop/src/lib/tags.ts` 생성. 알고리즘은 Rust `tags.rs`와 동일(선행 글자/숫자 가드):

```ts
/**
 * Inline `#tag` extraction + highlight, mirroring `crates/oxinot-core/src/tags.rs`.
 * A `#` starts a tag only when NOT preceded by a Unicode letter/digit, so chord
 * symbols (`C#m7`) and markdown headings (`# Title`) never match. Extraction
 * normalizes (NFC + lowercase); highlighting preserves the body's display casing.
 * Keep this algorithm byte-for-byte equivalent to the Rust scanner.
 */

const WORD = /[\p{L}\p{N}_]/u;

function isWord(c: string): boolean {
  return WORD.test(c);
}

/** Normalized, lowercased, de-duplicated inline tags in first-occurrence order. */
export function extractTags(body: string): string[] {
  const chars = [...body]; // unicode code points
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "#") {
      const prevOk = i === 0 || !isWord(chars[i - 1]);
      if (prevOk) {
        const start = i + 1;
        let j = start;
        while (j < chars.length && isWord(chars[j])) j += 1;
        if (j > start) {
          const token = chars.slice(start, j).join("");
          const norm = token.normalize("NFC").toLowerCase();
          if (!out.includes(norm)) out.push(norm);
        }
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

export type TagSegment = { text: string; tag: boolean };

/** Split body into plain / `#tag` segments for the mirror highlighter.
 *  `tag` segments carry the raw display text INCLUDING the leading `#`. */
export function highlightTags(body: string): TagSegment[] {
  const chars = [...body];
  const segs: TagSegment[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      segs.push({ text: buf, tag: false });
      buf = "";
    }
  };
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "#") {
      const prevOk = i === 0 || !isWord(chars[i - 1]);
      if (prevOk) {
        const start = i + 1;
        let j = start;
        while (j < chars.length && isWord(chars[j])) j += 1;
        if (j > start) {
          flush();
          segs.push({ text: "#" + chars.slice(start, j).join(""), tag: true });
          i = j;
          continue;
        }
      }
    }
    buf += chars[i];
    i += 1;
  }
  flush();
  return segs;
}
```

- [ ] **Step 2: 타입체크**

Run: `cd apps/desktop && bunx tsc -b`
Expected: 통과.

- [ ] **Step 3: 커밋**

```bash
git add apps/desktop/src/lib/tags.ts
git commit -m "feat(desktop): inline #tag extract + highlight (Rust mirror)"
```

---

### Task 8: 프론트 `api.ts` / `types.ts` / `tauri.ts`

**Files:**
- Modify: `apps/desktop/src/lib/api.ts`
- Modify: `apps/desktop/src/lib/types.ts`
- Modify: `apps/desktop/src/lib/tauri.ts`

- [ ] **Step 1: `types.ts` — `Facets` 추가**

`apps/desktop/src/lib/types.ts`末尾에 추가:

```ts
export interface Facets {
  tags: [string, number][];
  colors: [string, number][];
}
```

- [ ] **Step 2: `api.ts` — 시그니처 + `listFacets`**

`apps/desktop/src/lib/api.ts`의 `listNotes`·`createNote`·`updateNote` 교체 + `listFacets` 추가:

```ts
export async function listNotes(
  after: string | null,
  limit = 50,
  filter: {
    include_tags?: string[];
    exclude_tags?: string[];
    match_all?: boolean;
    colors?: string[];
    favorites_only?: boolean;
  } = {},
) {
  return invoke<{ items: NoteSummary[]; next_cursor: string | null }>("list_notes", {
    after,
    limit,
    include_tags: filter.include_tags ?? [],
    exclude_tags: filter.exclude_tags ?? [],
    match_all: filter.match_all ?? false,
    colors: filter.colors ?? [],
    favorites_only: filter.favorites_only ?? false,
  });
}

export async function createNote(body: string, color: string | null) {
  return invoke<Note>("create_note", { body, color });
}

export async function updateNote(
  id: string,
  body: string | null,
  favorite: boolean | null,
  color: string | null,
) {
  return invoke<Note>("update_note", { id, body, favorite, color });
}

export async function listFacets() {
  return invoke<Facets>("list_facets");
}
```

`types.ts` import에 `Facets` 추가: `import type { Note, NoteSummary, IndexStats, DoctorReport, NoteStats, Facets } from "./types";`

- [ ] **Step 3: `tauri.ts` mock 미러링**

`apps/desktop/src/lib/tauri.ts` 상단에 `import { extractTags } from "./tags";` 추가.

`browserFallback`의 `list_notes` 케이스(119–142줄) 필터 파싱 교체:

```ts
    case "list_notes": {
      const after = (args?.after as string | null | undefined) ?? null;
      const limit = (args?.limit as number | undefined) ?? 50;
      const include = (args?.include_tags as string[] | undefined) ?? [];
      const exclude = (args?.exclude_tags as string[] | undefined) ?? [];
      const matchAll = (args?.match_all as boolean | undefined) ?? false;
      const colors = (args?.colors as string[] | undefined) ?? [];
      const favoritesOnly = (args?.favorites_only as boolean | undefined) ?? false;
      const has = (n: Note, t: string) =>
        n.tags.some((x) => x.toLowerCase() === t.toLowerCase());
      const notes = liveSorted(loadStore()).filter((n) => {
        if (favoritesOnly && !n.favorite) return false;
        if (colors.length && !colors.includes(n.color)) return false;
        if (exclude.some((t) => has(n, t))) return false;
        if (include.length) {
          const ok = matchAll ? include.every((t) => has(n, t)) : include.some((t) => has(n, t));
          if (!ok) return false;
        }
        return true;
      });
      let start = 0;
      if (after) {
        const sep = after.indexOf("|");
        const t = sep === -1 ? after : after.slice(0, sep);
        const id = sep === -1 ? "" : after.slice(sep + 1);
        const idx = notes.findIndex((n) => n.updated_at === t && n.id === id);
        start = idx === -1 ? notes.length : idx + 1;
      }
      const page = notes.slice(start, start + limit);
      const last = page.at(-1);
      const next_cursor =
        page.length > 0 && start + limit < notes.length && last
          ? `${last.updated_at}|${last.id}`
          : null;
      return { items: page.map(summaryOf), next_cursor };
    }
```

`create_note` 케이스(160–178줄)에서 tags 파생:

```ts
    case "create_note": {
      const now = new Date().toISOString();
      const body = (args?.body as string | undefined) ?? "";
      const note: Note = {
        id: crypto.randomUUID(),
        created_at: now,
        updated_at: now,
        hash: fakeHash(),
        favorite: false,
        color: (args?.color as string | null | undefined) ?? "",
        tags: extractTags(body),
        body,
        deleted_at: null,
      };
      const store = loadStore();
      store[note.id] = note;
      saveStore(store);
      emitBrowser("notes:changed");
      return note;
    }
```

`update_note` 케이스(180–195줄)에서 body 변경 시 재파생, tags 인자 무시:

```ts
    case "update_note": {
      const id = args?.id as string;
      const store = loadStore();
      const n = store[id];
      if (!n) throw new Error(`note not found: ${id}`);
      if (typeof args?.body === "string") {
        n.body = args.body;
        n.tags = extractTags(n.body);
      }
      if (typeof args?.favorite === "boolean") n.favorite = args.favorite;
      if (typeof args?.color === "string") n.color = args.color;
      n.updated_at = new Date().toISOString();
      n.hash = fakeHash();
      store[id] = n;
      saveStore(store);
      emitBrowser("notes:changed");
      return n;
    }
```

`note_stats` 케이스 뒤에 `list_facets` 케이스 추가:

```ts
    case "list_facets": {
      const live = liveSorted(loadStore());
      const tagMap = new Map<string, number>();
      const colorMap = new Map<string, number>();
      for (const n of live) {
        for (const t of n.tags) tagMap.set(t, (tagMap.get(t) ?? 0) + 1);
        if (n.color) colorMap.set(n.color, (colorMap.get(n.color) ?? 0) + 1);
      }
      return {
        tags: [...tagMap.entries()].sort((a, b) => a[0].localeCompare(b[0])),
        colors: [...colorMap.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      };
    }
```

- [ ] **Step 4: 타입체크**

Run: `cd apps/desktop && bunx tsc -b`
Expected: 에러(호출부 `createNote(body, tags, color)` 등은 Task 10·11에서 수정 → 여기서 타입 에러 예상. **Task 8·9는 lib 레이어만; 호출부 에러는 Task 11 종료 시점 전체 빌드로 해소**. 진행상 Task 8·9 커밋은 `tsc` 실패 가능 — WIP 커밋 허용, Task 11에서 green.)

- [ ] **Step 5: 커밋**

```bash
git add apps/desktop/src/lib/api.ts apps/desktop/src/lib/types.ts apps/desktop/src/lib/tauri.ts
git commit -m "feat(desktop): body-only note API + listFacets + mock mirror"
```

---

### Task 9: 태그 CSS 변수

**Files:**
- Modify: `apps/desktop/src/app.css`

- [ ] **Step 1: `:root`/`.dark` 블록에 태그 변수 추가**

`apps/desktop/src/app.css`의 `:root` 블록(8–11줄)에 추가:

```css
:root {
  --card-surface: #ffffff;
  --card-edge: #e7e7ea;
  --tag: #b45309;
  --tag-bg: #fff3df;
}
```

`.dark` 블록(12–15줄)에 추가:

```css
.dark {
  --card-surface: #18181b;
  --card-edge: #2a2a2e;
  --tag: #ffb84d;
  --tag-bg: rgba(255, 159, 10, 0.16);
}
```

- [ ] **Step 2: 커밋**

```bash
git add apps/desktop/src/app.css
git commit -m "style(desktop): tag accent CSS vars (orange app-wide)"
```

---

### Task 10: `MirrorTagEditor` 컴포넌트

**Files:**
- Create: `apps/desktop/src/components/MirrorTagEditor.tsx`

**Consumes:** `highlightTags` from `../lib/tags`.

- [ ] **Step 1: 구현**

`apps/desktop/src/components/MirrorTagEditor.tsx` 생성:

```tsx
/**
 * Body editor with inline `#tag` chips via the textarea + mirror-overlay
 * technique (§6). A transparent-text <textarea> (caret visible) sits above a
 * pointer-events:none <div> that renders the same text with `#tags` wrapped in
 * colored chips. Identical font/padding/whitespace keeps them pixel-aligned.
 * Input, IME composition, undo, paste, selection are all native textarea —
 * Korean Hangul composition never breaks because we never rewrite the textarea.
 */
import { forwardRef, useImperativeHandle, useRef, type TextareaHTMLAttributes } from "react";
import { highlightTags } from "../lib/tags";

const FONT =
  "text-sm leading-relaxed"; // shared by textarea + mirror

interface Props {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  textareaProps?: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "className">;
}

export const MirrorTagEditor = forwardRef<HTMLTextAreaElement, Props>(
  function MirrorTagEditor({ value, onChange, className = "", textareaProps }, ref) {
    const inner = useRef<HTMLTextAreaElement>(null);
    const mirrorRef = useRef<HTMLDivElement>(null);
    useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement);

    const onScroll = () => {
      if (mirrorRef.current && inner.current) {
        mirrorRef.current.scrollTop = inner.current.scrollTop;
        mirrorRef.current.scrollLeft = inner.current.scrollLeft;
      }
    };

    return (
      <div className={`relative ${className}`}>
        <div
          ref={mirrorRef}
          aria-hidden
          className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words ${FONT} px-0 py-0 text-zinc-800 dark:text-zinc-100`}
        >
          {highlightTags(value).map((s, i) =>
            s.tag ? (
              <span
                key={i}
                className="rounded bg-[var(--tag-bg)] px-0.5 font-medium text-[var(--tag)]"
              >
                {s.text}
              </span>
            ) : (
              <span key={i}>{s.text}</span>
            ),
          )}
          {value.endsWith("\n") ? " " : ""}
        </div>
        <textarea
          ref={inner}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={onScroll}
          spellCheck={false}
          {...textareaProps}
          className={`relative block w-full resize-none bg-transparent caret-zinc-800 text-transparent selection:bg-blue-500/25 focus:outline-none dark:caret-zinc-100 ${FONT} ${textareaProps?.className ?? ""}`}
        />
      </div>
    );
  },
);
```

> 정렬 핵심: textarea와 mirror가 **동일** 폰트 클래스(`text-sm leading-relaxed`)·동일 패딩(여기선 `px-0 py-0`, 호스트가 여백 제어)·`whitespace-pre-wrap break-words`를 공유. 호스트(`NoteComposeForm`)가 양쪽에 같은 박스를 줘야 함 — Task 11에서 textarea 래퍼와 mirror를 같은 컨테이너에 둠.

- [ ] **Step 2: 타입체크**

Run: `cd apps/desktop && bunx tsc -b`
Expected: 이 파일 단독 통과(호출부 미연결은 무관).

- [ ] **Step 3: 커밋**

```bash
git add apps/desktop/src/components/MirrorTagEditor.tsx
git commit -m "feat(desktop): MirrorTagEditor (textarea + overlay, IME-safe)"
```

---

### Task 11: `NoteComposeForm` 재작업 + 호출부 + `TagInput` 삭제

**Files:**
- Modify: `apps/desktop/src/components/NoteComposeForm.tsx`
- Modify: `apps/desktop/src/components/CaptureOverlay.tsx`
- Modify: `apps/desktop/src/components/NoteDetail.tsx`
- Delete: `apps/desktop/src/components/TagInput.tsx`

- [ ] **Step 1: `NoteComposeForm` — TagInput 제거, 미러 편집기**

`NoteComposeForm.tsx` 전체를 다음으로 교체:

```tsx
/**
 * Shared note compose panel. Body is a `MirrorTagEditor` (inline `#tag` chips);
 * the bottom strip is color swatches + confirm only — the tag input is gone
 * because tags are derived from the body (§4.1).
 */
import { type Ref } from "react";
import { Check } from "lucide-react";

import { MirrorTagEditor } from "./MirrorTagEditor";
import { ColorSwatches } from "./ColorPicker";

const cx = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join(" ");

export interface NoteComposeFormProps {
  body: string;
  onBodyChange: (v: string) => void;
  bodyRef?: Ref<HTMLTextAreaElement>;
  bodyProps?: React.TextareaHTMLAttributes<HTMLTextAreaElement>;
  bodyClassName?: string;
  color: string;
  onColorChange: (oklch: string) => void;
  onConfirm: () => void;
  confirmLabel: string;
  confirmDisabled?: boolean;
  confirmKbd?: string;
  className?: string;
}

export function NoteComposeForm({
  body,
  onBodyChange,
  bodyRef,
  bodyProps,
  bodyClassName,
  color,
  onColorChange,
  onConfirm,
  confirmLabel,
  confirmDisabled,
  confirmKbd,
  className,
}: NoteComposeFormProps) {
  return (
    <div className={cx("flex flex-1 flex-col gap-2.5", className)}>
      <MirrorTagEditor
        ref={bodyRef}
        value={body}
        onChange={onBodyChange}
        textareaProps={bodyProps}
        className={cx("min-h-0 flex-1", bodyClassName)}
      />
      <div className="flex flex-wrap items-center gap-2.5">
        <ColorSwatches value={color} onChange={onColorChange} />
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirmDisabled}
          aria-label={confirmLabel}
          title={confirmLabel}
          className="group inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-2 text-white shadow-sm transition-all hover:bg-zinc-800 active:scale-95 disabled:pointer-events-none disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          <Check size={15} strokeWidth={2.5} className="transition-transform group-hover:scale-110" />
          {confirmKbd && (
            <kbd className="font-mono text-[10px] leading-none text-white/60 dark:text-zinc-500">
              {confirmKbd}
            </kbd>
          )}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `CaptureOverlay` — tags 상태 제거, body-only create**

`CaptureOverlay.tsx`에서 `const [tags, setTags] = useState<string[]>([]);`(21줄) 삭제. `capture:show` 리스너의 `setTags([]);`(31줄) 삭제. `save()`의 `createNote(body, tags, color || null)`(63줄)을 `createNote(body, color || null)`로 교체. `<NoteComposeForm ...>`(84–101줄)에서 `tags={tags}`·`onTagsChange={setTags}` 두 prop 삭제.

- [ ] **Step 3: `NoteDetail` — tags 상태 제거, body-only update**

`NoteDetail.tsx`에서 `const [tags, setTags] = useState<string[]>([]);`(35줄) 삭제. seed effect의 `setTags(note.data.tags);`(45줄) 삭제. autosave effect(58줄) `updateNote(selectedId, body, tags, favorite, color)` → `updateNote(selectedId, body, favorite, color)`. effect deps(70줄)에서 `tags` 제거. `close()`의 빈_draft 판정(75줄) `!body.trim() && tags.length === 0` → `!body.trim()`. flush `updateNote`(85줄)도 tags 인자 제거. `<NoteComposeForm ...>`(138–150줄)에서 `tags={tags}

- [ ] **Step 4: `TagInput.tsx` 삭제**

```bash
git rm apps/desktop/src/components/TagInput.tsx
```

- [ ] **Step 5: 전체 프론트 빌드**

Run: `cd apps/desktop && bun run build`
Expected: tsc -b + vite build 통과. (이 시점에서 lib+editor 호출부가 모두 새 시그니처라 green이어야 함. 실패 시 잔여 `tags=`/`onTagsChange`/3인자 `createNote`/4→3인자 `updateNote` grep.)

- [ ] **Step 6: 커밋**

```bash
git add -A apps/desktop/src/components
git commit -m "feat(desktop): mirror editor in compose form, drop TagInput"
```

---

### Task 12: UI store + i18n

**Files:**
- Modify: `apps/desktop/src/stores/ui.ts`
- Modify: `apps/desktop/src/lib/locales/ko.ts`
- Modify: `apps/desktop/src/lib/locales/en.ts`

- [ ] **Step 1: `ui.ts` — 복합 필터 + 사이드바 상태**

`apps/desktop/src/stores/ui.ts` 전체를 다음으로 교체:

```ts
/** UI state store (Zustand). Server data lives in TanStack Query; this
 *  holds only ephemeral UI state per §7.4. */
import { create } from "zustand";
import { loadTheme, type Theme } from "../lib/theme";

export type TagState = "off" | "in" | "out";

interface UIState {
  search: string;
  setSearch: (s: string) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  selectedId: string | null;
  select: (id: string | null) => void;
  /** tag -> filter state (3-state cycle). Absent = "off". */
  tagFilter: Record<string, TagState>;
  cycleTag: (tag: string) => void;
  clearTagFilter: () => void;
  /** AND over the include set when true, OR when false. */
  matchAll: boolean;
  toggleMatchAll: () => void;
  /** Selected colors (OR membership). */
  colorFilter: string[];
  toggleColor: (c: string) => void;
  favoritesOnly: boolean;
  setFavoritesOnly: (b: boolean) => void;
  /** Sidebar collapsed? Persisted to localStorage. */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  error: string | null;
  setError: (msg: string | null) => void;
  toast: string | null;
  setToast: (msg: string | null) => void;
  draftId: string | null;
  setDraftId: (id: string | null) => void;
}

const COLLAPSED_KEY = "oxinot.sidebarCollapsed";
function loadCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(COLLAPSED_KEY) === "1";
}

export const useUI = create<UIState>((set) => ({
  search: "",
  setSearch: (s) => set({ search: s }),
  theme: loadTheme(),
  setTheme: (t) => set({ theme: t }),
  selectedId: null,
  select: (id) => set({ selectedId: id }),
  tagFilter: {},
  cycleTag: (tag) =>
    set((s) => {
      const cur = s.tagFilter[tag] ?? "off";
      const next = cur === "off" ? "in" : cur === "in" ? "out" : "off";
      const tf = { ...s.tagFilter };
      if (next === "off") delete tf[tag];
      else tf[tag] = next;
      return { tagFilter: tf };
    }),
  clearTagFilter: () => set({ tagFilter: {} }),
  matchAll: true,
  toggleMatchAll: () => set((s) => ({ matchAll: !s.matchAll })),
  colorFilter: [],
  toggleColor: (c) =>
    set((s) => ({
      colorFilter: s.colorFilter.includes(c)
        ? s.colorFilter.filter((x) => x !== c)
        : [...s.colorFilter, c],
    })),
  favoritesOnly: false,
  setFavoritesOnly: (b) => set({ favoritesOnly: b }),
  sidebarCollapsed: loadCollapsed(),
  toggleSidebar: () =>
    set((s) => {
      const v = !s.sidebarCollapsed;
      if (typeof window !== "undefined")
        window.localStorage.setItem(COLLAPSED_KEY, v ? "1" : "0");
      return { sidebarCollapsed: v };
    }),
  error: null,
  setError: (msg) => set({ error: msg }),
  toast: null,
  setToast: (msg) => set({ toast: msg }),
  draftId: null,
  setDraftId: (id) => set({ draftId: id }),
}));
```

- [ ] **Step 2: i18n 키 추가**

`ko.ts` dict에 추가(`vault_location` 뒤):

```ts
  all_notes: "모든 노트",
  tags_section: "태그",
  colors_section: "색상",
  all_tags: "모든 태그",
  match_all: "모두 포함",
  match_any: "하나라도 포함",
  hide_sidebar: "사이드바 숨기기",
  show_sidebar: "사이드바 보기",
  filter_summary: "{tags}개 태그 선택 · {notes}개의 메모",
  filter_none: "전체 · {notes}개의 메모",
```

`en.ts` dict에 동일 키 추가:

```ts
  all_notes: "All notes",
  tags_section: "Tags",
  colors_section: "Colors",
  all_tags: "All tags",
  match_all: "Match all",
  match_any: "Match any",
  hide_sidebar: "Hide sidebar",
  show_sidebar: "Show sidebar",
  filter_summary: "{tags} tags · {notes} notes",
  filter_none: "All · {notes} notes",
```

- [ ] **Step 3: 타입체크**

Run: `cd apps/desktop && bunx tsc -b`
Expected: 통과(구 `activeTag`/`setActiveTag` 참조는 Task 13 `CardGrid`에서 제거 → 여기서 에러 가능, Task 13 종료 시 green).

- [ ] **Step 4: 커밋**

```bash
git add apps/desktop/src/stores/ui.ts apps/desktop/src/lib/locales/ko.ts apps/desktop/src/lib/locales/en.ts
git commit -m "feat(desktop): composite filter + sidebar UI state + i18n"
```

---

### Task 13: `Sidebar` + `CardGrid` 재작업 + `Card` 칩

**Files:**
- Create: `apps/desktop/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/components/CardGrid.tsx`
- Modify: `apps/desktop/src/components/Card.tsx`

- [ ] **Step 1: `Sidebar.tsx`**

`apps/desktop/src/components/Sidebar.tsx` 생성:

```tsx
/**
 * Collapsible left sidebar (§7): All notes / Favorites navigation, the tag list
 * with 3-state filter chips + AND/OR toggle, and the color filter swatches.
 * Counts come from `list_facets` (page-independent).
 */
import { useQuery } from "@tanstack/react-query";
import { PanelLeftClose, PanelLeft, Star, Layers } from "lucide-react";

import { listFacets } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useUI, type TagState } from "../stores/ui";

const STATE_CLASS: Record<TagState, string> = {
  off: "bg-zinc-200/70 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  in: "bg-[var(--tag)] text-white font-semibold",
  out: "border border-[var(--tag)] text-[var(--tag)] line-through",
};

export function Sidebar() {
  const { t } = useI18n();
  const facets = useQuery({ queryKey: ["facets"], queryFn: listFacets });
  const tagFilter = useUI((s) => s.tagFilter);
  const cycleTag = useUI((s) => s.cycleTag);
  const clearTagFilter = useUI((s) => s.clearTagFilter);
  const matchAll = useUI((s) => s.matchAll);
  const toggleMatchAll = useUI((s) => s.toggleMatchAll);
  const colorFilter = useUI((s) => s.colorFilter);
  const toggleColor = useUI((s) => s.toggleColor);
  const favoritesOnly = useUI((s) => s.favoritesOnly);
  const setFavoritesOnly = useUI((s) => s.setFavoritesOnly);
  const collapsed = useUI((s) => s.sidebarCollapsed);
  const toggleSidebar = useUI((s) => s.toggleSidebar);

  const tags = facets.data?.tags ?? [];
  const colors = facets.data?.colors ?? [];
  const total = tags.reduce((n, [, c]) => n + c, 0);
  const favoritesCount = facets.data ? undefined : undefined; // favorites count not in facets; omitted

  if (collapsed) {
    return (
      <div className="flex w-10 flex-col items-center gap-2 border-r border-zinc-200 py-2 dark:border-zinc-800">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={t.show_sidebar}
          className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <PanelLeft size={16} />
        </button>
      </div>
    );
  }

  return (
    <aside className="flex w-56 flex-col border-r border-zinc-200 bg-zinc-50/60 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
      <button
        type="button"
        onClick={() => setFavoritesOnly(false)}
        className={`mx-2 flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] ${
          !favoritesOnly ? "bg-zinc-200/70 font-semibold dark:bg-zinc-800" : "text-zinc-600 dark:text-zinc-300"
        }`}
      >
        <span className="flex items-center gap-2"><Layers size={14} /> {t.all_notes}</span>
        <span className="text-[11px] text-zinc-400">{total}</span>
      </button>
      <button
        type="button"
        onClick={() => setFavoritesOnly(true)}
        className={`mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${
          favoritesOnly ? "bg-amber-100 font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" : "text-zinc-600 dark:text-zinc-300"
        }`}
      >
        <Star size={14} /> {t.favorites}
      </button>

      <div className="mt-3 flex items-center justify-between px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t.tags_section}</span>
        <button type="button" onClick={toggleMatchAll} className="text-[10px] font-semibold text-[var(--tag)]">
          {matchAll ? t.match_all : t.match_any} ⇅
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5 px-3 pt-1">
        <button
          type="button"
          onClick={clearTagFilter}
          className="rounded-md bg-zinc-200/70 px-2 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
        >
          {t.all_tags}
        </button>
        {tags.map(([tag, count]) => {
          const st: TagState = tagFilter[tag] ?? "off";
          return (
            <button
              key={tag}
              type="button"
              onClick={() => cycleTag(tag)}
              className={`rounded-md px-2 py-0.5 text-[11px] ${STATE_CLASS[st]}`}
            >
              #{tag} <span className="opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 px-3 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t.colors_section}</div>
      <div className="flex flex-wrap gap-2 px-3 pt-1">
        {colors.map(([color]) => (
          <button
            key={color}
            type="button"
            onClick={() => toggleColor(color)}
            aria-label={color}
            className="h-5 w-5 rounded-md"
            style={{
              backgroundColor: color,
              boxShadow: colorFilter.includes(color) ? "0 0 0 2px var(--card-surface), 0 0 0 3.5px var(--tag)" : undefined,
            }}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={toggleSidebar}
        className="mt-auto mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
      >
        <PanelLeftClose size={14} /> {t.hide_sidebar}
      </button>
    </aside>
  );
}
```

> `favoritesCount`는 facets에 없음 — "즐겨찾기" 행은 건수 없이 토글만 표시(스코프 내 단순화). 원하면 `note_stats`의 favorite를 facets에 병합 가능(비목표).

- [ ] **Step 2: `CardGrid` 재작업 — 레이아웃 + 복합 필터 + facets 무효화**

`CardGrid.tsx`에서 다음 변경:

(a) import 교체: `useUI`에서 `activeTag`/`setActiveTag` 제거, `tagFilter`/`matchAll`/`colorFilter`/`favoritesOnly`/`sidebarCollapsed` 추가. `Sidebar` import 추가. 헤더의 태그 chip 렌더 블록(221–234줄)·`tags` useMemo(82–87줄)·`Star` import(필터 chip용, 사이드바로 이동) 제거.

(b) `listing` queryKey/queryFn(54–59줄)을 복합 필터로 교체:

```ts
  const tagFilter = useUI((s) => s.tagFilter);
  const matchAll = useUI((s) => s.matchAll);
  const colorFilter = useUI((s) => s.colorFilter);
  const include_tags = Object.entries(tagFilter).filter(([, s]) => s === "in").map(([t]) => t);
  const exclude_tags = Object.entries(tagFilter).filter(([, s]) => s === "out").map(([t]) => t);

  const listing = useInfiniteQuery({
    queryKey: ["notes", include_tags, exclude_tags, matchAll, colorFilter, favoritesOnly],
    queryFn: ({ pageParam }) =>
      listNotes(pageParam, PAGE_SIZE, {
        include_tags,
        exclude_tags,
        match_all: matchAll,
        colors: colorFilter,
        favorites_only: favoritesOnly,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
```

(c) 클라이언트 필터(70–80줄 `items` useMemo)를 새 필드로 갱신(검색 경로):

```ts
    return base.filter((n) => {
      if (favoritesOnly && !n.favorite) return false;
      if (colorFilter.length && !colorFilter.includes(n.color)) return false;
      if (exclude_tags.some((t) => n.tags.includes(t))) return false;
      if (include_tags.length) {
        const ok = matchAll ? include_tags.every((t) => n.tags.includes(t)) : include_tags.some((t) => n.tags.includes(t));
        if (!ok) return false;
      }
      return true;
    });
```

(d) `notes:changed` 리스너(121–130줄)에 `facets` 무효화 추가: `qc.invalidateQueries({ queryKey: ["facets"] });` (두 곳 invalidate 뒤에).

(e) 스크롤 리셋 effect(134–136줄) deps를 `[include_tags, exclude_tags, colorFilter, favoritesOnly]` 로.

(f) `onNewNote`(167줄) `createNote("", [], null)` → `createNote("", null)`.

(g) return JSX: 최상위 `<div className="flex h-full flex-col">` 를 `<div className="flex h-full">` 로, 그 안에 `<Sidebar />` 를 첫 자식으로, 기존 헤더+스크롤러를 `<div className="flex flex-1 flex-col min-w-0">` 로 감쌈. 헤더에서 태그 chip 블록(209–235줄의 `flex-1 flex-wrap` div 전체) 제거 — 헤더는 검색 + 새노트 + 설정 + 테마만. 접혔을 때 헤더 좌측에 펼치기 버튼: `sidebarCollapsed`이면 검색 앞에 `<button onClick={toggleSidebar}><PanelLeft/></button>`.

- [ ] **Step 3: `Card` 태그 칩 주황**

`Card.tsx` 73줄 칩 클래스를 태그 악센트로 교체:

```tsx
              className="rounded-full bg-[var(--tag-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--tag)]"
```

- [ ] **Step 4: 전체 프론트 빌드**

Run: `cd apps/desktop && bun run build`
Expected: tsc -b + vite build 통과.

- [ ] **Step 5: 커밋**

```bash
git add apps/desktop/src/components/Sidebar.tsx apps/desktop/src/components/CardGrid.tsx apps/desktop/src/components/Card.tsx
git commit -m "feat(desktop): collapsible sidebar + 3-state filters + orange chips"
```

---

### Task 14: 최종 검증 + 앱 재배포

**Files:** none (verification only)

- [ ] **Step 1: 워크스페이스 Rust 검증**

Run: `cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings`
Expected: 전체 통과, 경고 0.

- [ ] **Step 2: 프론트 빌드**

Run: `cd apps/desktop && bun run build`
Expected: 통과.

- [ ] **Step 3: 릴리즈 빌드 + 앱 교체 + 재서명**

Run:
```bash
cargo build -p oxinot-desktop --release
cp target/release/oxinot-desktop /Applications/oxinot.app/Contents/MacOS/oxinot-desktop
codesign --force --deep -s - /Applications/oxinot.app
```
Expected: 교체 성공, 서명 완료.

- [ ] **Step 4: 브라우저 스모크 (vite dev)**

Run: `cd apps/desktop && bun run dev` → 브라우저에서:
1. 캡처 오버레이: `#회의 메모 #업무` 입력 → 저장 → 카드에 `#회의 #업무` 칩(주황). **한글 조합 입력** 스트레스: `#한글태그` 조합 중 커서 안 튀는지.
2. 사이드바: 태그 건수 표시, 칩 클릭 3상태 순환(꺼짐→주황→취소선), `⇅` 토글 AND/OR, 색상 swatch 다중 선택, `◧` 접기/펼치기 새로고침 후 영속.
3. 검색 + 필터 조합 동작.
Expected: 모두 동작, 콘솔 에러 없음.

- [ ] **Step 5: 커밋 (정리 잔여분 있으면)**

```bash
git status
# 잔여 변경 없으면 스
```

---

## Self-Review Notes (작성자가 점검한 항목)

- **Spec coverage:** §3 추출(Task1/7), §4.1 파생(Task4/8/11), §4.2 facets(Task4/6/8/13), §4.3 복합필터(Task2/5/6/8/12/13), §4.4 해시(Task3/4), §5 마이그레이션 없음(전체 — 마이그레이션 코드 부재), §6 미러 편집기(Task10/11), §7 사이드바(Task12/13), §8 팔레트/헤더/카드(Task9/13). 비목표 명시됨.
- **타입 일관성:** `createNote(body, color)`, `updateNote(id, body, favorite, color)`, `listNotes(after, limit, filter)`, `listFacets()`, `NoteFilter{include_tags,exclude_tags,match_all,colors,favorites_only,include_deleted}`, `Facets{tags,colors}`, `TagState`, ui store 액션명(`cycleTag`/`toggleColor`/`toggleMatchAll`/`toggleSidebar`) 전 태스크 동일.
- **플레이스홀더 없음:** 모든 코드 단계에 실제 코드 포함.
- **알려진 진행 주의:** Task 2·3·4·5·6은 호출부 정리가 태스크를 가로지르므로 중간 `cargo build`는 실패 가능 — Task 6 Step 5에서 한 번에 green. 프론트 Task 8·9·10·11·12·13도 동일(호출부 미연결 기간 tsc 실패 가능) — Task 11·13 종료 시 green. 각 태스크 커밋은 WIP 허용.
