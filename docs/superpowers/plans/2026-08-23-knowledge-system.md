# Knowledge System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 지식 관리 시스템 통합 설계 v3(`docs/superpowers/specs/2026-08-23-knowledge-system-design.md`)를 구현한다 — 범용 속성 엔진, 폴더 스키마(TEMPLATE.md + SCHEMA.toml), 퍼스트파티 Knowledge UX.

**Architecture:** 파일이 source of truth. 코어에 범용 props 엔진(`props.rs`)과 스키마 레이어(`schema.rs`)를 추가하고, `Memo`/`IndexRecord`/DTO에 props를 전파, tantivy에 aliases 필드, NoteQuery 오프셋 쿼리, SCHEMA.toml 전이 실행기, 프론트 속성 패널·배지·칩바·복습 대기열.

**Tech Stack:** Rust 1.89 (edition 2024), redb, tantivy, toml, oxi-frontmatter; React 19 + Tauri 2 + zustand.

## Global Constraints

- 스펙 §3: 코어 5키(id/created/updated/favorite/deleted) 외 모든 키 = 속성. 문법은 grammar v2.
- 스펙 §5.1: `PropValue = Str | Bool | List` (number 없음). `#[serde(default)]`로 하위호환.
- 스펙 §5.1: `hash_memo`에 속성 포함. `INDEX_FORMAT_VERSION` 3→4. tantivy 스키마 불일치 시 디렉터리 재구축.
- 스펙 §5.2: 속성 정렬 = 오프셋 페이지네이션(`NoteQuery`), 커서 경로와 분리.
- 스펙 §6.2: 검증은 경고 수준, 저장 안 막음. 전이 `on="change"` 기본, `merge="max"` 서열=options 선언 순서.
- 스펙 §11: 신규 로직은 `props.rs`/`schema.rs`에, vault.rs는 디스패치만.
- 기존 테스트 전부 통과 유지. 커밋은 conventional commits.

## Task 순서 (인라인 실행)

1. **oxi-frontmatter `Mutation::set_props`** — write.rs: 필드 추가, build_next_table 적용, 테스트(set/삭제/NoOp 보존).
2. **props 엔진 코어** — props.rs 신규(PropValue/props_from_table/PropPredicate/SortSpec/NoteQuery/QueryPage), memo.rs·index.rs·hash.rs·files.rs·vault.rs 전파, search.rs aliases 필드+스키마 재구축, INDEX_FORMAT_VERSION 4, 테스트.
3. **속성 쓰기·쿼리 경로** — update_note props 파라미터, query_notes(오프셋), 리네임 전파의 props 링크 재작성, aliases title_map, 링크 스캔 확장(graph/backlinks), 테스트.
4. **CLI** — `list --where/--sort/--offset`, `update --set/--unset`. where 파서는 props.rs에 순수 함수로.
5. **schema.rs** — SCHEMA.toml 파싱·검증·전이 실행기(merge max, on write/change, stamp_date), mtime 캐시 folder_schema, 지식 프리셋 파일 생성, doctor schema_violations, template.rs (Table, body) 반환 + create_note 비-blank 스탬프, 테스트.
6. **Tauri IPC + 프론트 타입** — query_notes/update_memo(props)/folder_schema/apply_preset 커맨드, types.ts·api.ts·tauri.ts(폴백 포함).
7. **속성 패널** — PropertyPanel(자유 모드 → 타입 편집기), MemoDetail 통합, 충돌 표시.
8. **배지·칩바·정렬** — badge=true select 배지(Card/List/Timeline/Graph), 속성 칩바, 정렬 옵션(오프셋 경로).
9. **복습 대기열** — 폴더 탭, ⌘K 팔레트 통합 커맨드, 재확인/막힘 액션, i18n(ko/en).
10. **검증·문서** — cargo test 전체, bun test, tsc+vite build, 브라우저 폴백 UI 스크린샷 검증, README·CHANGELOG.

각 태스크 완료 시 커밋. 스펙 §11의 층별 테스트 의무가 각 태스크의 테스트 목록이다.
