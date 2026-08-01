# 메모 위키링크 + 임베드 기능 설계 — oxinot

> 상태: 설계 (사용자 위임 — "superpower로 설계해보고 알아서 진행")
> 날짜: 2026-08-01
> 범위: 데스크톱 프론트엔드 + CM6 확장 1개. **Rust 코어 변경 없음, 스키마/마이그레이션 없음.**

## 1. 목표 / 배경

메모 간 참조를 위한 **위키링크**(`[[memo-id]]`)와 **임베드**(`![[memo-id]]`)를 추가한다.
메모에는 **제목이 없고 본문만** 있으므로:

- `[[` 입력 → **본문 검색 자동완성 팝업**이 뜬다(Tantivy BM25). `↑↓` 탐색, `Enter` 선택 → `]]` 자동 닫힘 + **링크엔 메모 ID(UUIDv7)만 저장**. 키보드 중심.
- 선택된 링크는 인라인 **칩**으로 표시(라벨 = 대상 메모 미리보기). 클릭 → 해당 메모 열기.
- `![[memo-id]]` (줄 단독) → 대상 메모 본문을 **읽기 전용 블록**으로 인라인 렌더(트랜스클루전).

필요한 백엔드 API는 이미 존재한다: `search_memos`(자동완성), `get_memo`(칩 라벨 + 임베드 본문), `select(id)`(열기).

## 2. 핵심 결정 (locked)

| # | 결정 | 근거 |
|---|------|------|
| 1 | **`wikiLinks()` 확장을 활성화** — 에디터 라이브러리 `@atomic-editor/editor`에 이미 내장 | `[[` 트리거 자동완성·`]]` 자동 닫기·인라인 칩 렌더·클릭 열기·비동기 resolve+캐시가 모두 구현됨(`wiki-links.js`, `wiki-links.d.ts`). 우리는 `extensions` prop으로 켜기만 하면 됨. |
| 2 | **저장 = `[[memo-id]]` 순수 마크다운** — `serializeSuggestion` 오버라이드 | `#tag`처럼 본문에서 파생. 라이브러리 기본값은 `[[target\|label]]`을 저장하지만, `serializeSuggestion: (s) => \`${s.target}]\`]` 로 **ID만** 저장. 칩 라벨은 `resolve(id)`가 `getMemo` 미리보기로 제공. 스키마/마이그레이션 불필요. |
| 3 | **임베드는 같은 `[[` 자동완성을 공유** | `!` 를 치고 `[[` 를 치면 동일 팝업; 트리거 정규식 `/\[\[[^\]\n\|]*$/`(`wiki-links.js#9`)는 앞의 `!`와 무관 → 선택 시 ID 삽입으로 자연스럽게 `![[memo-id]]`. 임베드는 순수 *렌더링* 문제. |
| 4 | **임베드 = `StateField` + block-replace** (초안 ViewPlugin 설계는 **폐기**) | CM6는 ViewPlugin에서 block decoration을 내보낼 수 없다(`@codemirror/view` `RangeError: Block decorations may not be specified via plugins`). `@atomic-editor/editor`의 `image-blocks.js:13-17`가 동일 제약을 명시하고 `StateField.define + EditorView.decorations.from(f)`로 구현(`image-blocks.js:229-232`). `lib/embeds.ts`도 동일 패턴. |
| 5 | **block-replace가 wikiLinks 인라인 칩을 억제** | `wiki-links.js#398`(`findWikiLinksInLine`)가 `![[id]]` 안의 `[[id]]`를 파싱해 숨김-구문 mark + 칩 point-widget을 내보내지만, `Decoration.replace({block:true})`가 해당 줄의 인라인 콘텐츠를 통째로 제거(CM6 fold 의미론 — 코드 폴딩이 접힌 범위 내의 모든 것을 숨기는 것과 동일)하므로 칩·stray `!` 는 렌더되지 않음. **구현 smoke test에서 최종 확인**(실앱이 렌더링 검증의 신뢰 가능한 장소). 억제가 부족해도 수정 범위는 embed 확장에 국한됨. |
| 6 | **자동완성 소스 = 기존 `searchMemos`(BM25)** + 빈 쿼리 → 최근 메모 | 별도 백엔드 불필요. 단문 쿼리 품질은 v2에 prefix/substring 전용 suggest로 개선 여지. |
| 7 | **임베드는 1단계 트랜스클루전만** | 중첩 `![[...]]`는 렌더하지 않음 → A→B→A 순환 자동 차단, 단순성. |
| 8 | **임베드는 읽기 전용, 줄 단독 블록** | 편집은 원본 메모에서. 인라인(줄 단독 아닌) 임베드는 v2. |

## 3. 구문 & UX

```
[[memo-id]]          → 인라인 칩(라벨=대상 미리보기). 클릭 → 대상 메모.
![[memo-id]]         → (줄 단독) 대상 본문 읽기전용 블록. 헤더 클릭 → 원본 메모.
```

- **트리거**: `[[` 입력 즉시 팝업. 빈 쿼리 = **최근 메모**(즐겨찾기 우선, `listMemos` 최신순). 입력 시 `searchMemos(query, 12)`.
- **항목 표시**: 미리보기(label) + detail(`카테고리 · 상대날짜 · ★`). `↑↓` 이동, `Enter` 선택(`]]` 자동 닫힘), `Esc` 취소. 모두 `wikiLinks` 확장 + CM6 autocomplete가 제공.
- **IME 안전**: `[[`는 한국어 조성 문자가 아니므로 `/` 슬래시 명령(`doc/CAPTURE_SLASH_PALETTE.md`의 모호성)과 달리 조합 충돌 없음.
- **상태 표시**: resolve 결과로 `resolved`(정상) / `missing`(삭제·존재안함) 칩 색상 분리.

## 4. 아키텍처 / 데이터 흐름

```
MemoEditorForm.tsx  ──useMemo 조립──▶  extensions={[ wikiLinks(cfg), ...embedExtension(cfg) ]}
                                         │
MarkdownEditor.tsx  ──forwards(NEW)──▶  AtomicCodeMirrorEditor extensions prop
                                         │
lib/memoLinks.ts (신규)   suggest / resolve / serializeSuggestion / onOpen
lib/embeds.ts   (신규)   StateField block-replace → getMemo 본문 → marked 렌더
markdownPreview.ts       카드 미리보기에서 [[id]]/![[id]] → 중립 칩 정리(UUID 노출 방지)
```

### cfg (wikiLinks)
- **suggest(q)**: `q.trim()` 빈 → `listMemos(null, 24)`(최신순, favorite 우선 정렬) 매핑; else `searchMemos(q, 12)`. 반환 `WikiLinkSuggestion[]{ target: id, label: preview.slice(0,60), detail, boost: favorite?1:0 }`. `debounceMs`/`maxSuggestions`는 라이브러리 기본(120ms/12).
- **serializeSuggestion(s)** = `` `${s.target}]]` `` (ID만; `]]` 포함 → 적용 핸들러 `wiki-links.js#229-232`가 `[[` 뒤에 끼워 `[[id]]` 완성).
- **resolve(id)** = `getMemo(id)` → `{ target:id, label: preview.slice(0,60), status: memo? 'resolved':'missing' }`. 삭제/없음 → missing. 라이브러리가 per-target debounced 캐싱(`wiki-links.js` README).
- **onOpen(id)** = `useUI.getState().select(id)` (MemoDetail 다이얼로그 오픈). `openOnClick: true`.
- **shouldResolve(id)** = 항상 `true` (모든 bare 링크를 칩으로).

### embedExtension(cfg)
- `StateField.define({ create, update, provide: f => EditorView.decorations.from(f) })`.
- `buildEmbed(state)`: 각 줄에서 `/^\s*!\[\[([^\]\n|]+)\]\]\s*$/` 매칭 → `Decoration.replace({block:true, widget: new EmbedWidget(target)}).range(lineStart, nextLineStart)` (줄 전체, 개행 포함).
- `EmbedWidget`: 로딩 플레이스홀더 → `getMemo(target).body` 비동기 fetch → `marked`로 본문 렌더(읽기전용). 헤더(대상 미리보기 + ▢) 클릭 → `cfg.onOpen(target)`. missing → "삭제된 메모" 플레이스홀더.
- 캐시: 모듈 스코프 `Map<id,{body,status}>`; 위젯 `eq`는 id 기반 → decoration 재빌드 시 로드된 콘텐츠 유지.
- `documentId` 전환(메모 교체) 시 위젯 재생성 → 재 fetch.

## 5. 컴포넌트 / 파일 상세

| 액션 | 파일 | 내용 |
|------|------|------|
| 변경 | `apps/desktop/src/components/MarkdownEditor.tsx` | `extensions?: readonly Extension[]` prop 추가 → `<AtomicCodeMirrorEditor extensions={extensions}>` 로 전달. (현재 의도적 미노출 — 본 spec이 먼저 추가; 향후 이미지 기능도 동일 훅 사용.) |
| 변경 | `apps/desktop/src/components/MemoEditorForm.tsx` | `useMemo`로 `wikiLinks(cfg) + embedExtension(cfg)` 조립해 `MarkdownEditor extensions` 전달. `documentId` 의존. |
| 추가 | `apps/desktop/src/lib/memoLinks.ts` | `buildWikiLinksConfig({ onOpen })` → `WikiLinksConfig`. suggest/resolve/serialize 헬퍼 + `MemoSummary→WikiLinkSuggestion` 매핑. |
| 추가 | `apps/desktop/src/lib/embeds.ts` | `embedExtension({ onOpen })` → `[StateField]`. `buildEmbed` + `EmbedWidget`. 의존: `@codemirror/state`(StateField, Decoration), `@codemirror/view`(EditorView, WidgetType). |
| 변경 | `apps/desktop/src/lib/markdownPreview.ts` | `renderPreviewMarkdown` 후처리: `[[target]]`, `![[target]]` (및 `[[target\|label]]`) 를 중립 칩 텍스트(◆ 링크 / ▢ 임베드, label 있으면 label)로 축약. 카드에 UUID 노출 방지. |
| 변경 | `apps/desktop/src/lib/i18n.ts` (ko/en) | `missing_link`, `deleted_memo`, `embed_loading` 등 키. |
| 변경 | `apps/desktop/package.json` | `@codemirror/state`, `@codemirror/view` 직접 의존성 추가(현재 @atomic-editor/editor 경유 transitive). |

> **의존성 추가 근거**: `embeds.ts`의 StateField/WidgetType은 `@codemirror/state`·`@codemirror/view` 타입을 직접 import해야 함(이미지 삽입 spec §2.3과 동일 선례). 번들 중복 방지를 위해 기존과 동일 버전 사용.

## 6. 엣지 / 에러

- **삭제·존재안함 대상**: resolve→`missing` 칩("삭제된 링크"); embed→"삭제된 메모" 플레이스홀더. UUID 불일치도 missing 처리.
- **코드 펜스/인라인 코드 내 `[[...]]`**: `wiki-links.js`는 라인 기반 스캔이므로 코드 내에서도 매칭될 수 있음(라이브러리 한계). v1 감수.
- **자기참조 `[[self-id]]`**: 동일 메모가 다시 열림(재로드). 무해.
- **임베드 다수**: 각 `![[id]]`마다 `getMemo` 1회. v1 감수; 다수 시 배치는 v2.
- **재귀**: 1단계만(결정 7). 중첩 `![[]]`는 marked가 일반 텍스트로 처리 → 재귀 렌더 안 함.
- **`[[id|label]]` 수동 편집**: 사용자가 파이프+라벨을 수동으로 넣으면 라이브러리가 label 표시(resolve 미호출). 파워유저 기능, 그대로 동작.

## 7. 범위 밖 (v2)

- **백링크 / 링크 그래프** (`DESIGN.md:64`에 "위키링크·백링크"로 후보 등록됨).
- **CaptureOverlay의 `[[`**: textarea 기반이라 미동작. 빠른 캡처는 평문 유지(기존 결정).
- **그리드 카드에서 링크 대상 리졸브**: 카드당 N번 IPC는 비용 과다 → 미리보기는 중립 칩만.
- **임베드 재귀(다단계) / 인라인 임베드(줄 단독 아님)**.
- **BM25 대신 prefix/substring 자동완성 전용 엔진** (`suggest_memos` Rust 명령).

## 8. 검증

- **빌드**: `tsc -b && vite build` (apps/desktop). Rust 변경 없음.
- **smoke**(브라우저 dev 모드, `tauri.ts` localStorage 폴백으로 전 플로우 가능):
  1. 메모 A 생성(본문 입력).
  2. 메모 B에서 `[[` 입력 → 팝업 등장 → A의 미리보기 항목 확인 → `Enter` → `]]` 자동 닫힘 + `[[A-id]]` 저장 + 칩 표시.
  3. 칩 클릭 → 메모 A 열림.
  4. 메모 B에서 `![[` 입력 → 같은 팝업 → A 선택 → `![[A-id]]` → **임베드 블록 렌더**(본문 표시, stray `!`/칩 없음 **여기서 최종 확인**). 헤더 클릭 → A 열림.
  5. 없는 ID로 `[[x]]`/`![[x]]` → missing 표시.
  6. 카드 미리보기에 UUID 안 보임(◆/▢ 칩).
- **regression**: 기존 편집·autosave·`#tag`·카테고리·즐겨찾기 동작 유지.

## 9. 아키텍처 노트 — block-replace 억제 (결정 5 상세)

`wiki-links.js`의 파서(`findWikiLinksInLine`, `indexOf('[[')`)는 앞의 `!`를 인지하지 못해 `![[id]]` 안의 `[[id]]`를 일반 링크로 장식한다(숨김 mark `wiki-links.js#338` + 칩 point-widget `#339-342`). 이로 인해 (a) stray `!`, (b) 칩 이 렌더될 수 있다.

해법: embed 확장의 `Decoration.replace({block:true})`가 `![[id]]` **줄 전체**(lineStart→nextLineStart, 개행 포함)를 치환한다. CM6는 block-replace 범위의 인라인 콘텐츠를 렌더 트리에서 아예 제거한다(코드 폴딩이 접힌 범위의 마크/위젯을 모두 숨기는 것과 동일한 의미론). 따라서 해당 줄의 wikiLinks 인라인 mark·point-widget·stray `!`는 출력되지 않는다.

제약: block-replace는 반드시 **완전한 줄**(줄 시작 → 다음 줄 시작)을 덮어야 하며, 다른 block decoration과 부분 겹침이 없어야 한다. wikiLinks는 block decoration을 내보내지 않으므로(인라인 mark + point-widget만) 충돌 없음. 본 억제 동작은 구현 smoke test(§8-4)에서 실앱으로 최종 확인한다.
