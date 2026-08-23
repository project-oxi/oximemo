# 데일리 노트 퍼스트파티 UX (Daily Notes: Props + Dedicated UI)

- 날짜: 2026-08-23
- 상태: 확정 — 구현 완료
- 선행 문서: `2026-08-23-knowledge-system-design.md` (속성 엔진·스키마 계층), 데일리 노트 스펙 2026-08-21 §2–3
- 사용자 지시: "데일리 노트도 이제 전용 UI랑 속성이랑 그런 걸 설계하고 구현해줘" + 문서 종류 분류·생성일/편집일 노출 요청

## 1. 배경

지식 폴더가 스키마 프리셋(SCHEMA.toml + TEMPLATE.md)으로 퍼스트파티 대우를 받게 된
것과 같은 수준을 데일리 노트에 적용한다. 지식 시스템의 일반 규칙 — "폴더가 스키마를
선언하면 UI가 반응한다" — 을 그대로 재사용하고, 데일리 고유의 표면(달력·날짜)만
새로 더한다.

## 2. 핵심 결정사항

1. **데일리 프리셋 = 설정 폴더 추종.** `Vault::migrate`가 `[daily] folder`(기본
   `daily`)에 `SCHEMA.toml` + `TEMPLATE.md`를 탑재한다. 하드코딩 경로가 아니라
   설정된 폴더를 따른다(테스트 `migrate_ships_daily_preset_at_configured_folder`).
   기존 파일 보존(skip-if-exists)은 지식 프리셋과 동일.
2. **프리셋 속성 — kind / mood / energy, 전부 선택.** 무드 5단계
   (great/good/okay/low/bad, `badge = true`, 색 success/info/neutral/warning/error),
   컨디션 3단계(high/medium/low). `required`가 없으므로 프리셋 이전 노트는 경고 없다.
3. **`kind` 문서 종류 프롭 (사용자 요청).** "폴더 경로가 아닌 파일 자체에 종류" —
   지식 템플릿 `kind: knowledge`, 데일리 생성 `kind: daily`, 일반 노트는 부재
   (=일반). 값은 note/knowledge/daily 셀렉트로 양쪽 스키마에 선언. 저장은 표준
   YAML이라 grep·외부 도구에서도 분류 가능.
4. **생성일/편집일 패널 노출 (사용자 요청).** 모든 노트의 속성 패널 하단에
   읽기전용 푸터 "만든 날 · 고친 날"(코어 `created`/`updated` → 로컬 날짜). 중복
   저장 없음 — 순수 표시.
5. **날짜 내비게이션.** `{daily.folder}/YYYY-MM-DD.*` 노트를 열면 헤더에 ‹ › 화살표
   + 상대 라벨(오늘/어제/N일 전/N일 후). ‹는 이전 날을 open-or-create(달력 클릭과
   동일 계약), ›는 오늘까지만(미래 노트 우발 생성 방지).
6. **무드 캘린더.** 사이드바 미니 달력의 점(3px→4px)을 배지 속성 색으로. 일반
   규칙: "폴더 스키마의 첫 `badge` 속성이 점 색을 정한다" — 무드 프리셋이
   great=초록…bad=빨강. 값 없는 날은 중립 점 그대로.
7. **속성 커밋 = 초안 생존.** 세션 초안(새 데일리 노트)에서 본문을 건드리지 않고
   속성만 썼으면(무드만 설정) 닫아도 폐기하지 않는다. `PropertyPanel.commit`
   성공 시 `draftId` 해제. "무드만 찍고 닫았는데 노트가 사라지는" 데이터 손실 방지.

### 기각한 대안

- **mood/energy 외 하이라이트·감사 등 회고 필드**: YAGNI — 패널에서 자유 추가
  가능. 프리셋은 최소로.
- **캘린더 중심 브라우징 뷰(카드 그리드 교체)**: 규모 대비 가치 미확인. 사이드바
  캘린더 + 날짜 내비가 먼저.
- **kind를 태그(#daily)로**: 태그는 사용자 어휘 공간을 오염시킨다. 속성이 정위치.

## 3. 구현 요약

**코어** (`crates/oximemo-core`):
- `schema.rs`: `DAILY_TEMPLATE_MD`(`kind: daily` + `# {{date}}` — 닫는 `---` 뒤
  빈 줄 없음: 템플릿 본문이 빈 줄로 시작하면 H1 정규화가 깨짐), `DAILY_SCHEMA_TOML`,
  지식 프리셋에 `kind` 추가.
- `vault.rs`: `apply_knowledge_preset`를 사유 `apply_preset(folder, template,
  schema)`로 일반화, `ensure_default_folders`가 지식 + 설정 데일리 폴더에 적용.

**프론트** (`apps/desktop`):
- `dates.ts`: `isoToLocalDate`/`shiftISODate`/`daysBetween`.
- `propDisplay.ts`: 키별 값 어휘 맵(`VALUE_LABEL`) — `low`가 무드에서는 저조,
  컨디션에서는 낮음. `toneBg`(점 배경색).
- `PropertyPanel.tsx`: 생성일/편집일 푸터, 커밋 시 초안 해제.
- `MemoDetail.tsx`: `[data-daily-nav]` ‹ › + `[data-daily-rel]` 상대 라벨.
- `Calendar.tsx`: `dotTone?: (date) => bg-class` 옵션.
- `Sidebar.tsx`: 배지 속성 조회(`useSchemaInfo`) → 날짜별 무드 → `toneBg`.
- `tauri.ts` 폴백: `DAILY_PRESET_SCHEMA` 미러, 데일리 스키마 시딩, 생성 시
  `kind: daily` 스탬프.
- i18n ko/en: `prop_key_{kind,mood,energy}`, `prop_val_{note,knowledge,daily,
  great,good,okay,low_mood,bad,high,medium,low}`, `prop_{created,updated}`,
  `daily_{prev,next}_day`, `rel_{today,yesterday,days_ago,in_days}`.

## 4. 검증

- `cargo test --workspace`: 291 pass (신규 `migrate_ships_daily_preset_at_configured_folder`).
- `tsc --noEmit` 클린, `bun test` 19 pass, `vite build` 성공.
- 브라우저 실증(폴백): 프리셋 시딩, 오늘 노트 종류=데일리 + 무드/컨디션 행 + 만든
  날/고친 날, ‹ 오늘→어제 라벨 전환, 무드=나쁨 → 어제 점 `bg-hue-red`, 무드만
  설정하고 닫아도 노트 생존(초안 해제), › 오늘에서 비활성.

## 5. 백로그

- 오늘 셀의 무드 점은 primary-foreground(채운 셀 위 대비) — 무드 미표시. 필요하면
  오늘 셀 테두리 색 등으로 표현.
- 리스크·타임라인 뷰 배지는 지식과 동일 미적용 상태.
