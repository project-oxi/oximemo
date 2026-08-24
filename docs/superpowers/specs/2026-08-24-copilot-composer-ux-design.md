# Copilot composer UX — revision 2026-08-24

**Status:** 구현 승인됨 (사용자 자율 위임, 2026-08-24)
**선행:** `2026-08-23-copilot-panel-design.md` (규범), revision 2026-08-24 (플로팅 레이어).
**연구:** 기성 코파일럿 UX 패턴 조사(GitHub Copilot Chat, Cursor, Claude Code/Desktop, Notion AI, ChatGPT desktop, Linear, Slack AI, Warp, Raycast) — `local://copilot-ux-research.md`.

## 1. 문제

현재 컴포저는 placeholder 하나짜리 평문 textarea다.

- **컨텍스트 지정 불능** — 열린 노트·선택 영역은 자동 첨부되지만, "저번에 쓴 X 노트 참고해서"처럼 다른 노트를 지정할 방법이 없다. 에이전트가 `oximemo search`로 찾게 방치하면 턴이 느려지고 부정확하다.
- **명령 발견성 0** — "요약해줘/태그 붙여줘" 같은 반복 작업을 매번 자연어로 새로 써야 한다.
- **응답이 마크다운 미렌더** — 에이전트 출력(oxios/omp)은 마크다운인데 `whitespace-pre-wrap` 평문으로 나온다. 코드블록·리스트가 깨진다.
- **진행 피드백 부족** — 턴은 수십 초~수 분짜리 subprocess인데 스피너만 있다. 경과 시간, 취소 버튼 위치(리스트 안)도 불분명.
- **패널을 닫으면 대화 소실** — `copilotOpen && <CopilotPanel/>` 언마운트로 entries가 사라진다.
- **IME Enter 버그** — 한국어 조합 중 Enter(`isComposing`)가 그대로 전송된다. Cursor가 유명하게 망한 지점(CJK 1.5B 사용자 버그). 한국어 앱에서는 필수 수정.
- 변경된 노트가 `id.slice(0,8)`로 표시된다 — 제목이 없으면 무엇이 바뀌었는지 알 수 없다.

## 2. 연구 기반 채택/기각

**채택** (근거 제품):

| 패턴 | 근거 |
|---|---|
| Send↔Stop 토글 (컴포저 푸터) | Cursor/ChatGPT/Notion — de-facto. Copilot Chat의 "취소 없음"은 반면교사 |
| @ 멘션 → 칩 + 원클릭 제거 | Cursor/Raycast/Notion — 컨텍스트를 "보이고 지울 수 있는 객체"로 |
| / 슬래시 메뉴 실시간 필터 | Warp/Claude Code |
| 빈 상태 = 스킬 제안 카드 | Linear — 시스템의 반복 작업을 첫 화면에서 가르친다 |
| 응답별 컨텍스트 액션 (복사) | Cursor/Copilot — per-message action row |
| Esc 체인 (메뉴 → 턴 취소 → 닫기) | Claude Code 2단계 취소 정신 |
| 경과 타이머 | 어디에도 없는 미개척 지점 — 긴 턴에서 개입 시점 판단에 필수 |
| IME-safe Enter (`isComposing` 검사) | Cursor 버그의 교훈 |

**기각** (YAGNI/계약 위반):

- **토큰 스트리밍** — 선행 스펙 §17: 어댑터별 출력 형식이 제각각, v1 밖.
- **자동 후속 제안 칩** — 연구에서 "가장 미움받는 패턴"(맥락 무시 발사). 넣지 않는다.
- **사이드챗(/btw), 클라우드 히스토리, 프롬프트 히스토리 ↑** — 각각 Cursor 전용 구조, 로컬 앱에 클라우드 없음, Copilot의 ↑ 내비게이션은 "가장 싫어하는" 패턴으로 보고됨.
- **편집-후-되감기(checkpoint)** — vault side-effect 롤백은 백엔드 checkpoint 계약이 선행되어야 한다. 별도 과제.
- **사용자 저장 레시피** — 저장 계약(어디에 어떤 스키마로)이 없다. 미래 후보: 레시피를 노트로 저장(oximemo-native).

## 3. 설계

### 3.1 컴포저 (하단 고정)

```
┌─ 컨텍스트 트레이 ──────────────────────────┐
│ [📝 열린 노트: 제목 ×] [▤ 선택 영역 × …] [@노트제목 ×] │   ← 첨부된 컨텍스트 칩들
├──────────────────────────────────────┤
│ textarea (자동 성장 2~8행)                     │
│ ┌ /명령 또는 @멘션 팝오버 (활성 시) ┐           │
├──────────────────────────────────────┤
│ @ 컨텍스트 · / 명령 · ⇧↵ 줄바꿈      [▶ 전송/■ 정지] │
└──────────────────────────────────────┘
```

- **@ 멘션** — `@`를 단어 시작(문두/공백 직후)에 입력하면 팝오버가 열리고 `searchMemos(query)` 결과(제목/경로/태그 부분일치)가 뜬다. 선택하면 `@query` 텍스트는 지워지고 **칩**이 트레이에 추가된다(인라인 토큰이 아님 — 제목에 공백이 있는 한국어 노트 타이틀에서 토큰 파싱은 모호성 지뢰). IME 안전: 트리거 판정은 keydown이 아니라 **draft 값 기반**이다.
- **/ 슬래시** — draft가 `/`로 시작할 때만. 선택하면 현지화된 프롬프트 템플릿으로 draft를 교체(사용자가 수정 후 전송). 템플릿은 §4.
- **전송/정지 토글** — busy면 전송 버튼이 Stop(■)으로 바뀐다. 리스트 안의 취소 행은 제거.
- **Esc 체인** — 팝오버 열림 → 닫기 / busy → 턴 취소 / 그 외 → 패널 닫기.
- 힌트 푸터의 `@`·`/`는 클릭 가능(각 트리거 삽입).

### 3.2 컨텍스트 트레이 — 하나의 모델

기존의 "active memo 스트립 + selection 스트립"(패널 상단)을 컴포저 트레이로 **통합**한다. 상태는 세 종류:

| 칩 | 소스 | 기본 | 제거 시 |
|---|---|---|---|
| 열린 노트 | `selectedId` → `getMemo` | 첨부 | 그 턴부터 `activeMemo: null` |
| 선택 영역 | CM6 selection (`copilotSelection`) | 첨부(열린 노트와 memoId 일치 시) | `selection: null` |
| @참조 | 사용자가 @로 선택 | 없음 | 목록에서 제거 |

- 칩은 `title || path` 표시, 클릭하면 그 노트를 연다(`setDraftId`/`selectedId` — AgentMessage 링크와 동일 의미론). @참조 칩의 ×만 제거, 열린 노트 칩의 ×는 "첨부 해제"토글.
- 발송한 턴의 user entry 아래에 당시 첨부 칩을 축소 표시해 대화 기록이 자기 설명적이게 한다.
- 선택 영역 칩은 클릭 시 전문 확장(preview).

### 3.3 IPC 확장 — `referenced` 참조

`copilot_send`에 `referenced: Option<Vec<{id,title,path}>>` 추가. 컨텍스트 블록에 선행 스펙 §7의 "사실 나열" 원칙 그대로:

```yaml
referenced_memos:
  - id: 01991a…
    title: 러닝 기록
    path: memos/2026/08/….md
```

- 모든 필드 `single_line` 처리(주입 방어 — selection과 동일 규율), **최대 8개**(초과분은 버리고 턴 결과에 경고하지 않음 — 칩 UI가 이미 상한을 보여준다: 8개 도달 시 @ 팝오버 안내).
- `active_memo`와 중복(id 일치) 시 참조 목록에서 제거 — 같은 사실을 두 번 쓰지 않는다.
- 열린 노트가 참조 목록에 @로 다시 들어오면 active 쪽이 이긴다(우선순위: active_memo가 사실의 원천).

### 3.4 메시지 렌더링

- **ChatMarkdown** — 기존 `marked`+`DOMPurify` 파이프라인(`markdownPreview.ts`)의 채팅 변형. 헤딩 축소, 리스트·테이블, **코드블록 헤더(언어 라벨 + 복사 버튼)**. sanitize 설정은 기존과 동일(FORBID script/iframe/style/…).
- 응답 우측 상단: **복사** 버튼(전체 원문). 하단 메타: `model/provider` 배지(기존) + 소요 시간(`duration_ms`).
- **변경 노트** — `getMemo(id)`로 제목·경로 해석(created/changed는 인덱스에 있다). deleted는 해석 실패 → id 표시. kind별 상태색 점(created=green, changed=blue, deleted=red). 라벨은 §9.4 준수 "이 턴 동안 변경된 노트".
- 오류 entry에 **재시도** 버튼 — 마지막 user 메시지+컨텍스트를 그대로 재전송.

### 3.5 진행 상태

- busy 동안 리스트 말미: `생각 중… 00:42` (경과 카운트업, 500ms 틱). 정지 버튼은 컴포저 푸터(§3.1).
- 완료된 턴은 duration을 메타로 표시.

### 3.6 빈 상태

중앙에 (1) 인사 + agent/provider 처분 공개 1줄("요청과 첨부 노트는 {provider}로 전송됩니다" — §12 처분 정신, 패널 상시 노출에서 첫 화면 강조로), (2) 제안 카드 4개 — §4 명령과 동일 템플릿으로 draft를 채운다.

### 3.7 대화 지속

entries/session/model/busy를 `ui.ts` store로 이동(패널 언마운트에 생존). **localStorage 미사용** — 응답에 vault 본문이 포함될 수 있고 평문 저장은 과하다. 앱 재시작 시 소실(스펙 §17의 세션 모델과 정합). agent 교체 시 초기화(기존 규칙 유지).

### 3.8 모델 피커

모델 수 > 8이면 필터 입력 노출. 나머지 유지.

### 3.9 컴포넌트 분리

`CopilotPanel.tsx`(셸: 헤더·빈상태·리스트) + `CopilotComposer.tsx`(트레이·textarea·팝오버·푸터) + `chatMarkdown.ts`(렌더러) + `copilotCommands.ts`(명령 카탈로그). 패널 파일이 445줄에서 더 자라기 전에 경계를 나눈다.

## 4. 명령 카탈로그

| id | 라벨(ko/en) | 템플릿(ko 기준; en은 locales) | 열린 노트 없을 때 |
|---|---|---|---|
| `summary` | 요약 / Summarize | "지금 열린 노트를 요약해줘" | "최근 노트 10개를 중요도 순으로 요약해줘" |
| `tags` | 태그 제안 / Suggest tags | "지금 열린 노트에 어울리는 태그를 제안하고, 확실한 것만 붙여줘" | "최근 노트들의 태그 일관성을 점검하고 제안만 해줘" |
| `tidy` | 정리 / Tidy up | "최근 노트를 검토해서 분류가 어긋나거나 비어 있는 노트를 찾고, 옮길 곳을 제안한 뒤 확실한 것만 실행해줘" | 동일 |
| `find` | 찾기 / Find notes | "다음 주제에 관한 노트를 찾아서 요약해줘: " (커서 끝) | 동일 |
| `new` | 새 노트 / New note | "다음 내용으로 새 노트를 만들어줘: " (커서 끝) | 동일 |

모두 "제안 우선, 확실한 것만 실행" 어조 — vault 쓰기는 에이전트 승인 정책을 따른다는 스펙 §11과 정합.

## 5. 검증

- Rust: `build_context` 참조 섹션 테스트(주입/상한/active 중복 제거/부재 시 생략) — TDD.
- TS: `bun run build`(tsc + vite).
- 브라우저 스모크(`vite dev` + browserFallback): 빈 상태 카드, / 메뉴 필터·전개, @ 메뉴 검색·칩 추가·제거, 칩→노트 열기, 전송(마크다운 응답 렌더 + 코드 복사), Stop 토글, Esc 체인, 패널 닫기/열기 대화 생존, 모델 필터. 스크린샷 근거.
