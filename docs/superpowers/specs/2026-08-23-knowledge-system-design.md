# 지식 관리 시스템 통합 설계 (Knowledge State Management)

- 날짜: 2026-08-23
- 개정: v3 (최종 결정 — 미결정 사항 없음)
- 상태: 확정 — 구현 계획(writing-plans) 대기
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

## 2. 핵심 결정사항

1. **퍼스트파티 UX + 표준 파일.** oximemo는 지식 관리 UI를 퍼스트파티(내장,
   일급) 기능으로 제공한다. 저장되는 파일은 앱 비종속적인 YAML 프론트매터 +
   마크다운 그대로다. 다른 앱(Obsidian, VS Code, `grep`)에서는 평범한 마크다운
   노트로 읽히고 편집된다.
2. **일반 구조로 소화.** 지식 노트를 특별 취급하지 않는다. 코어는 범용
   **속성(properties) 엔진**을 갖고, 지식 관리는 "폴더 템플릿 + 스키마"라는
   일반 메커니즘 위에 올라간 구성(configuration)이다. 프론트엔드도 지식 전용
   분기를 두지 않는다 — 모든 지식 UI는 스키마 선언(`badge`, `[review]`)에
   반응하는 일반 규칙이다(§7).
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
- **`[workspace] kind = "knowledge"` 마커로 지식 화면 식별**(리뷰 제안): 앱이
  특정 kind 문자열을 아는 순간 결정 2의 예외가 된다. 대신 기능 선언
  (`badge = true`, `[review]` 블록)이 UI 존재를 결정한다 — 예외 0. 기각.
- **사이드바에 "지식" 전용 섹션 추가**: 사이드바는 Finder 모델(즐겨찾기·위치·
  데일리·최근·태그)로 확정돼 있고, 지식 섹션은 결정 2의 예외로 보인다. 대신
  폴더 화면 탭 + ⌘K 커맨드로 제공(§7.3). 기각.

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
source: 3Blue1Brown 영상
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
- **코어 `created`/`updated`는 RFC3339 타임스탬프**이고 지식 설계가 날짜로 쓰던
  의미(등록일/전이일)는 `date` 타입 속성(`status_changed` 등)이 담는다. 둘은
  공존하며 Obsidian Dataview에서도 타임스탬프 비교가 정상 동작한다.
- `related`는 코어에 특수 의미가 없고 값의 `[[..]]` 패턴에만 반응한다.
  **`aliases`는 예외적으로 코어가 예약하는 관례 키다**(Obsidian 호환):
  링크 해석(title_map)과 검색 색인에 쓰인다(§5.3).

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
속성 엔진 (oximemo-core/src/props.rs — 범용, 스키마를 모른다)
    │  - props 스냅샷 인덱싱 (redb IndexRecord 확장)
    │  - 속성 조건 쿼리 (NoteQuery)
    │  - 속성 Mutation (write_document set_props)
    ▼
폴더 스키마 (oximemo-core/src/schema.rs — UX를 모른다)
    │  TEMPLATE.md 초깃값 + SCHEMA.toml 규칙·전이·리뷰 선언
    ▼
퍼스트파티 Knowledge UX (frontend — 스키마 선언에만 반응)
    속성 패널 · 배지 · 속성 칩바 · 정렬 · 복습 대기열
```

- 지식 관리는 이 스택의 한 가지 사용례다. 같은 구조로 다른 속성 체계(책
  목록, 프로젝트 로그 등)도 폴더 스키마로 구성할 수 있다.
- 층 경계: 속성 엔진은 스키마를 모르고, 스키마는 UX를 모른다. 각 층은
  독립적으로 테스트된다(§11).
- CLI/GUI 패리티 원칙 유지: 속성 조회·수정·쿼리는 Tauri 커맨드와 CLI 양쪽에
  동일하게 노출한다(§5.4).

## 5. 속성 엔진 (oximemo-core)

### 5.1 데이터 모델

- `PropValue = Str(String) | Bool(bool) | List(Vec<String>)`. `number`는 v1에
  없다 — 수치 정렬이 필요해지면 `PropValue::Num`과 함께 도입한다.
- `IndexRecord`에 `props: BTreeMap<String, PropValue>` 추가(core 5키 제외한
  1차원 값 전부). `#[serde(default)]`를 붙여 옛 레코드 역직렬화가 깨지지 않게
  한다. `INDEX_FORMAT_VERSION`(현재 3 → 4) bump가 재색인을 트리거한다
  (`vault.rs`의 index-fmt 마커 경로).
- **DTO 전파 필수**: `MemoSummary`, `NoteDto`, 그리고 프론트엔드
  `types.ts`의 대응 타입에 `props`를 추가한다. 카드 배지·칩바가 목록 응답만으로
  그려져야 하므로 여기서 끊기면 UI가 매 카드마다 파일을 읽게 된다.
- `Mutation`(oxi-frontmatter)에 `set_props: IndexMap<String, Option<Value>>`
  추가 — `Some(v)` 설정, `None` 삭제. 알 수 없는 키 re-emit 보존은 그대로.
- **NoOp 계약**: `write_document`의 NoOp 판정은 의미 비교이므로 같은 값을
  다시 쓰면 파일을 건드리지 않는다(자동저장 반복 안전). 값이 실제로 달라지면
  `Written`이 되고 코어 `updated`가 bump된다 — 의도된 동작이다.
- **해시 계약 변경 (필수)**: 현재 `hash_memo(body, favorite)`는 속성을 보지
  않으므로 속성만 바뀐 노트가 sync 매니페스트의 해시 비교에서 누락된다
  (`hash.rs`, `sync.rs`, `export_manifest`). `hash_memo`에 정규화된 속성
  테이블을 포함시킨다. 대가는 일회성 전체 해시 변경이며, 재색인 1회 +
  에이전트 소비자의 1회 재수신으로 끝난다. §9에 마이그레이션 노트로 명시한다.

### 5.2 쿼리

- 신규 `NoteQuery`: `filter: MemoFilter` + `props: Vec<PropPredicate>` +
  `sort: SortSpec`(`UpdatedDesc` 기본 / `UpdatedAsc` / `PropAsc(key)`).
  `PropDesc`는 사용 사례가 생길 때 추가한다.
- `PropPredicate`: `key`, `op: Eq | In(values) | Contains(리스트 값 포함)`,
  `value`.
- 구현: 인덱스만 읽어(`export_since(None)`, 파일 I/O 없음) in-memory 필터+정렬.
  기존 `list_memos`의 커서 페이지네이션 경로는 손대지 않는다.
- **페이지네이션 결정**: `by_sort` 키는 `(updated_at, id)` 내림차순만 인코딩하므로
  속성 정렬은 커서와 양립하지 않는다. `NoteQuery`는 **오프셋 페이지네이션**
  (`offset`/`limit` + `total`)을 쓰고, 프론트엔드는 속성 정렬 뷰에서만 이 경로를
  사용한다. 기본 브라우징(최신순 무한 스크롤)은 기존 커서 경로를 그대로 쓴다.
  두 경로를 섞지 않는 것이 이 결정의 핵심이다.
- 검색 색인은 v1에서 **`aliases` 값만** tantivy에 추가한다(전체 속성 조인
  색인은 일반 검색을 오염시키므로 필요성이 확인된 뒤에). tantivy 스키마 변경은
  `INDEX_FORMAT_VERSION`과 별개로 감지되지 않으므로 **검색 인덱스 버전 마커를
  두고 불일치 시 디렉터리를 폐기·재구축**한다.

### 5.3 링크 통합

- **링크 스캔 범위 확장**: 현재 `link_scan_body`(본문 + HTML 주석 제거)만 보는
  지점 3곳 — 그래프(`graph_data`), 백링크(`get_backlinks`), 리네임 전파 — 을
  `본문 + 1차원 속성 값`으로 확장한다(`link_scan_view`). 스텁의 `related`가
  그래프 엣지와 상대 노트의 백링크로 잡힌다.
- **리네임 전파의 쓰기 측도 확장**: 노트 제목이 바뀌면 다른 노트의 **속성 값
  안 `[[..]]`도** 다시 써야 한다. 본문만 고치면 `related`가 조용히 끊긴다.
  `replace_link_target`을 속성 값에도 적용하고 `set_props`로 반영한다.
- **aliases 해석**: title_map에 H1과 `aliases` 값을 등록한다. 우선순위는
  **H1 > aliases**, 노트 간 충돌 시 `created`가 오래된 노트가 우선(결정적
  순서). 새 노트·aliases가 기존 H1/aliases와 충돌하면 속성 패널과 캡처에서
  경고한다(원 설계 "1개념=1파일" 이행 검사).

### 5.4 CLI 표면 (확정)

기존 `list`를 확장한다. 새 서브커맨드를 만들지 않는다 — `list`는 이미
`--limit/--tag/--folder/--favorites/--format`을 갖고 있고, 에이전트가 쓰는
JSON/NDJSON 출력도 그대로 재사용된다.

```bash
oximemo list --where status=understood --sort status_changed --limit 20
oximemo list --where domain=TECH,MATH          # 콤마 = In (OR)
oximemo list --where subdomain~AI              # ~ = Contains (리스트 멤버십)
oximemo list --where status=stub --offset 40   # 오프셋 페이지네이션
```

- `--where KEY=VAL` (반복 가능, 반복 시 AND), `~`는 Contains, 값의 콤마는 In.
- `--sort KEY` (오름차순), `--sort updated` / `--sort updated:desc`로 코어 키도
  지정 가능. 미지정 시 현행 최신순.
- `--offset N`은 `--sort`가 속성 키일 때의 페이지네이션 수단.
- `--where`/`--sort`가 없으면 기존 커서 경로를 그대로 타므로 성능 회귀가 없다.

## 6. 폴더 스키마 — TEMPLATE.md + SCHEMA.toml

### 6.1 TEMPLATE.md (초깃값)

- **동작 변경**: 현재 `load_template`은 템플릿의 프론트매터를 제거하고 본문만
  반환한다. 이를 `(Table, body)` 반환으로 바꿔 프론트매터를 **속성 초깃값으로
  해석**한다.
- `create_note`는 본문이 비어 있을 때만 템플릿을 호출하므로, 본문이 있는
  캡처에도 속성 초깃값이 병합되도록 분기를 추가한다(본문은 캡처 텍스트 사용).
- 기존에 TEMPLATE.md에 프론트매터를 넣어 두고 "무시된다"고 가정한 볼트에는
  동작 변경이다 — §9 마이그레이션 노트에 명시한다.

### 6.2 SCHEMA.toml (규칙 선언 — 신규)

폴더 단위 파일. `.toml`은 노트 확장자(`is_note_ext`)와 watcher 필터에서 이미
제외되므로 **스캔 제외 작업은 불필요**하다. `paths.rs`에 `SCHEMA_NAME` 상수만
추가한다(하드코딩 산재 방지).

```toml
# knowledge 폴더의 SCHEMA.toml 예시
[workspace]
name = "지식"                 # 표시명 (선택)

[properties.status]
type = "select"               # text | select | multiselect | date
options = ["stub", "vague", "understood", "mastered", "decayed"]
required = true
badge = true                  # 카드·목록·그래프에 값 배지를 노출
[properties.status.colors]    # 값 → 디자인 토큰 (미지정 값은 선언 순서 팔레트)
stub = "neutral"
vague = "muted"
understood = "info"
mastered = "success"
decayed = "warning"

[properties.peak_status]
type = "select"
options = ["understood", "mastered"]

[properties.domain]
type = "select"
# 원 설계의 필수 7개. 선택 후보(PHIL/LANG/LIFE)는 아래 줄을 살려 쓴다.
options = ["SCI", "MATH", "TECH", "SOC", "CULT", "HIST", "FIN"]
# options = ["SCI", "MATH", "TECH", "SOC", "CULT", "HIST", "FIN", "PHIL", "LANG", "LIFE"]
required = true

[properties.subdomain]
type = "multiselect"          # 옵션 미지정 = 자유 값 허용

[properties.aliases]
type = "multiselect"

[properties.related]
type = "multiselect"

[properties.source]
type = "text"

[properties.status_changed]
type = "date"

# 전이 규칙. 기본 발화 조건은 on = "change"(값이 실제로 바뀔 때).
# 여러 규칙이 매칭되면 선언 순서대로 적용한다.
[[transitions]]
key = "status"
to = ["understood", "mastered"]
copy_from = "status"          # 전이 후의 status 값을
into = "peak_status"          # peak_status에 기록하되
merge = "max"                 # 기존 값보다 상위일 때만 (options 선언 순서 = 서열)

[[transitions]]
key = "status"
to = ["stub", "vague", "understood", "mastered", "decayed"]
on = "write"                  # 값이 안 바뀐 재확인 저장에도 발화
stamp_date = "status_changed"

# 복습 대기열 선언. 이 블록이 있는 폴더에만 대기열 UI가 나타난다.
[review]
property = "status"
due_values = ["understood", "mastered"]
order_by = "status_changed"   # 없거나 비면 코어 updated로 폴백
decay_to = "decayed"          # "막힘" 액션이 설정할 값
```

- **`peak_status` 시맨틱**: 직전 상태 스냅샷이 아니라 **역사상 최고 상태**다.
  `understood`/`mastered` 진입 시 `merge = "max"`로 갱신하므로, 붕괴→재학습→재붕괴
  사이클에서도 최고점이 덮어써지지 않는다. 서열은 대상 속성의 `options` 선언
  순서를 쓴다.
- **검증 강도 (확정)**: 경고 수준이며 저장을 막지 않는다. 표시 위치는
  **속성 패널 인라인 한정** — 카드·목록에는 위반 표시를 넣지 않는다(캡처 속도와
  시각 노이즈 보호, 위반은 편집 시점의 관심사). 볼트 전체 점검은 `doctor`가
  담당한다: `DoctorReport`에 `schema_violations: [(path, reason)]`를 추가한다
  (기존 `corrupt_frontmatter`와 같은 형태). **`--fix` 대상은 아니다** — 스키마
  위반은 사용자의 의도적 상태일 수 있으므로 자동 수정하지 않는다.
- 전이 규칙은 앱 UI 경로에서만 적용된다. 외부 편집기로 status를 바꾸면
  `status_changed`가 갱신되지 않지만, `[review] order_by`가 비면 코어
  `updated`로 폴백하므로 대기열 순서가 조용히 깨지지 않는다.
- **리로드 시점**: SCHEMA.toml은 watcher 대상이 아니므로 조회 시 mtime 확인
  후 캐시 무효화(온디맨드)한다.
- SCHEMA.toml이 없는 폴더는 "자유 속성" 모드 — 속성 패널이 키/값 텍스트
  편집기로 동작한다.

### 6.3 지식 프리셋

폴더 생성 UI의 내장 프리셋 "지식 관리". 선택하면 `TEMPLATE.md`(H1 플레이스홀더
+ 속성 초깃값 `status: stub`)와 위 `SCHEMA.toml`(+ TECH subdomain 코드표
`[SW, AI, DATA, SEC, HW, SYS]`)을 깔아준다. 파일 2개일 뿐이라 사용자가 자유롭게
고쳐 쓸 수 있다.

## 7. 프론트엔드

모든 항목은 스키마 선언에 반응하는 일반 규칙이다. 지식 전용 조건 분기는 없다.

### 7.1 속성 패널

- 위치: MemoDetail/에디터 제목 아래. 속성 0개면 "＋ 속성" 버튼만.
- 스키마 있음: 타입별 편집기(select 드롭다운 / multiselect 칩 + 자유값 /
  date 달력 / text). 필수 누락·허용값 위반을 필드 옆에 인라인 표시.
- 스키마 없음: 키/값 행 편집(스칼라·리스트 구분).
- 변경은 자동저장으로 `set_props`에 반영. **충돌 정책**: 외부 편집으로
  watcher 재색인이 오면 편집 중이 아닌 필드는 새 값으로 갱신하고, 사용자가
  수정 중인 필드는 유지한 뒤 "외부에서 변경됨" 표시를 띄운다(마지막 쓰기 승리).

### 7.2 배지·필터·정렬

- **배지**: `badge = true`인 select 속성의 값을 카드·리스트·타임라인·그래프
  노드에 표시한다. 색은 `[properties.<key>.colors]` 매핑, 미지정 값은 옵션
  선언 순서 팔레트. 값 이름(`stub` 등)에 대한 하드코딩은 없다.
- **속성 칩바 (확정)**: 기존 태그 칩과 **병치**한다 — 통합하지 않는다. 태그는
  본문에서 파생되는 자유 형식이고 볼트 전역이며, 속성은 스키마에 묶이고 폴더
  범위다. 한 줄에 섞으면 칩이 왜 존재하는지 알 수 없고, 태그 `#TECH`와
  `domain: TECH`처럼 이름이 겹칠 때 구분이 불가능해진다. 속성 칩은
  `속성명: 값` 형태로 속성별 그룹을 이루어 폴더 칩바 슬롯에 렌더링한다.
- **정렬**: 최신순(기본, 커서 경로) / 오래된순 / 임의 date·select 속성
  오름차순(오프셋 경로, §5.2).

### 7.3 복습 대기열 (진입점 확정)

`[review]` 블록이 선언된 폴더에서 **폴더 화면 상단 탭**으로 진입한다. 사이드바에
전용 섹션을 만들지 않는다(§2 기각 목록). 여러 폴더에 걸친 통합 목록은 **⌘K
팔레트 커맨드**로 제공한다 — `PaletteCommand` 카탈로그는 이미 앱 상태에서
조건부로 생성되므로(폴더·태그 커맨드와 동일 방식), `[review]`를 선언한 폴더가
하나도 없으면 커맨드 자체가 나타나지 않는다.

- 목록: `property ∈ due_values`를 `order_by` 오름차순(폴백: 코어 `updated`).
- 상태별 분포 요약 카운트 칩.
- 항목 액션 2개:
  - **"설명 가능함"** — 같은 값 재설정(reassert) 저장. `on = "write"` 규칙이
    발화해 `order_by` 날짜만 갱신된다.
  - **"막힘"** — `decay_to` 값으로 전이. `merge = "max"` 규칙이
    `peak_status`를 보존한 채 기록한다.
- 폴더 탭은 그 폴더 범위, 팔레트 진입점은 `[review]` 선언 폴더 전체 통합.

### 7.4 캡처 통합

- 대상 폴더의 템플릿 속성이 스탬프된다(§6.1) — 폴더 일반 규칙.
- **H1 승격**: 캡처 텍스트의 첫 줄을 H1으로 올리고 나머지는 본문으로 내린다.
  결정 5(스텁도 H1)가 캡처 경로에서 항상 지켜진다.
- ⌘K 팔레트의 "새 노트"도 동일 경로.

### 7.5 브라우저 폴백

`tauri.ts`의 localStorage 폴백은 속성 저장·조회까지만 최소 구현하고(list /
create / update), 복습 대기열·전이 규칙·그래프 통합은 데스크톱 전용 표면으로
명시한다(기존 백링크와 동일한 경계).

## 8. 기존 갭 → 해소 매핑

| 갭 | 해소 |
|---|---|
| 스텁이 존재할 수 없는 구조 | H1 규칙(결정 5) + 캡처 H1 승격(§7.4) |
| 프론트매터 related 링크 미인식 | 링크 스캔·리네임 전파 확장(§5.3) |
| 상태 쿼리·정렬 불가 | props 인덱싱 + NoteQuery 오프셋 경로(§5.2) |
| 앱 내 상태 변경 불가 | 속성 패널 + `set_props`(§5.1, §7.1) |
| aliases 미해석 | title_map·검색 통합 + 충돌 규칙(§5.3) |
| updated 시맨틱 충돌 | `status_changed` 속성 + `order_by` 폴백(§3, §6.2) |
| 속성 변경이 sync에서 누락 | `hash_memo`에 속성 포함(§5.1) |

## 9. 호환성·마이그레이션

일회성 마이그레이션 3건이 함께 일어난다:

1. **인덱스**: `INDEX_FORMAT_VERSION` 3 → 4. 기존 마커 불일치 시 자동 재색인.
   `IndexRecord.props`는 `#[serde(default)]`로 하위호환.
2. **검색 인덱스**: tantivy 스키마에 `aliases` 필드 추가 → 검색 인덱스 버전
   마커 불일치 시 디렉터리 폐기·재구축.
3. **해시**: `hash_memo`가 속성을 포함하므로 전 노트 해시가 한 번 바뀐다.
   에이전트 소비자는 1회 전체 재수신 후 정상화된다. 릴리스 노트에 명시.

그 외:

- 기존 노트는 속성이 없으면 `props` 빈 맵으로 그대로 동작한다.
- **템플릿 동작 변경**: TEMPLATE.md 프론트매터가 지금까지는 제거됐으나 이제
  속성 초깃값으로 주입된다. 프론트매터를 넣어둔 기존 볼트는 새 노트에 속성이
  생긴다(기존 노트 무영향).
- 외부 도구로 만든 지식 노트도 watcher가 인덱싱한다. 전이 규칙 자동 적용만
  앱 UI 경로 한정(§6.2).

## 10. 명시적으로 범위 밖

- 복습 주기 자동화(SRS, `next_review`), 자신감 점수 분리, 그래프 시각화 고도화.
- 사용자 정의 저장 뷰(저장된 쿼리) — 필요해지면 NoteQuery 위에 얹는다.
- **대량 시딩**(여러 줄 → 스텁 여러 개 일괄 생성): 3단계 백로그. 초기 시딩은
  외부 스크립트/에디터로 파일을 만들면 watcher가 흡수한다.
- `PropValue::Num`과 수치 정렬, 전체 속성 tantivy 색인.
- 스키마 위반 자동 수정(`doctor --fix`).

## 11. 구현 단계와 테스트 의무

**코드 배치** (vault.rs는 이미 4114줄 — 신규 로직을 넣지 않는다):

- `crates/oximemo-core/src/props.rs` — `PropValue`, `NoteQuery`,
  `PropPredicate`, 인덱스 스냅샷 변환.
- `crates/oximemo-core/src/schema.rs` — SCHEMA.toml 파싱·검증·전이 실행기.
- `vault.rs`는 디스패치만 추가한다.

**1단계 — 속성 엔진**: props.rs, `IndexRecord.props` + DTO 전파, `set_props`,
`hash_memo` 확장, NoteQuery 오프셋 경로, aliases 검색 필드, 인덱스·검색
마이그레이션, CLI `--where/--sort/--offset`(§5.4).
테스트: `set_props` round-trip에서 미지 키·flow 정규화 보존, 같은 값 재설정이
NoOp, 속성 변경이 해시·`updated`를 바꿈, props 스냅샷↔파일 동기화,
`--where` 파싱(Eq/In/Contains).

**2단계 — 스키마·템플릿**: schema.rs, `load_template` 시그니처 변경, 캡처
스탬프, 지식 프리셋, 속성 패널(자유 모드 → 타입 편집기), `doctor`
`schema_violations`.
테스트: 검증 경고 산출, 전이 멱등성, `merge = "max"` 보존, `on = "write"`
발화, 규칙 다중 매칭 순서, mtime 리로드.

**3단계 — Knowledge UX**: 배지, 속성 칩바, 정렬, 복습 대기열과 두 액션 + 팔레트
커맨드, 링크 스캔·리네임 전파 확장, 그래프 배지 색, i18n 키(ko/en 동시),
Tauri IPC 등록.
테스트: 대기열 정렬과 폴백, 재확인 액션이 날짜만 갱신, `related` 링크가
백링크·그래프에 등장, 리네임이 속성 링크까지 갱신.

각 단계는 독립 출시 가능하다(1단계만으로 CLI 속성 쿼리가 동작).

## 12. 최종 결정 (v2 미결정 사항 마감)

| 항목 | 결정 | 근거 |
|---|---|---|
| CLI 문법 | `list --where KEY=VAL --sort KEY --offset N` 확장, 새 서브커맨드 없음 | 기존 `list` 플래그·출력 포맷 재사용, 에이전트 패리티(§5.4) |
| 속성 칩바 vs 태그 필터 | 병치. 속성 칩은 `속성명: 값` 그룹 | 태그(본문 파생·전역)와 속성(스키마·폴더 범위)은 출처가 달라 통합 시 이름 충돌 구분 불가(§7.2) |
| 위반 표시 강도 | 속성 패널 인라인만. 카드 표시 없음. `doctor`에 `schema_violations` 추가, `--fix` 제외 | 캡처 속도·시각 노이즈 보호, 볼트 전체 점검은 doctor의 기존 역할(§6.2) |
| 도메인 코드표 기본값 | 필수 7개(SCI/MATH/TECH/SOC/CULT/HIST/FIN). 선택 3개는 주석 처리 | 원 설계가 3개를 "필요 없으면 빼도 됨"으로 분류, select 목록은 짧을수록 빠름(§6.2) |
| 복습 대기열 진입점 | 폴더 화면 상단 탭 + ⌘K 팔레트 통합 커맨드. 사이드바 섹션 없음 | 사이드바 Finder 모델 보존, 팔레트 카탈로그는 이미 조건부 생성(§7.3) |

미결정 사항 없음. 구현 계획 수립 가능.

## 13. 리뷰 반영 기록

**v1 → v2 (수용 — 설계 리뷰):**

- `peak_status`가 직전 스냅샷이라 붕괴 사이클에서 역사가 소실됨 → `merge = "max"`
  + 진입 시 기록으로 "역사상 최고" 시맨틱 명시(§6.2).
- 복습 "설명 가능함" 액션이 전이 발화 조건상 동작 불가 → `on = "write"` 도입.
- 배지·정렬·대기열이 `status`/프리셋 폴더에 하드코딩 의존 → `badge`,
  `[properties.*.colors]`, `[review]` 선언 기반으로 일반화. 리뷰가 제안한
  `kind = "knowledge"` 마커는 그 자체가 예외이므로 기능 선언으로 대체.
- §3 aliases 자기모순·참조 오타 → aliases를 "코어 예약 관례 키"로 명시.
- 템플릿 프론트매터 strip 동작 변경 미기재 → §6.1·§9에 명시.
- `number` 타입과 `PropValue` 불일치 → v1에서 `number` 제거.
- aliases 충돌 해석 규칙·중복 개념 경고 부재 → H1 > aliases, created 우선, 경고.
- 코드 배치·층별 테스트 의무 부재 → props.rs/schema.rs 분리 + 단계별 테스트 의무.
- YAGNI(PropDesc, 전체 속성 tantivy 색인) → v1 축소.
- 전이 다중 매칭 순서·no-op 저장 → 선언 순서, `on` 기본값 `change`.
- 캡처 H1 승격 규칙 부재 → 첫 줄 승격(§7.4), 대량 시딩은 범위 밖(§10).

**v1 → v2 (수용 — 코드 대조):**

- `hash_memo`가 속성을 제외해 sync 누락 → 해시에 속성 포함 + 마이그레이션.
- `MemoSummary`/`NoteDto`/`types.ts`에 props 전파 누락 → 명시.
- 속성 정렬이 커서 페이지네이션(`by_sort`)과 충돌 → 오프셋 경로 분리.
- tantivy 스키마 변경이 `INDEX_FORMAT_VERSION`으로 감지되지 않음 → 검색 인덱스
  버전 마커.
- `load_template`이 본문만 반환, `create_note`가 비-blank 본문에 템플릿 미호출 →
  시그니처·분기 변경.
- 리네임 전파가 본문만 재작성 → 속성 값 링크도 재작성.
- i18n 키·Tauri IPC 등록·브라우저 폴백 범위 → 3단계 작업 항목으로 명시.

**기각:**

- "`write_document` NoOp이 `set_props`에서 항상 Written이 되는 것은 BLOCKER" →
  값이 바뀌면 쓰는 것이 정상이고, 같은 값 재설정은 의미 비교로 NoOp이 유지된다.
  결함이 아니라 계약이므로 §5.1에 명문화만 했다.
- "SCHEMA.toml을 노트 스캔 제외 목록에 추가해야 한다"(v1 자체 주장) → `.toml`은
  `is_note_ext`/watcher 필터에서 이미 제외된다. v1의 사실 오류를 삭제하고
  `SCHEMA_NAME` 상수 추가로 축소.

**v2 → v3:** §12의 미결정 5건을 모두 결정하고 §5.4(CLI 표면)를 신설했다.
