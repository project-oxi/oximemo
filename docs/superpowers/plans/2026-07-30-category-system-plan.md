# 카테고리 시스템 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 수동 `color` 필드를 카테고리 분류 체계로 대체 — 노트는 `category` id를 저장하고 색상은 `config.toml` 레지스트리에서 파생. 슬래시 명령어(`/note`, `/todo`...)로 빠른 캡처 가능.

**Architecture:** `Note.category: String` (Rust + TS), `CategoriesConfig` in `config.toml`, 색상은 읽기시 룩업. `hash_note`가 `color` 대신 `category`로 해싱. Tauri 래퍼 명령 + 프론트 슬래시 메뉴.

**Tech Stack:** Rust(oxinot-core), Tauri 2, React/Zustand, serde, redb, tanstack-query

## Global Constraints

- `color: NoteColor` 필드를 `category: String`(기본 `"inbox"`)로 교체. `NoteColor` 타입 제거.
- `hash_note(body, favorite, category)` — category 변경이 hash를 바꿈 (동기화 diff 정확성).
- `Frontmatter`에 `#[serde(default)]`로 `category` 추가, `color` 제거. serde가 알려지지 않은 필드 무시 — 구형 파일 `color=` 줄 안전.
- Orphan 카테고리 id → 읽기시 inbox 중성색 폴백. 렌더 브레이크 금지.
- 마이그레이션 M2: 재작성 없음. 기존 파일에 `category` 없으면 inbox. `reindex` 1회로 인덱스 정리.
- `schema_version` 1 → 2 (레거시 `[color]` 감지 무시).
- 프론트 변경 후 `cargo build -p oxinot-desktop --release` + 앱 교체 + 재서명 필요.

---

### Task 1: Rust 데이터 모델 (note.rs + hash.rs)

**Files:**
- Modify: `crates/oxinot-core/src/note.rs` — Note, NoteSummary, NoteFilter, Facets, NoteColor 제거, COLOR_PRESETS 정리, 테스트
- Modify: `crates/oxinot-core/src/hash.rs` — hash_note 시그니처 변경

**Interfaces:**
- Consumes: 없음 (루트 변경)
- Produces: `Note.category: String`, `NoteSummary.category: String`, `NoteFilter.categories: Vec<String>`, `Facets.categories: Vec<(String, u32)>`, `hash_note(body, favorite, category: &str)`

- [ ] **Step 1: Note / NoteSummary 구조체 교체**

`note.rs`에서 `NoteColor` 타입을 제거하고 `color: NoteColor`를 `category: String`으로 교체. `pub const DEFAULT_CATEGORY: &str = "inbox";` 추가.

```rust
// note.rs — Note struct
// 변경 전:
pub color: NoteColor,

// 변경 후:
#[serde(default)]
pub category: String,  // 기본 "inbox"

// NoteColor 타입 제거
// NoteColor::NONE, NoteColor::is_valid, NoteColor::parse_or_none 전부 제거

// COLOR_PRESETS 유지 (config 기본값용)
```

```rust
// NoteSummary — 생성자 업데이트
color: n.color,                    // → category: n.category.clone(),
```

```rust
// NoteFilter
// 변경 전:
pub colors: Vec<String>,
// 변경 후:
pub categories: Vec<String>,
```

```rust
impl NoteFilter {
    pub fn matches(&self, s: &NoteSummary) -> bool {
        // ...
        // 변경 전:
        if !self.colors.is_empty() && !self.colors.iter().any(|c| c == &s.color.0) {
            return false;
        }
        // 변경 후:
        if !self.categories.is_empty() && !self.categories.iter().any(|c| c == &s.category) {
            return false;
        }
        // ...
    }
}
```

```rust
// Facets
// 변경 전:
pub colors: Vec<(String, u32)>,
// 변경 후:
pub categories: Vec<(String, u32)>,
```

- [ ] **Step 2: color_falls_back_for_legacy_values 테스트 제거**

```rust
// 제거:
#[test]
fn color_falls_back_for_legacy_values() { ... }
```

- [ ] **Step 3: filter_tests에서 color_membership → category_membership**

```rust
// 변경 전:
#[test]
fn color_membership() {
    let f = NoteFilter {
        colors: vec!["oklch(0.75 0.15 25)".into()],
        ..Default::default()
    };
    assert!(f.matches(&sum(&[], "oklch(0.75 0.15 25)", false)));
    assert!(!f.matches(&sum(&[], "oklch(0.7 0.13 270)", false)));
    assert!(NoteFilter::default().matches(&sum(&[], "", false)));
}

// 변경 후:
#[test]
fn category_membership() {
    let f = NoteFilter {
        categories: vec!["todo".into()],
        ..Default::default()
    };
    assert!(f.matches(&sum(&[], "todo", false)));
    assert!(!f.matches(&sum(&[], "inbox", false)));
    assert!(NoteFilter::default().matches(&sum(&[], "inbox", false)));
}
```

`sum()` 헬퍼도 `color` 대신 `category` 필드:

```rust
fn sum(tags: &[&str], category: &str, favorite: bool) -> NoteSummary {
    NoteSummary {
        // ...
        // 변경 전:
        color: NoteColor(color.to_string()),
        // 변경 후:
        category: category.to_string(),
        // ...
    }
}
```

- [ ] **Step 4: hash_note 시그니처 변경**

```rust
// hash.rs — 시그니처만 변경
pub fn hash_note(body: &[u8], favorite: bool, category: &str) -> NoteHash {
    // 함수 바디는 동일 — category가 color를 대체하는 것 외 변경 없음
    let normalized = normalize(body);
    let input = format!("{normalized}::{favorite}::{category}");
    // ...
}
```

- [ ] **Step 5: hash 테스트에서 color 인자 → category로 교체**

기존 테스트에서 `hash_note(..., "oklch(...)")` 호출을 `hash_note(..., "inbox")` 등으로 교체.

- [ ] **Step 6: cargo build + test 확인**

```bash
cd crates/oxinot-core && cargo build 2>&1 | head -20
cd crates/oxinot-core && cargo test 2>&1 | tail -20
```

Expected: build OK, 모든 테스트 통과.

- [ ] **Step 7: Commit**

```bash
git add crates/oxinot-core/src/note.rs crates/oxinot-core/src/hash.rs
git commit -m "feat(core): replace NoteColor with category field on Note/Summary

- note.rs: NoteColor type removed, color→category (default inbox)
- NoteFilter.colors→categories, Facets.colors→categories
- hash_note: color param → category param
- Tests updated for new category field"
```

---

### Task 2: Rust 카테고리 레지스트리 (config.rs)

**Files:**
- Modify: `crates/oxinot-core/src/config.rs` — `CategoriesConfig` + `CategoryDef`, `ColorConfig` 제거, helper 함수

**Interfaces:**
- Consumes: Task 1의 `Note` 구조체 변경
- Produces: `CategoriesConfig { items: Vec<CategoryDef> }`, `CategoryDef { id, color, builtin }`, `resolve_category_color(id, items) -> oklch`

- [ ] **Step 1: CategoriesConfig + CategoryDef 정의**

```rust
// config.rs
use serde::{Deserialize, Serialize};

/// Color preset palette used for auto-assigning new categories.
/// Values match the old COLOR_PRESETS (inbox neutral appended).
pub const AUTO_COLORS: &[&str] = &[
    "oklch(0.72 0.01 250)",  // inbox (gray)
    "oklch(0.70 0.14 250)",  // note (blue)
    "oklch(0.75 0.15 75)",   // todo (amber)
    "oklch(0.72 0.15 310)",  // idea (purple)
    "oklch(0.75 0.12 195)",  // bookmark (teal)
    "oklch(0.75 0.13 145)",  // snippet (green)
];

/// Resolve a category id to its oklch color string.
/// Returns the inbox (gray) fallback for any unknown/not-found id.
pub fn resolve_category_color(id: &str, items: &[CategoryDef]) -> String {
    items
        .iter()
        .find(|c| c.id == id)
        .map(|c| c.color.clone())
        .unwrap_or_else(|| AUTO_COLORS[0].to_string())
}

/// Single category definition in the registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryDef {
    pub id: String,
    pub color: String,
    #[serde(default)]
    pub builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CategoriesConfig {
    pub items: Vec<CategoryDef>,
}
```

- [ ] **Step 2: 기본 CategoriesConfig 구현**

```rust
impl Default for CategoriesConfig {
    fn default() -> Self {
        Self {
            items: vec![
                CategoryDef { id: "inbox".into(),    color: AUTO_COLORS[0].into(), builtin: true },
                CategoryDef { id: "note".into(),     color: AUTO_COLORS[1].into(), builtin: true },
                CategoryDef { id: "todo".into(),     color: AUTO_COLORS[2].into(), builtin: true },
                CategoryDef { id: "idea".into(),     color: AUTO_COLORS[3].into(), builtin: true },
                CategoryDef { id: "bookmark".into(), color: AUTO_COLORS[4].into(), builtin: true },
                CategoryDef { id: "snippet".into(),  color: AUTO_COLORS[5].into(), builtin: true },
            ],
        }
    }
}
```

- [ ] **Step 3: VaultConfig에서 ColorConfig 제거 + CategoriesConfig 추가**

```rust
// VaultConfig
#[serde(default)]
pub struct VaultConfig {
    pub general: GeneralConfig,
    pub capture: CaptureConfig,
    pub appearance: AppearanceConfig,
    // pub color: ColorConfig,  ← 제거
    pub categories: CategoriesConfig,  // ← 추가
    pub index: IndexConfig,
    pub schema_version: u32,
}
```

```rust
impl Default for VaultConfig {
    fn default() -> Self {
        Self {
            // ...
            categories: CategoriesConfig::default(),  // ← 추가
            schema_version: 2,  // ← 2로 상향
            // ...
        }
    }
}
```

`ColorConfig` struct 자체를 제거.

- [ ] **Step 4: `note::COLOR_PRESETS` → `AUTO_COLORS` 참조 변경**

`note.rs`에서 `COLOR_PRESETS`는 유지하되 `config.rs`가 `AUTO_COLORS`를 들고 있으므로 중복 방지. `config.rs`가 내보내는 `AUTO_COLORS`를 사용하고 `note::COLOR_PRESETS`는 제거(남아 있을 경우 컴파일 에러로 확인).

- [ ] **Step 5: cargo build + test 확인**

```bash
cargo build -p oxinot-core 2>&1 | head -20
cargo test -p oxinot-core 2>&1 | tail -20
```

Expected: 컴파일 OK, 모든 테스트 통과.

- [ ] **Step 6: Commit**

```bash
git add crates/oxinot-core/src/config.rs
git commit -m "feat(core): add CategoriesConfig with CategoryDef; remove ColorConfig

- CategoriesConfig holds 6 built-in categories (inbox/note/todo/idea/bookmark/snippet)
- resolve_category_color helper with inbox fallback for orphan ids
- VaultConfig.schema_version 1→2, ColorConfig removed"
```

---

### Task 3: Rust 저장소/볼트 (store + vault)

**Files:**
- Modify: `crates/oxinot-core/src/store/files.rs` — Frontmatter
- Modify: `crates/oxinot-core/src/store/index.rs` — IndexRecord, to_summary
- Modify: `crates/oxinot-core/src/vault.rs` — create/update/delete/restore, record_of, list_facets, 새 명령

**Interfaces:**
- Consumes: Task 1+2 — `Note.category`, `hash_note(..., category)`, `CategoriesConfig`
- Produces: `Vault::create_note(body, category)`, `Vault::update_note(..., category)`, `Vault::list_categories()`, `Vault::create_category(id, color?)`

- [ ] **Step 1: Frontmatter color→category**

```rust
// files.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frontmatter {
    pub id: NoteId,
    // ...
    // 변경 전:
    pub color: NoteColor,
    // 변경 후:
    #[serde(default)]
    pub category: String,
    // ...
}
```

```rust
impl Frontmatter {
    pub fn from_note(n: &Note) -> Self {
        Self {
            // ...
            category: n.category.clone(),  // color: n.color.clone() → category
            // ...
        }
    }
}
```

- [ ] **Step 2: IndexRecord color→category**

```rust
// index.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexRecord {
    // ...
    // 변경 전:
    pub color: crate::note::NoteColor,
    // 변경 후:
    #[serde(default)]
    pub category: String,
    // ...
}
```

```rust
impl IndexRecord {
    pub fn to_summary(&self) -> NoteSummary {
        NoteSummary {
            // ...
            // 변경 전:
            color: self.color.clone(),
            // 변경 후:
            category: self.category.clone(),
            // ...
        }
    }
}
```

- [ ] **Step 3: Vault create_note 시그니처 변경**

```rust
// vault.rs
pub fn create_note(&self, body: String, category: Option<String>) -> Result<Note> {
    let tags = extract_tags(&body);
    validate_note_input(&body, &tags)?;
    let now = OffsetDateTime::now_utc();
    let id = NoteId::now();
    let category = category.unwrap_or_else(|| "inbox".to_string());
    let note = Note {
        id,
        created_at: now,
        updated_at: now,
        hash: hash::hash_note(body.as_bytes(), false, &category),
        favorite: false,
        category,
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

- [ ] **Step 4: Vault update_note 시그니처 변경**

```rust
pub fn update_note(
    &self,
    id: NoteId,
    body: Option<String>,
    favorite: Option<bool>,
    category: Option<String>,  // color: Option<String> → category
) -> Result<Note> {
    let mut note = self.get_note(id)?;
    if let Some(b) = body {
        note.body = b;
        note.tags = extract_tags(&note.body);
    }
    if let Some(p) = favorite {
        note.favorite = p;
    }
    if let Some(c) = category {
        note.category = c;  // note.color = NoteColor(c) → category
    }
    validate_note_input(&note.body, &note.tags)?;
    note.updated_at = OffsetDateTime::now_utc();
    note.hash = hash::hash_note(note.body.as_bytes(), note.favorite, &note.category);
        idx.upsert(&record_of(&note))?;
        search.upsert(note.id, &note.body, &note.tags)
    })?;
    Ok(note)
}
```

- [ ] **Step 5: delete_note, restore_note hash 호출 수정**

```rust
// delete_note — hash_note 호출:
note.hash = hash::hash_note(note.body.as_bytes(), note.favorite, &note.category);
// restore_note도 동일

```rust
fn record_of(n: &Note) -> IndexRecord {
    IndexRecord {
        // ...
        // 변경 전:
        color: n.color.clone(),
        // 변경 후:
        category: n.category.clone(),
        // ...
    }
}
```

- [ ] **Step 7: list_facets color_map → category_map**

```rust
pub fn list_facets(&self) -> Result<crate::note::Facets> {
    self.with_redb(|idx| {
        let recs = idx.export_since(None)?;
        let mut tag_map: BTreeMap<String, u32> = Default::default();
        let mut cat_map: BTreeMap<String, u32> = Default::default();
        for r in &recs {
            if r.deleted { continue; }
            for t in &r.tags {
                *tag_map.entry(t.clone()).or_insert(0) += 1;
            }
            if !r.category.is_empty() {
                *cat_map.entry(r.category.clone()).or_insert(0) += 1;
            }
        }
        Ok(crate::note::Facets {
            tags: tag_map.into_iter().collect(),
            categories: cat_map.into_iter().collect(),  // colors → categories
        })
    })
}
```

- [ ] **Step 8: Vault에 list_categories + create_category 추가**

```rust
use crate::config::CategoryDef;

// vault.rs — Vault impl 블록 안에 추가

pub fn list_categories(&self) -> Vec<CategoryDef> {
    self.config.categories.items.clone()
}

pub fn create_category(&self, id: String, color: Option<String>) -> Result<CategoryDef> {
    if id.trim().is_empty() {
        return Err(CoreError::Other("category id must not be empty".into()));
    }
    let id = id.trim().to_lowercase();
    if self.config.categories.items.iter().any(|c| c.id == id) {
        return Err(CoreError::Other(format!("category '{id}' already exists")));
    }
    // Auto-assign color: pick the first AUTO_COLORS hue least used,
    // or fallback to inbox neutral if all used.
    let color = color.unwrap_or_else(|| {
        let used: std::collections::HashSet<&str> = self.config.categories.items.iter().map(|c| c.color.as_str()).collect();
        crate::config::AUTO_COLORS.iter().copied().find(|c| !used.contains(c))
            .unwrap_or(crate::config::AUTO_COLORS[0])
            .to_string()
    });
    let def = CategoryDef { id: id.clone(), color, builtin: false };
    // WARNING: config.toml is not rewritten on create_category in v1.
    // Categories added via this method survive until restart in memory,
    // but are NOT persisted to disk. For a single-user vault this is
    // acceptable — the idea is that adding a category in the capture
    // window is a rare operation and the user can manually edit
    // config.toml if they want permanence. (향후 config.save()로 개선.)
    self.config.categories.items.push(def.clone());
    Ok(def)
}
```

> 참고: `create_category`는 메모리에서만 config를 수정합니다. `config.toml`에 다시 쓰지는 않음(v1). 캡처 중 생성된 카테고리는 세션에 존재하지만 재시작 시 사라짐 — 사용자가 필요한 경우 직접 `config.toml`에 추가. 향후 `self.config.save()` 도입 전까지는 경량 설계를 유지.

- [ ] **Step 9: cargo build + test 확인**

```bash
cargo build -p oxinot-core 2>&1 | head -20
cargo test -p oxinot-core 2>&1 | tail -20
```

Expected: 컴파일 OK, 모든 테스트 통과.

- [ ] **Step 10: Commit**

```bash
git add crates/oxinot-core/src/store/files.rs crates/oxinot-core/src/store/index.rs crates/oxinot-core/src/vault.rs
git commit -m "feat(core): update store+vault for category field

- Frontmatter, IndexRecord: color→category with serde default
- vault CRUD signatures: color→category param
- list_facets: colors→categories facets
- Add list_categories, create_category to Vault API"
```

---

### Task 4: Tauri 명령 래퍼

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` — list_notes/create_note/update_note 인자, 새 명령 등록

**Interfaces:**
- Consumes: Task 3 — `Vault::create_note(body, category)`, `Vault::list_categories()`, `Vault::create_category(id, color?)`
- Produces: Tauri commands — `create_note(body, category?)`, `update_note(..., category?)`, `list_notes(..., categories)`, `list_categories()`, `create_category(id, color?)`

- [ ] **Step 1: list_notes `colors` → `categories`**

```rust
// lib.rs — list_notes command
#[allow(clippy::too_many_arguments)]
pub fn list_notes(
    state: State<'_, AppState>,
    after: Option<String>,
    limit: u32,
    include_tags: Vec<String>,
    exclude_tags: Vec<String>,
    match_all: bool,
    categories: Vec<String>,  // colors → categories
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
        categories,  // colors → categories
        favorites_only,
    };
    state.vault.list_notes(after, limit, filter).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: create_note `color` → `category`**

```rust
pub fn create_note(
    state: State<'_, AppState>,
    app: AppHandle,
    body: String,
    category: Option<String>,  // color → category
) -> Result<oxinot_core::Note, String> {
    let note = state.vault.create_note(body, category).map_err(|e| e.to_string())?;
    let _ = app.emit("notes:changed", ());
    Ok(note)
}
```

- [ ] **Step 3: update_note `color` → `category`**

```rust
pub fn update_note(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    body: Option<String>,
    favorite: Option<bool>,
    category: Option<String>,  // color → category
) -> Result<oxinot_core::Note, String> {
    let id = NoteId::parse(&id).map_err(|e| e.to_string())?;
    let note = state.vault.update_note(id, body, favorite, category).map_err(|e| e.to_string())?;
    Ok(note)
}
```

- [ ] **Step 4: list_categories + create_category 명령 추가**

```rust
#[tauri::command]
pub fn list_categories(state: State<'_, AppState>) -> Result<Vec<oxinot_core::config::CategoryDef>, String> {
    Ok(state.vault.list_categories())
}

#[tauri::command]
pub fn create_category(
    state: State<'_, AppState>,
    id: String,
    color: Option<String>,
) -> Result<oxinot_core::config::CategoryDef, String> {
    state.vault.create_category(id, color).map_err(|e| e.to_string())
}
```

- [ ] **Step 5: generate_handler[]에 새 명령 등록**

```rust
.invoke_handler(tauri::generate_handler![
    commands::list_notes,
    commands::get_note,
    commands::create_note,
    commands::update_note,
    commands::delete_note,
    commands::search_notes,
    commands::export_manifest,
    commands::reindex,
    commands::doctor,
    commands::vault_path,
    commands::note_stats,
    commands::list_facets,
    commands::list_categories,    // ← 추가
    commands::create_category,    // ← 추가
])
```

Tauri commands 정의 블록 안(`pub mod commands { ... }`)에 `list_categories`와 `create_category` 함수가 있어야 함. 같은 모듈 내에서 위 step 4의 함수를 배치.

- [ ] **Step 6: cargo build 확인**

```bash
cargo build -p oxinot-desktop 2>&1 | tail -20
```

Expected: Tauri 바이너리 컴파일 OK.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/
git commit -m "feat(tauri): update commands for category; add list/create_category

- list_notes(colors→categories), create_note(color→category)
- update_note(color→category)
- New commands: list_categories, create_category
- Registered in generate_handler"
```

---

### Task 5: TS 타입 + API + store + 색상 헬퍼

**Files:**
- Modify: `apps/desktop/src/lib/types.ts` — Note, NoteSummary, Facets, CategoryDef
- Modify: `apps/desktop/src/lib/api.ts` — createNote, updateNote, listNotes, listCategories, createCategory
- Modify: `apps/desktop/src/lib/tauri.ts` — mock 시그니처 동기화
- Modify: `apps/desktop/src/stores/ui.ts` — colorFilter→categoryFilter
- Modify: `apps/desktop/src/lib/color.ts` — colorForCategory 헬퍼, COLOR_PRESETS 제거

**Interfaces:**
- Consumes: Task 4의 Tauri 명령 시그니처
- Produces: TS 측의 `Note.category`, `listCategories()`, `colorForCategory(id, cats)`, `ui store categoryFilter`

- [ ] **Step 1: types.ts 업데이트**

```typescript
// Note — color 제거, category 추가
export interface Note {
  id: NoteId;
  created_at: string;
  updated_at: string;
  hash: string;
  favorite: boolean;
  category: string;   // ← color → category
  tags: string[];
  body: string;
  deleted_at: string | null;
}

export interface NoteSummary {
  id: NoteId;
  created_at: string;
  updated_at: string;
  hash: string;
  favorite: boolean;
  category: string;   // ← color → category
  tags: string[];
  preview: string;
  deleted: boolean;
}

// Facets — colors → categories
export interface Facets {
  tags: [string, number][];
  categories: [string, number][];  // ← colors → categories
}

// 새 타입
export interface CategoryDef {
  id: string;
  color: string;
  builtin: boolean;
}
```

- [ ] **Step 2: api.ts 시그니처 업데이트**

```typescript
// api.ts
export async function createNote(body: string, category: string | null) {
  // color: string | null → category: string | null
  return invoke<Note>("create_note", { body, category });
}

export async function updateNote(
  id: string,
  body: string | null,
  favorite: boolean | null,
  category: string | null,  // color → category
) {
  return invoke<Note>("update_note", { id, body, favorite, category });
}

export async function listNotes(
  after: string | null,
  limit = 50,
  filter: {
    include_tags?: string[];
    exclude_tags?: string[];
    match_all?: boolean;
    categories?: string[];  // colors → categories
    favorites_only?: boolean;
  } = {},
) {
  return invoke<{ items: NoteSummary[]; next_cursor: string | null }>("list_notes", {
    after,
    limit,
    include_tags: filter.include_tags ?? [],
    exclude_tags: filter.exclude_tags ?? [],
    match_all: filter.match_all ?? false,
    categories: filter.categories ?? [],  // colors → categories
    favorites_only: filter.favorites_only ?? false,
  });
}

// 새 함수
export async function listCategories(): Promise<CategoryDef[]> {
  return invoke<CategoryDef[]>("list_categories");
}

export async function createCategory(id: string, color: string | null): Promise<CategoryDef> {
  return invoke<CategoryDef>("create_category", { id, color });
}
```

- [ ] **Step 3: tauri.ts mock 업데이트**

```typescript
// tauri.ts — mock invoke 구현에서 create_note, update_note, list_notes 핸들러
// create_note: { color } → { category }
// update_note: { color } → { category }
// list_notes: { colors } → { categories }
// list_facets: 응답에 colors → categories
// list_categories 핸들러 추가: 기본 6개 반환
// create_category 핸들러 추가: 메모리에 저장 후 반환
```

실제 mock 코드는 tauri.ts를 읽어서 정확히 어디를 바꿀지 판단. 핵심은 모든 `color`/`colors` 참조를 `category`/`categories`로 교체.

- [ ] **Step 4: ui.ts store — colorFilter→categoryFilter**

```typescript
// ui.ts
interface UIState {
  // ...
  // 변경 전:
  colorFilter: string[];
  toggleColor: (c: string) => void;
  // 변경 후:
  categoryFilter: string | null;        // 단일 선택(라디오), null = 미선택
  setCategory: (c: string | null) => void;
  clearCategoryFilter: () => void;
  // ...
}
```

```typescript
// store 구현
categoryFilter: null as string | null,
setCategory: (c) => set({ categoryFilter: c }),
clearCategoryFilter: () => set({ categoryFilter: null }),
```

`toggleColor` / `colorFilter` 관련 코드 제거 또는 `setCategory` / `categoryFilter`로 교체.

- [ ] **Step 5: color.ts — colorForCategory + COLOR_PRESETS 정리**

```typescript
// color.ts — 기존 COLOR_PRESETS 관련 코드 유지(paperFor/edgeFor 등은 category 색 입력 받으므로 시그니처 동일)
// 신규 추가:

import type { CategoryDef } from "./types";

/** Inbox neutral fallback */
const INBOX_NEUTRAL = "oklch(0.72 0.01 250)";

/** Look up a category id's color from the registry. Orphan → inbox fallback. */
export function colorForCategory(id: string, cats: CategoryDef[]): string {
  return cats.find((c) => c.id === id)?.color ?? INBOX_NEUTRAL;
}
```

`COLOR_PRESETS` 배열은 유지하되 더 이상 `ColorSwatches`에서 사용되지 않음을 주석 표시. (설정 UI에서 카테고리 색 편집 시 재활용 가능.)

- [ ] **Step 6: tsc -b 확인**

```bash
cd apps/desktop && npx tsc --noEmit 2>&1 | tail -20
```

Expected: 타입 에러 0. `ui.ts` `colorFilter` 참조하는 컴포넌트에서 에러가 나면 Task 6-7에서 자연스럽게 해소됨.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/lib/types.ts apps/desktop/src/lib/api.ts apps/desktop/src/lib/tauri.ts apps/desktop/src/stores/ui.ts apps/desktop/src/lib/color.ts
git commit -m "feat(frontend): TS types+API for category system

- Note/NoteSummary: color→category, Facets: colors→categories
- CategoryDef interface added
- API: createNote/updateNote/listNotes category param, new listCategories/createCategory
- ui store: colorFilter→categoryFilter (single string|null)
- color.ts: add colorForCategory with orphan inbox fallback"
```

---

### Task 6: CaptureOverlay + QuickCaptureForm (슬래시 메뉴)

**Files:**
- Modify: `apps/desktop/src/components/QuickCaptureForm.tsx` — 슬래시 메뉴 + 칩, ColorSwatches 제거
- Modify: `apps/desktop/src/components/CaptureOverlay.tsx` — color state → category state
- Potentially remove: `apps/desktop/src/components/ColorPicker.tsx` (참조 없으면 제거)

**Interfaces:**
- Consumes: Task 5 — `colorForCategory`, `CategoryDef`, `createCategory`, `listCategories`, `createNote`, `ui.categoryFilter`
- Produces: `/` 슬래시 드롭다운 → 카테고리 칩 확정 → body 입력 → Enter 저장 흐름

- [ ] **Step 1: CaptureOverlay — color state → category state**

```typescript
// CaptureOverlay.tsx
const [value, setValue] = useState("");
const [category, setCategory] = useState("");       // color → category
const [categories, setCategories] = useState<CategoryDef[]>([]); // 레지스트리
const [busy, setBusy] = useState(false);
const ref = useRef<HTMLTextAreaElement>(null);
const setError = useUI((s) => s.setError);
const savingRef = useRef(false);

// 컴포넌트 마운트 시 레지스트리 로드
useEffect(() => {
  listCategories().then(setCategories).catch(() => {});
}, []);

useEffect(() => {
  void listen("capture:show", () => {
    setValue("");
    setCategory("");       // color → category
    setBusy(false);
    savingRef.current = false;
    window.setTimeout(() => ref.current?.focus(), 30);
  });
}, []);

// save()에서 createNote 호출:
await createNote(body, category || "inbox");  // color → category
```

- [ ] **Step 2: QuickCaptureForm props 변경**

```typescript
// QuickCaptureFormProps
export interface QuickCaptureFormProps {
  body: string;
  onBodyChange: (v: string) => void;
  bodyRef?: Ref<HTMLTextAreaElement>;
  bodyProps?: TextareaHTMLAttributes<HTMLTextAreaElement>;
  bodyClassName?: string;
  // 제거: color: string; onColorChange: (oklch: string) => void;
  // 추가:
  category: string;
  onCategoryChange: (v: string) => void;
  categories: CategoryDef[];       // 레지스트리 목록
  onPrimary: () => void;           // onConfirm → onPrimary로 rename (더 일반적)
  confirmLabel: string;
  confirmDisabled?: boolean;
  confirmKbd?: string;
  className?: string;
}
```

- [ ] **Step 3: SlashCategoryMenu 컴포넌트 구현**

```tsx
// QuickCaptureForm.tsx 내부 또는 별도 파일
import { colorForCategory } from "../lib/color";
import type { CategoryDef } from "../lib/types";

/** `/`로 열리는 자동완성 드롭다운 */
function SlashCategoryMenu({
  query,
  categories,
  onSelect,
}: {
  query: string;
  categories: CategoryDef[];
  onSelect: (id: string | null) => void;  // null = 새 카테고리 생성
}) {
  const filtered = categories.filter((c) =>
    c.id.includes(query.toLowerCase()),
  );
  const [sel, setSel] = useState(0);
  const isNew = query.length > 0 && !categories.some((c) => c.id === query);

  return (
    <div className="absolute bottom-full left-0 z-50 mb-1 w-48 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
      {filtered.map((c, i) => (
        <button
          key={c.id}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
            i === sel ? "bg-zinc-100 dark:bg-zinc-700" : ""
          }`}
          onClick={() => onSelect(c.id)}
          onMouseEnter={() => setSel(i)}
        >
          <span
            className="inline-block h-3 w-3 rounded-full"
            style={{ backgroundColor: c.color }}
          />
          <span>{c.id}</span>
          {c.builtin && (
            <span className="ml-auto text-[10px] text-zinc-400">built-in</span>
          )}
        </button>
      ))}
      {isNew && (
        <button
          className={`flex w-full items-center gap-2 border-t border-zinc-100 px-3 py-1.5 text-left text-sm text-purple-600 dark:border-zinc-700 dark:text-purple-400 ${
            filtered.length === sel ? "bg-zinc-100 dark:bg-zinc-700" : ""
          }`}
          onClick={() => onSelect(null)}
          onMouseEnter={() => setSel(filtered.length)}
        >
          ✨ '{query}' 만들기
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: CategoryChip 구현**

```tsx
function CategoryChip({
  id,
  categories,
  onDismiss,
  onClick,
}: {
  id: string;
  categories: CategoryDef[];
  onDismiss: () => void;
  onClick?: () => void;
}) {
  const color = colorForCategory(id, categories);
  return (
    <span
      className="inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-white"
      style={{ backgroundColor: color }}
      onClick={onClick}
    >
      ● {id}
      <button
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        className="ml-0.5 text-white/70 hover:text-white"
      >
        ✕
      </button>
    </span>
  );
}
```

- [ ] **Step 5: QuickCaptureForm JSX — ColorSwatches 제거 + 슬래시 메뉴/칩 추가**

```tsx
export function QuickCaptureForm({ ... }: QuickCaptureFormProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");

  // 버블 위쪽에 카테고리 칩
  // ColorSwatches 제거 → 컬러 선택 없음
  // 하단 스트립 = [카테고리 칩 | Enter 저장 버튼]

  const handleChange = (v: string) => {
    // '/' 감지 (입력창이 비었거나 첫 글자)
    if (v === "/") {
      setMenuOpen(true);
      setSlashQuery("");
      onBodyChange("");
      return;
    }
    onBodyChange(v);
  };

  const handleSlashSelect = (id: string | null) => {
    // id=null → 새 카테고리 생성
    if (id === null) {
      createCategory(slashQuery, null)
        .then((def) => {
          // categories 레지스트리에 추가 (상위에서 props로 받은 setCategories 필요)
          // → onCategoryChange로 전달
        })
        .catch(() => {});
    } else {
      onCategoryChange(id);
    }
    setMenuOpen(false);
    setSlashQuery("");
  };

  // JSX 구조 (변경 후):
  return (
    <div className="flex w-full flex-col gap-2">
      {/* 메시지 버블 */}
      <div className="relative rounded-2xl border px-3 pb-2 pt-1 shadow-sm backdrop-blur ..."
           style={category ? { backgroundColor: paperFor(colorForCategory(category, categories)) } : undefined}>
        {/* 카테고리 칩 (있는 경우) */}
        {category && (
          <div className="mb-1 flex items-center gap-1">
            <CategoryChip id={category} categories={categories}
              onDismiss={() => onCategoryChange("")}
              onClick={() => setMenuOpen(true)} />
          </div>
        )}

        {/* 슬래시 메뉴 (오픈 시) */}
        {menuOpen && (
          <SlashCategoryMenu query={slashQuery} categories={categories}
            onSelect={handleSlashSelect} />
        )}

        {/* textarea */}
        <textarea ref={...} value={body}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === "Escape") { setMenuOpen(false); return; }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); /* select highlighted */ return; }
            }
            // 기존 Enter/Escape 핸들링
          }}
          {...}
          className={...} />
      </div>

      {/* 하단 스트립 — 더 이상 ColorSwatches 없음 */}
      <div className="flex items-center justify-end gap-2 px-1">
        <button type="button" onClick={onPrimary} disabled={confirmDisabled}
                aria-label={confirmLabel}
                className="group inline-flex h-7 items-center gap-1.5 ...">
          <Check size={14} strokeWidth={2.5} />
          {confirmKbd && <kbd>...</kbd>}
        </button>
      </div>
    </div>
  );
}
```

전체 JSX는 최종적으로 위 패턴을 따름. 하단 스트립은 `justify-end`(오른쪽 정렬) — 더 이상 왼쪽에 `ColorSwatches`가 없으므로 저장 버튼만 우측에.

- [ ] **Step 6: CaptureOverlay prop 연결**

```tsx
// CaptureOverlay.tsx return
<QuickCaptureForm
  body={value}
  onBodyChange={setValue}
  bodyRef={ref}
  bodyProps={{ placeholder: t.capture_placeholder, onKeyDown: onKey }}
  category={category}
  onCategoryChange={setCategory}
  categories={categories}
  onPrimary={save}                    // onConfirm → onPrimary
  confirmLabel={t.capture_save}
  confirmDisabled={busy || value.trim().length === 0}
  confirmKbd="↵"
/>
```

- [ ] **Step 7: tsc -b 확인**

```bash
cd apps/desktop && npx tsc --noEmit 2>&1 | tail -20
```

Expected: 타입 에러 0. (ui.ts의 `colorFilter`/`toggleColor` 참조가 Sidebar 등에 남아있어도 Task 7에서 해소.)

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/components/QuickCaptureForm.tsx apps/desktop/src/components/CaptureOverlay.tsx
# ColorPicker.tsx가 더 이상 import되지 않으면 제거
if ! grep -q 'ColorPicker' apps/desktop/src/ -r 2>/dev/null; then
  git rm apps/desktop/src/components/ColorPicker.tsx
fi
git commit -m "feat(capture): slash-command category menu, remove color picker

- QuickCaptureForm: color props → category + categories
- Add SlashCategoryMenu dropdown and CategoryChip component
- Remove ColorSwatches from capture flow
- CaptureOverlay: color state → category state (default inbox)
- ColorPicker.tsx removed (no longer imported)"
```

---

### Task 7: 사이드바 + 카드/그리드 (카테고리 필터 + 파생 색상)

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx` — 카테고리 리스트 (라디오 필터), 색상 섹션 제거
- Modify: `apps/desktop/src/components/Card.tsx` — `paperFor(colorForCategory(...))`
- Modify: `apps/desktop/src/components/CardGrid.tsx` — `listNotes` filter `colors`→`categories`, category 레지스트리 쿼리
- Modify: `apps/desktop/src/components/NoteEditorForm.tsx` — `color` prop → `category` prop
- Modify: `apps/desktop/src/components/NoteDetail.tsx` — color 참조 → category

**Interfaces:**
- Consumes: Task 5 — `colorForCategory`, `Note.category`, `listCategories()`, `ui.categoryFilter`, `listNotes(filter: {categories})`

- [ ] **Step 1: Sidebar — 카테고리 섹션 + 색상 섹션 제거**

```tsx
// Sidebar.tsx — 기존 colors 관련 state/query, swatches 섹션 제거
// 추가:

import { listCategories } from "../lib/api";
import type { CategoryDef } from "../lib/types";

export function Sidebar() {
  const facets = useQuery({ queryKey: ["facets"], queryFn: listFacets });
  // 추가: 레지스트리 쿼리
  const categoriesQ = useQuery({ queryKey: ["categories"], queryFn: listCategories });
  const cats = categoriesQ.data ?? [];
  
  // colorFilter/toggleColor → categoryFilter/setCategory
  const categoryFilter = useUI((s) => s.categoryFilter);
  const setCategory = useUI((s) => s.setCategory);
  const clearCategoryFilter = useUI((s) => s.clearCategoryFilter);

  // facets.data?.colors → facets.data?.categories
  const catCounts: Record<string, u32> = Object.fromEntries(
    (facets.data?.categories ?? []) as [string, number][]
  );

  // ...
  return (
    <aside ...>
      {/* All Notes (+ total), Favorites — 그대로 */}
      
      {/* 카테고리 섹션 — 신규 */}
      <div className="mt-3 px-3">
        <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">Category</label>
        <div className="mt-1 flex flex-col gap-0.5">
          <button
            className={`flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${
              categoryFilter === null ? "bg-zinc-200/70 font-semibold dark:bg-zinc-700" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
            }`}
            onClick={clearCategoryFilter}
          >
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-zinc-400" />
            <span>All</span>
          </button>
          {cats.map((c) => (
            <button
              key={c.id}
              className={`flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${
                categoryFilter === c.id ? "bg-zinc-200/70 font-semibold dark:bg-zinc-700" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
              onClick={() => setCategory(categoryFilter === c.id ? null : c.id)}
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: c.color }}
              />
              <span>{c.id}</span>
              {catCounts[c.id] !== undefined && (
                <span className="ml-auto text-[11px] text-zinc-400">{catCounts[c.id]}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* 기존 색상 스왓치 섹션 — 완전 제거 */}
      
      {/* 태그 섹션 — 유지 (변경 없음) */}
    </aside>
  );
}
```

- [ ] **Step 2: CardGrid — categories 필터 + categories 레지스트리 쿼리**

```tsx
// CardGrid.tsx — listNotes 호출 수정
// 기존:
// filter.colors = ...
// 변경 후:
filter.categories = ui.categoryFilter ? [ui.categoryFilter] : [];
```

`listNotes` 호출에서 colors = [] → categories = [].

```typescript
// useQuery queryKey에서 colorFilter→categoryFilter 반영:
export function useNotesQuery(filter: NoteFilter) {
  return useQuery({
    queryKey: ["notes", filter],
    queryFn: () => listNotes(filter.after, filter.limit, {
      include_tags: filter.include_tags,
      exclude_tags: filter.exclude_tags,
      match_all: filter.match_all,
      categories: filter.categories,  // colors → categories
      favorites_only: filter.favorites_only,
    }),
  });
}
```

- [ ] **Step 3: Card — paperFor → colorForCategory**

```tsx
// Card.tsx — note.color 참조 찾아서 변경
import { colorForCategory } from "../lib/color";
// categories props 추가 또는 context/query에서 읽기

// 변경 전:
const bg = paperFor(note.color);
// 변경 후:
const catColors = useQuery({ queryKey: ["categories"], queryFn: listCategories }).data ?? [];
const noteColor = colorForCategory(note.category, catColors);
const bg = paperFor(noteColor);
```

각 카드가 `listCategories`를 쿼리하는 것은 비효율적이므로, categories를 컨텍스트 또는 상위 컴포넌트에서 주입. CardGrid가 categories를 한 번 쿼리해서 Card props로 전달:

```tsx
// CardGrid.tsx
const categories = useQuery({ queryKey: ["categories"], queryFn: listCategories }).data ?? [];

// ...
return items.map((n) => (
  <Card key={n.id} note={n} categories={categories} />
));
```

```tsx
// Card.tsx props
interface CardProps {
  note: NoteSummary;
  categories: CategoryDef[];
}

export function Card({ note, categories }: CardProps) {
  const noteColor = colorForCategory(note.category, categories);
  // ...
}
```

- [ ] **Step 4: NoteEditorForm + NoteDetail — category prop**

```tsx
// NoteEditorForm.tsx
// color: string → category: string (prop 이름 변경)
// onSubmit에서 updateNote(body, favorite, category) 호출

// NoteDetail.tsx
// note.color → note.category 참조 변경
// paperFor(note.color) → paperFor(colorForCategory(note.category, categories))
```

- [ ] **Step 5: tsc -b + Vite 빌드 확인**

```bash
cd apps/desktop && npx tsc --noEmit 2>&1 | tail -20
cd apps/desktop && npx vite build 2>&1 | tail -20
```

Expected: 타입 에러 0, Vite 빌드 성공.

- [ ] **Step 6: 전체 cargo build 확인 (Tauri 바이너리)**

```bash
cargo build -p oxinot-desktop --release 2>&1 | tail -10
```

Expected: 릴리스 바이너리 빌드 OK.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/components/Sidebar.tsx apps/desktop/src/components/Card.tsx apps/desktop/src/components/CardGrid.tsx apps/desktop/src/components/NoteEditorForm.tsx apps/desktop/src/components/NoteDetail.tsx
git commit -m "feat(ui): category filter in sidebar + card category color

- Sidebar: category radio filter, remove color swatches section
- Card: derive color from category via colorForCategory
- CardGrid: inject categories list to cards, filter by categories
- NoteEditorForm/NoteDetail: color→category props"
```
