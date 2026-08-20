# oximemo × oxibrain: 지식 문서 작성 통합 설계

> **날짜:** 2026-08-18
> **상태:** 구현 완료 (2026-08-19 · 커밋 범위 85bf2bb..HEAD · 브랜치 feat/brain-integration)
> **구현 노트:** D1–D13 전 항목 구현됨. oxibrain 커넥터의 `.html` 스캔/와치는 §8에 따라 oxibrain 저장소에서 별도 진행 중.
> **범위:** oximemo에 HTML 노트 포맷 추가 + Brain 패널(oxibrain 클라이언트 통합)
> **생태계 근거:** `oxibrain/doc/ECOSYSTEM.md` v1.0 §3.1 — "oximemo … remains the
> ecosystem's authoring interface"

---

## 1. 배경과 비전

oxibrain은 oxi 생태계의 유일한 기억 저장소(data plane)다. 에피소드를 축적하고
엔티티·신념을 추출하지만, **사람이 지식을 "저술"하는 표면이 없다** — brain-ui는
대시보드이지 편집기가 아니며, ARCHITECTURE §1.4는 "oxibrain is not an editor"를
명시한다. 동시에 oximemo는 폴더 기반 노트북(물리 .md 파일 = 진실, 위키링크,
템플릿, 4개 뷰)으로 전환을 완료한 생태계의 authoring interface다.

이 통합이 완성하는 루프:

```
캡처(에피소드) ──→ oxibrain(기억·추출) ──→ oximemo에서 증류(지식 문서 저술)
      ▲                                            │
      └──── 커넥터가 파일 변화를 새 에피소드로 재섭취 ◄┘
```

핵심 관점: **지식 문서는 새 데이터 타입이 아니다.** 노트북 철학(타입 필드 없음,
폴더+템플릿이 사용자의 타입)을 그대로 적용한다. 이 통합이 추가하는 것은
(1) 저술 포맷으로 HTML, (2) 브레인으로부터의 읽기 전용 피드백 패널 — 루프 자체가
기능이다.

## 2. 핵심 결정

| # | 결정 | 근거 |
|---|------|------|
| D1 | HTML 노트 = `.html` 파일, frontmatter는 파일 선두 HTML 주석 `<!-- +++ … +++ -->` | 유효한 HTML, 브라우저에서 렌더 시 보이지 않음, 기존 TOML 파서 재사용 |
| D2 | 포맷 필드는 어디에도 저장하지 않음 — 확장자에서 항상 파생 | "제목 저장 안 함" 원칙과 동일. 저장소·인덱스·DTO 어디서든 드리프트 불가 |
| D3 | HTML 노트는 프래그먼트(기본)와 완전 문서(`<!DOCTYPE>`) 모두 허용, 파일 그대로 저장 | 완전 문서는 브라우저에서 바로 열리고 배포 가능; 프래그먼트는 md 본문과 대등 |
| D4 | 제목 파생: 첫 `<h1>` → `<title>` → 없음(타임스탬프 파일명) | md의 H1 규칙과 대칭 |
| D5 | 편집: 원시 CM6 + `@codemirror/lang-html`, 미리보기 토글(편집/분할/미리보기) | atomic-editor는 마크다운 전용; HTML은 원시 편집+샌드박스 미리보기가 정직한 v1 |
| D6 | 미리보기: DOMPurify 새니타이즈 → `sandbox="allow-same-origin"` iframe srcdoc (스크립트 금지) | 노트의 `<style>`은 살리되(아름다운 문서) 앱 DOM과 스타일 격리; allow-scripts 없으므로 same-origin도 안전 |
| D7 | 검색: `html_to_text`(태그·주석·style/script 내용 제거, 엔티티 디코딩) 후 기존 tantivy 파이프라인 | BM25 품질 유지, HTML 인지는 코어의 유일한 새 의무 |
| D8 | 새 노트 포맷 선택: 폴더의 `TEMPLATE.html` 존재 → html 노트, `TEMPLATE.md` → md, 둘 다 → 툴바 분할 버튼(기본 md) | 템플릿 = 사용자의 타입. 포맷 UI는 이 한 곳만 |
| D9 | Brain 패널: Rust 글루는 src-tauri에만 (oximemo-core는 순수·동기 유지), oxibrain-client git tag `v0.3.0` 의존 | C6(클라이언트 의존, 코어 링크 금지) 준수. crates.io는 0.2.0뿐, `connect_default`·핸드셰이크는 0.3.0 |
| D10 | 패널 쿼리: `recall`(assemble_context) 단일 호출 + `stats`. `search`는 v1 제외 | 실측: 추출 완료 지식이 없으면 `search`가 `[]` 반환. `recall`은 레이어로 실제 콘텐츠 반환 |
| D11 | 인증: 익명 Unix 소켓(기본 데몬 동작). 토큰은 문서화된 후속 작업 | 실측: 익명 접속으로 stats/recall 동작. C7(비밀은 설정 파일에 두지 않음) 준수 |
| D12 | `get_memo` 등 DTO에 파생 필드 `title`/`folder`/`format` 추가 반환 | 잠재 버그 수정: TS `Memo` 타입은 이미 이 필드들을 요구하나 Rust 직렬화에 없음 |
| D13 | 설정 `[brain]` (enabled/socket/space) 추가, schema_version 3 유지 | 추가 섹션이며 vault 레이아웃 불변. 마이그레이션 불필요 |
| D14 | oxibrain側(.html 스캔, watch 커넥터)은 핸드오프 문서로 분리 | C3: 커넥터는 브레인 소유. 본 저장소 작업 완료 후 별도 커밋 |

## 3. HTML 노트 상세

### 3.1 파일 형식

```html
<!--
+++
id = "01957a3b-…"
created_at = "2026-08-18T14:30:52Z"
updated_at = "2026-08-18T14:30:52Z"
hash = "b3:…"
favorite = false
tags = ["knowledge", "rust"]
+++
-->
<h1>Rust의 소유권 모델</h1>
<p>소유권은 <a href="https://rust-lang.org">Rust</a>의 핵심 개념이다.
[[이동 시맨틱]] 참고.</p>
```

- 주석은 `<!DOCTYPE html>` 이전에 있어도 유효하며 quirks mode를 유발하지 않는다
  (HTML5 파싱: initial 모드에서 주석 토큰 무시).
- TOML 내용은 md 노트와 완전 동일한 파서/검증/해시 규칙을 통과한다.
- `hash` 계산 대상도 md와 동일하게 정규화된 콘텐츠(전 파일 본문) — 포맷 무관.

### 3.2 파생 규칙

| 항목 | 규칙 |
|---|---|
| 포맷 | 확장자 `.html` (`.htm`은 불허, 최소주의) |
| 제목 | 첫 `<h1>` 텍스트(태그 제거·trim) → 없으면 `<title>` → 없으면 `None` |
| 파일명 | md와 동일: `slugify(제목)`.html 또는 타임스탬프.html |
| 미리보기 텍스트(카드) | `html_to_text` 결과 앞 280자 |
| 검색 본문 | `html_to_text` 결과 |
| 위키링크 | 본문 텍스트 노드의 `[[…]]` — **frontmatter 주석 영역은 제외하고** 추출. 그래프·백링크·리네임 전파 모두 기존 코드 경로 재사용 |
| 트래시/복원/이동/즐겨찾기/태그 | 포맷 무관 (frontmatter만 보므로) |

### 3.3 `html_to_text` (코어 신규, 순수 함수)

```
원본 → 주석 제거(frontmatter 포함) → <script>/<style> 내용 제거 →
태그 제거 → 기본 엔티티 디코딩(&amp; &lt; &gt; &quot; &#39; &nbsp; 및 &#NNN;) →
공백 정규화
```

상태 머신 구현 (외부 HTML 파서 의존 없음 — 순수 Rust 코어 유지). 정확한 DOM
파싱이 목적이 아니라 검색 색인과 카드 미리보기가 목적이므로 충분하다.

### 3.4 미리보기 파이프라인 (프론트엔드)

```
원본 html
  → 전처리: [[위키링크]] → <a class="wiki-link" data-target="…">, 
            상대 자산 경로 → oximg:// 해석
  → DOMPurify.sanitize: script/이벤트 핸들러/javascript:·data: URL 제거,
    <style> 허용(노트 자체 스타일링), <iframe>/<object>/<embed>/<form> 제거
  → 전체 문서면 그대로, 프래그먼트면 앱 타이포그래피 래퍼 문서로 감쌈
  → <iframe sandbox="allow-same-origin" srcdoc={…}> (allow-scripts 절대 없음)
  → 부모가 contentDocument 높이 측정해 auto-height
```

보안 겹층: (1) 새니타이즈 (2) 샌드박스 iframe — allow-same-origin만 있고
allow-scripts가 없으면 프레임 내부 코드 실행이 불가능하므로 부모 접근 위험 없음.
DOMPurify는 앱 웹뷰(브라우저 환경)에서 동작.

### 3.5 편집기

- `HtmlEditor.tsx`: CM6 (`@codemirror/lang-html` + history/selection/activeLine
  최소 확장). 원시 HTML 편집.
- 툴바 토글: 편집 | 분할 | 미리보기 (md 노트의 atomic-editor 라이브 프리뷰와
  대응하는 명시적 형태).
- `MemoEditorForm`이 포맷에 따라 MarkdownEditor/HtmlEditor를 선택.

## 4. Brain 패널

### 4.1 아키텍처

```
MemoDetail (React)
  └─ BrainPanel ──invoke──▶ src-tauri
                              ├─ brain_status() → {online, version, stats?}
                              └─ brain_gather(query, budget) → layers JSON
                                   └─ oxibrain-client (git tag v0.3.0)
                                        └─ ~/.oxi/brain/oxibrain.sock (익명)
```

- 연결 수명: 명령 호출마다 단기 접속(접속+핸드셰이크+호출+drop). 데몬 다운 시
  즉시 에러 → C1(스피너 아님, 차단 아님).
- `brain_gather`는 `recall(query, space, budget)` 한 번 호출 후 레이어 JSON을
  그대로 반환. 렌더링은 프론트엔드가 담당.
- `brain_status`는 `connect_default()` 핸드셰이크 + `stats(space)`.

### 4.2 설정

```toml
# oximemo.toml — 추가 섹션 (schema_version 3 유지)
[brain]
enabled = true            # false면 패널 자체를 렌더하지 않음
socket = ""               # 빈 문자열 = 기본 경로 (~/.oxi/brain/oxibrain.sock)
space = "personal"        # C2: 스페이스는 프라이버시 경계
```

### 4.3 UX

```
┌────────────────────────────────────────────┐
│ Brain                        ● 온라인 v0.3.0│
│ ┌────────────────────────────────────────┐ │
│ │ [컨텍스트 수집]                         │ │ ← 노트 제목+태그로 recall
│ └────────────────────────────────────────┘ │
│ 핵심 신념 (2)                               │
│  · "Rust 소유권은 컴파일 타임에 정적으로…"  │
│ 최근 에피소드 (3)                           │
│  · [note] 2026-08-17 — oximemo 노트북 설계… │
│ ┌────────────────────────────────────────┐ │
│ │ [이 내용으로 새 노트 시작]              │ │ ← 증류(distill)
│ └────────────────────────────────────────┘ │
└────────────────────────────────────────────┘
```

- 위치: MemoDetail 우측, BacklinksPanel 아래 (둘 다 접기 가능).
- 수집은 **명시적 버튼** — 자동 호출 없음 (no-AI-promise: 지능은 항상 닫을 수
  있는 패널, 사용자 시작).
- 오프라인: "Brain 오프라인 · 다시 시도" 한 줄. 노트 기능 영향 0.
- 증류 버튼: 수집 결과를 참조 목록(source + 발췌)으로 포함한 새 노트 생성 —
  루프의 클로징 액션.
- i18n: 기존 `useI18n` 키 패턴 따름 (ko/en).

### 4.4 라이선스/의존 정리

- `oxibrain-client = { git = "https://github.com/a7garden/oxibrain", tag = "v0.3.0" }`
  — src-tauri에만 선언. core/cli는 영향 없음.
- Cargo.lock 고정으로 재현성 확보.

## 5. CLI 패리티

```bash
oximemo new "본문" --html        # <타임스탬프>.html 프래그먼트 노트 생성
oximemo get/list/search/export   # 포맷 무관하게 그대로 동작
```

`--html` 플래그 하나. 브레인 패널은 GUI 기능이므로 CLI 명령 추가 없음
(패리티 원칙은 vault 조작에 적용).

## 6. 검증 계획

1. **코어 단위 테스트**: html frontmatter 파싱 라운드트립, 제목 파생
   (h1/title/none), `html_to_text`(엔티티/script/style/주석), 위키링크 추출
   (주석 제외 포함), TEMPLATE.html 적용, HTML 노트 create→search→get→delete
   사이클(임시 vault), 리네임 전파가 html 노트에 적용.
2. **게이트**: `cargo fmt`, `cargo clippy -p oximemo-core -p oximemo-cli
   --all-targets -- -D warnings`, 전체 테스트, `bun run build`(tsc 포함).
3. **런타임(브라우저 모드)**: HTML 노트 편집·미리보기·카드 표시, 포맷 배지,
   Brain 패널 오프라인 상태 — 스크린샷 검증.
4. **런타임(데몬 라이브)**: 실제 데몬(`~/.oxi/brain/oxibrain.sock`) 대상
   brain_status/brain_gather 응답 확인 — 별도 소켓 테스트로 글루 검증.
5. **회귀**: 기존 md 노트 전 기능(91 core + 11 CLI 테스트) 통과.

## 7. 범위 밖 (후속)

- oxibrain 커넥터의 `.html` 스캔 지원 및 watch 커넥터 — oxibrain 저장소 작업,
  본 작업 완료 후 핸드오프(§8)
- 브레인 토큰 인증(필요 시 Keychain locator)
- HTML 노트 내 코드 하이라이팅, 임베드 트랜스클루전 `![[…]]` in HTML
- 노트 → 브레인 push(ingest) — C3/C4에 따라 커넥터가 담당, 앱이 푸시하지 않음

## 8. oxibrain 측 핸드오프 (요약)

1. `oxibrain-connectors/markdown.rs`: `scan_directory`가 `.html`도 스캔하고
   `html_to_text` 상당물로 본문 추출 (SourceRef::Note 그대로).
2. `oxibrain sync`의 스캔 대상에 `.html` 포함.
3. (별도 이슈) vault watch 커넥터 — debounce + 최소 diff로 C4 준수.

이 세 가지가 끝나야 루프가 닫힌다. 그 전에는 md 노트만 브레인에 흘러간다.

> **후속 해소 (2026-08-20, oxibrain v0.6.0 · ADR-010):** 핸드오프 3항목 전부
> 완료됐다. watch는 브레인 소유·데몬 호스팅으로 판정되었다(P8 단일 라이터
> 락이 유일한 자동화 가능 위치). `oxibrain sync <vault>`가 등록 표면이고,
> 데몬이 등록된 pull 소스를 debounce(2s) 와치한다. 실제 vault 등록·C4 편집
> 검증 완료 — 루프가 닫혔다. 본 저장소는 `oxibrain-client` v0.6.0으로
> 승격만 하면 된다(완료).
