# 지식 관리 시스템 통합 설계 (Knowledge State Management)

- 날짜: 2026-08-23
- 상태: 초안 — 사용자 검토 대기
- 선행 문서: 사용자 설계 "개인 지식 상태 관리 시스템" (상태 체계·분류 체계·프론트매터 필드 확정본)

## 1. 배경과 목표

사용자가 설계한 개인 지식 상태 관리 시스템(이하 "지식 설계")을 oximemo에서 실행
가능하게 만든다. 지식 설계의 핵심:

- 모르는 것도 파일이다(스텁 = 정식 엔트리)
- 1개념 = 1파일, 동의어는 `aliases`로 통합
- 지식 상태는 5단계(`stub`/`vague`/`understood`/`mastered`/`decayed`)이며
  역사(`peak_status`)를 가진다
- 분류는 폴더가 아니라 프론트매터 메타데이터(`domain` 단일값 + `subdomain` 리스트)
- 파일은 순수 텍스트(YAML 프론트매터 + 마크다운)이며 어떤 도구로도 읽을 수 있어야 한다

이 시스템이 oximemo 위에서 "일반적인 구조"로 소화되어야 한다. 지식 관리만을 위한
예외 분기(status/domain 필드 존재 여부로 노트 종류 추론 등)를 만들지 않는다.

## 2. 핵심 결정사항 (확정)

1. **퍼스트파티 UX + 표준 파일.** oximemo는 지식 관리 UI를 퍼스트파티(내장,
   일급) 기능으로 제공한다. 저장되는 파일은 앱 비종속적인 YAML 프론트매터 +
   마크다운 그대로다. 다른 앱(Obsidian, VS Code, `grep`)에서는 평범한 마크다운
   노트로 읽히고 편집된다.
2. **일반 구조로 소화.** 지식 노트를 특별 취급하지 않는다. 코어는 범용
   **속성(properties) 엔진**을 갖고, 지식 관리는 "폴더 템플릿 + 스키마"라는
   일반 메커니즘 위에 올라간 구성(configuration)이다.
3. **스키마는 폴더 단위.** 각 폴더의 `TEMPLATE.md`(초깃값)와 `SCHEMA.toml`
   (규칙 선언)이 그 폴더 노트의 속성 체계를 정의한다. 노트가 지식 노트인
   이유는 필드 값을 가져서가 아니라, 그 폴더가 지식 스키마를 쓴다고
   **명시적으로 설정**돼 있기 때문이다.
4. **속성 편집은 본문 위 속성 패널.** 제목 아래에 타입별 편집기를 두고 원본
   프론트매터와 동기화한다. 일반 노트는 속성이 없으면 패널이 거의 보이지 않는다.
5. **스텁도 H1 제목은 갖는다.** 본문이 사실상 비어 있어도 `# 개념명` 한 줄은
   필수로 둔다. 제목 한 줄은 지식이 아니라 정체성이며, 이로써 현재 링크
   해석·백링크·그래프·파일명 파생 체계가 그대로 재사용된다.

### 기각한 대안

- **고정 지식 필드를 코어에 추가** (`Memo.status` 등): 모든 메모 모델이 지식
  설계에 종속된다. 일반 구조 원칙과 충돌. 기각.
- **완전 선언형 워크스페이스 엔진** (뷰·대시보드까지 전부 사용자 설정): 로우코드
  빌더가 되고 퍼스트파티 지식 UX 완성도가 늦어진다. 과설계. 기각.
- **status를 `#stub` 본문 태그로 치환** (코드 0 우회): 파일 오염이 끈적여서
  나중에 YAML로 돌아갈 때 전량 마이그레이션이 필요하다. 기각.

## 3. 파일 형식 — 표준 계약

지식 노트의 온디스크 예시 (oximemo가 쓴 canonical 출력 기준):

```markdown
---
id: 01991a2e-7c3f-7c91-9f3e-6b1a2e8f9c10
created: 2026-08-23T10:15:03+09:00
updated: 2026-08-23T10:15:03+09:00
aliases: [Backpropagation, 역전파, BP]
status: stub
status_changed: 2026-08-23
domain: TECH
subdomain: [AI]
related: ["[[딥러닝]]", "[[경사하강법]]"]
---

# 오류역전파
```

규칙:

- 코어 5키(`id, created, updated, favorite, deleted`)는 기존 그대로. 그 외
  모든 키가 **속성**이며 oximemo 쓰기 시 보존된다(기존 merge-write 보존
  동작 그대로).
- 배열은 flow 형식(`[a, b]`)으로 쓴다(oxi-frontmatter canonical emitter 규칙).
  외부 도구가 block 형식(`- a`)으로 쓴 파일도 파싱되고, oximemo가 다음에 쓸 때
  flow 형식으로 정규화된다 — 의미 손실 없음.
- 속성 값의 문법 범위는 oxi-frontmatter grammar v2(SCALAR / 리스트 / 깊이 ≤2)를
  따른다. 인덱스·쿼리 대상은 1차원 값(스칼라, 리스트)으로 한정하고 Map 값은
  보존만 한다.
- `aliases`, `related` 등 지식 설계의 필드 이름은 oximemo 코어에 특수 의미를
  갖지 않는다(§6의 링크 통합 제외 — 그것도 필드 이름이 아니라 값의 `[[..]]`
  패턴에 반응한다).

지식 설계 대비 조정 2가지 (사용자 설계 문서에 반영할 내용):

| 원 설계 | 조정 | 이유 |
|---|---|---|
| 스텁 = 프론트매터만 있는 진공 파일 | H1 제목 한 줄 필수 | 현재 타이틀·링크 해석 체계 재사용, 등록 장벽 동일하게 0 |
| `updated` = 상태가 마지막으로 바뀐 날 | 코어 `updated`(마지막 수정) 유지 + 속성 `status_changed`(전이일) 추가 | 앱의 updated 시맨틱은 전 노트 공통계약이라 바꾸지 않고, 복습 대기열 정렬 기준은 `status_changed`로 원 설계 의도 보존 |

## 4. 아키텍처

```text
Markdown/HTML files (source of truth)
    │  oxi-frontmatter parse (Table 전체 보존)
    ▼
속성 엔진 (oximemo-core 신규, 범용)
    │  - props 스냅샷 인덱싱 (redb IndexRecord 확장)
    │  - 속성 조건 쿼리 (NoteQuery)
    │  - 속성 Mutation (write_document 확장)
    ▼
폴더 스키마 (TEMPLATE.md 초깃값 + SCHEMA.toml 규칙)
    │
    ▼
퍼스트파티 Knowledge UX (frontend)
    상태 배지 · 상태/도메인 필터 · 복습 대기열 · 전이 규칙 · 속성 패널
```

- 지식 관리는 이 스택의 한 가지 사용례다. 같은 구조로 다른 속성 체계(책
  목록, 프로젝트 로그 등)도 폴더 스키마로 구성할 수 있다.
- CLI/GUI 패리티 원칙 유지: 속성 조회·수정·쿼리는 Tauri 커맨드와 CLI 양쪽에
  동일하게 노출한다.

## 5. 속성 엔진 (oximemo-core)

### 5.1 데이터 모델

- `IndexRecord`에 `props: BTreeMap<String, PropValue>` 추가
  (`PropValue = Str(String) | Bool(bool) | List(Vec<String>)`). 프론트매터의
  core 5키를 제외한 1차원 값 전부. `INDEX_FORMAT_VERSION` bump + 재색인.
- `Mutation`(oxi-frontmatter)에 속성 변경 추가: `set_props:
  IndexMap<String, Option<Value>>` — `Some(v)`는 설정, `None`은 키 삭제.
  기존 보존 규칙(알 수 없는 키 re-emit)은 그대로.
- 속성이 바뀌면 코어 `updated`를 bump한다(의미 있는 변경).

### 5.2 쿼리

- 신규 `NoteQuery`: `filter: MemoFilter` + `props: Vec<PropPredicate>` +
  `sort: SortSpec`(`UpdatedDesc`(현행 기본) / `UpdatedAsc` / `PropAsc(key)` /
  `PropDesc(key)`).
- 구현: `export_since(None)`로 전체 레코드를 가져와 in-memory 필터+정렬 후
  페이지 slice. 개인 볼트 규모(수천~수만 노트)에서 충분하고, 커서 페이지네이션
  재설계라는 과설계를 피한다. 기존 `list_memos` 경로는 그대로 두어 일반
  브라우징 성능에 영향 없게 한다.
- `PropPredicate`: `key`, `op: Eq | In(values) | Contains(값 — 리스트 값의
  부분 집합)`, `value`.
- tantivy에 속성 텍스트 색인 필드 1개 추가(모든 스칼라 값을 join)해서
  `status: stub` 같은 값이 전문 검색에도 잡히게 한다. 필터·정렬은 redb
  스냅샷이 담당한다.

### 5.3 링크 통합 (지식 설계 갭 해소)

- **프론트매터 속성 값의 `[[...]]`를 링크로 인식.** 백링크(`get_backlinks`)와
  그래프(`graph_data`)의 링크 스캔 범위를 본문 + 1차원 속성 값으로 확장한다.
  스텁의 `related`가 그래프 엣지·상대 노트의 백링크로 잡힌다.
- **aliases 링크 해석.** `graph_data`/`get_backlinks`의 title_map에 H1
  타이틀과 함께 `aliases` 속성의 각 값을 등록한다(대소문자 무시, H1 우선).
  `[[ML]]`이 aliases에 ML을 둔 노트로 해석된다. 검색 색인에 aliases 값 포함.
- 노트 리네임 시 기존 `[[링크]]` 전파(`replace_link_target`)는 그대로, aliases는
  그대로 유지한다.

## 6. 폴더 스키마 — TEMPLATE.md + SCHEMA.toml

### 6.1 TEMPLATE.md (초깃값 — 기존 기능 확장)

- 기존 그대로: 빈 본문으로 노트를 만들면 폴더의 `TEMPLATE.md`가 본문을 시딩
  (`{{date}}` 등 치환).
- **확장:** 본문이 있는 캡처(퀵캡처 등)로 만들 때도 템플릿의 프론트매터
  속성 초깃값을 스탬프한다(본문은 캡처 텍스트 사용). 현재는 빈 본문일 때만
  템플릿이 적용되므로 이 경로가 속성 시딩의 실수로 빠진다.

### 6.2 SCHEMA.toml (규칙 선언 — 신규)

폴더 단위. 노트 스캔 대상에서 제외(TEMPLATE.md와 동일 취급, watcher·인덱스
프루닝 목록에 추가).

```toml
# knowledge 폴더의 SCHEMA.toml 예시
[workspace]
name = "지식"            # 사이드바·탭 표시명 (선택)

[properties.status]
type = "select"           # text | select | multiselect | date | number
options = ["stub", "vague", "understood", "mastered", "decayed"]
required = true

[properties.peak_status]
type = "select"
options = ["understood", "mastered"]

[properties.domain]
type = "select"
options = ["SCI", "MATH", "TECH", "SOC", "CULT", "HIST", "FIN", "PHIL", "LANG", "LIFE"]
required = true

[properties.subdomain]
type = "multiselect"
# 옵션 미지정 = 자유 값 허용 (TECH 코드표는 지식 프리셋이 채워 제공)

[properties.aliases]
type = "multiselect"

[properties.related]
type = "multiselect"

[properties.status_changed]
type = "date"

# 상태 전이 규칙: status가 to 값으로 바뀌면 side_effect 실행
[[transitions]]
key = "status"
from = ["understood", "mastered"]
to = "decayed"
copy_from = "status"      # 변경 직전의 status 값을…
into = "peak_status"      # …peak_status에 기록

[[transitions]]
key = "status"
to = ["stub", "vague", "understood", "mastered", "decayed"]
stamp_date = "status_changed"  # 전이 시 해당 date 속성에 오늘 날짜 기록
```

- 검증은 **경고 수준**: 필수 누락·허용값 위반은 속성 패널과 카드에 표시하지만
  저장을 막지 않는다(빠른 캡처 보호, 외부 편집 허용).
- 전이 규칙은 앱 UI에서 속성을 변경할 때만 자동 적용된다. 외부 편집기로
  status를 바꾼 경우 규칙 미적용(파일은 그대로 유효).
- 폴더에 SCHEMA.toml이 없으면 그 폴더는 "자유 속성" 모드 — 속성 패널은
  키/값 텍스트 편집기로 동작한다.

### 6.3 지식 프리셋

폴더 생성 UI에 내장 프리셋 "지식 관리" 추가. 선택하면:

- `TEMPLATE.md`: §3 형식의 스텁 스켈레톤(H1 플레이스홀더 + 속성 초깃값)
- `SCHEMA.toml`: 위 예시 + TECH subdomain 코드표(`[SW, AI, DATA, SEC, HW, SYS]`)
  + 도메인 표시명 매핑

프리셋은 그냥 파일 2개를 깔아주는 것이라 사용자가 자유롭게 고쳐 쓸 수 있다.

## 7. 프론트엔드

### 7.1 속성 패널 (에디터 공통)

- 위치: MemoDetail/에디터에서 제목 아래. 속성 0개면 한 줄짜리 "＋ 속성" 버튼만.
- 스키마 있음: 타입별 편집기 — select(드롭다운), multiselect(칩 + 자유값
  입력), date(달력), text, number. 필수 누락·위반 표시.
- 스키마 없음(자유 모드): 키/값 텍스트 행 편집 + 값은 리스트/스칼라 구분.
- 변경은 기존 저장 흐름에 합류(자동 저장) — `set_props` Mutation으로 반영.

### 7.2 Knowledge 워크스페이스 화면

SCHEMA.toml이 있는 폴더를 브라우징할 때:

- **상태 배지**: 카드·리스트 행에 `status` 값 배지(색: stub=중립, vague=회색,
  understood=파랑, mastered=초록, decayed=주황 — 최종 색은 디자인 시스템
  참조). 배지 렌더링은 "스키마에 select형 status 속성이 있으면"이라는 일반
  규칙으로 구현한다(지식 전용 분기 아님).
- **속성 필터 칩바**: 폴더 칩바 옆에 스키마 select/multiselect 속성의 값
  칩(예: `stub` `understood` …, `TECH` `MATH` …). 클릭으로 필터 토글.
- **정렬 옵션**: 최신순(기본) / 오래된순 / `status_changed` 오래된순.
- **복습 대기열 뷰**: knowledge 프리셋 폴더 전용 진입점(폴더 화면 상단
  탭). `status ∈ {understood, mastered}`를 `status_changed` 오래된순으로
  정렬한 목록 + 현재 상태별 분포 요약(카운트 칩). 항목에서 바로
  "설명 가능함(상태 유지 → status_changed만 갱신)" / "막힘(decayed 전이)"
  액션 제공. 이 액션들은 §6.2 전이 규칙을 타고 `peak_status`·`status_changed`를
  자동 기록한다.
- 그래프 뷰: 노드 색을 상태값으로 칠하는 옵션(폴더 컬러 대신).

### 7.3 캡처 통합

- 퀵캡처/새 노트에서 대상 폴더의 템플릿 속성이 스탬프된다(§6.1).
- 캡처 → 지식 등록 단축 경로: 캡처 대상이 knowledge 폴더면 입력 텍스트가
  곧 H1이고 `status: stub`으로 시작한다(프론트매터는 템플릿이 제공).
- ⌘K 팔레트의 "새 노트" 경로도 동일하게 폴더 템플릿을 탄다.

### 7.4 브라우저 폴백

`tauri.ts`의 localStorage 폴백은 속성 엔진 API를 최소 구현(저장·필터)하되,
복습 대기열·전이 규칙·그래프 통합은 데스크톱 전용 표면으로 명시한다(기존
백링크와 동일한 경계).

## 8. 기존 갭 → 해소 매핑

| 갭 (2026-08-23 분석) | 해소 |
|---|---|
| 스텁이 존재할 수 없는 구조 | H1 규칙(결정 5) + 캡처 스탬프(§6.1) |
| 프론트매터 related 링크 미인식 | 속성 값 `[[..]]` 링크 통합(§5.3) |
| 상태 쿼리·정렬 불가 | props 인덱싱 + NoteQuery(§5.2) |
| 앱 내 상태 변경 불가 | 속성 패널 + Mutation 확장(§5.1, §7.1) |
| aliases 미해석 | title_map·검색 통합(§5.3) |
| updated 시맨틱 충돌 | `status_changed` 속성(§3, §6.2) |

## 9. 호환성·마이그레이션

- 기존 노트 무영향: 속성 없으면 `props` 빈 맵. 인덱스 버전 bump + 재색인
  한 번으로 끝.
- 외부 도구로 지식 노트를 직접 만들어도 watcher가 잡아 인덱싱한다(파일이
  source of truth). 단 전이 규칙 자동 적용은 앱 UI 경로에서만(§6.2).
- 프론트매터 round-trip 보존(알 수 없는 키 re-emit)은 기존 동작이므로 지식
  노트의 모든 속성이 앱 편집 후에도 유지된다.

## 10. 명시적으로 범위 밖

- 복습 주기 자동화(SRS, `next_review`) — 지식 설계 10절과 동일하게 추후 검토.
- 자신감 점수 분리, 지식그래프 시각화 고도화.
- 속성 기반 저장 뷰의 사용자 정의(저장된 쿼리) — 필요해지면 NoteQuery 위에
  얹는다.

## 11. 구현 단계 제안

1. **속성 엔진 (core)**: `PropValue`/IndexRecord props/Mutation `set_props`/
   NoteQuery/속성 텍스트 색인 + 재색인 마이그레이션 + CLI 노출.
2. **스키마·템플릿**: SCHEMA.toml 파싀·검증, 캡처 속성 스탬프, 지식 프리셋,
   속성 패널(자유 모드 → 타입 편집기 순서).
3. **Knowledge UX**: 상태 배지, 속성 필터 칩바, 정렬, 복습 대기열, 전이
   규칙 실행기, aliases/related 링크 통합, 그래프 상태 색.

각 단계가 끝나면 독립적으로 출시 가능하다(1단계만으로도 CLI 쿼리
`oximemo list --where status=stub` 수준이 동작).

## 12. 미결정 사항 (구현 계획 수립 전 확정 필요)

1. NoteQuery의 CLI 문법 형태 (`--where key=value` vs 서브커맨드).
2. 속성 필터 칩바와 기존 태그 필터의 관계(병치 vs 통합).
3. 복습 대기열의 위치 — 폴더 화면 탭 vs 사이드바 섹션.
4. `status_changed` 스탬프를 전이 외 편집에서도 갱신할지.
5. knowledge 프리셋이 제공할 도메인 코드표의 기본값(원 설계 7+3개 전부 vs
   최소 셋).
