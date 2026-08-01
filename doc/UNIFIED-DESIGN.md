# Unified Design System for the Oxi Ecosystem

> **한 문장:** 잉크 위 종이(Ink on paper) — 중성의 따뜻한 표면, 헤어라인 보더, 무게 중심의 위계. 색은 데이터이지 장식이 아니다.
>
> **버전:** v1.0 · **작성일:** 2026-07-31 · **작성 모델:** `zai/glm-5.2` (design-farmer Phase 4.5)
> **적용 범위:** `oxinot` (Tauri 2 · macOS), `oxipage` (Vite · web), `oxios` (Vite · web)

이 문서는 oxi 생태계 세 프로젝트가 공유하는 **단일 디자인 문법**을 정의한다. oxinot의 스타일(캡처 우선 철학, OKLCH 6-hue 라벨 팔레트, 미니멀 카드 그리드)을 기준 레퍼런스로 삼고, oxipage·oxios의 패턴을 그 위로 통합했다. 모든 토큰 값은 세 프로젝트의 실제 CSS 파일에서 추출·검증했다.

> **정보 출처(verified):** `oxios/web/src/index.css`(3-tier 구현 완료), `oxipage/web/src/shared/tokens.css`(v1), `oxinot/apps/desktop/src/app.css` + `lib/color.ts`(레거시 hex, OKLCH 팔레트 보유), 그리고 정규 스펙 `oxi-design-system` 매니지드 스킬.

---

## 0. 현재 상태 (migration snapshot)

| 프로젝트 | 토큰 계층 | 다크모드 트리거 | 본문 폰트 | 디스플레이 폰트 | 비고 |
|---|---|---|---|---|---|
| **oxios** | ✅ 3-tier 완료 | `.dark` | SUIT (Geist fallback) | SUITE | 가장 앞서 있음 |
| **oxipage** | ⚠️ v1 (`[data-theme]`) | `[data-theme]` → `.dark` | Pretendard → SUIT | Fraunces → SUITE | 마이그레이션 필요 |
| **oxinot** | ⚠️ 레거시 hex | `.dark` ✅ | Inter/Pretendard → SUIT | SUITE | `color.ts`는 OKLCH 보유 |

이 문서의 토큰 값은 **oxios가 이미 구현한 정규(canonical) 값**이며, oxipage·oxinot이 마이그레이션해야 할 목표치다.

---

## 1. Design Philosophy

세 프로젝트의 원칙을 우선순위대로 통합했다. 1·2·3위는 oxinot에서, 4위는 oxipage에서, 5위는 oxios에서 가져왔다.

1. **캡처는 마찰이 없어야 한다** (oxinot). 가장 빠른 경로가 이긴다. 디자인은 결코 사용자를 기다리게 만들지 않는다.
2. **파일이 진실이다** (oxinot). CSS 변수는 시맨틱 토큰의 별칭일 뿐이다. 컴포넌트에서 프리미티브를 직접 손대지 않는다.
3. **적을수록 좋다** (oxinot). 장식적 크롬, AI 기본값 그라디언트, "Inter = 정체성"은 없다.
4. **종이와 잉크** (oxipage). 중성 표면에 하나의 절제된 악센트 — 단, 그 악센트는 **6-hue 팔레트**이지 단일 색이 아니다.
5. **상태는 차분하다** (oxios). 상태색은 의미로 무게를 얻는다. 그 외 어떤 것도 색을 갖지 않는다.

### 1.1 이 시스템이 배제하는 것

- 정체성을 고정하는 단일 브랜드 색.
- 컴포넌트 파일에 흩뿌려진 `dark:` 변형 (금지).
- light/dark 전환용 `[data-theme="dark"]` 셀렉터 (deprecated — `.dark` 클래스 사용). 단, `[data-theme="brand-x"]` 변형 축(§8.4)은 별개 관심사로 허용.
- 컴포넌트 파일 내 hex, `rgb()`, `hsl()` — OKLCH만, 그리고 토큰 계층 내에서만.
- 정체성 폰트로서의 Inter / Roboto / system-ui (fallback으로는 허용).
- HSL 기반 다크모드 반전 (`filter: invert()`) — 지각 대비가 깨진다.
- 타입 시스템의 정체성 수단으로서의 세리프/산세리프 대비 (SUIT + SUITE 모두 산세리프).

---

## 2. Color System (OKLCH)

### 2.1 왜 OKLCH인가

oxinot §7.7과 oxipage §3.2에서 상속:

- **지각적 균일성.** 같은 L → 색상에 무관하게 동일한 체감 밝기. 카드 왼쪽 색상 바가 어떤 색이든 동일한 "시각적 무게"를 갖는다.
- **CSS 네이티브.** Tailwind CSS v4가 OKLCH를 기본 색상 공간으로 채택했고, 모든 모던 브라우저(WebKit 포함)가 `oklch()`를 지원한다. Tauri WebView(WebKit)에서 변환 없이 렌더링.
- **예측 가능한 다크모드.** L만 뒤집으면 된다.
- **기계적 팔레트 생성.** H만 회전하고 L/C를 고정하면 안전한 6-hue 팔레트가 생성된다.

### 2.2 L-only 규칙 (범위 지정)

- **중성색 + 라벨 hue:** 다크모드는 **L만** 조정 — C나 H는 건드리지 않는다.
- **상태색 (status hues):** 모드별로 APCA 최적화 — C/H가 달라질 수 있다. oxios 대시보드의 실측값이 권위 있다.

> 중성색의 warm→cool hue 전환(light 95° → dark 265°)은 프리미티브 계층에서 **단 한 번** 적용되는 유일한 구조적 예외다.

### 2.3 Primitive palette (Tier 1 — raw OKLCH, 컴포넌트 접근 금지)

**중성 램프 — "paper / ink"** (검증: `oxios/web/src/index.css:161-170`)

| Step | Light 값 | Dark override | 용도 |
|---|---|---|---|
| `--p-neutral-0` | `oklch(98.5% 0.004 95)` | — | 가장 밝은 종이 |
| `--p-neutral-50` | `oklch(95% 0.006 95)` | — | 표면 (light) |
| `--p-neutral-100` | `oklch(90% 0.007 95)` | `oklch(28% 0.015 265)` | 보더 (light), 떠있는 표면 (dark) |
| `--p-neutral-200` | `oklch(82% 0.008 95)` | `oklch(40% 0.015 265)` | 강한 보더 |
| `--p-neutral-300` | `oklch(75% 0.010 95)` | — | 3차 텍스트 (light) |
| `--p-neutral-500` | `oklch(55% 0.012 95)` | `oklch(65% 0.012 265)` | 뮤트 텍스트 (양 모드) |
| `--p-neutral-700` | `oklch(35% 0.012 265)` | — | 2차 텍스트 (light) |
| `--p-neutral-900` | `oklch(18% 0.015 265)` | — | 1차 텍스트 (light) — 잉크 |
| `--p-neutral-950` | `oklch(13% 0.020 265)` | 동일 | 캔버스 (dark) |
| `--p-neutral-999` | `oklch(0% 0 0)` | — | 그림자용 순흑 |

라이트 톤은 hue `95` (따뜻한 종이), 다크 셰이드는 `265` (차가운 잉크).

**6-hue 라벨 팔레트** (검증: oxinot `lib/color.ts` + oxios `index.css:208-213`)

| 이름 | OKLCH | 용도 |
|---|---|---|
| Red | `oklch(0.75 0.15 25)` | 긴급, 차단, 파괴적 액션 |
| Amber | `oklch(0.75 0.15 75)` | 주의, 아이디어, 대기 |
| Green | `oklch(0.75 0.13 145)` | 완료, 긍정, 성공 |
| Teal | `oklch(0.75 0.12 195)` | 참고, 정보 |
| Blue | `oklch(0.70 0.14 250)` | 작업 중, 진행 |
| Purple | `oklch(0.72 0.15 310)` | 영감, 개인 |

여섯 색 모두 **L ≈ 0.70–0.75**, **C ≈ 0.12–0.15**로 통일. 어떤 라벨이든 어떤 배경에서든 동일한 시각적 무게. 다크모드는 시맨틱 계층에서 L+0.05 보정.

**상태색 — APCA 최적화** (검증: oxios `index.css:215-218`)

| Semantic | Light | Dark | Hue 계열 |
|---|---|---|---|
| Success | `oklch(0.596 0.145 163)` | `oklch(0.723 0.219 149.579)` | Green |
| Warning | `oklch(0.669 0.162 70)` | `oklch(0.769 0.188 70.08)` | Amber |
| Error | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` | Red |
| Info | `oklch(0.623 0.214 259.815)` | `oklch(0.685 0.196 259)` | Blue |

> 라벨 hue ≠ 상태색. 라벨은 사용자가 고르는 태그 성격; 상태색은 시스템 구동이며 대시보드 영역에 존재. 둘 다 동일한 6 hue 계열을 재사용.

**대화형 주색 (Interactive primary)** — 전용 버튼 필 (검증: oxios `index.css:228-229`)

라벨 hue(L≈0.70)는 흰 텍스트 버튼 필에 너무 밝다. 전용 토큰을 둔다:

- Light: `oklch(0.45 0.14 250)` (L=0.45 — 흰 텍스트가 APCA Lc 60 통과)
- Dark: `oklch(0.70 0.14 250)` (L=0.70 — 어두운 텍스트 통과)

### 2.4 Light Theme (Semantic Tier 2 — `:root`)

검증: `oxios/web/src/index.css:192-229`

```css
:root {
  /* 표면 */
  --color-surface:          var(--p-neutral-0);
  --color-surface-raised:   oklch(1 0 0);
  --color-surface-sunken:   var(--p-neutral-50);
  --color-surface-muted:    oklch(96% 0.005 265);
  /* 텍스트 */
  --color-text:             var(--p-neutral-900);   /* 잉크 */
  --color-text-muted:       var(--p-neutral-500);
  --color-text-subtle:      oklch(0.42 0.010 95);   /* L=0.42 — light 표면에서 APCA Lc 60 통과 */
  --color-text-inverse:     oklch(0.985 0 0);
  /* 보더 / 포커스 */
  --color-border:           var(--p-neutral-100);
  --color-border-strong:    var(--p-neutral-200);
  --color-focus-ring:       oklch(0.45 0.04 265);
  /* 6-hue 라벨 */
  --color-hue-red:    oklch(0.75 0.15 25);
  --color-hue-amber:  oklch(0.75 0.15 75);
  --color-hue-green:  oklch(0.75 0.13 145);
  --color-hue-teal:   oklch(0.75 0.12 195);
  --color-hue-blue:   oklch(0.70 0.14 250);
  --color-hue-purple: oklch(0.72 0.15 310);
  /* 상태 (APCA 최적화) */
  --color-status-success: oklch(0.596 0.145 163);
  --color-status-warning: oklch(0.669 0.162 70);
  --color-status-error:   oklch(0.577 0.245 27.325);
  --color-status-info:    oklch(0.623 0.214 259.815);
  /* 상태 표면 (패널 배경) */
  --color-status-success-subtle: oklch(0.97 0.014 163);
  --color-status-warning-subtle: oklch(0.97 0.014 70);
  --color-status-error-subtle:   oklch(0.97 0.014 27);
  --color-status-info-subtle:    oklch(0.97 0.014 259);
  /* 상태 텍스트 on subtle (10px 마이크로 라벨용 Lc 75+) */
  --color-status-success-on-subtle: oklch(0.40 0.13 163);
  --color-status-warning-on-subtle: oklch(0.45 0.14 70);
  --color-status-error-on-subtle:   oklch(0.42 0.18 27);
  --color-status-info-on-subtle:    oklch(0.42 0.16 259);
  /* 대화형 주색 */
  --color-interactive-primary:           oklch(0.45 0.14 250);
  --color-interactive-primary-foreground: oklch(0.985 0 0);
}
```

### 2.5 Dark Theme (`.dark` override)

검증: `oxios/web/DESIGN.md:334-378`

```css
.dark {
  --color-surface:          var(--p-neutral-950);
  --color-surface-raised:   oklch(22% 0.016 265);
  --color-surface-sunken:   oklch(11% 0.018 265);
  --color-surface-muted:    oklch(20% 0.012 265);
  --color-text:             var(--p-neutral-0);
  --color-text-muted:       var(--p-neutral-300);
  --color-text-subtle:      oklch(75% 0.012 265);   /* L=0.75 — dark 표면에서 통과 */
  --color-text-inverse:     var(--p-neutral-900);
  --color-border:           oklch(28% 0.015 265);
  --color-border-strong:    oklch(40% 0.015 265);
  --color-focus-ring:       oklch(0.65 0.05 265);
  /* 라벨: L+0.05 사전 계산 단계 */
  --color-hue-red:    oklch(0.78 0.14 25);
  --color-hue-amber:  oklch(0.78 0.14 75);
  --color-hue-green:  oklch(0.78 0.12 145);
  --color-hue-teal:   oklch(0.78 0.11 195);
  --color-hue-blue:   oklch(0.74 0.13 250);
  --color-hue-purple: oklch(0.76 0.14 310);
  /* 상태 — dark용 APCA 최적화 (C/H 가변) */
  --color-status-success: oklch(0.723 0.219 149.579);
  --color-status-warning: oklch(0.769 0.188 70.08);
  --color-status-error:   oklch(0.704 0.191 22.216);
  --color-status-info:    oklch(0.685 0.196 259);
  /* 상태 표면 (dark) */
  --color-status-success-subtle: oklch(0.20 0.03 163);
  --color-status-warning-subtle: oklch(0.20 0.03 70);
  --color-status-error-subtle:   oklch(0.20 0.03 27);
  --color-status-info-subtle:    oklch(0.20 0.03 259);
  /* 상태 텍스트 on subtle (dark — 더 밝게) */
  --color-status-success-on-subtle: oklch(0.80 0.10 163);
  --color-status-warning-on-subtle: oklch(0.82 0.10 70);
  --color-status-error-on-subtle:   oklch(0.78 0.12 27);
  --color-status-info-on-subtle:    oklch(0.78 0.10 259);
  /* 대화형 주색 — dark (어두운 텍스트용 더 밝은 필) */
  --color-interactive-primary:           oklch(0.70 0.14 250);
  --color-interactive-primary-foreground: oklch(15% 0.015 265);
}
```

### 2.6 Semantic Color Tokens → Tailwind (Tier 2.5)

`@theme inline` 블록이 시맨틱 토큰을 Tailwind 유틸리티로 별칭. **자기참조 `var()` 회피**를 위해 별칭 이름은 원본과 충돌하지 않게 설계한다 (검증: oxios `index.css:18-150`):

```css
@theme inline {
  /* 표면 */
  --color-surface:        var(--color-surface);   /* → bg-surface */
  --color-surface-raised: var(--color-surface-raised);
  --color-surface-sunken: var(--color-surface-sunken);
  /* 텍스트 → text-text, text-text-muted, text-text-subtle */
  --color-text:           var(--color-text);
  /* 보더 → border-line */
  --color-line:           var(--color-border);
  --color-line-strong:    var(--color-border-strong);
  /* 라벨 → bg-hue-{red|amber|green|teal|blue|purple} */
  /* 상태 → bg-status-success, text-status-warning, bg-status-success-subtle … */
  /* 주색 → bg-interactive-primary, text-interactive-primary-foreground */
}
```

> oxios는 레거시 shadcn 별칭(`--background`→`--color-surface` 등)을 **동시 보존**해 기존 유틸리티가 조용히 no-op 되지 않게 한다. oxipage·oxinot 마이그레이션 시 동일 패턴 권장.

### 2.7 커스텀 OKLCH 입력 (oxinot §7.7)

사용자가 임의 OKLCH 값을 입력할 수 있다. UI는 지각적 안전 범위로 clamp (검증: `lib/color.ts`):

```ts
const SAFE_RANGES = { L: [0.50, 0.90], C: [0.05, 0.25], H: [0, 360] };
```

frontmatter에 `color = "oklch(L C H)"`로 그대로 저장. 파싱 실패 시 `--color-hue-blue`(중성 기본값)로 fallback하고 `doctor` 경고.

---

## 3. Typography

### 3.1 폰트 페어링 — 둘 다 산세리프, 밀도 대비만

**이 시스템에 세리프는 없다.** SUIT와 SUITE는 모두 산세리프다. 카테고리가 아닌 **밀도**로 작동한다:

- **SUIT** = UI 본문용. 본고딕 기반, 작은 사이즈(10–16px)의 긴 한국어 문단에 최적화. 균등한 리듬, 높은 x-height. Variable wght 100–900.
- **SUITE** = UI 헤드라인. 기하학적 구조, 디스플레이 사이즈(≥20px)용. Variable wght 300–900.

| 역할 | 폰트 | 비고 |
|---|---|---|
| 본문 / UI | **SUIT** (`'SUIT Variable'`) | wght 100–900, SIL OFL. 한국어 우선 |
| 헤드라인 (≥20px) | **SUITE** (`'SUITE Variable'`) | wght 300–900. 디스플레이 전용 |
| 모노스페이스 | **Geist Mono** | Latin 우선. 코드·ID·JSON |
| Latin fallback | `system-ui, -apple-system, "Inter", sans-serif` | SUIT 로딩 중에만 |

> oxipage의 기존 Fraunces 디스플레이 세리프는 이 통합에서 제거된다. oxinot·oxios는 SUIT를 새로 채택.

### 3.2 배포 (jsDelivr, Google Fonts 아님)

SUIT/SUITE는 **Google Fonts에 없다**. jsDelivr CDN (`sun-typeface` GitHub org)로만:

```css
@import url('https://cdn.jsdelivr.net/gh/sun-typeface/SUIT@2/fonts/variable/woff2/SUIT-Variable.css');
@import url('https://cdn.jsdelivr.net/gh/sun-typeface/SUITE@2/fonts/variable/woff2/SUITE-Variable.css');
```

자체 호스팅(production/Tauri)은 woff2 번들: `apps/desktop/src/assets/fonts/`. Vite는 `@fontsource-variable/geist-mono` 사용.

### 3.3 스택 선언

```css
:root {
  --font-sans:    "SUIT Variable", "SUIT", system-ui, -apple-system, "Inter", sans-serif;
  --font-display: "SUITE Variable", "SUITE", system-ui, -apple-system, "Inter", sans-serif;
  --font-mono:    "Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
```

### 3.4 타입 스케일

| 역할 | Size | Line-height | Weight | Tailwind |
|---|---|---|---|---|
| Display | 36px | 1.2 | 700 (SUITE) | `text-display` |
| Heading 1 | 30px | 1.25 | 700 (SUITE) | `text-3xl` |
| Heading 2 | 24px | 1.3 | 600 (SUITE) | `text-2xl` |
| Heading 3 | 20px | 1.35 | 600 (SUITE/SUIT) | `text-xl` |
| Heading 4 | 18px | 1.4 | 600 (SUIT) | `text-lg` |
| Body | 16px | 1.55 | 400 (SUIT) | `text-base` |
| Body small | 14px | 1.5 | 400 (SUIT) | `text-sm` |
| Caption | 12px | 1.45 | 500 (SUIT) | `text-xs` |
| Micro label | 10px | 1.4 | 500 + tracking-wide + uppercase | `text-2xs` |

원칙: 무게가 위계를 만든다(색이 아니다). `font-medium`(500)이 주력. `font-bold`(700)는 디스플레이 전용. 렌더링 텍스트가 20px를 넘을 수 있으면 `font-display`(SUITE)로 전환 — 토큰 스왑이지 요소별 규칙이 아니다.

---

## 4. Spacing & Layout

### 4.1 스페이싱 스케일

기본 단위 **4px** (Tailwind 기본). 스케일: 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64.

기본 리듬: 컴포넌트 내부 `gap-2` (8px), 섹션 간 `gap-4` (16px) (oxios 기본값).

### 4.2 브레이크포인트

| 이름 | Width | 동작 |
|---|---|---|
| `sm` | 640px | 2열→1열 스택, 사이드바→오버레이 |
| `md` | 768px | 태블릿 레이아웃 전환 |
| `lg` | 1024px | 데스크톱, 풀 사이드바 |
| `xl` | 1280px | 와이드 콘텐츠, 선택적 3패널 |

터치 타겟 최소: **44 × 44px**.

### 4.3 그리드 (프로젝트별)

| 프로젝트 | 패턴 |
|---|---|
| oxinot 카드 그리드 | `grid-cols-[repeat(auto-fill,minmax(240px,1fr))]` — 균일 높이, `@tanstack/react-virtual` 가상화 |
| oxipage lobby `list` | 단일 열, 헤어라인 구분선, 모션 없음 |
| oxipage lobby `grid` | 1 / 2 / 3열 반응형 |
| oxipage lobby `canvas` | 플로팅 카드; 드리프트 진폭 12px / 주기 14s; seed `stable-per-day` |
| oxios 대시보드 | 3-zone: 사이드바 + 메인 + 선택적 인스펙터 패널 |

---

## 5. Elevation & Shadows

4단계 그림자. **다크모드는 알파를 크게 올린다** — 그렇지 않으면 다크 배경에서 그림자가 사라진다 (oxipage §3.3 실측 발견).

| 단계 | Light | Dark | 용도 |
|---|---|---|---|
| `shadow-xs` | `0 1px 2px oklch(0% 0 0 / 0.04)` | `0 1px 2px oklch(0% 0 0 / 0.30)` | 호버 전용 리프트 |
| `shadow-sm` | `0 1px 3px oklch(0% 0 0 / 0.07), 0 1px 2px oklch(0% 0 0 / 0.04)` | `…/ 0.40, …/ 0.30` | 카드, 인풋 |
| `shadow-md` | `0 4px 8px oklch(0% 0 0 / 0.08), 0 2px 4px oklch(0% 0 0 / 0.04)` | `…/ 0.45, …/ 0.35` | 드롭다운, 팝오버 |
| `shadow-lg` | `0 12px 24px oklch(0% 0 0 / 0.10), 0 4px 8px oklch(0% 0 0 / 0.06)` | `…/ 0.50, …/ 0.40` | 모달, 드로어 |

포커스 (별개 레이어): `outline: 2px solid var(--color-focus-ring); outline-offset: 2px`. 단, 폼 인풋/셀렉트는 `--input-shadow-focus`(box-shadow)를 쓴다 (§7.3).

```css
--shadow-xs: var(--elevation-xs);
--shadow-sm: var(--elevation-sm);
--shadow-md: var(--elevation-md);
--shadow-lg: var(--elevation-lg);
```

---

## 6. Border Radius

### 6.1 반경 스케일

| 토큰 | 값 | 용도 |
|---|---|---|
| `--radius-xs` | 0.25rem (4px) | 태그, dense 칩 |
| `--radius-sm` | 0.375rem (6px) | 인라인 요소, 인풋(대안) |
| `--radius-md` | 0.5rem (8px) | 버튼, 인풋, 셀렉트 |
| `--radius-lg` | 0.75rem (12px) | 카드, 다이얼로그 |
| `--radius-xl` | 1rem (16px) | 팝오버, 툴팁 |
| `--radius-2xl` | 1.25rem (20px) | 모달, 히어로 표면 |
| `--radius-full` | 9999px | 배지, 필, 아바타 |

> oxinot 카드는 `--radius-lg`(12px). oxios 버튼은 `--radius-md`(8px). oxipage v1 카드는 `--radius-md`에서 `--radius-lg`로 정렬 필요.

---

## 7. Component Tokens

모든 컴포넌트는 **명시적 반경 토큰**을 참조해야 한다 — raw `px` 금지 (검증: oxios `index.css:232-248`).

### 7.1 Card

| 변형 | 배경 | 보더 | 그림자 | 용도 |
|---|---|---|---|---|
| **Outlined** (기본) | `bg-surface-raised` | `1px solid var(--color-border)` | 없음 | 표준 콘텐츠 컨테이너 |
| **Elevated** | `bg-surface-raised` | 없음 | `shadow-sm` | 플로팅 콘텐츠, 팝오버형 카드 |
| **Filled** | `bg-surface-sunken` | 없음 | 없음 | 중첩 섹션, 인셋 패널 |

```html
<!-- Outlined (기본) -->
<article class="bg-surface-raised text-text border border-line rounded-[var(--card-radius)] p-4">…</article>
```

- 반경 토큰: `--card-radius: var(--radius-lg)` (12px)
- oxinot 카드 해부: 선택적 2px 왼쪽 바 `bg-hue-{name}` (라벨용). 호버: `hover:shadow-md transition-shadow`.
- 서브 컴포넌트: `CardHeader`(border-bottom `border-line/50`, `px-4 py-3`), `CardTitle`(`font-semibold text-text`), `CardContent`(`p-4`), `CardFooter`(border-top).

### 7.2 Button

공유 사이즈 스케일 (Button/Input/Select 정렬):

| Size | Height | Padding X | Tailwind | 용도 |
|---|---|---|---|---|
| xs | 28px | 10px | `h-7 px-2.5 text-xs` | dense 툴바 |
| sm | 32px | 12px | `h-8 px-3 text-[13px]` | 인라인, 컴팩트 폼 |
| md (기본) | 36px | 14px | `h-9 px-3.5 text-sm` | 표준 액션 |
| lg | 40px | 16px | `h-10 px-4 text-[15px]` | 주 CTA |
| icon | 36×36 | — | `h-9 w-9` | 아이콘 전용 (md 높이) |

| 변형 | 배경 | 텍스트 | 호버 | 용도 |
|---|---|---|---|---|
| Primary | `bg-interactive-primary` | `text-interactive-primary-foreground` | `bg-interactive-primary/90` | 화면당 단일 CTA |
| Secondary | `bg-surface-muted` | `text-text` | `bg-surface-muted/80` | 보조 액션 |
| Ghost | transparent | `text-text` | `bg-surface-muted` | 인라인, 저강조 |
| Outline | transparent | `text-text` | `shadow-[0_0_0_1px_var(--color-border)]` | 3차 액션 |
| Destructive | `bg-status-error` | `text-text-inverse` | `bg-status-error/90` | 삭제, 돌이킬 수 없음 |

반경: `--button-radius: var(--radius-md)` (8px). 규칙: 보이는 영역당 Primary 최대 1개.

### 7.3 Input / Form

**보더 접근: `box-shadow`, CSS `border`가 아님.** `box-shadow: 0 0 0 1px`는 상태 전환 시 1px 레이아웃 시프트를 방지한다.

```css
--input-shadow:        0 0 0 1px var(--color-border);
--input-shadow-focus:  0 0 0 1px var(--color-focus-ring), 0 0 0 4px oklch(0.45 0.04 265 / 0.15);
--input-shadow-error:  0 0 0 1px var(--color-status-error);
```

```html
<input class="h-9 px-3.5 rounded-[var(--input-radius)] bg-surface text-text text-sm
              placeholder:text-text-subtle
              shadow-[var(--input-shadow)]
              focus-visible:shadow-[var(--input-shadow-focus)]
              focus-visible:outline-none
              aria-[invalid=true]:shadow-[var(--input-shadow-error)]" />
```

- 반경 토큰: `--input-radius`, `--select-radius`, `--textarea-radius` → 모두 `var(--radius-md)` (8px)
- 에러: `aria-invalid="true"`, 도움말 텍스트 `text-status-error text-xs`.

### 7.4 Dialog / Drawer

| 속성 | 값 |
|---|---|
| 백드롭 | `oklch(0 0 0 / 0.4)` + `backdrop-blur-sm` |
| 표면 | `bg-surface-raised` |
| 그림자 | `shadow-lg` |
| 반경 | `--dialog-radius` → `--radius-lg` (12px) |
| 최대 너비 | sm 380px · md 520px · lg 680px |
| 너비 | `w-full max-w-[Xpx]` (반응형, 고정 `width` 금지) |
| 입장 애니메이션 | scale + fade: `scale(0.95)`→`scale(1)`, `--duration-base` + `--ease-out` |

### 7.5 Badge / Tag

| 변형 | 배경 | 텍스트 |
|---|---|---|
| default | `bg-surface-muted` | `text-text-muted` |
| outline | transparent | `text-text` (shadow `0 0 0 1px var(--color-border)`) |
| success | `bg-status-success-subtle` | `text-status-success-on-subtle` |
| warning | `bg-status-warning-subtle` | `text-status-warning-on-subtle` |
| error | `bg-status-error-subtle` | `text-status-error-on-subtle` |
| info | `bg-status-info-subtle` | `text-status-info-on-subtle` |

- 배지 반경: `--badge-radius` → `--radius-full` (9999px 필)
- 태그/칩(dense): `--tag-radius` → `--radius-xs` (4px)
- 마이크로 라벨: `text-2xs font-medium tracking-wider uppercase`

### 7.6 Navigation / Sidebar

세 프로젝트가 동일 프리미티브를 공유 (검증: oxios sidebar 패턴):

```ts
export const sidebarPrimitives = {
  itemBase:      "flex items-center w-full text-sm py-2 px-2 gap-3 rounded-md transition-colors",
  itemActive:    "bg-surface-muted text-text font-medium",
  itemInactive:  "text-text-muted hover:text-text hover:bg-surface-muted/50",
  itemCollapsed: "flex items-center justify-center w-9 h-9 rounded-md",
  sectionHeader: "px-2 py-1.5 text-2xs font-medium tracking-wider uppercase text-text-subtle",
  sectionSep:    "my-2 border-t border-line/50",
} as const;
```

- 아이템 반경: `--nav-item-radius` → `--radius-md` (8px), dense → `--radius-sm` (6px)

### 7.7 Popover / Tooltip / Dropdown

모든 오버레이 표면은 동일 처리: `bg-surface-raised`, `1px solid var(--color-border)` (여기서는 CSS border OK — 상태 변화 없음), `shadow-md`, 반경 `--popover-radius` → `--radius-xl` (16px). 입장: fade + `translateY(-4px)`→`0`.

---

## 8. Theme Switching

### 8.1 트리거

**`.dark` 클래스(단일)가 light/dark의 유일한 트리거.** `[data-theme="dark"]`는 deprecated.

```ts
export function applyTheme(theme: "light" | "dark") {
  document.documentElement.classList.toggle("dark", theme === "dark");
}
export function initTheme() {
  const saved = localStorage.getItem("oxi-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved === "dark" || (!saved && prefersDark) ? "dark" : "light");
}
```

- **저장 키:** `oxi-theme` (oxios는 현재 `oxios-theme` → 마이그레이션 필요)
- **oxinot:** Tauri WebKit. `NSAppearanceChange` 수신 → Tauri 이벤트 → JS가 `.dark` 적용. macOS 타이틀바는 OS 설정 따름.

### 8.2 FOUC 방지 (web)

`<head>` 최상단, Tailwind CSS 요청 **이전**에 인라인 스크립트:

```html
<script>
  (function () {
    try {
      var t = localStorage.getItem("oxi-theme");
      var d = t === "dark" || (t == null && matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.classList.toggle("dark", d);
    } catch (_) {}
  })();
</script>
```

### 8.3 Tailwind dark 변형

`theme.css`에 한 번 선언, **토큰에만 스코프**:

```css
@custom-variant dark (&:where(.dark, .dark *));
```

컴포넌트 코드는 절대 `dark:bg-*`를 쓰지 않는다. 모든 테임 반응은 `.dark { … }` 내에서 전환되는 시맨틱 토큰을 통해 흐른다.

### 8.4 2축 확장 (미래)

브랜드 테마 추가 시 `[data-theme="brand-x"]`를 **독립 축**으로 사용: `.dark` = light/dark 축, `[data-theme="..."]` = 변형 축. 직교.

---

## 9. Motion & Animation

```css
:root {
  --duration-fast:  120ms;   /* 호버, 포커스, 토글 */
  --duration-base:  200ms;   /* 다이얼로그, 팝오버 */
  --duration-slow:  350ms;   /* 모달, 페이지 전환 */
  --ease-out:       cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out:    cubic-bezier(0.4, 0, 0.2, 1);
}
```

- `prefers-reduced-motion: reduce`는 모든 지속시간을 0으로, 드리프트/패럴랙스/리프트 비활성화.
- oxipage canvas 모드는 자동으로 `grid`로 폴백. oxinot 캡처 오버레이는 즉시 표시.
- 호버/액티브는 CSS `:hover` / `:active`만 — `onMouseEnter`/`onMouseLeave` 금지.

### 9.1 캡처 오버레이 (oxinot 특화)

warm-up 전략: 화면 밖 좌표 `visible: true`로 생성 → 첫 표시 **≤ 16ms** (NSWindow 재할당 없음). 저장 경로 ≤ 50ms.

### 9.2 캔버스 드리프트 (oxipage 특화)

```ts
type CanvasParams = {
  drift_amplitude_px: number;   // 기본 12
  drift_period_s:     number;   // 기본 14
  seed:               string;   // 기본 "stable-per-day"
};
```

초기 위치는 단순 충돌 회피 패스로 1회 계산. 드리프트는 CSS `transform: translate(...)` 키프레임 — JS rAF 루프 아님.

---

## 10. Iconography

| 속성 | 값 |
|---|---|
| 라이브러리 | **lucide-react** (세 프로젝트 공통) |
| 스타일 | 미니멀 라인, 1.5px stroke |
| 기본 사이즈 | `size-4` (16px) — 트레일링 인라인, 수직 중앙 |
| 색상 | 컨텍스트 따라 `text-text-muted` 또는 시맨틱 |

- 셀렉트 체브론: trailing, `size-4`, `text-text-muted`, `shrink-0`.
- 상태 아이콘은 항상 라벨과 페어 (색 단독 금지, §접근성).

---

## 11. Project-Specific Adaptations

공통 문법은 §1–10. 아래는 각 프로젝트가 **그 위에** 갖는 고유 표면 정체성.

### 11.1 oxinot (Tauri macOS app) — 기준 레퍼런스

- **스택:** React 19 + TS 5 + Vite, **Base UI**(헤드리스) + Tailwind v4, `@tanstack/react-virtual` + `react-query`, zustand, lucide-react, motion.
- **창 크롬:** `titleBarStyle: overlay` + 커스텀 툴바(검색 인라인). Arc/Linear 패턴.
- **카드 그리드:** `repeat(auto-fill, minmax(240px,1fr))`, 균일 높이, 가상화. §7.2 (oxinot DESIGN.md).
- **Hue 라벨:** 선택적 2px 왼쪽 바 `bg-hue-{name}`. OKLCH 입력 clamp (`lib/color.ts`).
- **상태색:** 메인 앱에서 미사용 — oxinot에는 "running/failed" 의미가 없음. 토큰에는 미래용으로 정의됨.
- **마이그레이션 상태:** 현재 `app.css`는 레거시 hex(`#18181b`, `#e7e7ea`) + Inter/Pretendard. `.dark` 트리거는 이미 올바름. SUIT/SUITE 도입 + hex→OKLCH 토큰 전환이 필요. `doc/DESIGN.md`에 폰트/스케일이 없었음 — 이 문서가 최초 정의.
- **OKLCH 라벨 팔레트(`lib/color.ts`):** 이미 정규 6-hue 값과 일치. 이것이 전 생태계 라벨 시스템의 원천.

### 11.2 oxipage (Vite web)

- **스택:** React 19 + Vite + Tailwind v4, Radix 프리미티브(a11y), shadcn 방식 로컬 소유 컴포넌트.
- **로비 모드:** `list`, `grid`, `canvas`. canvas 기본값: 진폭 12px / 주기 14s / seed `stable-per-day`. reduced-motion → `grid`.
- **별점 골드 (oxipage 고유, 유지):** `--p-gold-500: oklch(78% 0.15 85)`, `--p-gold-600: oklch(68% 0.15 85)`. "잉크에 찍은 금박" 톤. 별점 전용 — 6-hue 라벨과 분리.
- **마이그레이션:**
  1. `tokens.css`: `[data-theme]` → `.dark` / `:root`. pine green 악센트 → 6-hue 라벨 + interactive-primary.
  2. Pretendard → SUIT, Fraunces → SUITE. **line-height 재보정 필요** (Pretendard x-height이 SUIT보다 ~2% 큼: 1.55→1.50 본문, 1.5→1.45 소형).
  3. radius: `--radius-md` 0.75rem(12px) → 정규 0.5rem(8px) 정렬 검토.
  4. 콘솔 사이드바 레거시 그린(`#22c55e`): v1 유지, v2에서 `bg-status-success`로 교체.
  5. `[data-public-theme]` 퍼블릭 테마 축(6테마): 독립 변형 축으로 유지 (§8.4와 동일 원리).

### 11.3 oxios (Vite web)

- **스택:** React 19 + Vite + Tailwind v4, Base UI + shadcn 방식, TanStack Query/Router, Zustand.
- **상태색:** 주 메커니즘. 모든 에이전트 상태가 `text-status-{success|warning|error|info}` + 페어된 아이콘+라벨로 표면화.
- **밀도:** `gap-2`(8px) 기본 리듬; 섹션 간격 `gap-4`(16px).
- **마이그레이션:** 가장 앞서 있음. 3-tier 토큰 완료. 남은 작업:
  1. 산재 `dark:` 리터럴 → 시맨틱 토큰 스윕.
  2. 저장 키 `oxios-theme` → `oxi-theme` (부트 시 1회 마이그레이션: 기존 키 복사 후 삭제).
  3. 에디터 폰트 프리셋에서 `'Serif'` 제거(§4.1 세리프 금지에 위배), `'Geist Sans'` deprecated.
  4. Geist Mono는 유지(SUIT 모노 변형 없음).
- **차트/메시지 토큰(oxios 고유):** `--chart-1..5`, `--message-task/status/result/query/handshake` — 대시보드 전용. 유지.

---

## 부록 A: 토큰 계층 파일 구조 (per project)

```
src/
├── tokens/
│   ├── primitives.css       ← Tier 1: OKLCH 램프 (hues, neutrals)
│   ├── semantic.css         ← Tier 2: light theme 시맨틱 별칭
│   ├── semantic-dark.css    ← Tier 2: dark theme override (.dark)
│   ├── components.css       ← Tier 3: 컴포넌트형 별칭
│   └── theme.css            ← @theme inline 노출 (Tailwind 유틸리티)
└── components/              ← Tailwind 유틸리티만 소비
```

### 네이밍 규칙

| 계층 | 패턴 | 예 |
|---|---|---|
| Primitive | `--p-{hue}-{step}` | `--p-neutral-100`, `--p-red-500` |
| Semantic | `--color-{role}-{variant?}` | `--color-surface`, `--color-text-muted`, `--color-hue-red` |
| Component | `--{component}-radius` / `--input-shadow` | `--button-radius`, `--card-radius` |
| Utility | `{role}-{variant?}` (Tailwind) | `bg-surface`, `text-text-muted`, `border-line`, `bg-hue-red` |

**단일 규칙:** 컴포넌트 코드는 Tailwind 유틸리티만 쓴다. `var(--color-*)` 직접 읽기 금지, 프리미티브 import 금지, `dark:` 금지.

---

## 부록 B: 금지 패턴 (component code)

- `bg-zinc-*`, `text-gray-*` — 시맨틱 유틸리티 사용
- hex, `rgb()`, `hsl()` — OKLCH만, 토큰 계층만
- `dark:` 변형 — 토큰 파일에서만
- `[data-theme="dark"]` — `.dark` 클래스 사용 (`[data-theme="brand-x"]` 변형 축은 허용)
- 인풋/셀렉트에 CSS `border` — `box-shadow` 사용
- `React.FC`, `React.ElementRef`, `defaultProps`
- 정체성 폰트로 세리프
- 호버에 `onMouseEnter`/`onMouseLeave` — CSS만

---

## 부록 C: 에이전트 빠른 참조

| 필요 | 사용 |
|---|---|
| 페이지 배경 | `bg-surface text-text` |
| 카드 | `bg-surface-raised text-text border border-line rounded-[var(--card-radius)] shadow-sm` |
| 뮤트 텍스트 | `text-text-muted` |
| 상태 성공 | `text-status-success bg-status-success-subtle` |
| 노트 라벨 | `bg-hue-{red\|amber\|green\|teal\|blue\|purple}` |
| 포커스 링 | 버튼/링크: `focus-visible:outline-2 focus-visible:outline-focus-ring`. 인풋: `focus-visible:outline-none shadow-[var(--input-shadow-focus)]` |
| 디스플레이 헤딩 | `font-display` (SUITE로 해석) |

---

*이 문서는 정규 스펙 `oxi-design-system` 매니지드 스킬(`~/.omp/agent/managed-skills/oxi-design-system/DESIGN.md`) 및 `oxios/web/DESIGN.md` v1.0과 값이 일치한다. 권위 순서: 매니지드 스펙 = 이 문서 > 각 프로젝트 개별 문서.*
