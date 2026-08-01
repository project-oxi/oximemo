# 빠른 캡처 라이프사이클 — 토글 · 외부클릭 닫기 · 메뉴바 아이콘 Design Spec

**Date:** 2026-08-01
**Status:** Approved
**Scope:** 빠른 캡처 오버레이의 세 가지 동작 보강 — (1) 단축키/더블탭 재입력 시 토글 닫기, (2) 캡처 창 바깥 클릭 시 자동 닫기, (3) macOS 메뉴바(상태표시줄) 트레이 아이콘 추가.

## 1. 목표

- **토글 닫기:** 캡처 창이 열려 있을 때 `⌘+Shift+N` 또는 Option 더블탭을 다시 입력하면 창이 닫힌다. 현재는 두 트리거 모두 항상 `show_capture`만 호출해 무조건 연다.
- **외부 클릭 닫기:** 캡처 창이 열린 상태에서 데스크톱·다른 앱·메인 창 등 창 바깥을 클릭하면 자동으로 닫힌다.
- **메뉴바 아이콘:** 상태표시줄에 oximemo 아이콘이 표시되고, **좌클릭 시 드롭다운 메뉴**가 열린다(표준 macOS 메뉴바 앱 동작).

## 2. 접근법 결정

### 2.1 토글 → `show_capture` 가시성 분기 (채택)

**근거:**
- 두 트리거(글로벌 단축키 핸들러 `lib.rs:53-57`, Option 더블탭 콜백 `lib.rs:63-66`)가 모두 `show_capture(&handle)`를 호출. 한 함수만 고치면 양쪽에 동일 적용.
- `show_capture` 진입에서 `win.is_visible()`을 검사해 참이면 `hide()` + `capture:hide` emit 후 반환, 거짓이면 기존 위치지정·show·focus 로직. 단일 분기, ~6줄.
- 외부 클릭으로 이미 숨겨진 뒤엔 `is_visible()`이 거짓이므로 재입력 = 다시 열기. 의도 정확히 부합.

**배제:** 프론트엔드 단의 가시성 추적 — 진실의 원천이 OS 윈도우 상태이므로 Rust `is_visible()`이 권위.

### 2.2 외부 클릭 닫기 → Rust `WindowEvent::Focused(false)` (채택)

**근거:**
- 캡처 창은 하단 중앙 560×200 투명 필. 창 바깥(데스크톱·타 앱·메인 창) 클릭은 캡처 webview에 닿지 않으므로 프론트엔드 클릭 감지·백드롭으로는 불가능.
- OS 레벨 포커스 상실이 정확한 신호. `tauri::Builder::on_window_event`에서 창 라벨 `"capture"`로 필터 후 `WindowEvent::Focused(false)` → `win.hide()`.
- `SlashCategoryMenu`는 캡처 창 **안**의 DOM 팝오버(`QuickCaptureForm.tsx:63`) → 같은 NSWindow → 포커스 상실 유발 안 함. 오탐 안전.
- 동작은 기존 Escape 닫기(`CaptureOverlay.tsx:43`)와 동일한 park/hide. 재오픈 시 `capture:show`가 상태 초기화(기존 동작 유지).
- **허구 self-dismiss 가드:** show 직후 토글/포커스 시퀀스에서 허구의 `Focused(false)`가 즉시 발생해 창이 자기닫힘할 위험을 막기 위해 `AppState.capture_focused: AtomicBool` 도입. `Focused(true)` → true, `Focused(false)` → 직전에 true였을 때만 hide + false. show 시퀀스 도중 false가 먼저 오면 무시. 시간 기반 hack보다 상태 기반이 정확.

**배제:** 시간 기반 디바운스(timestamp guard) — 정확한 포커스 상태 기반보다 불안정. JS `blur` 리스너 — 위에서 기술한대로 외부 클릭 감지 불가.

### 2.3 메뉴바 트레이 아이콘 → 단색 template 이미지 + 좌클릭 메뉴 (채택)

**근거:**
- Tauri 2 `tray-icon` 피처가 이미 활성화(`Cargo.toml:22`). 신규 의존성 없음.
- macOS 메뉴바 아이콘은 단색 template 이미지(16–22px)여야 라이트/다크에 자동 적응. `app.default_window_icon()`(풀컬러) 재사용 시 muddy/비표준 → 단색 glyph를 신규 자산으로 생성 후 `icon_as_template(true)`.
- `show_menu_on_left_click(true)` → **좌클릭 = 드롭다운 메뉴**(표준 macOS). 우클릭도 동일 메뉴.
- 메뉴 항목: `빠른 캡처` / `메인 창 보기` / 구분선 / `종료`.
  - `빠른 캡처` → `show_capture`(2.1 토글과 동일 로직)
  - `메인 창 보기` → `main` 창 show + focus
  - `종료` → `app.exit(0)`

**배제:** 좌클릭 = 캡처 토글(사용자 거부) — "상태표시줄 앱은 좌클릭하면 메뉴가 열리는 게 표준"이므로 드롭다운 메뉴로 통일. dock 제거/LSUIElement 전환 — "아이콘도 떠야 해(추가)"이므로 기존 dock + 메인 창 라이프사이클 유지.

### 2.4 트레이 메뉴 언어 → 프론트엔드 locale 동기화 (채택)

**근거:**
- 앱 locale은 프론트엔드 `localStorage`(`oximemo.locale`)에만 존재(`i18n.tsx:19,42`). Rust가 직접 읽을 수 없음.
- 시작 시엔 시스템 locale(`LANG`)로 기본 메뉴 구성, 프론트엔드 로드 후 `set_menu_locale` 커맨드로 사용자가 선택한 locale로 메뉴 라벨 재구성. 앱 locale 설정과 트레이 메뉴가 항상 일치.
- `ko` 시작이 아니면 `en`(프론트엔드 `detectInitial`과 일치).

## 3. 아키텍처

변경은 `apps/desktop/src-tauri/src/lib.rs`(Rust)와 `apps/desktop/src/lib/i18n.tsx`(프론트엔드)에 집중. 신규 자산 1개(template PNG).

### 3.1 `lib.rs` — `show_capture` 토글화

```
fn show_capture(handle: &AppHandle) {
    let Some(win) = capture_window else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        let _ = handle.emit("capture:hide", ());
        return;
    }
    // … 기존 위치지정 + show + set_focus + emit capture:show 그대로
}
```

### 3.2 `lib.rs` — 포커스 상실 닫기

`Builder` 체인에 추가:

```
.on_window_event(|window, event| {
    if window.label() != "capture" { return; }
    let Some(state) = window.app_handle().try_state::<AppState>() else { return };
    match event {
        WindowEvent::Focused(true)  => state.capture_focused.store(true, Ordering::Relaxed),
        WindowEvent::Focused(false) => {
            if state.capture_focused.swap(false, Ordering::Relaxed) {
                let _ = window.hide();
                let _ = window.app_handle().emit("capture:hide", ());
            }
        }
        _ => {}
    }
})
```

`AppState`에 `pub capture_focused: AtomicBool` 추가.

### 3.3 `lib.rs` — 트레이 아이콘 + 메뉴

setup 단계에서:

```
let menu = build_tray_menu(app, &default_locale())?;   // 빠른 캡처 / 메인 창 보기 / ─ / 종료
TrayIconBuilder::with_id("main-tray")
    .icon(Image::from_bytes(include_bytes!("../icons/tray-template.png"))?)
    .icon_as_template(true)
    .menu(&menu)
    .show_menu_on_left_click(true)
    .on_menu_event(|app, event| match event.id().as_ref() {
        "capture" => show_capture(app),
        "show"    => { show_main_window(app); }
        "quit"    => app.exit(0),
        _ => {}
    })
    .build(app)?;
```

`build_tray_menu(app, locale) -> Result<Menu>` 헬퍼 — locale별 라벨로 `MenuItem` + `PredefinedMenuItem::separator` 조립. `set_menu_locale` 커맨드는 `app.tray_by_id("main-tray")` → `set_menu(&build_tray_menu(...))`로 재구성.

`AppState`에 `pub menu_locale: parking_lot::Mutex<String>` 추가.

### 3.4 `i18n.tsx` — locale 백엔드 동기화

기존 locale effect(`i18n.tsx:41-44`)에 한 줄 추가:

```
useEffect(() => {
  localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.lang = locale;
  void invoke("set_menu_locale", { locale });   // ← 추가
}, [locale]);
```

`invoke`는 이미 `lib/tauri.ts`에서 사용 중. capture 창에서도 호출되지만 동일 결과(idempotent).

### 3.5 template 아이콘 자산

`apps/desktop/src-tauri/icons/tray-template.png` — 단색(검정 + 투명) 22×22(@2x 44×44) glyph. oximemo의 "o" 마크 또는 펜촉 중 단순형. `icon_as_template(true)`로 다크모드 자동 반전.

## 4. 상호작용 매트릭스

| 상태 | 트리거 | 결과 |
|---|---|---|
| 닫힘 | 단축키 / 더블탭 | 열림(show+focus) |
| 열림 | 단축키 / 더블탭 | **닫힘**(토글) |
| 열림 | 창 바깥 클릭 | **닫힘**(포커스 상실) |
| 열림 | Esc | 닫힘(기존, 유지) |
| — | 메뉴바 좌클릭 | 드롭다운 메뉴 |
| — | 메뉴 `빠른 캡처` | show_capture(토글) |
| — | 메뉴 `메인 창 보기` | main 창 show+focus |
| — | 메뉴 `종료` | 앱 종료 |

## 5. 비목표

- dock 아이콘 제거 / LSUIElement 전환(메뉴바 전용 앱화) — "추가" 의도이므로 기존 동작 유지.
- 메인 창 닫기=종료 동작 변경 — 유지.
- 캡처 드래프트(입력 중 텍스트) 보존 — 재오픈 시 `capture:show` 초기화가 기존 동작이며 유지. 외부 클릭 닫기도 동일.

## 6. 검증

- **컴파일:** `cargo build -p oximemo-desktop`(Rust 타입·API 검증), `bun run build`(프론트엔드 tsc).
- **토글:** 캡처 열림 상태에서 단축키 재입력 → 닫힘 확인.
- **외부 클릭:** 캡처 열림 상태에서 데스크톱 클릭 → 닫힘. 슬래시 카테고리 메뉴(인윈도우) 조작 시에는 닫히지 않음 확인.
- **self-dismiss 가드:** show 직후 창이 자기닳힘하지 않는지 확인.
- **트레이:** 메뉴바 아이콘 표시, 좌클릭 메뉴 오픈, 각 메뉴 항목 동작, 다크/라이트 모드에서 아이콘 가시성.
- **locale:** 앱 locale 전환 시 트레이 메뉴 라벨이 즉시 전환.

## 7. 참조

- `apps/desktop/src-tauri/src/lib.rs:53-57` — 글로벌 단축키 핸들러.
- `apps/desktop/src-tauri/src/lib.rs:60-72` — Option 더블탭 모니터 시작.
- `apps/desktop/src-tauri/src/lib.rs:139-194` — `show_capture`(토글 대상).
- `apps/desktop/src-tauri/Cargo.toml:22` — `tray-icon` 피처 활성.
- `apps/desktop/src/components/QuickCaptureForm.tsx:63` — `SlashCategoryMenu`(인윈도우 DOM 팝오버, 오탐 회피 근거).
- `apps/desktop/src/components/CaptureOverlay.tsx:43` — 기존 Escape 닫기.
- `apps/desktop/src/lib/i18n.tsx:19,41-44` — locale 영속화 effect(동기화 지점).
- `apps/desktop/src-tauri/tauri.conf.json:24-38` — capture 창 속성.
