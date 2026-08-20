# oximemo: 노트 다이얼로그 맥락 UX 재설계

> **날짜:** 2026-08-20
> **상태:** 설계 (사용자 승인 완료)
> **범위:** 데스크톱 프론트엔드 — `MemoDetail.tsx`, `BacklinksPanel.tsx`, `BrainPanel.tsx` 대체
> **선행 설계와의 관계:** `2026-08-13-memo-to-notebook-design.md` §7.3(에디터 UI)의 "백링크 사이드 패널" 스케치를 대체한다.

---

## 1. 배경

메모/노트 하이브리드 평가 중 "다이얼로그 편집 모델이 장문 노트에도 적합한가"라는 질문이 제기됐다. 세 방향을 순서대로 검토하고 앞의 둘을 기각했다.

### 1.1 기각된 방향 1 — 노트 팝아웃 OS 윈도우

캡처 오버레이 패턴을 확장해 노트마다 독립 `WebviewWindow`(`note-<id>` 라벨)를 여는 안을 상세 설계까지 진행했다(창 라이프사이클, `note-*` capability 글로브, 단일 편집면 정책, Dock back/닫기 분리 등). 사용자 피드백으로 기각:

- 메인 브라우저(파일 트리 + Grid/List/Timeline/Graph)와 노트 편집이 물리적으로 분리되면 "브라우징 중 카드 클릭 → 편집" 흐름이 깨진다.
- 복귀 흐름(⌘W vs Dock back)을 별도로 설계해야 하는 것 자체가 팝아웃의 UX 비용이다.
- 장문이라는 이유만으로 별도 창을 정당화할 수 없다 — 진짜 필요조건은 "메인과 노트, 또는 노트 두 개를 동시에 보이게 해야 하는가"이고, 현재 그 요구가 없다.

### 1.2 기각된 방향 2 — Immersive(확장) 다이얼로그

기존 `MemoDetail.tsx`의 immersive 토글(640×80vh → 900px×94vh)을 `min(1120px, 96vw)×94vh`로 더 키우고 백링크/브레인을 우측 사이드 패널로 재배치하는 안. 사용자 지적으로 기각:

> "장문으로 넓어져봤자 옆에 Links랑 Brain이 이동해서 붙는 것뿐이잖아 … 그게 장문을 위해 유리할 것도 없지 않나."

확장은 패널 재배치일 뿐 실제 집필 경험(본문 measure, 몰입도)을 개선하지 않는다. 폭을 넓힌다고 문장이 더 잘 써지지 않는다.

### 1.3 채택된 방향 — Compact 다이얼로그 고정 + Floating Context Card

다이얼로그 크기·위치를 하나로 고정하고, 하단의 백링크/브레인 아코디언 두 개를 **평상시엔 상태만 보이고 필요할 때만 뜨는 카드**로 바꾼다. 별도 창도, 확장 모드도 없다.

---

## 2. 핵심 결정 (locked)

| # | 결정 | 근거 |
|---|------|------|
| 1 | **노트 팝아웃 윈도우 없음** | §1.1. 메인 브라우징과 편집의 분리는 이득보다 비용이 크다. |
| 2 | **Immersive/확장 모드 제거** | §1.2. 패널 재배치일 뿐 장문 편집에 실질적 이득 없음. `MemoDetail.tsx`의 `immersive` state, `Maximize2`/`Minimize2` 토글, `popupSize` 삼항식을 삭제한다. |
| 3 | **다이얼로그 크기 고정** | `640px × 80vh` 하나만 유지 (기존 Compact 크기). |
| 4 | **하단은 Context Dock** | 백링크/브레인 아코디언 헤더 두 줄을 슬림 상태 바 하나로 대체: `Links {n} · Brain ● · Saved`. |
| 5 | **Floating Context Card — 한 번에 하나** | Dock의 Links/Brain 버튼 클릭(또는 포커스 후 Enter) → 해당 카드가 Dock 위에 뜬다. 다른 카드를 열면 이전 카드는 닫힌다. |
| 6 | **본문 레이아웃 불변** | 카드가 열려도 에디터 높이·줄바꿈·스크롤 위치가 절대 변하지 않는다 (카드는 다이얼로그 위에 겹쳐 뜬다, 인라인 확장 아님). |
| 7 | **메인 윈도우 상태 완전 보존** | 다이얼로그가 열리고 닫혀도 메인의 파일 트리 선택, 폴더, 검색어, 뷰 모드, 스크롤 위치는 그대로다. 이 설계는 그 계약을 바꾸지 않는다 (이미 참이었음, 재확인). |

---

## 3. UX 스펙

### 3.1 Context Dock

다이얼로그 하단, 기존 `BacklinksPanel`/`BrainPanel`이 있던 자리를 대체하는 33px 슬림 바.

```text
[Links 4]   [Brain ●]              Saved
```

- `Links {n}`: 백링크 개수. `n === 0`이어도 버튼은 항상 표시(빈 상태 카드로 열림).
- `Brain ●`: 점 색상 = `brain_status().online` — 온라인 `--color-status-success`, 오프라인 `--color-text-subtle/40`. 브레인 결과 개수가 아니라 **연결 상태**를 나타낸다 (`BrainPanel.tsx:116`의 기존 `online` 판정 재사용).
- `Brain` 버튼은 `config.brain.enabled === false`일 때 Dock에서 완전히 숨김 (기존 `BrainPanel.tsx:74` 조건 이전).
- `Saved`: 우측 정렬. `dirty === true`(대기 중인 편집 있음)일 때 `dock_saving`("저장 중…") 표시, 저장 완료(`dirty === false`)로 전환되면 `dock_saved`("저장됨")로 교체. 신규 문자열 (§6).
- 버튼 스타일: 활성(카드 열림) 시 `bg-surface-muted text-text`, 평상시 `text-text-subtle`.

### 3.2 Links Card

**목적:** 기존 `BacklinksPanel.tsx`의 데이터/동작을 그대로 유지하되 아코디언이 아닌 팝오버로 표시.

- 크기: `320px` 폭, 최대 높이 `360px` (내용에 따라 축소, 초과 시 내부 스크롤)
- 위치: Dock의 `Links` 버튼 위, 왼쪽 정렬로 앵커
- 헤더: "이 노트를 참조하는 노트" + 개수
- 목록: 기존 `BacklinksPanel.tsx:47-60` 그대로 — 제목 + 1줄 발췌, 행 클릭 시 `select(bl.id)` 호출
- **행 클릭 시 카드는 즉시 닫힌다** (대상 노트로 다이얼로그 내용이 스왑되므로, 열려 있으면 새 노트의 백링크와 혼동됨)
- 빈 상태: 기존 `backlinks_empty` 문자열 재사용

### 3.3 Brain Card

**목적:** 기존 `BrainPanel.tsx`의 gather/distill 흐름을 아코디언 대신 팝오버 안에서 그대로 수행.

- 크기: `360px` 폭, 최대 높이 `min(480px, 65vh)` — 결과 레이어 영역만 내부 스크롤, 헤더와 액션 바는 고정
- 위치: Dock의 `Brain` 버튼 위, 왼쪽 정렬로 앵커
- 헤더: 상태 점 + "Brain" + `brain_episodes` 문자열(온라인일 때만: "에피소드 {n}개 · 엔티티 {e}개")
- 본문 상태 기계는 `BrainPanel.tsx:56-207`의 기존 로직을 그대로 이식 (컴포넌트 셸만 아코디언 → 팝오버로 교체, `gather`/`distill`/`layers`/`gathering`/`offline` state와 파생 로직 불변):
  - 오프라인: 안내 텍스트 + "다시 시도" 버튼
  - 미수집(`layers === null`): "컨텍스트 수집" 버튼
  - 수집 중: 버튼 비활성 + "수집 중…"
  - 결과 있음: 레이어 카드 목록 + 하단 고정 액션 바 (`다시 수집` / `새 노트로 정리`)
- `distill()` 호출 후 (`createMemo` 성공 → `select(n.id)`): 카드 닫고 다이얼로그가 새로 만들어진 노트로 스왑됨 (기존 `BrainPanel.tsx:108-113` 동작 그대로, Links Card와 동일한 "노트 전환 시 카드 닫힘" 규칙 적용)

### 3.4 상호작용 계약

| 트리거 | 동작 |
|---|---|
| Dock의 Links/Brain 버튼 클릭 | 해당 카드 열기. 다른 카드가 열려 있으면 먼저 닫음 |
| 열린 버튼 재클릭 | 카드 닫기 |
| `Escape` | 열린 카드 닫기 (다이얼로그 자체는 닫지 않음 — 카드가 없을 때만 `Escape`가 다이얼로그를 닫는 기존 동작 유지) |
| 카드 바깥 클릭 | 카드 닫기 |
| `Tab` → Dock 버튼 포커스 → `Enter`/`Space` | 카드 열기 (마우스 없이 접근 가능) |
| 카드 닫힘 (모든 경로) | 포커스는 트리거 버튼으로 복귀 |
| 모션 | `120ms ease-out`, 4px 위로 슬라이드 + 페이드. `prefers-reduced-motion`에서는 이동 없이 페이드만 |

### 3.5 레이아웃 불변 보장

카드는 `position: absolute`로 다이얼로그의 콘텐츠 영역 위에 겹쳐 뜬다 (문서 스택 흐름 밖). 열림/닫힘이 에디터의 높이, 줄바꿈, 스크롤 오프셋에 영향을 주지 않는다 — 이것이 §1.3에서 기각된 인라인 아코디언 대비 채택 이유다.

---

## 4. 컴포넌트 변경 범위

| 파일 | 변경 |
|---|---|
| `MemoDetail.tsx` | `immersive` state, `Maximize2`/`Minimize2` 토글 버튼, `popupSize` 삼항식 제거. `popupSize`를 `"h-[80vh] w-[min(640px,92vw)] p-5"` 고정값으로. 하단에 `ContextDock` 렌더 (기존 `BacklinksPanel`/`BrainPanel` 직접 렌더 제거) |
| 신규 `ContextDock.tsx` | §3.1. `noteId`, `favorite` 등 다이얼로그가 이미 가진 값 props로 전달. 열린 카드 상태(`"links" \| "brain" \| null`) 소유 |
| 신규 `LinksCard.tsx` | `BacklinksPanel.tsx`의 쿼리/렌더 로직 이식 (아코디언 헤더·`collapsed` state 제거, 팝오버 셸로 교체). 기존 `BacklinksPanel.tsx`는 삭제 |
| 신규 `BrainCard.tsx` | `BrainPanel.tsx`의 상태 기계 이식 (아코디언 헤더·`collapsed` state 제거, 팝오버 셸 + 고정 액션 바로 교체). 기존 `BrainPanel.tsx`는 삭제 |
| `lib/locales/ko.ts` / `en.ts` | §6 신규 키 추가 |

`getBacklinks`, `brainStatus`, `brainGather`, `createMemo` 등 `lib/api.ts` 호출부는 변경 없음 — UI 셸만 아코디언에서 팝오버로 바뀐다.

---

## 5. 엣지 케이스

- **카드 열린 채 다이얼로그 닫기(`Done`/⌘⏎):** 카드는 다이얼로그와 함께 사라짐. 별도 처리 불필요 (다이얼로그 언마운트 시 카드도 언마운트).
- **Links Card에서 행 클릭 → 대상 노트로 스왑 → 새 노트의 백링크 수 다름:** 카드가 닫힌 상태로 스왑되므로 사용자가 다시 Dock의 `Links {new-n}`을 클릭해야 함 — 혼동 없음 (§3.2 규칙).
- **Brain 카드 결과 표시 중 노트가 외부에서 삭제/변경됨:** 범위 밖. 기존 `BrainPanel`도 이 케이스를 처리하지 않았음 — 회귀 아님.
- **`Brain` 비활성(`config.brain.enabled === false`):** Dock에 `Brain` 버튼 자체가 없음 — `Links` 버튼만 존재.
- **좁은 화면(다이얼로그 92vw로 축소되는 매우 작은 창):** 카드 폭(320/360px)이 다이얼로그 폭을 넘지 않도록 `max-width: calc(100vw - 32px)` 안전장치. macOS 최소 앱 윈도우 폭(720px, `lib.rs:93`) 기준 다이얼로그 최소 폭은 항상 카드보다 크므로 실질적으로 발생하지 않음.

---

## 6. i18n 변경

기존 키 재사용: `backlinks_title`, `backlinks_empty`, `brain_title`, `brain_offline`, `brain_retry`, `brain_gather`, `brain_gathering`, `brain_distill`, `brain_episodes`, `brain_layer_*`.

신규 키 (ko/en):

| 키 | ko | en |
|---|---|---|
| `dock_saved` | "저장됨" | "Saved" |
| `dock_saving` | "저장 중…" | "Saving…" |

---

## 7. 검증 계획

1. **레이아웃 불변:** Brain 카드를 열고 레이어 결과가 로드된 상태에서 에디터에 타이핑 → 커서 위치·스크롤·줄바꿈이 카드 열기 전후로 동일한지 확인
2. **한 번에 하나:** Links 카드 연 상태에서 Brain 버튼 클릭 → Links 카드 자동 닫힘, Brain 카드 열림
3. **키보드:** Tab으로 Dock 버튼 도달 → Enter로 열기 → Escape로 닫기 → 포커스가 버튼으로 복귀하는지 확인
4. **백링크 이동:** Links 카드에서 노트 클릭 → 다이얼로그가 대상 노트로 스왑, 카드는 닫힌 상태
5. **Brain 흐름 회귀:** 오프라인 → 재시도 → 컨텍스트 수집 → 레이어 표시 → 새 노트로 정리 → 생성된 노트로 다이얼로그 스왑, 전 과정이 기존 아코디언과 동일하게 동작
6. **immersive 제거 회귀:** `Maximize2`/`Minimize2` 버튼이 다이얼로그 툴바에서 사라졌는지, 다이얼로그가 항상 640×80vh인지 확인
7. **메인 상태 보존:** 다이얼로그를 열고 카드를 열고 닫은 뒤 `Done` → 메인의 폴더/검색/뷰/스크롤이 그대로인지 확인 (기존에도 참이었던 계약의 무회귀 확인)

---

## 8. 범위 밖

- 노트 팝아웃 윈도우 (§1.1에서 기각, 향후 재검토 가능성은 열어두되 이번 스펙엔 포함 안 함)
- Immersive/확장 다이얼로그 모드 (§1.2에서 기각)
- 위키링크 뒤로/앞으로 내비게이션 기록 (별도 스펙 후보 — 이번 범위 아님)
- 다이얼로그 리사이즈/사용자 지정 크기
- Links/Brain 카드의 동시 표시(멀티 카드) — 명시적으로 배제 (§2 결정 5)
