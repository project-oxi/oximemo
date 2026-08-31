# Slash Menu v2 — Notion-Style Presentation

Date: 2026-08-31
Status: Approved (user directive: "Notion 스타일로 설계하고 진행해", autonomous run authorized)
Supersedes: tasks spec §8 v1 presentation decisions (trigger gate, default tooltip look)

## 배경

v1 슬래시 메뉴(tasks spec §8, commit `ed979e3`, v0.13.1 배포)는 CM6 autocompletion
위에 6개 그룹 24개 명령을 제공한다. 사용자 체험 결과 Notion/Logseq 대비 갭:

| # | 갭 | 사용자 결정 |
|---|---|---|
| 1 | 빈 `/`만으론 메뉴 미개방 — 첫 글자 필요 | **빈 `/` 즉시 개방** (체험 중 확인한 1순위 불만) |
| 2 | CM6 기본 툴팁 룩 — 그룹 헤더·아이콘 박스·설명 라인 없음 | **Notion식 프레젠테이션** |
| 3 | (미채택) React 플로팅 패널 신규 구현 | 기각 — 키보드 내비·위치잡기·IME 조합을 새로 구현하는 리스크.
     QuickCapture `/` 메뉴의 한글 IME 사고 전례(CHANGELOG L251) |
| 4 | (미채택) 블록 변환·새 명령 카탈로그 | 별도 사이클 — 본 스펙은 UX 계층만 |

## 결정 (자율 진행 중 확정)

1. **표면은 CM6 네이티브 유지.** 사용자가 직전 인터랙션에서 추천안(CM6 툴팁 개선)을
   선택했고, "Notion 스타일 제대로"는 프레젠테이션 품질 요구로 해석한다. 코어를
   재작성하지 않는다 — v1의 순수 코어(catalog/rank/patch/insertions, 606+라인,
   테스트 3종)는 그대로 재사용하고 UX 계층만 교체한다.
2. **설명 라인은 토큰 프리뷰 유지.** 24개 명령의 인간 언어 설명 사전 추가는 하지 않는다 —
   현행 `detail()` 토큰 프리뷰(`@due(2026-08-31)`, `---` 등)를 라벨 아래 muted 스택으로
   보여준다(Logseq가 같은 방식). 카탈로그 API 무변경.
3. **빈 쿼리 = 전체 카탈로그, curated order.** recency 부스트는 빈 쿼리에 적용하지 않는다
   (결정적 순서, 테스트 용이). 타이핑된 쿼리는 현행 래더 유지.

## 설계

### 트리거 (`slashTrigger.ts` — 무변경)

`slashTriggerAt`은 이미 bare `/`를 `{ from, query: "" }`로 반환한다 (줄 시작·공백 뒤만,
코드 컨텍스트 제외, CRLF 인식). 게이트는 소스 쪽에만 있다.

### 소스 (`slashExtension.ts` — 유일한 동작 변경)

```ts
// before
if (!trigger || trigger.query === "") return null;
const ranked = rankSlashCommands(buildSlashCatalog(deps), trigger.query, deps.recency);

// after
if (!trigger) return null;
const ranked = rankSlashCommands(buildSlashCatalog(deps), trigger.query, deps.recency);
```

- IME composing 게이트 유지 (프로젝트 도크린 — compositionend 재쿼리는 CM6 몫).
- 스페이스 입력 → 쿼리에 공백 → 트리거 해제 → 메뉴 닫힘, `/`는 문자로 잔존 (Notion 동일).
- 매치 없음 → `null` 반환으로 메뉴 닫힘 (Notion의 "결과 없음" 행 대신 — 닫힘이 더 조용함).

### 랭킹 (`slashCommands.ts` — 의미 하나 변경)

`rankSlashCommands(commands, query, recency)`: `query === ""`일 때 `[]` 대신 **curated
`order` 그대로 전체 반환**. 타이핑된 쿼리 경로(라벨+alias 매치, group rank → recency →
order 래더) 무변경.

### 프레젠테이션 (`app.css` — Plan D frozen 해제, 이번 작업 목적)

`taskSuggestExtension`/`slashExtension` 공용 툴팁을 Notion 스타일로. **app.css 전역
클래스 셀렉터** 사용 (EditorView.theme 미사용 — 프로젝트 컨벤션). 셀렉터를
`.cm-tooltip-autocomplete` 하위로 한정해 다른 표면 오염 방지. 위키 `[[`·task-field
완성도 같은 툴팁을 공유하므로 함께 리스타일된다 — 의도된 일관성.

| 대상 | 스타일 |
|---|---|
| `.cm-tooltip.cm-tooltip-autocomplete` | bg `--color-surface-raised`, border `--color-line`, `--shadow-lg`, `--radius-lg`, max-height 340px, min-width 280px, padding 6px |
| `completion-section` (CM6 6.20.3 커스텀 엘리먼트 헤더) | block, 12px, `--color-text-subtle`, padding 8px 10px 4px, letter-spacing 0.02em |
| `ul > li` (행) | grid `auto 1fr` / column-gap 10px, padding 6px 10px, `--radius-md`, cursor default |
| `li[aria-selected=true]`, `li:hover` | bg `--color-surface-muted` |
| 행 안 svg (lucide 인라인) | 20×20, padding 4px, bg `--color-surface-muted`, `--radius-sm`, `--color-text-muted` — Notion의 아이콘 박스 |
| `.cm-completionLabel` | grid-column 2, 14px, `--color-text` |
| `.cm-completionDetail` | grid-column 2, block 스택, 12px, `--color-text-subtle` |

행 그리드 자동배치: icon(col1,row1) → label(col2,row1) → detail(col2,row2) —
라벨-설명 2단 스택이 순수 CSS로 성립.

### 마운트 (`taskSuggestExtension` — 무변경)

소스 병합 구조 그대로. MemoEditorForm 변경 없음. `slashExtension`(standalone)도
동일 소스를 쓰므로 자동 적용.

## 파일 변경

| 파일 | 변경 |
|---|---|
| `apps/desktop/src/lib/slashCommands.ts` | `rankSlashCommands` 빈 쿼리 → 전체 반환 |
| `apps/desktop/src/lib/slashExtension.ts` | 소스의 `query === ""` 게이트 제거, doc 주석 갱신 |
| `apps/desktop/src/app.css` | `.cm-tooltip-autocomplete` Notion 스타일 블록 추가 |
| `apps/desktop/src/lib/slashCommands.test.ts` | 빈 쿼리 케이스 갱신/추가 |
| `apps/desktop/src/lib/slashTrigger.test.ts` | bare `/` (`query === ""`) 케이스 확인 |

## 검증

1. `bun test` — lib 테스트 전부 (기존 컨벤션).
2. `bunx tsc -b` — 타입.
3. `cargo tauri dev` 스모크 + 시각 확인: 빈 `/` 개방, 6개 그룹 헤더, 아이콘 박스,
   2단 행, 타이핑 필터, ↑↓ Enter 적용, 스페이스 해제, IME 한글 조합 중 무동작.
4. 릴리스(auto-release-prep) → `scripts/install.sh` PC 설치 → 버전·기동 확인.

## 리스크

- **IME**: 게이트 유지로 완화. bare `/`는 한글 조합과 무관 (`/`는 비조합 문자).
- **오발 트리거**: URL(`://`), `24/7`은 기존 가드(전임자 비공백 → 미트리거)로 차단.
- **app.css frozen 해제**: 셀렉터 범위 한정으로 영향은 완성 툴팁뿐.
- **병렬 세션**: 스테이징 전 `git status --short` 대조, 파일 단위 add.
