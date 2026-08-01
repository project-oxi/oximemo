# 통합 디자인 시스템 (DESIGN.md) 추출 — 자동 실행 태스크

> **실행 시점:** 2026-07-31 03:00 KST (UTC+9)
> **실행 모델:** `zai/glm-5.2`
> **기준 CWD:** `/Volumes/MERCURY/PROJECTS/oximemo` (작업 중 oxipage, oxios도 참조)
> **의뢰인:** 사용자
> **사용 스킬:** `design-farmer`

---

## 목표

3개의 프로젝트(oximemo, oxipage, oxios)의 디자인 시스템을 분석하여 **하나의 일관된 DESIGN.md**를 정립하라.

## 스타일 선호도 (중요)

| 순위 | 프로젝트 | 비고 |
|---|---|---|
| **1위 (가장 선호)** | **oximemo** | 가장 마음에 드는 스타일. 메인 레퍼런스로 삼을 것 |
| 2위 | oxipage | 다음으로 선호 |
| 3위 | oxios | 가장 덜 선호하지만, 좋은 요소는 참고 |

> oximemo도 아직 디자인이 완비되지 않아 허점이 많다. 완벽하지 않다는 전제로 접근하고, 부족한 부분은 design-farmer가 채워나갈 것.

---

## 프로젝트 위치

| 프로젝트 | 경로 | 기존 디자인 문서 |
|---|---|---|
| **oximemo** | `/Volumes/MERCURY/PROJECTS/oximemo` | `doc/DESIGN.md` (788줄, v0.2, 가장 최근) |
| **oxipage** | `/Volumes/MERCURY/PROJECTS/oxipage` | `doc/03-design-system.md` (11.5KB) |
| **oxios** | `/Volumes/MERCURY/PROJECTS/oxios` | `web/DESIGN.md`, `DESIGN.md`, `docs/design-web-ui-ts.md`, `docs/design-knowledge-ui.md` |

---

## 실행 방식

### 0. design-farmer 스킬 로드

`design-farmer` 스킬을 로드하고 그 지침을 따라 11개 Phase를 순차적으로 실행하라.

### Phase 0: Preflight

**중요: 사용자에게 질문하지 말고 아래 정보를 답변으로 사용하라.**

- **프로젝트 유형:** 3개의 독립된 프론트엔드 프로젝트 (oximemo: Tauri 2 + React 19, oxipage: Vite + React 19, oxios: Vite + React 19)
- **패키지 매니저:** bun
- **CSS 접근법:** Tailwind v4 + CSS 변수
- **색상 시스템:** OKLCH 기반 (oximemo, oxipage 둘 다 OKLCH 사용. oxios는 OKLCH 아닐 수 있음)
- **디자인 성숙도:** EMERGING (서로 다른 디자인 시스템, 통합 필요)
- **기존 DESIGN.md:** oximemo `doc/DESIGN.md` (가장 상세), oxipage `doc/03-design-system.md` (중간), oxios `web/DESIGN.md` + `DESIGN.md` (여러 개)
- **프레임워크:** 모두 React 19
- **아이콘:** lucide-react (oximemo, oxipage, oxios 일부)
- **언어:** TypeScript

### Phase 1: Discovery Interview

**사용자에게 질문하지 말고 아래 답변을 사용하라:**

1. **Scope (3개 프로젝트 통합):** oximemo의 스타일을 메인 레퍼런스로, oxipage와 oxios의 요소를 통합한다.
2. **Headless or not:** 필요에 따라 oximemo은 Headless UI + Tailwind, oxipage/oxios는 Radix UI 사용 중. 통합 디자인은 Tailwind v4 + CSS 변수 기반으로.
3. **Theme support:** 3개 프로젝트 모두 다크/라이트 테마 지원 필요.
4. **Typography:** oximemo의 Pretendard 폰트 시스템을 기본으로.
5. **Spacing scale:** 4px 그리드 기반.
6. **Border radius:** oximemo의 rounded-xl (12px) 카드 + rounded-lg (8px) 버튼 스타일을 기본으로.
7. **Elevation/shadow:** oximemo의 subtle shadow 스타일.
8. **Design output location:** 각 프로젝트의 기존 디자인 문서 위치에 업데이트. 메인 unified DESIGN.md는 `oximemo/doc/UNIFIED-DESIGN.md`에 저장하고, 각 프로젝트에도 사본/참조를 추가.

### Phase 2-4: 분석 및 패턴 추출

세 프로젝트의 다음 측면을 분석하라:
- 색상 팔레트 (OKLCH 우선)
- 타이포그래피 (폰트, 크기, 두께)
- 간격/레이아웃 (그리드, 여백)
- 컴포넌트 패턴 (카드, 버튼, 입력 폼, 다이얼로그)
- 테마 시스템 (라이트/다크)
- 애니메이션/모션 패턴

### Phase 4.5: DESIGN.md 생성 (핵심 산출물)

아래 구조로 통합 DESIGN.md를 작성하라:

```
# Unified Design System for Oxi Ecosystem

## 1. Design Philosophy
## 2. Color System (OKLCH)
### 2.1 Light Theme
### 2.2 Dark Theme
### 2.3 Semantic Color Tokens
## 3. Typography
## 4. Spacing & Layout
## 5. Elevation & Shadows
## 6. Border Radius
## 7. Component Tokens
### 7.1 Card
### 7.2 Button
### 7.3 Input / Form
### 7.4 Dialog / Drawer
### 7.5 Badge / Tag
### 7.6 Navigation
## 8. Theme Switching
## 9. Motion & Animation
## 10. Iconography
## 11. Project-Specific Adaptations
### 11.1 oximemo (Tauri macOS app)
### 11.2 oxipage (SSG web)
### 11.3 oxios (web app)
```

**저장 위치:**
1. `oximemo/doc/UNIFIED-DESIGN.md` — 메인 통합 문서
2. `oximemo/doc/DESIGN.md` — 기존 DESIGN.md 업데이트 (통합 시스템 반영)
3. 각 프로젝트에 `UNIFIED-DESIGN.md` 사본 + 프로젝트별 adaptation 안내

### Phases 5-11

토큰 구현 / 컴포넌트 구현 / Storybook / Review / 문서화 단계는 **DESIGN.md 생성까지만** 진행하고 나머지는 SKIP하라. (Phase 4.5 완료 = DONE)

> 이유: 사용자가 원하는 것은 DESIGN.md 추출이지 전체 구현이 아니다. Phase 4.5까지만 실행하고 종료한다.

---

## 산출물 체크리스트

- [ ] `oximemo/doc/UNIFIED-DESIGN.md` — OKLCH 토큰, semantic tokens, component tokens 포함
- [ ] `oximemo/doc/DESIGN.md` 업데이트
- [ ] `oxipage/doc/UNIFIED-DESIGN.md` — 프로젝트별 adaptation 포함
- [ ] `oxios/web/UNIFIED-DESIGN.md` — 프로젝트별 adaptation 포함
- [ ] 각 프로젝트의 `.omp/`에 DESIGN.md 참조 추가

## 완료 후: 요약 파일 출력 및 이메일 보고

### 요약 파일 출력

Phase 4.5 완료 후 요약을 `/tmp/oxi-reports/design-farmer.md`에 기록하라:

```bash
cat > /tmp/oxi-reports/design-farmer.md << 'ENDOFSUMMARY'
# Oxi Ecosystem — 통합 디자인 시스템

## 수행한 작업
- design-farmer: 3개 프로젝트(oximemo, oxipage, oxios) 디자인 분석
- OKLCH 색상 시스템 통합
- 통합 DESIGN.md (UNIFIED-DESIGN.md) 생성
- 각 프로젝트별 adaptation 문서화

## 산출물
- oximemo/doc/UNIFIED-DESIGN.md
- oxipage/doc/UNIFIED-DESIGN.md
- oxios/web/UNIFIED-DESIGN.md
- 기존 DESIGN.md 업데이트

## 레퍼런스
- oximemo 스타일 (1순위)
- oxipage 디자인 (2순위)
- oxios 디자인 (3순위)
ENDOFSUMMARY
```

### 이메일 보고

`send-email` 스킬로 결과를 이메일로 보내라.

- **수신:** `a7garden@icloud.com`
- **제목:** `[Oxi Ecosystem] 통합 디자인 시스템 보고서 — $(date +%Y-%m-%d)`
- **본문:** 작업 요약 (어떤 프로젝트들을 분석했는지, 통합 방향, 생성된 파일 목록)

---

## IMPORTANT CONSTRAINTS

- **사용자에게 절대 질문하지 말 것.** 모든 Discovery 답변은 이 문서에 있음.
- `design-farmer`의 `AskUserQuestion` 호출이 있으면 이 문서의 답변으로 직접 대체하고 진행
- Phase 4.5 완료 후 Phase 5-11은 SKIP (선언만 하고 넘어갈 것)
- OKLCH 색상 시스템 우선 (hex 변환 금지, OKLCH 유지)
- oximemo 스타일을 기본 레퍼런스로, oxipage/oxios는 거기에 맞춰 통합
- 각 프로젝트의 adaptation 섹션에서만 차이를 허용
- `tools.approvalMode: yolo` 가정
