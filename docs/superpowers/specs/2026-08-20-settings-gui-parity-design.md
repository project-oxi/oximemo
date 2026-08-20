# Settings GUI Parity — TOML 전 필드 GUI화

> **날짜:** 2026-08-20
> **상태:** 구현 완료 (2026-08-20 · 게이트/프리뷰 검증 통과)
> **원칙 (사용자 선언):** TOML로 설정할 수 있는 것은 모두 GUI로도 설정할 수
> 있어야 한다. 역방향도 성립 — GUI가 없는 죽은 TOML 필드는 제거한다.

## 1. 필드 감사 (2026-08-20 실측)

| 필드 | 사용처 | GUI 현황 | 조치 |
|---|---|---|---|
| `brain.enabled` | 패널 표시/글루 게이트 | 없음 | **추가** |
| `brain.socket` | 접속 경로 | 없음 | **추가** |
| `brain.space` | recall/stats 스페이스 | 없음 | **추가** + 데몬 목록 선택 |
| `general.trash_retention_days` | vault.rs:1138 휴지통 파기 | 없음 | **추가** |
| `capture.double_tap_threshold_ms` | lib.rs:126 더블 트리거 | 없음 | **추가** |
| `capture.overlay_max_height` | **사용 없음** | 없음 | **배선** 후 추가 |
| `appearance.theme` | 프론트 localStorage만 | GUI 있으나 TOML 미기록 | **쓰기-스루** 추가 |
| `appearance.show_dock_icon` | **사용 없음** | 없음 | **배선**(활성화 정책) 후 추가 |
| `index.watcher_debounce_ms` | vault.rs:1037 + 메뉴 | 없음 | **추가** (고급) |
| `index.watcher_retry_count` | **사용 없음** | 없음 | **제거** |
| `index.watcher_retry_interval_ms` | **사용 없음** | 없음 | **제거** |
| `folders.items` | 폴더/뷰/색 | CRUD + 뷰 설정 있음 | 변경 없음 |
| `schema_version` | 마이그레이션 마커 | — | 시스템 필드, 제외 |

죽은 필드 제거는 읽기 호환(serde는 unknown 필드 무시)이라 기존
`oximemo.toml`은 그대로 파싱된다.

## 2. 설계

### 2.1 Rust (oximemo-core)

`vault.rs`에 섹션 단위 setter — `set_folder_view`의 지속 패턴(write guard →
`cfg.save(&self.paths)`) 재사용:

```rust
pub fn set_brain_config(&self, v: BrainConfig) -> Result<()>
pub fn set_general_config(&self, v: GeneralConfig) -> Result<()>
pub fn set_capture_config(&self, v: CaptureConfig) -> Result<()>
pub fn set_appearance_config(&self, v: AppearanceConfig) -> Result<()>
pub fn set_index_config(&self, v: IndexConfig) -> Result<()>
```

`IndexConfig`에서 retry 2필드 제거. `CaptureConfig`/`AppearanceConfig`는
기존 필드 그대로 (overlay_max_height, show_dock_icon을 실제로 배선).

### 2.2 Rust (src-tauri)

- 위 5 setter를 tauri command로 노출. `set_appearance_config`는 저장 후
  독 아이콘 활성화 정책(NSApp `setActivationPolicy`)을 즉시 반영.
- setup에서 `appearance.show_dock_icon=false`면 Accessory로 기동.
- `brain_list_spaces`: `brain_connect` → `client.list_spaces()`. 오프라인은
  정상 상태 — `{online: false, spaces: []}` (C1).

### 2.3 배선

- **overlay_max_height**: QuickCaptureForm 스크롤 영역 `maxHeight` 적용.
  창(560×200 고정) 안에서 카드가 캡을 넘으면 내부 스크롤.
- **show_dock_icon**: objc2-app-kit `NSApplication::setActivationPolicy`
  (Regular/Accessory). 트레이 아이콘은 유지 — 트레이가 앱의 상주 표면.
- **theme 쓰기-스루**: `onTheme`에서 localStorage(현행 유지) + TOML 동시
  기록. 기존 사용자 경험 불변 — 로드 우선순위는 현행대로.

### 2.4 GUI (SettingsMenu)

새 섹션 (기존 Section/스타일 재사용):

1. **Brain** (Brain 아이콘): enabled 토글, socket 텍스트 입력(빈=기본 경로
   안내), space — 데몬 온라인 시 목록 선택 + 새로고침, 오프라인 시 자유 입력.
2. **동작(General)**: 휴지통 보존 일수(숫자).
3. **캡처**: 더블 트리거 임계값(ms), 오버레이 최대 높이(px).
4. **고급(Index)**: 와처 디바운스(ms).
5. **외관**: 독 아이콘 토글 추가.

변경 즉시 저장(자동저장, 별도 Save 버튼 없음 — 폴더/테마 섹션 관례).
`config` 쿼리 무효화로 BrainPanel이 즉시 반응.

### 2.5 프리뷰 모의 (tauri.ts)

`set_*_config` 5종 + `brain_list_spaces` 모의 추가 — 브라우저 프리뷰에서
설정 UI 검증 가능.

## 3. 검증

1. core 단위: 각 setter 라운드트립(기본→변경→TOML 재파싱), retry 필드
   제거 후 기존 TOML 파싱 호환.
2. 게이트: fmt/clippy(-D warnings)/테스트/bun build.
3. 브라우저 프리뷰 스크린샷: 신규 섹션 렌더링 확인.
4. 실제 앱(수동): 독 토글 즉시 반영, 휴지통 보존일 반영.
