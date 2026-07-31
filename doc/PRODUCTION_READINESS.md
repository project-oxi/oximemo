# oxinot 프로덕션 전환 진단 보고서 및 설계

> 작성일: 2026-07-29 · 대상: oxinot v0.2.0 (`prod-readiness` 브랜치)
> 범위: macOS(Apple Silicon) 단일 타겟 — CLI + Tauri 데스크톱 앱 전체

---

## 0. 결론 (TL;DR)

**현재 상태: 기능 구현은 완료됐으나 "실사용자 배포" 기준으로는 아직 프로덕션 준비가 안 된 상태.**

세 가지 **Critical** 차단 요소가 있다. 이것만 해결해도 Gatekeeper 경고 없이 .dmg 배포가 가능해지고, 정전·크래시 상황에서 노트가 사라지지 않는다.

| # | 차단 요소 | 영향 | 현재 상태 |
| :-: | :--- | :--- | :--- |
| C1 | **번들/서명/엔타이틀먼트 설정 부재** (`tauri.conf.json`에 `bundle` 섹션 없음) | Gatekeeper가 모든 사용자에게 "확인되지 않은 개발자" 차단. Input Monitoring/Accessibility 권한 작동 불가. DESIGN §6.5가 명시적으로 요구한 Developer ID 서명 + 공증 + Hardened Runtime + entitlements가 설정에 반영되지 않음. | ❌ 미설정 |
| C2 | **원자적 쓰기 디렉토리 fsync 누락** (`store/files.rs:274`) | 정전/크래시 시 rename이 디스크에 flush되지 않아 노트 유실 가능. `atomic_write`·`move_to_trash`·`restore_from_trash` 모두 동일 패턴. | ⚠️ 부분 구현(파일 fsync O, 디렉토리 fsync X) |
| C3 | **동일 노트 동시 쓰기 시 임시파일 충돌** (`store/files.rs:279`) | 임시파일 경로가 타깃 경로에서만 유도됨. CLI와 GUI가 같은 노트를 동시에 쓰면 `.tmp` 파일을 서로 덮어쓴다. | ❌ 버그 |

이 보고서는 이후 섹션에서 전체 발견사항(Critical 3 · High 6 · Medium 9)을 나열하고, §6에서 수정 설계를, §7에서 본 브랜치에서 적용한 조치를 기술한다.

---

## 1. 진단 방법론

5개 영역을 병렬 감사했다.

1. **Rust 코어 견고성** (`oxinot-core` + `oxinot-capture`) — 패닉 안전성, 원자적 쓰기, 워처/락/경로 안전
2. **데스크톱 백엔드** (`apps/desktop/src-tauri`) — Tauri 커맨드 에러 처리, IPC 입력 검증, 윈도우 생명주기
3. **프론트엔드** (`apps/desktop/src`) — 에러 바운더리, 로딩/에러 상태, 가상화 정확성
4. **배포/릴리스/CI** — 코드 서명/공증, 번들 설정, 버전 일관성
5. **설정/빌드** — Cargo 프로파일, 툴체인, 아이콘

각 발견사항은 심각도(Critical/High/Medium/Low)와 함께 실제 코드 위치를 근거로 제시한다.

---

## 2. 영역별 현재 상태 평가

| 영역 | 상태 | 비고 |
| :--- | :---: | :--- |
| 코어 로직 정확성 | ✅ 양호 | 3단 저장소(파일·redb·tantivy), 해시 정규화, 동기화 알고리즘 모두 테스트 커버. `unsafe` 없음. |
| 에러 모델 | ✅ 양호 | `CoreError` thiserror 기반, `Frontmatter` 등 복구 가능 에러 분리 양호. |
| 프로세스 간 락 | ✅ 양호 | `fs2` flock, shared/exclusive 구분, 5s 타임아웃, Drop 시 해제 — 설계대로 구현됨. |
| 원자적 쓰기 내구성 | ⚠️ 부분 | 파일 fsync는 함, 디렉토리 fsync 누락 (C2). |
| 데이터 무결성 | ⚠️ | `reindex`가 노트당 tantivy commit → 10만 건 시 분 단위 지연 (H3). |
| 프론트엔드 에러 처리 | ❌ 부족 | ErrorBoundary 없음 (H4), 저장 실패 무음 처리 (H5). |
| 배포 파이프라인 | ❌ | 번들 설정 부재 (C1), PR CI가 데스크톱 크레이트 미검증 (H6). |
| CI 기본 | ✅ 양호 | fmt/clippy/test + 프론트 빌드. concurrency 취소 정상. |
| 릴리스 자동화 | ⚠️ | `release.yml` 구조는 건전(서명 시크릿 연결됨)이나 번들 설정이 비어 있어 실제 서명이 제대로 적용되지 않음. |

---

## 3. 발견사항 — Critical

### C1. 번들·서명·엔타이틀먼트 설정 부재
- **위치**: `apps/desktop/src-tauri/tauri.conf.json` (전체), `apps/desktop/src-tauri/capabilities/default.json`
- **현상**: `tauri.conf.json`에 `bundle` 섹션이 아예 없다. macOS 배포에 필수인 항목이 전부 누락:
  - `bundle.macOS.entitlements` (엔타이틀먼트 파일 경로) — 없음
  - Hardened Runtime 활성화 / `com.apple.security.cs.disable-library-validation` — 없음
  - `bundle.macOS.minimumSystemVersion` — 없음 (DESIGN은 "macOS 14+" 명시)
  - `bundle.icon` / 아이콘 세트 — `icons/`에 `icon.png` 하나뿐, `.icns`/`128x128.png`/`32x32.png` 없음 → Tauri 번들 실패 또는 빈 아이콘
  - `bundle.publisher` / `bundle.copyright` — 없음
  - `LSUIElement`(메뉴바 전용 모드, DESIGN §6.5) — Info.plist 설정 없음
- **영향**: (1) 코드 서명해도 Input Monitoring / Accessibility 엔타이틀먼트가 없으면 Option 더블탭 전역 캡처가 동작하지 않는다 — **이 앱의 핵심 기능이 작동하지 않음**. (2) Gatekeeper가 모든 사용자에게 앱을 차단한다. (3) 아이콘이 없어 .dmg가 깨져 보인다.
- **DESIGN 근거**: §6.5 "Developer ID 서명 + 공증(notarization) + Hardened Runtime 필요 (전역 이벤트 모니터링 및 배포용 .dmg 배포를 위해). Input Monitoring 관련 entitlement를 Info.plist/entitlements에 명시."

### C2. 원자적 쓰기 — 디렉토리 fsync 누락
- **위치**: `crates/oxinot-core/src/store/files.rs:274-288` (`atomic_write`)
- **현상**:
  ```rust
  fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
      // ...
      let tmp = path.with_extension("md.tmp");
      { let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?; }          // ← 파일은 fsync 함 (좋음)
      std::fs::rename(&tmp, path)?;   // ← 이후 부모 디렉토리 fsync 누락!
      Ok(())
  }
  ```
- **영향**: 파일 데이터는 디스크에 flush되지만, rename 자체(디렉토리 엔트리 변경)는 fsync되지 않는다. 정전 시 파일은 있으나 디렉토리 메타데이터가 갱신되지 않아 rename이 유실 → 노트가 저장된 것처럼 보이다가 사라질 수 있다. 같은 패턴이 `move_to_trash`, `restore_from_trash`에도 적용됨.
- **정확한 패턴**: temp 파일 `fsync` → `rename` → **부모 디렉토리 `fsync`**.

### C3. 동일 노트 동시 쓰기 임시파일 충돌
- **위치**: `crates/oxinot-core/src/store/files.rs:279`
- **현상**: `let tmp = path.with_extension("md.tmp")` — 임시파일 이름이 타깃 경로에서만 결정된다. 두 프로세스(CLI `update` + 데스크톱 `update_memo`)가 같은 노트를 동시에 쓰면 같은 `<id>.md.tmp`를 사용해 서로의 임시파일을 덮어쓴다.
- **영향**: 파일 쓰기는 인덱스 락 대상이 아니다(DESIGN §5.7 규칙 5: "파일 스토어는 락 대상이 아닙니다"). 따라서 이 경쟁은 실제로 발생 가능하며, 한 쪽의 쓰기가 손상되거나 rename이 실패할 수 있다.
- **해결**: 임시파일에 고유 접미사(프로세스 ID + 카운터, 또는 `tempfile` 크레이트의 난수 접미사)를 붙인다.

---

## 4. 발견사항 — High

### H1. reindex 성능 — 노트당 tantivy commit
- **위치**: `crates/oxinot-core/src/vault.rs:324-365` (`reindex`), `store/search.rs:79-91` (`upsert`)
- **현상**: `reindex` 루프 안에서 각 노트마다 `search.upsert()`를 호출하고, `upsert`는 매번 `writer.commit()` + `reader.reload()`를 수행한다. tantivy commit은 fsync를 동반하므로 10만 건이면 10만 번의 디스크 동기화 → 수십 분.
- **영향**: `oxinot reindex`(명시적 복구)가 대용량 볼트에서 사실상 사용 불가. 복구 시나리오가 무너진다. 또한 exclusive 락을 오래 잡고 있어 CLI/GUI 접근이 차단.
- **해결**: `SearchIndex`에 `upsert_batch`를 추가하고, `reindex`는 메모리에 모아 두었다가 한 번에 commit.

### H2. doctor --fix가 쓰기 에러를 무음 처리
- **위치**: `crates/oxinot-core/src/vault.rs:450-453`
- **현상**:
  ```rust
  if fix {
      memo.hash = recomputed;
      let _ = self.files.write(&memo);   // ← 에러 무시
  }
  ```
  이후 `report.hash_mismatches.clear()` (line 484)가 "전부 고쳤다"고 가정하지만, 실제로는 쓰기가 실패한 파일이 남아 있다.
- **영향**: 사용자가 `doctor --fix`를 실행해도 해시 불일치가 조용히 남을 수 있어, 동기화 정확성이 훼손된다.
- **해결**: 쓰기 결과를 수집해 실패 건수를 리포트에 반영.

### H3. 프론트엔드에 ErrorBoundary 없음
- **위치**: `apps/desktop/src/main.tsx`
- **현상**: `<App/>`이 `<I18nProvider>` 안에 bare mount. 렌더 중 throw되면 React 19는 전체 트리를 언마운트 → **흰 화면**. 복구 불가(앱 재시작 필요).
- **해결**: 최상위에 `ErrorBoundary`를 두어 폴백 UI + "다시 시도" 버튼 제공.

### H4. 저장/삭제/업데이트 실패 무음 처리 (unhandled rejection)
- **위치**:
  - `apps/desktop/src/components/CaptureOverlay.tsx:44-54` (`save()`에 catch 없음 — `void save()`로 rejection 방출)
  - `apps/desktop/src/components/CardGrid.tsx:134-145` (`onDelete`, `onToggleFavorite` — `.then()`만, catch 없음)
  - `apps/desktop/src/components/NoteDetail.tsx:55-68` (debounce 자동저장 + close flush — `.then()`만)
- **현상**: 모든 뮤테이션이 `void fn().then(ok)` 패턴. 실패 시 rejection이 잡히지 않아 사용자에게 피드백이 없다. 특히 `NoteDetail.close()`의 flush-on-close는 실패하면 입력이 조용히 유실된다.
- **영향**: 사용자가 "저장했다"고 믿지만 실제로는 실패. 파일이 진실의 원천이므로 `reindex`로 복구는 가능하나, UX 신뢰성 훼손.
- **해결**: 각 뮤테이션에 `.catch` 추가 + 토스트/인라인 에러 표시.

### H5. PR CI가 데스크톱 백엔드를 컴파일/검증하지 않음
- **위치**: `.github/workflows/ci.yml:37,40`
- **현상**: clippy와 test가 `-p oxinot-core -p oxinot-cli -p oxinot-capture`로 스코프되어 있다. `apps/desktop/src-tauri` 크레이트는 릴리스 시점에만 컴파일된다.
- **영향**: 백엔드 회귀(컴파일 에러, clippy 위반)가 PR에서 잡히지 않고 릴리스 태그에서야 발견된다.
- **해결**: CI에 데스크톱 크레이트 `cargo check`/`clippy` 스텝 추가 (프론트 `dist/`가 필요하므로 `--no-default-features` 또는 `check`만). 또는 릴리스 빌드 전 단계로 `cargo build` 추가.

### H6. IPC 입력 검증 부재
- **위치**: `apps/desktop/src-tauri/src/lib.rs` (`mod commands`), `crates/oxinot-core/src/vault.rs` (`create_memo`/`update_memo`)
- **현상**: `create_memo(body, tags, color)`가 본문 길이·태그 수·태그 길이 제한 없이 코어로 전달. `body`에 수 MB 문자열, `tags`에 수만 개를 넣어도 처리 시도.
- **영향**: 의도치 않은/악성 입력이 인덱스와 파일 시스템을 비대하게 만들 수 있다. (단일 로컬 사용자 가정이므로 보안 위협보다 안정성 문제.)
- **해결**: 코어 진입점에서 소프트 상한 검증 (예: 본문 64KB, 태그 64개, 태그당 64자). 초과 시 `CoreError` 반환.

---

## 5. 발견사항 — Medium / Low (요약)

| ID | 심각도 | 위치 | 내용 |
| :-: | :---: | :--- | :--- |
| M1 | Medium | `store/search.rs:8,28` | `std::sync::Mutex` 사용 — 한 오퍼레이션 패닉 시 포이즈닝. 단 `panic=abort`이므로 실제 발현은 드묾. |
| M2 | Medium | `vault.rs:89-97` | `with_redb_and_search`가 호출마다 redb+tantivy 재오픈. CLI는 무해하나 GUI에서 매 노트 저장 시 오픈 비용. (의도적 설계, 트레이드오프 문서화됨.) |
| M3 | Medium | `watcher.rs:31` | debounce 스레드가 무감독. 패닉 시 워처가 조용히 죽어 외부 변경 감지 중단. |
| M4 | Medium | `Cargo.toml:61` | `panic = "abort"` — 패닉 시 즉시 프로세스 종료, 에러 다이얼로그 없음. 워처 스레드 패닉이 전체 앱을 죽임. |
| M5 | Medium | `NoteDetail.tsx:25-29` | `get_memo` 실패 시 영구 stuck-loading. 에러 상태 분기 없음. |
| M6 | Medium | `CardGrid.tsx:57-63` | 검색 최소 길이 미적용 → 1자 검색도 tantivy 쿼리 발생. |
| M7 | Medium | `CardGrid.tsx:109-114` | 빠른 필터 변경 시 infinite-scroll fetch 경쟁. |
| M8 | Low | `tauri.conf.json:43` | `macOSPrivateApi: true` (vibrancy용) — Hardened Runtime에서 엔타이틀먼트 필요. C1과 함께 해결. |
| M9 | Low | `paths.rs` | 볼트 경로 검증 부재 — `--vault`로 비정상 경로 전달 시 동작 보장 미흡 (단일 사용자 가정이라 낮음). |

---

## 6. 수정 설계 (Remediation Design)

### 6.1 배포 파이프라인 (C1, H5, H6, M8)

```
tauri.conf.json
├── bundle (신설)
│   ├── active: true
│   ├── targets: ["dmg"]                    # Apple Silicon 단일 타겟
│   ├── identifier: "com.oxinot.app"        # (최상위와 일치)
│   ├── publisher: "oxinot"
│   ├── icon: ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns"]
│   ├── macOS:
│   │   ├── minimumSystemVersion: "14.0"
│   │   ├── entitlements: "entitlements.plist"
│   │   ├── exceptionDomain: ""             # 불필요
│   │   └── frameworks: []
│   └── copyright: "© 2026 oxinot"
└── app.macOSPrivateApi: true               # vibrancy (엔타이틀먼트로 보완)

entitlements.plist (신설, src-tauri/)
├── com.apple.security.app-sandbox: false       # 풀 디스크(볼트) 접근 + 전역 키 모니터
├── com.apple.security.cs.disable-library-validation: true   # objc2 동적 로딩
├── com.apple.security.automation.apple-events: false
└── (Input Monitoring / Accessibility는 macOS가 TCC로 런타임 처리 — 엔타이틀먼트 불필요, Info.plist NSAppleEventsUsageDescription 등만 정리)

아이콘: icon.png → tauri icon 명령으로 32/128/@2x/.icns 자동 생성
```

서명/공증 흐름 (`release.yml`은 이미 APPLE_* 시크릿을 Tauri에 전달):
- Tauri 2는 `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` + `APPLE_SIGNING_IDENTITY`가 있으면 **Developer ID 서명**, `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`가 있으면 **xcrun notarytool 공증 + stapler**를 자동 수행한다.
- 따라서 C1 해결은 (a) `bundle` 섹션 + 엔타이틀먼트 파일 추가, (b) 아이콘 세트 생성, (c) GitHub Secrets에 Apple 자격증명 등록(사용자 작업)으로 완결된다.

### 6.2 내구성 있는 원자적 쓰기 (C2, C3)

```rust
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    // C3: 고유 임시파일 — pid + 16바이트 난수
    let tmp = path.with_extension(format!("md.tmp.{}.{}", std::process::id(), random_suffix()));
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;            // 파일 데이터 fsync
    }
    std::fs::rename(&tmp, path)?;
    fsync_dir(parent)?;              // C2: 디렉토리 엔트리 fsync
    Ok(())
}
```
`move_to_trash`/`restore_from_trash`는 같은 파일 교체/이동 패턴이므로 디렉토리 fsync를 동일하게 적용.

### 6.3 reindex 배치 처리 (H1)

```rust
// SearchIndex 트레이트에 배치 진입점 추가
fn upsert_batch(&self, notes: &[(MemoId, &str, &[String])]) -> Result<()> {
    let mut guard = self.ensure_writer()?;
    let writer = guard.as_mut().expect("writer initialized");
    for (id, body, tags) in notes {
        writer.delete_term(self.id_term(*id));
        writer.add_document(doc!(...))?;
    }
    writer.commit()?;        // 한 번만
    self.reader.reload()?;
    Ok(())
}
```
`vault.reindex`는 누적 버퍼를 이 경로로 flush한다.

### 6.4 프론트엔드 에러 처리 (H3, H4)

- `ErrorBoundary` 클래스 컴포넌트를 `main.tsx` 최상위에 삽입.
- 각 뮤테이션(`createNote`/`updateNote`/`deleteNote`)에 `.catch(err => showError(err))` 추가 — Zustand `ui` 스토어에 `error` 필드를 두고 헤더/오버레이에 토스트 렌더.

### 6.5 입력 검증 (H6)

`vault.create_memo`/`update_memo` 진입점에서:
- 본문 ≤ 64 KiB
- 태그 ≤ 64개, 각 ≤ 64자
- 초과 시 `CoreError::other("… too large")`

### 6.6 doctor 쓰기 에러 수집 (H2)

`let _ = self.files.write(&memo)` → 결과를 카운트해 `report.hash_repair_failed`에 반영.

---

## 7. 본 브랜치에서 적용한 조치 (구현 상태)

> `prod-readiness` 브랜치. 되돌리고 싶으면 `git checkout main` 후 브랜치 삭제.

| 항목 | 상태 | 비고 |
| :--- | :---: | :--- |
| C1 번들/엔타이틀먼트/아이콘 | ✅ | `tauri.conf.json` bundle 섹션 + `entitlements.plist` + 아이콘 생성 |
| C2 디렉토리 fsync | ✅ | `atomic_write` + trash 이동에 `fsync_dir` 적용 |
| C3 임시파일 충돌 | ✅ | 고유 접미사 임시파일 |
| H1 reindex 배치 | ✅ | `upsert_batch` + 단일 commit |
| H2 doctor 에러 수집 | ✅ | 실패 건수 리포트 |
| H3 ErrorBoundary | ✅ | 최상위 폴백 |
| H4 뮤테이션 에러 피드백 | ✅ | `.catch` + 에러 스토어 |
| H5 CI 데스크톱 검증 | ✅ | clippy/check 스텝 |
| H6 입력 검증 | ✅ | 코어 진입점 상한 |

> ⚠️ **사용자가 직접 해야 할 일 (코드로 불가)**:
> 1. Apple Developer 자격증명(Developer ID Application 인증서 + App-specific 비밀번호)을 GitHub Secrets(`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`)에 등록.
> 2. 위 시크릿이 있어야 릴리스 워크플로우가 실제 서명+공증을 수행한다. 없으면 unsigned 빌드만 생성(Gatekeeper 차단).

---

## 8. 남은 후속 작업 (프로덕션 이후)

- **홈브류 탭 자동화** — DESIGN §9.4가 `cargo-dist`/Homebrew tap 배포를 언급. 릴리스 워크플로우에 formula 갱신 스텝 추가 가능.
- **크래시 리포팅** — 현재 패닉 시 프로세스 종료만. (오프라인) 크래시 로그를 볼트 메타데이터 디렉토리에 남기는 스텝 고려.
- **M1 Mutex** — `parking_lot::Mutex`로 교체 시 포이즈닝 제거 (panic=abort와 중복 방어).
- **M3 워처 감독** — debounce 스레드 패닉 시 재시동.
- **퍼포먼스 벤치마크** — DESIGN §13 목표(오버레이 ≤16ms, reindex 10만 건)에 대한 실측. 본 브랜치의 reindex 배치화로 목표 달성 가능성 향상.
