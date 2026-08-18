# Brain Knowledge Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** oximemo에 HTML 노트 포맷과 Brain 패널(oxibrain 연결)을 추가하여 생태계의 지식 문서 저술 인터페이스로 완성한다.

**Architecture:** 포맷은 어디에도 저장하지 않고 확장자에서 파생한다(`NoteFormat`). 코어는 새 `html.rs` 순수 함수 모듈과 포맷 인지 헬퍼(`note_title`/`preview_of`/`tags_of`/`searchable_body`)로 기존 파이프라인을 확장한다. Brain 글루는 src-tauri에만 존재(oxibrain-client git dep, 호출마다 단기 접속)하고 프론트엔드는 BrainPanel/HtmlEditor를 추가한다.

**Tech Stack:** Rust (edition 2024, redb/tantivy), Tauri 2, React 19, CodeMirror 6 (`@codemirror/lang-html`), DOMPurify, oxibrain-client v0.3.0.

**Spec:** `docs/superpowers/specs/2026-08-18-brain-knowledge-integration-design.md`

## Global Constraints

- 포맷 필드 저장 금지 — 확장자에서 항상 파생 (spec D2)
- oximemo-core는 순수·동기 유지, 브레인 의존은 src-tauri만 (spec D9)
- 데몬 다운 시 패널은 한 줄 상태로 퇴화, 노트 기능 영향 0 (C1)
- 기존 md 노트 동작 회귀 금지 (91 core + 11 CLI 테스트 통과)
- `cargo clippy --all-targets -- -D warnings` 클린, `cargo fmt` 적용
- HTML 미리보기: DOMPurify → `sandbox="allow-same-origin"` iframe, allow-scripts 절대 금지 (D6)

---

### Task 1: Core — `html.rs` 모듈 (순수 함수)

**Files:**
- Create: `crates/oximemo-core/src/html.rs`
- Modify: `crates/oximemo-core/src/lib.rs` (mod html; pub use)

**Interfaces:**
- Produces (Task 2–4가 소비):
  - `pub enum HtmlFrontmatterSplit<'a> { Some { toml_text: &'a str, body: &'a str }, None { body: &'a str } }`
  - `pub fn split_frontmatter(content: &str) -> HtmlFrontmatterSplit<'_>` — 파일 선두 `<!--\n+++\n…\n+++\n-->` 주석을 해석. 주석이 없거나 내부가 `+++` 블록이 아니면 `None`(전체가 body).
  - `pub fn serialize_frontmatter(toml_text: &str, body: &str) -> String` — `<!--\n+++\n{toml}+++\n-->\n{body}` 정규형 생성.
  - `pub fn html_to_text(html: &str) -> String` — 주석·`<script>`·`<style>` 내용 제거 → 태그 제거 → 엔티티 디코딩(`&amp; &lt; &gt; &quot; &#39; &nbsp;` + `&#NNN;``&#xHH;`) → 빈 줄/공백 정규화.
  - `pub fn strip_comments(html: &str) -> String` — 모든 `<!-- … -->` 제거 (위키링크 스캔 전 처리).
  - `pub fn derive_title(body: &str) -> Option<String>` — 첫 `<h1>` 내부 텍스트(중첩 태그 제거·엔티티 디코딩·trim) → 없으면 `<title>` → 없으면 `None`. 대소문자 무관 태그명.

- [ ] **Step 1: 실패 테스트 작성** — `html.rs` 하단 `mod tests`: round-trip(split→serialize 원문 복원), 주석 없는 경우, 일반 주석(비 frontmatter)은 None, html_to_text(엔티티/script/style/중첩), derive_title(h1/h1 내부 태그/title 태그/없음), strip_comments.
- [ ] **Step 2: 테스트 실패 확인** — `cargo test -p oximemo-core html` → 컴파일 에러(모듈 없음)
- [ ] **Step 3: 구현** — 상태 머신 스캐너(외부 크레이트 없음). `split_frontmatter` 규칙: trim_start 후 `<!--`로 시작 → 첫 `-->`까지가 주석; 주석 내부가 `+++\n`로 시작하고 닫는 `+++` 라인이 있으면 `Some`, 아니면 `None`(원문 전체가 body). body는 `-->` 라인 이후(선행 개행 1회 제거).
- [ ] **Step 4: 테스트 통과 확인** — `cargo test -p oximemo-core html`
- [ ] **Step 5: 커밋** — `feat(core): html note parsing primitives`

### Task 2: Core — `NoteFormat` + 파생 헬퍼

**Files:**
- Modify: `crates/oximemo-core/src/memo.rs`, `crates/oximemo-core/src/lib.rs`

**Interfaces:**
- Consumes: Task 1의 `html::{html_to_text, derive_title}`
- Produces (Task 3–7이 소비):
  - `pub enum NoteFormat { Markdown, Html }` (`Serialize/Deserialize`, `"md"|"html"`)
  - `impl NoteFormat { pub fn from_path(path: &Path) -> Self; pub fn from_rel(rel: &str) -> Self; pub fn ext(&self) -> &'static str }` — 확장자 기반, 기본 Markdown
  - `pub fn note_title(fmt: NoteFormat, body: &str) -> Option<String>` — md: 기존 `derive_title`, html: `html::derive_title`
  - `pub fn preview_of(fmt: NoteFormat, body: &str) -> String` — md: `make_preview(body)`, html: `make_preview(&html_to_text(body))`
  - `pub fn tags_of(fmt: NoteFormat, body: &str) -> Vec<String>` — md: `extract_tags(body)`, html: `extract_tags(&html_to_text(body))`
  - `pub fn searchable_body(fmt: NoteFormat, body: &str) -> std::borrow::Cow<'_, str>` — md: 빌림, html: `html_to_text` 소유

- [ ] **Step 1: 실패 테스트** — `from_rel("a/b.md")==Markdown`, `from_rel("x.html")==Html`, `from_rel("noext")==Markdown`; `tags_of(Html, "<a href='#sec'>x</a> #tag")` → `["tag"]`만(href 앵커 오인 금지); `searchable_body(Html, "<h1>제목</h1><p>본문</p>")` → "제목\n본문" 형태.
- [ ] **Step 2: 실패 확인** — `cargo test -p oximemo-core note_format`
- [ ] **Step 3: 구현 + lib.rs 재수출**
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `feat(core): NoteFormat with derived title/preview/tags helpers`

### Task 3: Core — FileStore/Paths 포맷 인지

**Files:**
- Modify: `crates/oximemo-core/src/store/files.rs`, `crates/oximemo-core/src/paths.rs`

**Interfaces:**
- Consumes: Task 1·2
- Produces:
  - `FileStore::serialize_as(memo: &Memo, fmt: NoteFormat) -> Result<String>` (기존 `serialize`는 `serialize_as(_, Markdown)` 위임 유지)
  - `FileStore::parse_as(content: &str, fmt: NoteFormat) -> Result<ParsedFile>` (기존 `parse` 위임 유지)
  - `FileStore::read_memo` — 경로 확장자로 자동 분기
  - `FileStore::write_note(folder, memo, fmt: NoteFormat)`, `write_note_at`은 rel_path 확장자 사용(변경 없음)
  - `Paths::note_path(folder, filename, fmt: NoteFormat)` — `.md`/`.html` 확장자. 호출부 전부 갱신.
  - `scan`/`scan_md_into` — `.html`도 수집, `TEMPLATE.md`·`TEMPLATE.html` 제외. `walk_md`(trash)도 `.html` 포함.
  - `derive_filename(memo, fmt)` — html은 `html::derive_title` 기반

- [ ] **Step 1: 실패 테스트** — html serialize→parse_as 라운드트립(frontmatter 보존), html 파일 write_note→read_memo(id·body·tags 보존), scan이 `.html` 수집·`TEMPLATE.html` 제외, `parse_as` 일반 html(주석 없음) → BodyOnly.
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — `unique_note_path`/`write_note`에 fmt 전달. `read_memo`의 `extract_tags(&body)` → `tags_of(fmt, body)`.
- [ ] **Step 4: 통과 확인** — `cargo test -p oximemo-core`
- [ ] **Step 5: 커밋** — `feat(core): html-aware file store and scanning`

### Task 4: Core — Vault 포맷 인지 + 템플릿

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs`, `crates/oximemo-core/src/template.rs`

**Interfaces:**
- Consumes: Task 1–3
- Produces:
  - `Vault::create_note(folder, body, fmt: NoteFormat)` (기존 2-arg 호출부 전부 갱신), `Vault::create_note_auto(folder, body)` — `TEMPLATE.html` 존재 && `TEMPLATE.md` 부재 → Html, else Markdown
  - `template::load_template(paths, folder, fmt)` — md는 `TEMPLATE.md`, html은 `TEMPLATE.html`(주석 frontmatter 있으면 제거). `count_notes`는 fmt 무관 총계.
  - `template::is_blank_body(fmt, body)`
  - vault.rs 전역 변환 규칙(기계적): `derive_title(&x.body)` → `note_title(fmt, &x.body)` (fmt는 스코프内 경로에서 `NoteFormat::from_path`/`from_rel`), `extract_tags(&x.body)` → `tags_of(fmt, …)`, `search.upsert(id, &note.body, …)`의 body 인자 → `searchable_body(fmt, &note.body).as_ref()`, `record_of(&n, &rel)` 내부에서 `NoteFormat::from_rel(path)` 사용, rename 전파의 `links_to(&src.body)` → `links_to(&strip_comments(&src.body))` (html 링크 스캔, md는 strip 무해), `write_note`/`serialize` 호출부 fmt 전달.

- [ ] **Step 1: 실패 테스트** — 임시 vault에서: (a) html 노트 create→get→search("본문" 히트)→update(h1 변경→파일명 변경)→delete→restore; (b) md 노트의 `[[대상]]` 링크가 html 노트 리네임 시 치환; (c) html 노트 본문 `[[링크]]`가 graph_data 엣지·backlinks에 나타남(frontmatter 주석 내 `[[…]]`은 제외); (d) `TEMPLATE.html` 폴더에서 create_note_auto → html 노트 + 변수 치환; (e) html_to_text 미리보기가 IndexRecord.preview에 반영.
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — 위 변환 규칙 적용. `migrate.rs`의 write_note 호출부 확인·갱신(md 고정).
- [ ] **Step 4: 통과 확인** — `cargo test -p oximemo-core` 전체(회귀 포함)
- [ ] **Step 5: 커밋** — `feat(core): html notes across vault lifecycle`

### Task 5: CLI — `--html` 플래그

**Files:**
- Modify: `crates/oximemo-cli/src/main.rs`, `crates/oximemo-cli/src/commands.rs`

- [ ] **Step 1: 실패 테스트** — CLI 테스트 패턴 따라 `new --html` → `.html` 파일 생성 확인
- [ ] **Step 2: 실패 확인** → **Step 3: 구현** (`create_note(_, _, NoteFormat::Html)`) → **Step 4: `cargo test -p oximemo-cli`** → **Step 5: 커밋** — `feat(cli): --html flag for note creation`

### Task 6: Core — `[brain]` 설정

**Files:**
- Modify: `crates/oximemo-core/src/config.rs`

**Interfaces:**
- Produces: `pub struct BrainConfig { pub enabled: bool /*default true*/, pub socket: String /*default ""*/, pub space: String /*default "personal"*/ }`, `VaultConfig.brain: BrainConfig`, `config_json`에 brain 섹션 포함. schema_version 3 유지.

- [ ] **Step 1: 실패 테스트**(기본값·toml 파싱 라운드트립) → **Step 2–4** → **Step 5: 커밋** — `feat(core): brain connection config section`

### Task 7: src-tauri — NoteDto + Brain 글루

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: Task 4·6 (core), oxibrain-client v0.3.0
- Produces (Task 8–11이 소비):
  - `NoteDto` = Memo 필드 + `title: Option<String>`, `path: String`, `folder: String`, `format: NoteFormat` — `get_memo`/`create_memo`/`update_memo`/`move_note` 반환 타입. 경로는 IndexRecord(`get_note_summary`)에서, folder는 path에서 파생.
  - `#[tauri::command] async fn brain_status() -> Result<BrainStatus, String>` — `{online: bool, server_version: Option<String>, episodes/entities/statements/contradictions: Option<u64>}`. `connect_default()` 핸드셰이크 + `stats(space)`. 실패 시 `online:false`(에러 아님).
  - `#[tauri::command] async fn brain_gather(query: String, budget: u32) -> Result<Value, String>` — `recall(query, space, budget)` 레이어 JSON 그대로. 데몬 불능 시 Err(문자열) → 프론트에서 오프라인 처리.
  - Cargo.toml: `oxibrain-client = { git = "https://github.com/a7garden/oxibrain", tag = "v0.3.0" }`

- [ ] **Step 1: DTO 테스트** — tauri 명령은 GUI 진입점이라 cargo test 대신: 코어 단에서 NoteDto 조립 로직을 별도 순수 함수(`fn note_dto(vault, memo) -> NoteDto`)로 분리해 단위 테스트.
- [ ] **Step 2: 실패 확인** → **Step 3: 구현 + 명령 등록** → **Step 4: `cargo check -p oximemo-desktop`(패키지명 확인) + 수동 소켓 스모크: 실제 데몬 대상 `brain_status` 로직 함수 직접 호출하는 ignored 테스트** → **Step 5: 커밋** — `feat(desktop): enriched note DTOs and brain commands`

### Task 8: Frontend — 의존성·타입·API

**Files:**
- Modify: `apps/desktop/package.json`, `apps/desktop/src/lib/types.ts`, `apps/desktop/src/lib/api.ts`

- [ ] **Step 1: `bun add @codemirror/lang-html @codemirror/commands @codemirror/language @codemirror/autocomplete dompurify`**
- [ ] **Step 2: types.ts** — `Memo`에 `path: string`, `format: "md"|"html"` 추가, `title: string | null`(사용부 수정). `BrainStatus`, `BrainLayer {kind: string, text: string}` 타입 추가.
- [ ] **Step 3: api.ts** — `brainStatus()`, `brainGather(query, budget)` (browser fallback: `{online:false,…}` / throw), `createMemo`에 `format?: "md"|"html"` 인자.
- [ ] **Step 4: `bun run build` 통과(기존 사용부 수정 포함)** → **Step 5: 커밋** — `feat(desktop): brain api bindings and note format types`

### Task 9: Frontend — HTML 편집기·미리보기

**Files:**
- Create: `apps/desktop/src/components/HtmlEditor.tsx`, `apps/desktop/src/components/HtmlPreview.tsx`, `apps/desktop/src/components/HtmlNoteEditor.tsx`

**Interfaces:**
- Consumes: Task 8 타입
- Produces: `HtmlNoteEditor {body, onChange}` — 툴바 토글(편집/분할/미리보기) + `HtmlEditor`(CM6 lang-html) + `HtmlPreview`(DOMPurify `WHOLE_DOCUMENT` 감지→srcdoc iframe, auto-height, `[[위키링크]]`→앵커 전처리).

- [ ] **Step 1: HtmlEditor/HtmlPreview 구현 + 최소 렌더 테스트(vite dev에서 수동)**
- [ ] **Step 2: HtmlNoteEditor 토글 UI** (Base UI 토글 그룹, i18n)
- [ ] **Step 3: `bun run build`** → **Step 4: 커밋** — `feat(desktop): html note editor with sandboxed preview`

### Task 10: Frontend — 편집기 분기·포맷 배지·새 노트 분할 버튼

**Files:**
- Modify: `apps/desktop/src/components/MemoEditorForm.tsx`, `MemoDetail.tsx`, `CardGrid.tsx`(또는 Card/ListView 해당부), `lib/i18n.ts`(키 추가)

- [ ] **Step 1: MemoEditorForm** — `memo.format === "html"` → HtmlNoteEditor, else MarkdownEditor
- [ ] **Step 2: 카드/리스트 HTML 배지**(`path.endsWith('.html')` → 작은 "HTML" 칩)
- [ ] **Step 3: 새 노트 분할 버튼** — 기본 클릭은 기존 동작(코어 auto 규칙), 캐럿 드롭다운 "마크다운"/"HTML" 명시 선택 → `createMemo(body, folder, format)`
- [ ] **Step 4: `bun run build`** → **Step 5: 커밋** — `feat(desktop): html note editing surface and format affordances`

### Task 11: Frontend — BrainPanel

**Files:**
- Create: `apps/desktop/src/components/BrainPanel.tsx`
- Modify: `MemoDetail.tsx`, `lib/i18n.ts`

**Interfaces:**
- Consumes: Task 7 명령, Task 8 api
- Produces: `BrainPanel {noteId, title, tags}` — 상태 점검(마운트 시 1회), "컨텍스트 수집" 버튼 → 레이어 목록(kind 라벨 i18n: high_salience_beliefs→핵심 신념, query_neighborhood→관련 항목, recent_episodes→최근 에피소드, summaries→요약, profile/pinned_facts→기타), "새 노트로 정리" → 수집 결과 발췌를 참조 목록으로 포함한 노트 생성(createMemo). 오프라인: 한 줄 "Brain 오프라인 · 다시 시도". config.brain.enabled === false면 렌더 안 함.

- [ ] **Step 1: 컴포넌트 구현** — **Step 2: MemoDetail 우측 BacklinksPanel 아래 배치**
- [ ] **Step 3: `bun run build`** → **Step 4: 커밋** — `feat(desktop): brain context panel with distill action`

### Task 12: 검증

- [ ] **Step 1: 게이트** — `cargo fmt && cargo clippy -p oximemo-core -p oximemo-cli --all-targets -- -D warnings && cargo test -p oximemo-core -p oximemo-cli && (cd apps/desktop && bun run build)`
- [ ] **Step 2: 런타임 브라우저 검증** — vite dev + browser 스킬: HTML 노트 생성·편집·미리보기(살니타이즈·iframe), 카드 배지, Brain 오프라인 상태. 스크린샷.
- [ ] **Step 3: 라이브 데몬 검증** — 실제 소켓 대상 brain_status/brain_gather 응답(ignored 테스트 또는 수동 실행 로그).
- [ ] **Step 4: 문서** — CHANGELOG Unreleased 갱신, README vault 섹션에 .html 언급, 스펙 상태 갱신. 커밋.

### Task 13: oxibrain 저장소 — 커넥터 .html 지원 (별도 저장소, oximemo 그린 후)

- [ ] `oxibrain-connectors` markdown 스캐너가 `.html` 수집 + 텍스트 추출, `oxibrain sync` 반영, 해당 저장소 게이트(cargo test/clippy/deny) 통과 후 커밋. 세부는 oximemo 완료 후 스펙 §8 핸드오프 따름.
