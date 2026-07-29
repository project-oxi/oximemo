---
name: oxinot-build-install
description: Use when the user asks to build, install, compile, or package the oxinot desktop .app bundle — triggers on phrases like "앱 설치해줘", "build the app", "install oxinot", ".app 만들어줘", "로컬 빌드". Does NOT handle code signing/notarization for distribution; use the release workflow for that.
---

# oxinot 로컬 .app 빌드 + 설치

소스에서 macOS `.app` 번들을 `/Applications`에 빌드하고 설치하는 절차.

## Prerequisites

- macOS 14+ (Apple Silicon, `aarch64-apple-darwin`)
- Rust 1.89+ (`rust-toolchain.toml` 기준)
- Bun 1.3.14+
- 프로젝트 루트 (`/Volumes/MERCURY/PROJECTS/oxinot`)

> **`cargo tauri build`는 알려진 Cargo proc-macro 해석 버그로 작동하지 않는다.** 반드시 아래 수동 조립 절차를 따라야 한다.

## 절차

### 1. 프론트엔드 빌드

```bash
cd apps/desktop
bun install --frozen-lockfile
bun run build            # tsc -b && vite build → dist/ 생성
```

### 2. Stale proc-macro 아티팩트 정리

`tauri-custom-protocol` feature 빌드에서 `tauri-macros` E0463 버그가 발생할 수 있다. 원인: `custom-protocol` 없이 먼저 컴파일된 proc-macro가 feature 변경 후 재컴파일되지 않는 Cargo fingerprinting 문제.

```bash
rm -rf target/release/deps/libtauri_macros*
rm -rf target/release/.fingerprint/tauri-macros*
```

### 3. 데스크톱 바이너리 빌드

```bash
cargo build -p oxinot-desktop --release
```

→ `target/release/oxinot-desktop` (Mach-O 64-bit arm64, ~10 MB)

### 4. .app 번들 조립

```bash
APP="/tmp/oxinot.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 바이너리
cp target/release/oxinot-desktop "$APP/Contents/MacOS/"
chmod +x "$APP/Contents/MacOS/oxinot-desktop"

# 아이콘
cp apps/desktop/src-tauri/icons/icon.icns "$APP/Contents/Resources/"

# 프론트엔드 자산 (custom-protocol 없이 tauri:// 로드)
cp -R apps/desktop/dist "$APP/Contents/"

# Info.plist
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>oxinot-desktop</string>
    <key>CFBundleIdentifier</key>
    <string>com.oxinot.app</string>
    <key>CFBundleName</key>
    <string>oxinot</string>
    <key>CFBundleVersion</key>
    <string>0.2.0</string>
    <key>CFBundleShortVersionString</key>
    <string>0.2.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleIconFile</key>
    <string>icon.icns</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSUIElement</key>
    <false/>
</dict>
</plist>
PLIST
```

### 5. Ad-hoc 서명 + 설치

```bash
codesign -d --force -s - "$APP"
cp -R "$APP" /Applications/
open /Applications/oxinot.app
```

### 6. 실행 확인

```bash
ps aux | grep "[o]xinot-desktop"
# 정상 RSS: ~100-110 MB (DESIGN 목표 150MB 이내)
```

## 알려진 문제

| 문제 | 증상 | 해결 |
|:---|:---|:---|
| `cargo tauri build` 실패 | `error[E0463]: can't find crate for tauri_macros` | 위 수동 조립 절차 사용 |
| Gatekeeper 차단 | "확인되지 않은 개발자" | Finder 우클릭 > 열기 |
| Option 더블탭 무반응 | 전역 캡처 동작 안함 | 설정 > 개인정보 보호 및 보안 > 손쉬운 사용 > 입력 모니터링 활성화 |

## CLI만 필요하면

```bash
cargo build --release -p oxinot-cli
# target/release/oxinot
```
