# 코파일럿 스키마 인지 — 자기서술적 vault

- 날짜: 2026-08-24
- 상태: 시행 (사용자 위임 — 자율 진행)
- 선행 문서: `2026-08-23-copilot-panel-design.md`, `2026-08-24-copilot-composer-ux-design.md`
- 트리거: "코파일럿에 지식을 몇 개 생성해달라 하거나 영화를 해달라 할 때, 코파일럿이 우리의 각각의 스키마도 이해하고 동작도 이해해서 다 수행할 수 있는 시스템이야? 아니라면 설계해보고 구현해."

## 0. 현재 상태 판정 — 아니다

위임된 에이전트가 턴당 받는 것은 `vault_root`/`cli`/`skill` 경로 + `active_memo` + `referenced_memos`뿐이다. 에이전트는:

1. **폴더를 열거할 수 없다.** CLI에 `folders` 커맨드가 없다. `ls`로 우회해야 한다.
2. **스키마를 읽을 수 없다.** CLI에 `schema` 커맨드가 없다. SCHEMA.toml의 존재·경로·의미(프로퍼티, 허용값, 전이, 리뷰 큐)를 스스로 발굴해야 한다. knowledge의 `status`/`domain` 규칙, movie의 `director`/`release_date`/`runtime_min` 매핑을 알 방법이 없다.
3. **컬렉션 설치를 못 한다.** `install_collection`은 desktop IPC 전용이다. "영화 컬렉션 만들어줄게 아니라 설치해줘"가 불가능하다.
4. **메타데이터 그라운딩이 없다.** provider 검색·스탬프는 GUI 전용 IPC다. 에이전트는 감으로 영화 정보를 채운다.
5. **생성이 2단계다.** `new`는 프로퍼티를 못 설정한다. 스키마 유효한 노트는 `new` → `update --set` 조합이 필요한데 이조차 스키마를 모르면 불가능하다.

즉 "지식 3개 생성해줘"는 루트에 스키마 없는 평범 노트를 만들고, "인터스텔라 등록해줘"는 movie 스키마와 무관한 노트를 만든다.

## 1. 원칙 — 계약면은 CLI다

README: "human/agent parity — every operation the GUI can do, the CLI can do." GUI는 폴더·스키마·컬렉션·메타데이터 뷰를 갖는데 CLI는 갖지 않는다 — **패리티 결함이 곧 코파일럿 결함**이다. 따라서 해법은 코파일럿 특수 경로가 아니라:

1. **vault를 CLI로 자기서술化** — 폴더·스키마·컬렉션·메타데이터의 열거/조회/실행을 CLI에 추가. 모든 외부 에이전트(oxios, omp, 터미널의 인간)가 동일하게受益.
2. **컨텍스트 블록에 구조 지도만** — §7 규율(사실만, vault 주입 금지) 유지. 전체 스키마를 주입하지 않고 폴더 목록(프리셋 마커 포함) 팩트만 주고, 상세는 `oximemo schema <folder>`로 가져가게 한다.
3. **SKILL.md가 행동 계약** — oximemo 앱 코드는 여전히 지시문을 저술하지 않는다(수용 기준 3 유지). 스키마 인지 워크플로는 SKILL.md에 문서화된 배포 계약으로 전달.

## 2. 설계

### 2.1 core — `Vault::folder_inventory()`

`list_folders()`는 이미 물리 디렉토리(빈 컬렉션 폴더 포함)를 반환한다. 여기에 스키마 사실을 얹은 조회 전용 인벤토리를 추가한다:

```rust
pub struct FolderInfo {
    pub path: String,          // vault 상대 경로, "" = 루트 미포함
    pub notes: u32,            // 그 폴더 직속 노트 수
    pub preset: Option<String>,   // [meta] preset 마커
    pub workspace: Option<String>, // [workspace] name
    pub has_schema: bool,
    pub has_template: bool,
}
```

`folder_schema()`(mtime 캐시)를 재사용하므로 호출 비용은 기존 그리드와 동급. desktop 컨텍스트 블록과 CLI `folders`가 같은 진실을 공유한다.

### 2.2 CLI — 자기서술 커맨드

```
oximemo folders [--format table|json|ndjson]
  # 모든 물리 폴더 + 노트 수 + 프리셋/워크스페이스 마커 + 데일리 폴더 표식

oximemo schema [FOLDER] [--format json]     # FOLDER 생략 = 루트
  # { folder, preset, workspace, schema: FolderSchema|null, template: TEMPLATE.md|null }
  # 스키마 없는 폴더도 exit 0 + schema:null (free-property 모드 사실)

oximemo collection list                      # 설치 가능 프리셋 카탈로그
oximemo collection install <PRESET> <FOLDER> # skip-if-exists, IPC와 동일 위임

oximemo new ... --set KEY=VAL                # 템플릿 스탬핑 후 프로퍼티 적용
  # update와 동일 파싱(콤마=리스트). 전이·검증은 set_props 경로 그대로.

oximemo metadata search <QUERY> --domain book|movie [--format ndjson|json]
  # [metadata] 설정(enabled·키) 게이트 → provider fan-out → MetaHit NDJSON

oximemo stamp <ID> --hit-stdin               # MetaHit JSON을 노트에 스탬프
  # core stamp_targets + 빈 프로퍼티만 채움 + source_url/cover_url 규칙 — IPC와 동일 계약
```

`new --set`의 전이 동작이 핵심이다: knowledge 폴더에서 `--set status=understood`는 `peak_status`/`status_changed` 스탬핑까지 GUI와 동일하게 일어난다("동작도 이해"의 실체).

### 2.3 metadata 공유 크레이트 — `oximemo-metadata`

프로바이더 어댑터(~1,100줄, src-tauri/metadata.rs)를 `crates/oximemo-metadata`로 추출한다:

- **동기 ureq + rustls** — CLI에 tokio를 끌어들이지 않는다(이 저장소 CLI는 이미 upgrade에 ureq를 쓴다). 단일 HTTP 구현, 양단 공유.
- **core는 network-free 유지** — 어댑터 크레이트는 core의 타입(MetaHit/MetaField/ProviderInfo/MetadataConfig)만 소비한다.
- desktop은 `metadata.rs`가 얇은 shim이 되고 IPC 핸들러는 `spawn_blocking`으로 감싼다. reqwest 의존은 desktop에서 제거된다.
- CLI의 `metadata search`는 vault config(`[metadata]`)에서 키·enabled를 읽어 GUI와 동일 게이트로 fan-out한다. 비활성 시 빈 목록(GUI 동일).

### 2.4 컨텍스트 블록 — 구조 지도 팩트

`build_context`가 `folders:` 섹션을 얻는다(상한 64폴더, 초과분은 `oximemo folders` 포인터):

```yaml
daily_folder: daily
folders:
  - path: knowledge
    notes: 12
    preset: knowledge
    workspace: 지식
  - path: 영화
    notes: 3
    preset: movie
    workspace: 영화
```

- 전체 스키마는 주입하지 않는다(§7: 필요한 만큼 `oximemo schema`로).
- `path`/`workspace`는 `single_line()` 통과(스키마 파일은 사용자 편집 가능 — 주입 불가 원칙 유지).
- `notes`는 직속 수가 아니어도 무방하나 inventory의 직속 수를 그대로 쓴다(사실 그 자체).

### 2.5 SKILL.md — 배포 계약 갱신

새 절: "Folders & schemas"(`folders`/`schema`, SCHEMA.toml이 선언하는 것, free-property 폴더), "Collections"(설치), "Metadata grounding"(search/stamp, 매핑 규칙 — 평점은 절대 매핑 안 됨). 레시피 갱신: "영화 추가"(folders → schema movies → metadata search → new --set/stamp), "지식 노트 생성". description 트리거에 컬렉션·스키마 어휘 추가.

## 3. 거절한 대안

| 대안 | 거절 이유 |
|---|---|
| 컨텍스트 블록에 전체 스키마 주입 | §7 위반(vault 주입 금지). 폴더 수에 비례해 턴 비용 증가. |
| 코파일럿 전용 툴콜 브리지 | §2 비목표 위반(앱 내 툴콜링 루프 금지). 위임 에이전트는 이미 셸을 가진 완전한 에이전트다. |
| desktop IPC를 CLI가 호출 | CLI는 독립 실행이 계약(에이전트 환경에 앱이 없을 수 있다). |
| CLI에 reqwest+tokio | CLI 무겁워짐. ureq 동기 단일 구현이 양단에 더 깨끗. |
| 메타데이터 CLI 제외(에이전트 LLM 지식으로 채우기) | "다 수행"의 반감. 희귀 타이틀 환각 위험. 사용자가 설정한 provider 키를 못 쓰는 것은 GUI 불평등. |

## 4. 오류 처리

- `schema` — 존재하지 않는 폴더: exit 1 + "no such folder". 스키마 없음: exit 0 + `schema: null`(정상 상태).
- `collection install` — 알 수 없는 프리셋: exit 1 + 카탈로그 ids 나열. 기존 파일: skip-if-exists(IPC 동일).
- `metadata search` — disabled: 빈 목록 exit 0(GUI 동일). provider별 실패: 조용히 스킵(IPC 동일 — 한 provider가 검색을 못 막는다).
- `stamp` — 노트 없음/파싱 실패: exit 1 + core 에러 체인.

## 5. 테스트

- **core**: `folder_inventory` — 노트 있는 폴더/빈 컬렉션 폴더/프리셋 마커/루트 제외.
- **CLI**(기존 commands.rs 단위 패턴, temp vault): folders json shape, schema null/json, collection install round-trip, `new --set` 전이 스탬핑(knowledge status 전이로 peak_status 검증), stamp 빈 프로퍼티만 채움.
- **metadata 크레이트**: 기존 정규화 테스트(캔드 페이로드, 네트워크 없음) 이관 + enabled_providers 게이트 테스트.
- **desktop**: `build_context` 폴더 팩트 직렬화 + 단일줄 소독 + 상한. `real_omp_turn` ignored 테스트로 실측(§6 검증).
- **스모크**: temp vault에 컬렉션 설치 → 스키마 덤프 → `new --set` → `folders` → `schema` 실명령 확인.

## 6. 수용 기준

1. "지식 3개 만들어줘" 턴이 `kind: knowledge`/`status: stub`/`domain` 스키마 유효 노트를 knowledge 폴더에 생성한다(실측: omp 턴).
2. "영화 인터스텔라 등록해줘" 턴이 movie 컬렉션(미설치 시 `collection install movie 영화` 포함)에 director/release_date/runtime_min이 채워진 노트를 만든다.
3. CLI만으로(앱 무실행) 폴더 열거→스키마 조회→생성→전이→메타데이터 검색→스탬프가 성립한다.
4. 앱 코드에 모델 향한 지시문 추가 없음(수용 기준 3 of 선행 스펙 유지).
5. core는 network-free 유지(metadata 크레이트 분리).
6. 기존 전 기능 회귀 없음(cargo test 전체 + 프런트엔드 빌드).
