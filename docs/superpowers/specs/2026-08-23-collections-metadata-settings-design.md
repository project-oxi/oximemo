# 컬렉션 라이브러리 · 메타데이터 프로바이더 · 설정 창 재설계

- 날짜: 2026-08-23
- 상태: 구현 완료 (2026-08-23, 리뷰 패스 02b2d55 + §3.5 후속 실장) — §3.5 채우기 UX·어댑터 HTTP(OL/Google/알라딘/TMDB/OMDb)·Intl 지역 자동 추정 완료. 남은 후속: NDL/DNB(XML 파싱), KMDB(승인 후 어댑터).
- 선행 문서: `2026-08-23-knowledge-system-design.md`, `2026-08-23-daily-notes-design.md`
- 트리거: "데일리, 지식 말고 다른 기본 폴더로 제공되면 좋을 것" 논의 → 설정 창 구조 문제 → 프로바이더 지역 확장 → 아이디어 컬렉션 결정까지, 한 세션 내 4단계 확정 대화의 통합 스펙.

## 1. 배경 및 범위

지식(`knowledge`) 폴더가 스키마 프리셋(SCHEMA.toml+TEMPLATE.md)으로 퍼스트파티 대우를 받는 것과 데일리 노트의 전용 UI(§ 선행 문서)에 이어, 세 가지를 한 번에 다룬다:

1. **컬렉션 라이브러리** — 책·영화·블로그·소설·아이디어를 "설치형" 프리셋으로 제공할지, 기본 탑재할지.
2. **메타데이터 프로바이더** — 책/영화 메타데이터 검색을 다국적으로 지원하되 API 키 관리 문제를 어떻게 풀지.
3. **설정 창 재설계** — 위 두 가지가 낳는 설정 항목 증가를 감당 못 하는 현재 드로어 UI를 좌측 레일 + 콘텐츠 모달로 교체.

세 주제는 서로 의존한다(레일은 설치된 컬렉션 목록이 필요, 메타데이터 패널은 새 설정 UI가 필요) — 하나의 스펙, 단계적 구현.

## 2. 컬렉션 라이브러리

### 2.1 기본 vs 설치형

기본 탑재는 **데일리 + 지식만 유지**(범용 습관/핵심 미션). 나머지(책·영화·블로그·소설·아이디어)는 **설치형 컬렉션** — 프리셋은 데이터(TOML+MD)라 한계 비용이 없으므로 카탈로그에는 전부 포함하되, 볼트에는 사용자가 설치한 것만 존재한다.

- **IPC**: `install_collection(preset_id, folder)` — 기존 사유 `apply_preset(folder, template, schema)`를 일반 노출한 것. `apply_knowledge_preset` IPC와 그 유일한 콜사이트(`CardGrid.tsx` 폴더→지식 변환)는 `installCollection("knowledge", folder)` 호출로 클린 컷오버(별칭 없음 — 데스크톱 전용 API라 안전).
- **진입점 2곳**: ⌘K "컬렉션 추가", 설정 창의 "설치된 컬렉션" 레일 그룹 하단 "+ 컬렉션 추가" — 둘 다 같은 카탈로그 피커 컴포넌트, 같은 IPC.
- **소유권**: 설치 후 폴더는 사용자 소유. 데일리/지식처럼 삭제 시 재생성되지 않는다(시스템 폴더가 아니므로).
- **식별 마커**: 프리셋이 만드는 `SCHEMA.toml`에 `[meta] preset = "book"`(또는 movie/blog/novel/idea/daily/knowledge)을 새로 포함시켜, 설정 창이 "이 폴더는 관리되는 컬렉션"임을 사용자 커스텀 스키마와 구분한다.
- **하위 호환**: 이미 존재하는 데일리/지식 폴더의 SCHEMA.toml에는 이 마커가 없다(파일 재작성 금지 원칙 유지). 설정 창의 컬렉션 목록 계산은 `[meta].preset` 우선, 없으면 폴더 경로가 `config.daily.folder`/`config.knowledge.folder`와 일치하는지로 폴백 식별한다.
- 문서 종류(`kind`) 어휘 확장: `note`(기본, 부재)/`knowledge`/`daily`/`book`/`movie`/`blog`/`novel`/`idea`. 각 프리셋 템플릿이 스탬프.

### 2.2 프리셋 카탈로그 v1

| 컬렉션 | 속성 | 엔진 시너지 | 비고 |
|---|---|---|---|
| **책** (`book`) | `status`(읽는 중/읽음/보류/중단, 배지)·`rating`(1–5)·`author`(text) | `[review]` — 하이라이트 복습 | 메타데이터 매핑 대상 |
| **영화/시리즈** (`movie`) | `watched_at`(date)·`rating`(1–5)·`series`(Bool) | 배지 분포바 | 메타데이터 매핑 대상 |
| **블로그** (`blog`) | `status`(초고→수정→예약→발행, 배지)·`platform`(text)·`published_at`(date) | 상태 파이프라인 | API 불필요 |
| **소설** (`novel`, 라이트) | `status`(개요/초고/1차고/완결, 배지) | 프로젝트=폴더, 챕터=노트 | 장문 전용 뷰는 범위 밖 |
| **아이디어** (`idea`) | `status`(fleeting/archived, 배지)·`source`(text, 선택) | `[review]` — **fleeting note 처리 강제** | §2.3 |

**아이디어를 제외한 4종의 템플릿**은 각각 최소 스캐폴드(H1만, 필요한 kind 스탬프). 아이디어는 그보다도 더 미니멀(빈 본문) — "그냥 수집"이 목적이라 마찰 자체가 없어야 한다.

### 2.3 아이디어 컬렉션 — 설계 근거

리서치 근거(Zettelkasten fleeting notes, GTD inbox-zero, Andy Matuschak/Maggie Appleton의 seedling→evergreen 성숙도 모델): **아이디어는 처리되기 전의 임시 상태**이지 영구 보관 카테고리가 아니다. 자체 상태 어휘를 만드는 대신, 이미 있는 지식 상태 사다리(`stub→vague→understood→mastered`)의 **입구**로 설계한다.

- `status`: `fleeting`(기본, 캡처 직후) → `archived`(더는 안 키움, 보관— 삭제 아님) 2-상태만. "승격"은 별도 상태값이 아니라 **폴더 이동 그 자체**다(승격되면 `idea/`를 떠나 `knowledge/`로 이동하므로 `idea/` 안에 "promoted" 상태가 남을 이유가 없다).
- `[review]` 대기열에 두 액션: **"지식으로 승격"**(`move_note(folder=knowledge)` + `kind: knowledge` 스탬프 + 지식 자체 상태 `stub`로 시작 + 아이디어 전용 프롭(`status`/`source`) 제거) / **"보관"**(`status: archived`로 전환, 대기열에서 빠짐). 새 백엔드 프리미티브 없음 — 기존 `move_note`+`update_memo` props diff의 조합.
- 이 설계로 "아이디어가 조용히 잊힌다"는 실패 모드를 복습 대기열이 구조적으로 막는다 — 수집은 마찰 없이, 처리는 강제로.

## 3. 메타데이터 프로바이더 계층

### 3.1 아키텍처

- `oximemo-core`: 순수 계약만. `MetaField` enum(author/isbn/page_count/published_date/director/release_date/runtime_min/original_title), `MetaHit`, 그리고 **선언적 매핑** — SCHEMA.toml의 각 속성이 `metadata = "author"` 같은 필드를 선언하면 스탬프 대상이 된다. 평점(`rating`)은 사용자의 주관적 판단이므로 **자동 매핑 대상에서 제외**(TMDB `vote_average` 등을 사용자 rating에 자동 채우지 않는다).
- `src-tauri`: 프로바이더별 어댑터(HTTP 호출+필드 매핑), 이번이 앱의 **첫 네트워크 의존성**(reqwest+rustls). 코어는 네트워크 프리 유지.
- `ProviderInfo` 카탈로그(id·domain·access: Keyless｜ConditionalKeyless｜Keyed｜KeyedWithApproval·recommended_regions)는 코어에 순수 데이터로 둔다 — **카탈로그 확장은 데이터 한 줄 + 어댑터 하나**, 코어 변경 없음.

### 3.2 v1 카탈로그 (검증 완료)

| 도메인 | 프로바이더 | 지역 | 접근 | 비고 |
|---|---|---|---|---|
| 책 | Open Library | 글로벌 | 완전 키리스 | 항상 켜짐, 기본 폴백 |
| 책 | Google Books | 글로벌 | 키(무료, 즉시 발급, 10k/day) | 영어권 주력 |
| 책 | 알라딘 TTB | 한국 | 키(즉시 발급) | 한국어 책 최강 |
| 책 | NDL Search | 일본 | **조건부 키리스**(비영리/오픈 라이선스 메타데이터만; 상업적 사용·썸네일은 별도 신청) | 일본어 책 |
| 책 | DNB SRU | 독일 | 완전 키리스, CC0, 등록 불필요 | 독일어 책 |
| 영화 | TMDB | 글로벌 | 키(무료, 즉시), `language` 파라미터로 사실상 전 지역 | attribution 문구 필수 |
| 영화 | OMDb | 글로벌 | 키(무료, 즉시) | TMDB 보조 |
| 영화 | KMDB | 한국 | 키(**회원가입+개발계정 심사 1~2일, 일 1,000건 캡**) | 한국 영화 제작사·크레딧 심층 정보 |

### 3.3 지역 설정 (UI 언어와 분리)

- 현재 설정의 언어(ko/en)는 UI 번역 스위치일 뿐 국적과 무관. **메타데이터 패널에 별도 "추천 지역" 셀렉트**를 신설 — `Intl` API로 최초 실행 시 자동 추정(`ko-KR`→대한민국), 수동 변경 가능. 번역에는 영향 없고 프로바이더 정렬/추천 배지에만 쓰인다.
- 추천 정렬 예시:

| 지역 | 책 순서 | 영화 순서 |
|---|---|---|
| 대한민국 | 알라딘 → Google Books → Open Library | TMDB(ko) → KMDB → OMDb |
| 일본 | NDL → Google Books → Open Library | TMDB(ja) → OMDb |
| 독일 | DNB → Google Books → Open Library | TMDB(de) → OMDb |
| 기타/글로벌 | Google Books → Open Library | TMDB → OMDb |

- 수동 프로바이더 재정렬 UI는 v1 범위 밖(YAGNI) — 지역 셀렉트로 충분.

### 3.4 설정: `[metadata]` 섹션

```toml
[metadata]
enabled = true
region = "KR"            # ISO 3166, 자동 추정 + 수동 override
google_books_key = ""
aladin_key = ""
tmdb_key = ""
omdb_key = ""
kmdb_key = ""
```

Open Library·NDL·DNB는 키 필드 없음(NDL은 "비영리 조건" 안내만). `set_metadata_config` 세터는 `set_brain_config`와 동일 패턴.

### 3.5 검색/스탬프 UX

속성 패널에 "메타데이터 채우기"(스키마에 `metadata` 매핑 프롭이 있을 때만 노출) → 검색 팝오버 → **키 있는/조건 충족 프로바이더만, 지역 우선순위로 정렬**된 결과 → 선택 → 프롭 스탬프 + `source_url`(출처 링크, TMDB attribution 겸). 키 없는 프로바이더는 조용히 스킵(브레인 소거 계약과 동일). **v1 제외**: 표지/포스터 렌더링·캐시, 배치 import.

## 4. 설정 창 재설계

### 4.1 현재 → 목표

현재: 우측 380px 슬라이드 드로어에 10개 섹션이 세로로 그냥 쌓인 단일 스크롤. 목표: **중앙 모달**(`Dialog.Popup`, 진입점은 기존 톱니바퀴 버튼·`Dialog.Trigger` 그대로) 안에 **좌측 레일(카테고리) + 우측 콘텐츠 패널** — macOS 시스템 설정/Obsidian 설정과 동일 패턴. 클릭한 카테고리만 렌더.

기존 `Section`/`ToggleRow`/`TextRow`/`NumberRow`/`Segmented`와 섹션 컴포넌트(`BrainSection`/`CaptureSection`/`FoldersSection`/`CliSection`/`AdvancedSection`/`UpdaterSection`)는 **로직 그대로, 배치만 이동** — 재작성 없음.

### 4.2 레일 구성

```
일반
 ├─ 일반        (외관+동작+고급 병합: 테마·언어·독·휴지통·watcher
 │               + 데일리 노트 enabled — SectionLabel 소제목으로 구분)
 └─ 캡처        (CaptureSection + ⌘⇧N 단축키 표기)

연동
 ├─ 브레인      (BrainSection, 기존)
 └─ 메타데이터   (§3.4/§3.5 UI — 키 입력은 카드형 풀와이드+보기 토글)

볼트
 ├─ 컬렉션      (§4.3 — 7종 전체를 한 pane에서 스위치로 설치/해제)
 └─ 폴더 관리   (FoldersSection, 기존)

시스템
 ├─ 저장소      (기존 Storage 블록: 경로·재색인·닥터·초기화)
 ├─ 업데이트     (UpdaterSection + 정보 병합: 버전·전체 단축키 목록)
 └─ CLI         (CliSection)
```

정리 이력: 2차(같은 날) — 외관/동작/고급/정처럼 짧은 탭 병합(12+N → 8+N),
데일리 enabled를 일반으로, 무소속 폴더 관리를 볼트로. 3차(사용자 요청) —
컬렉션별 레일 탭과 "+ 컬렉션 추가" 카탈로그 다이얼로그를 없애고 **단일 컬렉션
관리 pane**(전체 7종, 각각 설치/해제 스위치)로 통합. 고정된 프리셋 집합은
다이얼로그가 아니라 제자리에서 관리한다. ⌘K "컬렉션 관리"는 설정을 열어
컬렉션 탭으로 바로 이동(settingsTab 원샷 요청).

### 4.3 컬렉션 관리 pane — 한 곳에서 전부

7종(지식·데일리 시스템 + 책·영화·블로그·소설·아이디어 설치형)이 각각 한 행:
아이콘·이름·(설치 시 경로 chip / 미설치 시 한 줄 설명)·폴더로 이동 버튼·**스위치**.

- **켜기** = `install_collection` (기존 경로 재사용, 신규는 현지화 기본 폴더명).
- **끄기** = 앱 전반의 2클릭 arm 패턴: 첫 클릭은 행을 빨간 경고 상태로(스위치는
  유지), 두 번째 클릭에 `delete_folder`. 설치형은 영구 삭제("폴더와 노트가 함께
  삭제돼요"), 시스템 폴더는 재생성 문구(다음 실행에 빈 프리셋).
- 판정은 `[meta].preset` 마커 우선, 시스템 경로 폴백(§2.1과 동일).
- 이름 변경·고정은 폴더 관리, 프로바이더 키는 연동 → 메타데이터 — pane 하단
  안내 한 줄로 링크. 컬렉션 pane에는 관리만 존재.

## 5. 백엔드/프론트엔드 변경 요약

- `oximemo-core`: `MetaField`/`MetaHit`/`ProviderInfo` 카탈로그(순수 데이터), SCHEMA.toml `[meta] preset` 파싱 → `FolderSchema.meta.preset: Option<String>`, 5종 프리셋 TEMPLATE/SCHEMA 상수, `install_collection` 위임.
- `src-tauri`: `install_collection(preset_id, folder)` IPC, 프로바이더 어댑터(reqwest, 8종), `search_book_metadata`/`search_movie_metadata` 커맨드, `set_metadata_config` 세터, `[metadata]` config 구조체.
- 프론트: `FolderSchema` 타입에 `meta.preset` 추가, `installCollection` API 함수(`applyKnowledgePreset` 콜사이트 교체), 새 `SettingsRail`/`SettingsPane` 컴포넌트로 `SettingsMenu` 본체 재구성(기존 섹션 컴포넌트 재사용), `CollectionSection`(제네릭, preset_id로 분기 최소화 — 얇은 공통 뷰 + 책/영화만 프로바이더 링크 조건부 렌더), `MetadataSection`(지역 셀렉트+프로바이더 목록+키 입력+테스트), `CollectionCatalogPicker`(⌘K/설정 공용).
- i18n ko/en: 레일 그룹/탭 라벨, 컬렉션별 kind/상태 어휘, 지역명, 프로바이더 상태 뱃지(키리스/조건부 키리스/키 필요/승인 대기), 메타데이터 채우기 UI 문자열.
- `tauri.ts` 브라우저 폴백: 컬렉션 설치(순수 데이터, 구현). 메타데이터 검색은 **데스크톱 전용**(키·네트워크, 백링크 선례와 동일).

## 6. 검증 계획

- 코어: 각 프리셋 설치(`install_collection`)의 skip-if-exists·kind 스탬프 유닛테스트(데일리 프리셋 테스트와 동일 패턴). `[meta] preset` 파싱 라운드트립. 아이디어 승격 플로우(이동+kind 변경+프롭 제거)의 통합 테스트.
- 프로바이더: 각 어댑터의 필드 매핑을 **fixture JSON**으로 유닛테스트(네트워크 없음). 실제 키로 수동 스모크(1회, CI 아님).
- 프론트: tsc/bun test/vite build 게이트. 브라우저 e2e — 설정 레일 탐색, 컬렉션 설치→탭 등장→제거, 지역 셀렉트 변경, 아이디어 캡처→복습→승격 플로우.

## 7. 스코프 밖 (백로그)

- 표지/포스터 이미지 렌더링·캐시.
- 수동 프로바이더 우선순위 재정렬 UI.
- 소설 전용 장문 쓰기 뷰(챕터 목차, 글자수 목표).
- 추가 지역 프로바이더(프랑스 BnF, 한국 네이버 책, WorldCat 등) — 카탈로그 확장 구조는 마련하되 v1 구현 대상 아님.
- 컬렉션별 세부 커스터마이징(예: 책의 별점 스케일 5점/10점 전환) — 요청 시 추가.

## 8. 참고 자료

- Zettelkasten fleeting/permanent notes: zettelkasten.de, ixcoach.com
- Andy Matuschak, Evergreen notes (notes.andymatuschak.org); Maggie Appleton, Growing the Evergreens
- GTD inbox-zero: stephendolan.com, tomyjaya.github.io
- Google Books API 식별자 요구사항: developers.google.com/books/docs/v1/using
- Open Library API: openlibrary.org/developers/api
- DNB SRU: dnb.de/EN/sru
- NDL Search API: ndlsearch.ndl.go.jp/en/help/api
- TMDB API terms: themoviedb.org (attribution 요구)
- KMDB Open API 가이드: kmdb.or.kr/info/api/guide2
