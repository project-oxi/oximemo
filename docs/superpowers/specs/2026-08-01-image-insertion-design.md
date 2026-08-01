# 이미지 삽입 기능 설계 — oxinot

> 상태: 설계 (사용자 자리 비움 → 승인 게이트 면제, 자율 진행)
> 날짜: 2026-08-01

## 1. 목표
마크다운 메모에 이미지를 삽입한다. 드래그&드롭, ⌘V 붙여넣기, 파일 선택 버튼을 모두 지원하고, 삽입된 이미지를 한 곳에 모아보는 **갤러리** 뷰를 제공한다. 메모는 마크다운 파일 + TOML frontmatter 형식을 유지한다.

## 2. 핵심 결정 (사용자 선택 + 엔지니어링 판단)

### 2.1 저장 = 에셋 파일 분리 (사용자 선택)
- 이미지는 `<vault>/assets/<blake3hex16>.<ext>` 파일로 저장한다.
- **콘텐츠 어드레스**: blake3 해시 앞 16 hex를 파일명으로 쓴다 → 동일 이미지 자동 중복 제거 + 무결성.
- 허용 확장자 화이트리스트: `png, jpg, jpeg, gif, webp` (WKWebView 렌더링 보장, HEIC 제외).
- `.md` 파일은 가볍게 유지되고, 갤러리/재사용이 자연스럽다.

### 2.2 마크다운 참조 = `oximg://` 커스텀 스킴
- 본문에는 `![대체텍스트](oximg://<hash>.<ext>)` 로 기록한다.
- 기계 종속 경로가 아니라 **앱 상대 스킴**이므로 메모 위치/샤딩과 무관하게 안정적이고, 디스크의 .md에서도 읽기 깔끔하다.
- 너비 힌트는 fragment로: `oximg://<hash>.<ext>#w=400`. Rust 핸들러는 fragment를 무시(경로만 사용)하고, 프론트엔드가 렌더된 `<img>`에 `max-width`로 적용한다.
- Tauri webview는 `oximg://`를 네이티브로 로드(`register_uri_scheme_protocol`). 브라우저 dev 모드는 IndexedDB 기반 blob URL로 치환 렌더.

### 2.3 입력 통합점 = CM6 `extensions` prop (핵심 기술 통찰)
- `AtomicCodeMirrorEditor`는 `extensions?: readonly Extension[]` prop을 받는다.
- `EditorView.domEventHandlers({ paste, drop, dragover })` 확장을 전달하면, 핸들러가 **이벤트(이미지 추출)** 와 **EditorView(커서 위치 삽입)** 를 모두 쥔다.
- `view.dispatch({ changes: { from: view.state.selection.main.from, insert: markdown } })` 로 커서에 삽입.
- 이미지가 있을 때만 가로채고(업로드→삽입), 일반 텍스트는 `return false`로 에디터 기본 동작 유지.
- 툴바 파일 선택 버튼용으로 EditorView를 ref에 저장하는 작은 ViewPlugin 추가 → 버튼 클릭 시 같은 dispatch 경로.
- 직접 의존성 추가: `@codemirror/view`, `@codemirror/state` (현재는 @atomic-editor/editor 경유 transitive).

## 3. 컴포넌트 / 데이터 흐름

```
[drag/drop | paste | 파일버튼]
        │ (CM6 domEventHandler 또는 버튼)
        ▼
 lib/assets.ts: saveImage(bytes, ext)
        │  Tauri: invoke("save_image_bytes",{base64,ext}) → Rust 해시·저장·oximg:// URL 반환
        │  browser dev: IDB 저장, 같은 oximg:// URL
        ▼
 view.dispatch(insert "![alt](oximg://hash.ext)")  → 본문(마크다운) 갱신 → autosave
        │
        ▼ 렌더링
 Tauri: oximg:// → register_uri_scheme_protocol → vault/assets/<name> 서빙
 browser dev: MutationObserver가 oximg:// img.src를 IDB blob URL로 치환
```

## 4. 백엔드 (Rust)

### oxinot-core
- `paths.rs`: `ASSETS_DIR="assets"`, `Paths::assets_root()`, `Paths::asset_path(name)`.
- `error.rs`: `CoreError::AssetRejected(String)` (확장자/MIME 거부), `AssetInvalid(String)` (경로 순회 등).
- `vault.rs`: 에셋 메서드 (록 불필요 — 파일 I/O만):
  - `save_asset(bytes, ext) -> AssetRef { url, name }` — 해시→경로, 존재 시 스킵, 화이트리스트 검증.
  - `save_asset_from_path(path) -> AssetRef` — 파일 읽어 위임 (파일 선택용).
  - `list_assets() -> Vec<AssetInfo { name, ext, bytes, modified }>` — 디렉토리 스캔.
  - `gc_assets() -> u64` — 어떤 live 메모 본문에서도 참조되지 않는 에셋 삭제.
  - `asset_refs_from_bodies() -> HashSet<name>` — 모든 메모 본문에서 `oximg://` refs 추출 (GC/역색인용).
- `lib.rs`: `AssetRef`, `AssetInfo` re-export.

### src-tauri
- `lib.rs`:
  - `.register_uri_scheme_protocol("oximg", |ctx, req| ...)` — `ctx.app_handle().state::<AppState>().vault`에서 assets_root 획득, `req.uri().path()`에서 name 추출, 경로 순회 가드(`..`/슬래시 거부), 화이트리스트 확장자, `Content-Type` + `Cache-Control` 헤더로 바이트 서빙. 실패 시 404.
  - 명령: `save_image_bytes(base64, ext)`, `save_image_from_path(path)`, `list_assets()`, `gc_assets()`.
  - `invoke_handler`에 위 명령 추가.
- `tauri.conf.json`: CSP `img-src`에 `oximg:` 추가 → `"img-src 'self' data: oximg:"`.
- `Cargo.toml`: `base64 = "0.22"`, `http`는 tauri 재수출 사용. `mime`은 확장자 매핑 직접 구현(의존성 최소).

## 5. 프론트엔드 (React)

- `lib/assets.ts`:
  - `saveImageBytes(bytes: Uint8Array, ext): Promise<AssetRef>` — Tauri: base64 인코딩 invoke. browser dev: SHA-256(crypto.subtle) hex16 → IDB 저장 → AssetRef.
  - `saveImageFromFile(file: File): Promise<AssetRef>` — 타입→ext 매핑, `saveImageBytes`.
  - `saveImageFromPath(path): Promise<AssetRef>` — Tauri 전용 (파일 선택).
  - `listAssets()`, `gcAssets()`.
  - `OXIMG_RE = /!\[([^\]]*)\]\(oximg:\/\/([^)\s#?]+)(?:\?[^)]*)?(?:#([^)]*))?\)/g`.
  - `markdownForImage(url, alt, w?)`.
  - browser dev IDB 헬퍼 (`oxinot-assets` db, key `<hash>.<ext>` → Uint8Array).
- `lib/cm6Images.ts`: `imageInsertionExtension({ onInsert, viewRef })` — `EditorView.domEventHandlers({ paste, drop, dragover })`. 이미지 File 추출 → `onInsert` 콜백(업로드+dispatch). `ViewPlugin.fromClass`로 `viewRef.current = view`. 비-이미지는 false 반환.
- `components/MarkdownEditor.tsx`: `extensions` prop에 cm6Images 전달. browser dev용 MutationObserver(blob 치환) + 너비 fragment(`#w=`) → img style 적용 + 리사이즈 핸들.
- `components/MemoEditorForm.tsx`: `onInsert` 콜백(업로드 진행 토스트). 툴바에 이미지 버튼(Image 아이콘) → `tauri-plugin-dialog` open → `saveImageFromPath` → viewRef로 dispatch. ⌘I 단축키.
- `components/GalleryView.tsx`: 에셋 그리드(썸네일=oximg://). 클릭 → 참조하는 첫 메모 열기. 헤더에 "미사용 정리" 버튼(gc).
- `components/Sidebar.tsx`: 갤러리 네비 버튼(`Images` 아이콘).
- `stores/ui.ts`: `view: 'memos'|'gallery'`, `setView`.
- `components/CardGrid.tsx`: `view==='gallery'`면 `<GalleryView/>` 대신 렌더.
- `lib/i18n` ko/en: `gallery`, `image`, `insert_image`, `clean_unused`, `cleaned_n`, `pasting_image`, `image_too_large` 등 키 추가.
- `lib/api.ts` + `lib/tauri.ts`(browser fallback): 에셋 명령 stub 추가.

## 6. 에러 / 엣지
- 비-이미지 드롭/붙여넣기: 기본 동작 유지(false).
- 동시 삽입: 각각 별도 dispatch (경쟁 없음).
- 대용량: IPC base64 (단일 이미지 수 MB 허용). 브라우저 dev는 IDB(사실상 무제한), localStorage 한도 회피.
- 삭제된 메모의 이미지: 즉시 삭제 안 함(휴지통 복구 대비) → gc_assets로 정리.
- 경로 순회: 핸들러에서 `name`이 `/^[a-z0-9]+\.(png|jpe?g|gif|webp)$/` 인 경우만 서빙.

## 7. 범위 밖 (v2)
- **바이너리 동기화**: oximg:// 참조는 텍스트 manifest로 다른 기기에 전달되지만, 에셋 바이너리 자체는 동기화 안 됨(다른 기기에선 끊김). 별도 동기화 경로는 후속 작업.
- HEIC/RAW, 이미지 편집(자르기/회전).

## 8. 검증
- `cargo build` (core + desktop), `tsc -b && vite build` (프론트).
- `cargo test` -P oxinot-core (에셋 저장/dedup/gc 단위 테스트).
- 스모크: 메모에 이미지 드롭/붙여넣기 → 본문에 `oximg://` 삽입 → 렌더 → 저장 → 재오픈 시 표시 → 갤러리 등장.
