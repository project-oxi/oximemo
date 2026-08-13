# oximemo: Memo → Notebook 전환 설계

> **날짜:** 2026-08-13
> **상태:** 설계 (사용자 승인 완료)
> **범위:** Rust 코어(vault 레이아웃, 엔티티, 인덱스, 마이그레이션) + 데스크톱 프론트엔드 전면 재설계
> **선행 설계 대체:** `2026-08-01-memo-wiki-links-design.md`의 UUID 기반 위키링크를 **제목 기반**으로 대체

---

## 1. 배경

oximemo는 현재 "빠른 캡처 메모 앱"이다. 단일 `Memo` 엔티티(UUIDv7, body, category, tags)가 TOML frontmatter 마크다운 파일로 저장된다. 모든 메모는 같은 길이, 같은 형태(카드 그리드)로 취급된다.

사용자 요구: 메모뿐 아니라 **노트, 위키, 소설, 일기**를 하나의 앱에서. 단:

- **타입 필드 반대** — 유연성 저하, 미니멀하지 않음. 각 사용자마다 필요한 "타입"이 다름.
- **제목 문제** — 빠른 메모는 제목 짓기 싫고, 문서는 제목이 필요.
- **100% 마크다운 호환** 필수.
- **물리 폴더** — 마크다운 파일이 진실. Finder에서 구조가 보여야.

### 연구 요약

Obsidian, Bear, Apple Notes, Notion — **어떤 주요 앱도 "메모"와 "노트"를 별도 엔티티로 분리하지 않는다.** 단일 엔티티 + 조직 계층(폴더/태그/링크) + 적응형 프레젠테이션(뷰 모드).

핵심 통찰: "memo vs note"는 **데이터 타입이 아니라 행동과 컨텍스트의 문제**다.

---

## 2. 핵심 결정 (locked)

| # | 결정 | 근거 |
|---|------|------|
| 1 | **단일 엔티티, 타입 필드 없음** | 타입은 유연성을 떨어뜨린다. 각 사용자의 용도가 다르므로 하드코딩된 타입은 의미 없음. 콘텐츠와 컨텍스트가 동작을 결정. |
| 2 | **물리 폴더** — 파일 위치 = 조직 | frontmatter 필드가 아닌 물리 디렉토리. Finder에서 vault 구조가 보임. 마크다운이 완전한 진실. |
| 3 | **파일명 = 제목** (H1에서 파생) | 제목을 별도로 저장하지 않음. body의 첫 `# H1`이 제목 = 파일명. H1 없으면 타임스탬프 파일명. |
| 4 | **frontmatter 단순화** | `category`, `folder`, `deleted_at` 제거. 남은 필드: `id`, `created_at`, `updated_at`, `hash`, `favorite`, `tags`. |
| 5 | **위키링크 = 제목 기반** `[[Note Title]]` | 파일명으로 해석. UUID 기반(`[[memo-id]]`, 선행 설계)을 대체. human-readable raw markdown. 리네임 시 전 vault 링크 업데이트. |
| 6 | **템플릿 = 폴더 내 `TEMPLATE.md`** | 중앙 템플릿 저장소 없음. 각 폴더에 `TEMPLATE.md`를 두면 새 노트에 적용. 변수 지원(`{{date}}` 등). |
| 7 | **4가지 뷰 모드** — Grid / List / Timeline / Graph | 자동 제안 없음. 폴더별 사용자 선택. 락 아이콘으로 고정. |
| 8 | **날짜 샤딩 제거** | `memos/<YYYY>/<MM>/` 구조 제거. 파일이 폴더에 직접 존재. |
| 9 | **마크다운 = 진실, 인덱스 = 캐시** | redb/tantivy는 파일에서 재구축 가능한 캐시. `oximemo reindex`가 전체 갱신. 외부 도구(VS Code, grep, git)로 직접 편집 가능. |

---

## 3. 데이터 모델

### 3.1 파일 레이아웃

```text
<vault>/
├── novel/
│   ├── act1/
│   │   ├── 첫-번째-장.md
│   │   └── 폭풍의-밤.md
│   ├── act2/
│   │   └── 귀환.md
│   └── TEMPLATE.md              ← 챕터 템플릿 (노트 목록에서 제외)
├── diary/
│   ├── TEMPLATE.md              ← 일기 템플릿
│   ├── 2026-08-12-화.md
│   └── 2026-08-13-수.md
├── wiki/
│   └── 아키텍처-결정-기록.md
├── 가격-전략-메모.md              ← 루트의 느슨한 파일 = inbox
├── 2026-08-13-143052.md         ← 제목 없는 빠른 캡처 (타임스탬프 파일명)
├── _assets/
│   └── <hash>.<ext>             ← 이미지/첨부
├── .trash/                       ← 삭제된 파일 (원래 경로 보존)
│   └── novel/act1/삭제된-장.md
└── oximemo.toml                  ← vault 설정
```

### 3.2 파일명 규칙

| 상황 | 파일명 | 예 |
|---|---|---|
| H1 있음 | H1 텍스트 정규화 | `첫-번째-장.md` |
| H1 없음 (메모) | 생성 타임스탬프 | `2026-08-13-143052.md` |

**정규화 규칙:**
- 공백 → 하이픈 (`-`)
- 파일시스템 불가 문자 제거: `/ \ : * ? " < > |`
- 유니코드(한글 등) 유지 — macOS APFS에서 안전
- 파일명 충돌 시: 접미사 추가 (`첫-번째-장-2.md`)

### 3.3 Frontmatter

```toml
+++
id = "01957a3b-1234-5678-9abc-def012345678"
created_at = "2026-08-13T14:30:52Z"
updated_at = "2026-08-13T14:30:52Z"
hash = "b3:abcdef..."
favorite = false
tags = ["protagonist", "plot-twist"]
+++

# 첫 번째 장

본문 내용...
```

**제거된 필드 (마이그레이션 대상):**
- `category` → 물리 폴더 경로가 대체
- `folder` → 동일 (물리 위치)
- `deleted_at` → `.trash/` 이동으로 대체

**남은 필드:**
- `id` — UUIDv7. 내부 추적·동기화용 안정 식별자. 파일명이 바뀌어도 ID 불변.
- `created_at` / `updated_at` — RFC 3339 타임스탬프
- `hash` — BLAKE3 콘텐츠 해시 (`b3:` prefix). 동기화 충돌 감지.
- `favorite` — 즐겨찾기
- `tags` — 문자열 배열. 슬래시 허용 (`character/protagonist`) → 사이드바에서 중첩 표시.

### 3.4 제목 파생 (저장 아님, 계산)

```rust
fn derive_title(body: &str) -> Option<String> {
    // body의 첫 번째 "# H1" 헤딩 텍스트 반환
    // H1 없으면 None → 카드에 preview 표시, 사이드바에 "제목 없음"
}
```

- 빠른 캡처: body만, H1 없음 → 제목 없는 카드 (타임스탬프 파일명)
- 문서 작성: `# 제목` 입력 → 자동으로 제목 + 파일명
- 일기 템플릿: `# {{date}} {{weekday}}` → 날짜가 제목

### 3.5 삭제 모델

- 삭제 = 파일을 `<vault>/.trash/<원래-상대경로>`로 이동
- `.trash/novel/act1/삭제된-장.md` — 원래 폴더 구조 보존
- 복원 = 원래 위치로 파일 이동
- `trash_retention_days` (config) 후 영구 삭제

---

## 4. 위키링크

### 4.1 구문

```
[[Note Title]]            → 인라인 링크. 클릭 → 대상 노트 열기.
[[Note Title|표시 텍스트]]  → 커스텀 표시 텍스트.
![[Note Title]]           → (줄 단독) 트랜스클루전. 대상 본문을 읽기전용 블록으로 렌더.
```

### 4.2 해석 규칙

1. 링크 텍스트 → 파일명 정규화 → vault에서 매칭 파일 검색
2. 대소문자 무시, 앞뒤 공백 trim
3. 정확 매칭 우선 → 링크를 포함한 노트와 같은 폴더 우선 → 최근 수정 순
4. 중복 시: 사용자에게 picker 표시
5. 대상 없음: ghost link (클릭 → 새 노트 생성 프롬프트)

### 4.3 백링크 인덱스

```text
redb table: backlinks
  key:   target_note_id (Uuid)
  value: Vec<LinkRef { source_id: Uuid, link_text: String }>
```

- note 저장 시 body에서 `[[...]]` 파싱 → 대상 해석 → backlinks 테이블 업데이트
- reindex 시 전체 재구축
- UI: note 하단/사이드 패널에 "이 노트를 참조하는 N개 노트" 표시

### 4.4 리네임 전파

노트의 H1(제목)이 변경되면:

1. 파일명 변경: `old-title.md` → `new-title.md`
2. vault 내 모든 `[[old title]]` / `[[old title|...]]` → `[[new title]]` / `[[new title|...]]` 일괄 치환
3. 백링크 인덱스 갱신
4. redb 인덱스 경로 갱신

이 동작은 사용자에게 확인 프롬프트 없이 자동 수행 (Obsidian과 동일). 대상이 많을 경우 진행 상태 표시.

### 4.5 선행 UUID 링크와의 관계

기존 구현(`lib/memoLinks.ts`)은 `[[memo-id]]` (UUID) 방식. 본 설계는 `[[Note Title]]` (제목 기반)으로 전환:

- **이유:** 물리 폴더 + human-readable vault에서 UUID 링크는 원칙 위반. raw markdown에 UUID가 보이면 "마크다운이 진실" 원칙 훼손.
- **마이그레이션:** `[[UUID]]` 패턴을 스캔 → 해당 UUID의 노트 제목 조회 → `[[제목]]`으로 치환.
- `@atomic-editor/editor`의 `wikiLinks()` 확장은 `serializeSuggestion` 오버라이드만 변경하면 됨 (target을 UUID → filename으로).

---

## 5. 템플릿 시스템

### 5.1 개념

템플릿은 **사용자가 만드는 자신만의 "타입"**이다. 앱이 하드코딩한 타입 없음. 각 폴더에 `TEMPLATE.md`를 두면 새 노트에 적용.

### 5.2 동작

- 폴더에 `TEMPLATE.md` 존재 → "새 노트" 시 템플릿 body로 시작
- `TEMPLATE.md` 없음 → blank body
- `TEMPLATE.md`는 노트 목록/검색/그래프에서 제외 (특수 파일)
- 빠른 캡처(전역 단축키) → 항상 blank, 루트에 저장

### 5.3 변수

| 변수 | 값 | 예 |
|---|---|---|
| `{{date}}` | 오늘 날짜 (YYYY-MM-DD) | `2026-08-13` |
| `{{weekday}}` | 요일 (한글) | `수` |
| `{{time}}` | 현재 시각 (HH:MM) | `14:30` |
| `{{year}}` `{{month}}` `{{day}}` | 개별 날짜 구성요소 | `2026` `08` `13` |
| `{{counter}}` | 폴더 내 기존 노트 수 + 1 (`TEMPLATE.md` 제외) | `4` |
| `{{folder}}` | 폴더명 (가장 가까운) | `novel` |

### 5.4 적용 흐름

```text
diary/ 폴더에서 "새 노트"
  ↓
diary/TEMPLATE.md 읽기: "# {{date}} {{weekday}}\n\n## 오늘\n\n-\n"
  ↓
변수 치환: "# 2026-08-13 수\n\n## 오늘\n\n-\n"
  ↓
H1에서 파일명 파생: 2026-08-13-수.md
  ↓
diary/2026-08-13-수.md 저장, 에디터에 본문 표시
```

### 5.5 템플릿 예시

**일기 (`diary/TEMPLATE.md`):**
```markdown
# {{date}} {{weekday}}

## 오늘

-

## 메모

-
```

**소설 챕터 (`novel/TEMPLATE.md`):**
```markdown
# Chapter {{counter}}

---
```

---

## 6. 뷰 모드

### 6.1 네 가지 뷰

**Grid** — 카드 그리드 (현재 CardGrid).
- preview 텍스트 + 태그 + 상대 시간
- 폴더 색상 액센트
- 용도: inbox, 짧은 노트

**List** — 컴팩트 텍스트 행.
- `[★] 제목 | 태그 | 날짜` 한 줄
- 정렬: 제목/생성일/수정일
- 용도: 문서 다수 폴더, 위키, 챕터 목록

**Timeline** — 날짜별 그룹.
- 날짜 헤더 + 그날의 노트들
- 최신 상단 (설정으로 변경 가능)
- 용도: 일기, 데일리 로그

**Graph** — 위키링크 기반 지식 그래프.
- 노드 = 노트 (크기 = 연결 수)
- 엣지 = `[[위키링크]]`
- 폴더별 노드 색상
- 클릭 → 노트 열기. 줌/팬/드래그.
- 용도: 위키 네트워크, 아이디어 연결 시각화

### 6.2 선택 메커니즘

- **자동 제안 없음.**
- 툴바의 뷰 스위처로 폴더별 언제든 전환.
- **락 아이콘 (🔒):** 현재 뷰를 `oximemo.toml`에 저장. 앱 재시작 후에도 유지.
- **언락 (🔓):** 세션 내에서만 유효. 재시작 시 글로벌 기본(grid)으로 복귀.
- 글로벌 기본: `grid`.

### 6.3 `oximemo.toml`

```toml
schema_version = 3

[general]
trash_retention_days = 30

[capture]
double_tap_threshold_ms = 350
overlay_max_height = 400

[appearance]
theme = "system"
show_dock_icon = true

# 잠긴 뷰만 기록. 잠기지 않은 폴더는 미등록 = 글로벌 기본 적용.
[[folders]]
path = "novel"
view = "list"
color = "oklch(0.75 0.13 145)"

[[folders]]
path = "diary"
view = "timeline"
color = "oklch(0.72 0.15 310)"
```

> **참고:** `[[folders]]`의 `color`는 사이드바 폴더 아이콘 도트 및 카드 액센트에 사용. 미지정 시 투명 (기본 카드 서피스).

---

## 7. UI 아키텍처

### 7.1 사이드바 — 물리 폴더 트리

```text
┌─────────────────────────┐
│ 검색...                  │
├─────────────────────────┤
│ 전체 노트        (142)   │
│ 즐겨찾기          (12)   │
│ 최근 수정         (23)   │
├─────────────────────────┤
│ 루트 (느슨한 파일)  (8)  │
│ novel            (15) 🔵│
│   └─ act1         (5)   │
│   └─ act2         (4)   │
│ diary            (180)🟣│
│ wiki             (34) 🟢│
│ work             (28) 🟠│
├─────────────────────────┤
│ 태그                     │
│  #protagonist     (5)   │
│  #meeting         (12)  │
│  #idea            (23)  │
└─────────────────────────┘
```

- 폴더 = 물리 디렉토리. 사이드바는 파일 시스템의 라이브 뷰.
- Finder에서 폴더 생성/삭제/이동 → watcher 감지 → 사이드바 자동 업데이트.
- 드래그&드롭: 노트를 폴더로 이동 = 파일 이동.
- 폴더 우클릭: 새 노트, 새 하위 폴더, 이름 변경, 삭제, 뷰 모드 설정.
- 태그 섹션: 슬래시(`#character/protagonist`) 중첩 표시. 클릭 → 필터.

### 7.2 툴바

```text
[folder breadcrumb]    Grid | List | Timeline | Graph   🔒    [+ 새 노트]  [⚙ 정렬]
```

- 폴더 경로 (breadcrumb, 클릭하여 상위로 이동)
- 뷰 스위처 (4모드) + 락 아이콘
- 새 노트: 폴더에 `TEMPLATE.md`가 있으면 템플릿 적용
- 정렬 드롭다운: 수정일/생성일/제목

### 7.3 에디터

```text
┌─────────────────────────────────┬──────────────┐
│                                 │ 백링크 (3)   │
│ # 첫 번째 장                    │──────────────│
│                                 │ · 폭풍의 밤  │
│ 대지가 떨렸다. [[폭풍의 밤]]으로 │ · 세계관     │
│ 이어진다.                       │ · 주인공 설정│
│                                 │              │
│                                 │ 첨부 (2)     │
│                                 │ · map.png    │
└─────────────────────────────────┴──────────────┘
```

- `@atomic-editor/editor` (CodeMirror 6 기반) 유지. 위키링크 serialization만 UUID → 제목으로 변경.
- **`[[` 자동완성:** 노트 제목 검색 드롭다운. 선택 → `[[노트명]]` 삽입.
- **백링크 패널:** 이 노트를 `[[링크]]`하는 모든 노트. 클릭 → 이동. 접기/펼치기.
- **포커스 모드:** 사이드바/패널 숨기고 전체화면 집필 (토글).
- **제목 동기화:** H1 수정 → 파일명 자동 변경 + 링크 전파 (§4.4).

### 7.4 컨텍스트 메뉴 (노트 우클릭)

```
열기 / 편집
즐겨찾기 토글
폴더로 이동...
이름 변경 (H1 + 파일명 + 링크 업데이트)
복제
삭제 (.trash/로 이동)
위키링크 복사 ([[제목]])
```

### 7.5 빠른 캡처

- 전역 단축키 → 오버레이 → 텍스트 입력 → 저장 (현재와 동일)
- 루트에 타임스탬프 파일명 저장 (`2026-08-13-143052.md`)
- 템플릿 없음, 제목 없음
- CaptureOverlay는 textarea 유지 (CM6 마운트 비용 불필요, 기존 결정 유지)

### 7.6 검색

- tantivy 풀텍스트 검색 (전체 노트 대상)
- 결과: 제목 + 폴더 경로 + 하이라이트 발췌
- 필터: 폴더, 태그, 날짜 범위
- 위키링크 인식: 제목 검색 시 그 노트를 링크하는 노트도 결과에 포함

---

## 8. 인덱스 아키텍처

### 8.1 원칙

마크다운 파일 = 진실. 인덱스 = 캐시.

```text
파일 트리 (마크다운)  ──reindex──→  redb 메타데이터 캐시
                     ──reindex──→  tantivy 검색 캐시
                     ──reindex──→  백링크 그래프 캐시
```

### 8.2 redb 메타데이터 인덱스 (갱신)

```text
table: notes
  key:   id (Uuid)
  value: NoteRecord {
    path: String,           // vault-root 상대 경로 ("novel/act1/첫-번째-장.md")
    title: Option<String>,  // H1에서 파생, None = 제목 없음
    created_at, updated_at,
    hash, favorite,
    tags: Vec<String>,
  }
```

- 기존 `category` 필드 제거, `path` + `title` 추가
- 경로 변경(이동/리네임) 시 인덱스 갱신

### 8.3 tantivy 검색 인덱스

- 색인 필드: title (H1 파생), body, tags, path
- 기존과 동일한 검색 품질, path 필터링 추가

### 8.4 파일 감시 (watcher)

기존 watcher.rs 확장:
- 폴더 생성/삭제/이름 변경 감지
- 파일 이동(폴더 간) 감지
- `.trash/` 내 변경 무시
- `_assets/` 내 변경은 asset 인덱스만 갱신

---

## 9. 마이그레이션

### 9.1 개요

기존 vault (`memos/<YYYY>/<MM>/<id>.md`, frontmatter `category="..."`)를 새 구조로 변환.

### 9.2 단계

```text
oximemo migrate
  ↓
1. 백업: 전체 vault를 <vault>.bak/로 복사
  ↓
2. 각 .md 파일 순회:
   a. frontmatter 파싱 (category, id, body 등)
   b. body에서 H1 추출 → 새 파일명 결정
      - H1 있음: slugify(H1) → 파일명
      - H1 없음: created_at 타임스탬프 → 파일명
   c. category 값 → 폴더 경로
      - "inbox" → 루트 (느슨한 파일)
      - "idea" → idea/ 폴더
      - 커스텀 카테고리 → <category>/ 폴더
   d. frontmatter 갱신:
      - category, folder, deleted_at 제거
      - 나머지 필드 유지
   e. 파일 이동: memos/YYYY/MM/id.md → <folder>/<filename>.md
  ↓
3. 기존 memos/ 디렉토리 제거 (비었으면)
  ↓
4. .trash/ 재구성 (deleted_at 있던 파일 → .trash/<원래경로>로 이동)
  ↓
5. config.toml → oximemo.toml 마이그레이션
   - [categories] → [[folders]] (경로는 category id, 색상 유지)
   - schema_version = 2 → 3
  ↓
6. reindex 실행 (전체 인덱스 재구축)
  ↓
7. 기존 [[UUID]] 위키링크 → [[제목]] 치환 (구현된 경우)
```

### 9.3 안전장치

- 백업 없이 마이그레이션 불가 (자동 백업)
- `--dry-run` 플래그로 변경사항 미리보기
- 마이그레이션 실패 시 백업에서 롤백
- 이미 마이그레이션된 vault 감지 (`schema_version >= 3`) → 스킵

---

## 10. Rust 코어 변경 범위

| 모듈 | 변경 |
|------|------|
| `memo.rs` | `Memo` struct: `category` → 제거, `title` 파생 함수 추가. `MemoFilter`: category → folder path |
| `store/files.rs` | 파일 경로 계산: `memos/YYYY/MM/id.md` → `<folder>/<filename>.md`. `Frontmatter`: category/deleted_at 제거 |
| `store/index.rs` | redb 스키마: `category` → `path` + `title`. 마이그레이션 로직 |
| `store/search.rs` | tantivy: title 필드 추가, path 필터링 |
| `paths.rs` | `MEMOS_DIR` 제거. 폴더 경로 = vault root 상대. `.trash/` 경로 로직 변경 |
| `vault.rs` | `create_category`/`update_category`/`delete_category` → 폴더操作로 대체. 리네임 전파 로직 추가 |
| `config.rs` | `CategoriesConfig` → `FoldersConfig`. `[[folders]]` 시리즈. schema_version 3 |
| `tags.rs` | 슬래시 중첩 태그 파싱 |
| `sync.rs` | 경로 기반 동기화 (UUID는 유지하되 경로 매핑 추가) |
| `watcher.rs` | 폴더 생성/삭제/이동 감지 확장 |
| 신규 | `migrate.rs` — vault 마이그레이션 로직. `wiki.rs` — 위키링크 파싱·백링크 인덱스 |

---

## 11. 프론트엔드 변경 범위

| 컴포넌트 | 변경 |
|----------|------|
| `Sidebar.tsx` | 평면 category 리스트 → 폴더 트리. 드래그&드롭. 중첩 태그 |
| `CardGrid.tsx` | Grid 뷰로 명명화. 폴더 색상 액센트 |
| 신규 `ListView.tsx` | List 뷰 컴포넌트 |
| 신규 `TimelineView.tsx` | Timeline 뷰 컴포넌트 |
| 신규 `GraphView.tsx` | Graph 뷰 (d3-force 또는 유사 라이브러리) |
| `MemoDetail.tsx` | 백링크 패널 추가. 포커스 모드 토글 |
| `MemoEditorForm.tsx` | 위키링크 serialization UUID → 제목으로 |
| `lib/memoLinks.ts` | suggest/resolve를 UUID → 제목 기반으로 재구현 |
| `lib/embeds.ts` | 임베드 resolve를 제목 기반으로 |
| `lib/markdownPreview.ts` | 위키링크 치환 UUID → 제목 |
| `ContextMenu.tsx` | 폴더로 이동, 이름 변경(리네임 전파), 위키링크 복사 추가 |
| `stores/ui.ts` | 현재 폴더, 뷰 모드, 락 상태 관리 |
| `lib/tauri.ts` | 새 Tauri 명령 바인딩 (폴더 操作, 리네임, 마이그레이션) |

---

## 12. 범위 밖 (후속)

- **물리 폴더 + 날짜 샤딩 하이브리드** (대형 vault 성능)
- **그래프 뷰 고급 기능** (필터링, 그룹핑, 레이아웃 알고리즘 선택)
- **임베드 재귀** (다단계 트랜스클루전)
- **다중 vault** 지원
- **충돌 해결 UI** (동기화 충돌 시 시각적 머지)
- **모바일 / 웹 클라이언트**
- **백링크 검색 고급 필터** (링크 컨텍스트 표시)

---

## 13. 검증 계획

1. **마이그레이션:** 기존 vault 백업 → migrate → 파일 구조/내용/frontmatter 검증 → reindex → 모든 노트 검색 가능
2. **물리 폴더:** Finder에서 폴더/파일 생성·이동·삭제 → 앱에서 정확히 반영
3. **위키링크:** `[[제목]]` 작성 → 자동완성 → 클릭 이동 → 백링크 표시 → 리네임 시 링크 업데이트
4. **템플릿:** `TEMPLATE.md`가 있는 폴더에서 새 노트 → 변수 치환 확인
5. **뷰 모드:** 4가지 뷰 전환 → 락 고정 → 재시작 후 유지 확인
6. **그래프:** 위키링크가 있는 vault에서 그래프 렌더링 → 노드 클릭 이동
7. **빠른 캡처:** 전역 단축키 → 루트에 타임스탬프 파일 생성 → 카드에 표시
8. **회귀:** 기존 기능(검색, 태그, 즐겨찾기, 다크모드) 모두 정상 동작
