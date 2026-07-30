# oxinot — `@atomic-editor/editor` 통합 (라이브 마크다운 메모)

- **Date:** 2026-07-30
- **Status:** Draft (디자인 확정, 구현 계획 대기)
- **Scope:** 데스크톱 프론트엔드. 노트 편집기(`NoteDetail`)에 atomic-editor 통합, 카드 미리보기를 마크다운 렌더링으로 전환, 인라인 `#태그` 칩 표시 위치 조정. **CaptureOverlay는 textarea 유지**(사용자 결정).
- **Out of scope:** 검색 경로, 사이드바 필터, Rust 코어 변경, CLI 변경.

## 1. 배경 & 목표

현재 oxinot은 **plain-text-only** 메모 앱이다. 본문은 `MirrorTagEditor`(textarea + mirror overlay)로 입력되고, 카드 미리보기는 `**bold**` 정규식 한 줄로 inline bold만 표시한다. Obsidian/Apple Notes 같은 WYSIWYG 노트앱에 익숙한 사용자에게는 한계가 뚜렷하다.

목표:

1. **NoteDetail 편집기**를 Obsidian 스타일 라이브 프리뷰 마크다운 에디터로 교체.
2. **카드 미리보기**를 마크다운 HTML 렌더링으로 전환(`.renderPreview` → `marked`).
3. **CaptureOverlay는 변경 없음** — 빠른 캡처의 단순성을 유지.
4. 인라인 `#태그` 칩을 **에디터 아래 사이드 영역**으로 이동(MirrorTagEditor 제거).
5. 디자인 토큰으로 atomic-editor 스타일 변수를 oxinot 테마와 정합.

## 2. 결정 요약 (locked)

| # | 결정 | 근거 |
|---|------|------|
| 1 | NoteDetail만 atomic-editor 사용 | CaptureOverlay는 빠른 캡처 — CM6 mount 비용 불필요. 사용자 결정. |
| 2 | atomic-editor: `@atomic-editor/editor` v0.6.2 | MIT, React 19 호환, Obsidian 스타일 inline preview, raw markdown byte-for-byte round-trip. |
| 3 | 카드 미리보기: `marked`로 HTML 렌더 | 가벼움(~20KB gz), sync API, GFM. react-markdown보다 가볍고 이 앱은 카드 미리보기에 React-component-level markdown 표현력이 필요 없음. |
| 4 | 인라인 `#태그` 칩을 본문에서 분리, 에디터 하단 chip-row로 이동 | atomic-editor는 textarea 미러 오버레이 기법을 사용할 수 없으므로(MirrorTagEditor는 textarea 기반). 태그는 본문에서 파생(§4.2)이므로 chip-row는 시각 보조 — storage는 body의 `#태그`. |
| 5 | 헤드라인/리스트 등 핵심 문법 카드 미리보기에 표시 | "라이브 에디팅 마크다운 메모 앱" 경험의 핵심. plain text는 디버깅용으로만 의미 있음. |
| 6 | 코드 펜스 하이라이팅은 비활성(코드 랭귀지 lazy-load 없음) | 사용자가 명시 요청 없음. 추후 추가 가능. 우선 가벼운 빌드 유지. |
| 7 | `wiki-links` 확장 비활성 | 우리는 노트 간 링크 시스템 없음. `[[target]]`은 그냥 텍스트로 둠. |
| 8 | atomic-editor 테마 변수를 oxinot CSS 변수와 매핑 | 다크/라이트 전환 시 일관성. 라이트 테마는 `data-theme="light"` 스코프로 atomic-editor가 자동 처리. |

## 3. 컴포넌트 아키텍처

```
NoteDetail (Dialog)
├── <AtomicCodeMirrorEditor>      ← body 편집 (NEW)
│   markdownSource={body}
│   onMarkdownChange={editBody}
│   documentId={note.data.id}     ← 노트 전환 시 remount 트리거
│   editorHandleRef={handleRef}   ← imperative focus/undo
├── <TagChipRow>                  ← 추출된 #태그 칩 (NEW, 이동)
│   tags={extractTags(body)}
├── <ColorSwatches>
└── <ConfirmButton>               ← "Done" (⌘⏎)
```

`CaptureOverlay`는 **완전히 미변경**: 자체 textarea + 자체 키 핸들링(Enter→save, Shift+Enter=line, Esc=dismiss) 유지.

```
CaptureOverlay
├── <textarea>                    ← plain textarea 유지
├── <ColorSwatches>
└── <ConfirmButton>
```

`NoteComposeForm`은 두 편집 화면을 모두 감싸던 **공통 컴포넌트이므로 분해**:

- `MirrorTagEditor` 의존을 **완전 제거**.
- 새 컴포넌트 `MarkdownEditor`(atomic-editor 래퍼)와 `TagChipRow`(`extractTags` 결과 칩)를 분리.
- `NoteComposeForm`은 **두 가지 변형**으로 분기:
  - `QuickCaptureForm` — textarea + 컬러 + 저장. CaptureOverlay 전용.
  - `NoteEditorForm` — atomic-editor + TagChipRow + 컬러 + 완료. NoteDetail 전용.

이 분리는 **편집 경험의 의도적 불일치**(§1 결정 1)를 코드에서도 명시한다. "공통 컴포넌트로 묶어 일관성을 강제"하던 기존 패턴을 깨는 것이 합리적인 이유는 **두 화면의 사용 의도가 다르기 때문**.

## 4. 통합 상세

### 4.1 `MarkdownEditor` 컴포넌트 (NEW)

위치: `apps/desktop/src/components/MarkdownEditor.tsx`

```tsx
interface Props {
  body: string;
  onChange: (v: string) => void;
  documentId: string;            // 노트 전환 시 CM6 view 재마운트 트리거
  className?: string;
  onLinkClick?: (url: string) => void;
}

export function MarkdownEditor({ body, onChange, documentId, className, onLinkClick }: Props) {
  const handleRef = useRef<AtomicCodeMirrorEditorHandle | null>(null);
  return (
    <AtomicCodeMirrorEditor
      documentId={documentId}
      markdownSource={body}
      onMarkdownChange={onChange}
      editorHandleRef={handleRef}
      onLinkClick={onLinkClick ?? defaultOpenLink}
      className={className}
    />
  );
}
```

- **documentId 강제**: `note.id`를 그대로 전달. 노트 전환 시 CM6 view 재마운트되어 이전 노트의 undo/cursor 상태가 새 노트로 새지 않음.
- **onLinkClick 기본값**: `window.open(url, '_blank', 'noopener,noreferrer')`. Tauri 환경에서도 동작하지만 추후 Tauri shell로 라우팅 가능하도록 핸들러 주입 여지 확보.
- **keymap 그대로**: `⌘Z/⌘⇧Z`, `⌘F`(find), `⌘/`(toggle list), `⌘B/⌘I` 자동 — 별도 핸들링 불필요.
- **확장 미주입**: `extensions` prop은 기본 `[]`로 둠. wiki-links 비활성, 추가 비활성. 컴포넌트 단순성 유지.

### 4.2 `TagChipRow` 컴포넌트 (NEW)

위치: `apps/desktop/src/components/TagChipRow.tsx`

```tsx
interface Props {
  body: string;
  onTagClick?: (tag: string) => void;
}

export function TagChipRow({ body, onTagClick }: Props) {
  const tags = useMemo(() => extractTags(body), [body]);
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span key={t} className="...">#{t}</span>
      ))}
    </div>
  );
}
```

- 본문이 비거나 태그가 없으면 컴포넌트 자체를 렌더하지 않음(null).
- 칩은 **read-only 시각 보조**. 클릭 핸들러는 옵셔널(v1 비활성).
- 알고리즘은 `lib/tags.ts::extractTags` 그대로 — Rust 코어와 동일 패턴.

### 4.3 `NoteEditorForm` 컴포넌트 (NEW)

위치: `apps/desktop/src/components/NoteEditorForm.tsx`

기존 `NoteComposeForm`의 NoteDetail 전용 변형. 시그니처:

```tsx
interface Props {
  body: string;
  onBodyChange: (v: string) => void;
  documentId: string;
  color: string;
  onColorChange: (oklch: string) => void;
  onConfirm: () => void;
  confirmLabel: string;
  confirmDisabled?: boolean;
  confirmKbd?: string;
  className?: string;
}
```

내부 구조:
1. `<MarkdownEditor>` (flex-1)
2. `<TagChipRow body={body} />` (visual 보조)
3. `<ColorSwatches>` + `<ConfirmButton>` (인라인 스트립)

### 4.4 `QuickCaptureForm` 컴포넌트 (NEW)

위치: `apps/desktop/src/components/QuickCaptureForm.tsx`

CaptureOverlay 전용. 기존 `NoteComposeForm`에서 textarea 분기만 유지:

```tsx
interface Props {
  body: string;
  onBodyChange: (v: string) => void;
  bodyRef?: Ref<HTMLTextAreaElement>;
  bodyProps?: ...;
  color: string;
  onColorChange: (oklch: string) => void;
  onConfirm: () => void;
  confirmLabel: string;
  confirmDisabled?: boolean;
  confirmKbd?: string;
  className?: string;
}
```

내부: `<textarea>` + `<ColorSwatches>` + `<ConfirmButton>`. **태그 칩 없음**(textarea 위의 미러 오버레이 기법도 사용 안 함 — 빠른 캡처 화면에서 본문은 본문 그대로).

> **왜 미러 오버레이를 Capture에서도 빼는가?** 빠른 캡처의 본문 길이는 거의 한 줄이다. 미러 오버레이의 가치(긴 본문에서 `#태그` 시각화)가 작다. CaptureOverlay는 본문이 저장될 때 `extractTags`로 파생되므로 본문에는 항상 원문 그대로만 표시해도 충분하다.

### 4.5 파일 정리

| 액션 | 파일 |
|------|------|
| 추가 | `apps/desktop/src/components/MarkdownEditor.tsx` |
| 추가 | `apps/desktop/src/components/TagChipRow.tsx` |
| 추가 | `apps/desktop/src/components/NoteEditorForm.tsx` |
| 추가 | `apps/desktop/src/components/QuickCaptureForm.tsx` |
| 추가 | `apps/desktop/src/lib/markdownPreview.ts` (marked 래퍼) |
| 변경 | `apps/desktop/src/components/NoteDetail.tsx` — `NoteComposeForm` → `NoteEditorForm` |
| 변경 | `apps/desktop/src/components/CaptureOverlay.tsx` — `NoteComposeForm` → `QuickCaptureForm` |
| 변경 | `apps/desktop/src/components/Card.tsx` — 미리보기를 `renderMarkdownPreview`로 교체 |
| 변경 | `apps/desktop/package.json` — `@atomic-editor/editor`, `marked` 추가 |
| 변경 | `apps/desktop/src/app.css` — atomic-editor 테마 변수 오버라이드 |
| 삭제 | `apps/desktop/src/components/NoteComposeForm.tsx` (단일 사용처 분리됨) |
| 삭제 | `apps/desktop/src/components/MirrorTagEditor.tsx` (의존 사라짐) |

> NoteComposeForm이 두 곳에서 쓰여 분해한다. 한 곳 전용 컴포넌트가 되면 분리 비용 정당화.

## 5. 카드 미리보기 — `marked` 통합

위치: `apps/desktop/src/lib/markdownPreview.ts`

```ts
import { marked } from "marked";

marked.setOptions({
  breaks: false,
  gfm: true,
});
/** 카드 미리보기용 HTML (앞쪽 두 줄 + 약간의 인라인 마크업). */
export function renderPreviewMarkdown(body: string, maxLen = 200): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  // 첫 "블록"(빈 줄 전까지)만 사용하고, 그 안에서만 길이 제한.
  const firstBlock = trimmed.split(/\n\s*\n/, 1)[0];
  const head =
    firstBlock.length <= maxLen
      ? firstBlock
      : firstBlock.slice(0, maxLen).trimEnd() + "\u2026";
  return marked.parse(head, { async: false }) as string;
}
```

`Card.tsx`에서:

```tsx
const previewHtml = useMemo(
  () => renderPreviewMarkdown(note.preview),
  [note.preview],
);
return (
  ...
  <div
    className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-200"
    dangerouslySetInnerHTML={{ __html: previewHtml }}
  />
);
```

### 5.1 백엔드 `preview`는 그대로

`NoteSummary.preview`는 Rust `make_preview`에서 첫 160자 plain text로 잘라 보낸다. **카드에서 `marked` 적용은 이 preview 문자열에 대해서만** 수행. 원본 `body`는 NoteDetail에서만 atomic-editor로 열림.

## 6. 테마 매핑 (CSS 변수)

`apps/desktop/src/app.css`에 추가. **Tailwind v4는 `bg-zinc-900` 등 컬러 유틸을 `oklch(...)`로 자동 생성**하므로, 별도 CSS 변수 정의 없이 직접 값을 사용한다.

```css
:root {
  /* atomic-editor 기본 변수 오버라이드 (라이트) */
  --atomic-editor-fg: #18181b;
  --atomic-editor-bg: transparent;          /* oxinot Dialog 자체 배경 사용 */
  --atomic-editor-bg-panel: rgba(0, 0, 0, 0.04);
  --atomic-editor-border: var(--card-edge, #e7e7ea);
  --atomic-editor-link: #2563eb;
  --atomic-editor-code-bg: rgba(0, 0, 0, 0.05);
  --atomic-editor-code-fg: #1f2328;
  --atomic-editor-blockquote-fg: #57606a;
}

.dark {
  --atomic-editor-fg: #f4f4f5;
  --atomic-editor-bg: transparent;
  --atomic-editor-bg-panel: rgba(255, 255, 255, 0.04);
  --atomic-editor-border: #2a2e36;
  --atomic-editor-link: #60a5fa;
  --atomic-editor-code-bg: rgba(255, 255, 255, 0.06);
  --atomic-editor-code-fg: #e6edf3;
  --atomic-editor-blockquote-fg: #8b949e;
}

.atomic-cm-editor {
  font-family: var(--font-sans);
  font-size: 0.875rem; /* text-sm */
}

/* 카드 미리보기에서 marked 출력의 헤딩/리스트/코드 인라인 스타일 */
.md-preview h1 { font-size: 1rem; font-weight: 600; margin: 0.25rem 0; }
.md-preview h2 { font-size: 0.95rem; font-weight: 600; margin: 0.25rem 0; }
.md-preview h3,
.md-preview h4,
.md-preview h5,
.md-preview h6 { font-size: 0.875rem; font-weight: 600; margin: 0.25rem 0; }
.md-preview p { margin: 0.15rem 0; }
.md-preview ul,
.md-preview ol { margin: 0.15rem 0 0.15rem 1.25rem; padding: 0; list-style: revert; }
.md-preview blockquote { margin: 0.25rem 0; padding-left: 0.6rem; border-left: 2px solid var(--card-edge); color: var(--atomic-editor-blockquote-fg); }
.md-preview code { background: var(--atomic-editor-code-bg); padding: 0 0.2rem; border-radius: 3px; font-family: ui-monospace, "SF Mono", monospace; font-size: 0.85em; }
.md-preview pre { background: var(--atomic-editor-code-bg); padding: 0.5rem; border-radius: 6px; overflow-x: auto; }
.md-preview pre code { background: transparent; padding: 0; }
.md-preview a { color: var(--atomic-editor-link); text-decoration: underline; }
.md-preview hr { border: 0; border-top: 1px solid var(--card-edge); margin: 0.4rem 0; }
.md-preview strong { font-weight: 600; }
.md-preview em { font-style: italic; }
.md-preview del { text-decoration: line-through; opacity: 0.7; }
```

atomic-editor의 자체 CSS는 `package.json`의 `exports["./styles.css"]`를 통해 임포트:

```ts
import "@atomic-editor/editor/styles.css";
```

`NoteEditorForm`이 마운트될 때 dynamic import하면 초기 번들에서 제외할 수 있으나(vite 자동 chunk split), **수동 dynamic import는 우선 불필요** — NoteDetail은 거의 모든 사용 흐름에서 사용되므로 cold-start 비용은 CM6 mount 비용과 함께 들고 가는 것이 합리적. 측정 후 lazy load 결정(비목표).

## 7. 의존성 변경

`apps/desktop/package.json`:

```json
"dependencies": {
  ...기존,
  "@atomic-editor/editor": "^0.6.2",
  "marked": "^14.1.3"
}
```

**Peer dependencies**는 atomic-editor가 강제하는 코드미러 스택 — atomic-editor 설치 시 자동 설치되지만, 우리도 명시적으로 의존성을 잠가 두는 편이 안전. (선택)

```json
"dependencies": {
  ...,
  "@codemirror/state": "^6.4.0",
  "@codemirror/view": "^6.30.0",
  "@codemirror/commands": "^6.6.0",
  "@codemirror/language": "^6.10.0",
  "@codemirror/search": "^6.5.0",
  "@codemirror/autocomplete": "^6.18.0",
  "@codemirror/lang-markdown": "^6.3.0",
  "@lezer/common": "^1.2.0",
  "@lezer/highlight": "^1.2.0",
  "@lezer/markdown": "^1.3.0"
}
```

번들 사이즈 영향: 대략 **+120KB gzipped** (CM6 + atomic-editor + lezer). `marked`는 +10KB. preview 렌더러는 카드 그리드 전체에 동시 호출되므로 메모이즈 (`useMemo`) 필수.

## 8. 비목표 (향후)

- 코드 펜스 syntax 하이라이팅 (v2: `ATOMIC_CODE_LANGUAGES` 활성화 + lang-* peer 설치)
- wiki-links (v2: `wikiLinks` 확장 + 노트 제목 lookup 추가)
- 카드 미리보기에 이미지 표시 (v2: `Image` 위젯 + 이미지 lazy)
- NoteDetail 읽기 모드 토글 (v2: `readOnly` prop + 헤더 버튼) — 우선은 편집 모드만
- 인라인 `#태그` 칩 클릭으로 필터 (MirrorTagEditor 삭제되어 가능성 낮아짐 — 사이드바가 역할 대체)

## 9. 검증 계획

- **Rust 단위**: 변경 없음(코어 미수정). 기존 `cargo test` 통과.
- **빌드**: `tsc -b` 0 에러, `vite build` 성공, `@atomic-editor/editor` 청크 분리 확인.
- **수동**:
  - NoteDetail 열기 → 본문 bold/heading/list/blockquote/code/link 입력 → WYSIWYG 렌더 확인.
  - 카드 미리보기: heading `# Hello` → 큰 글씨, `**bold**` → 굵게, list → 점. (marked 렌더 확인)
  - 노트 전환: 카드 A → 카드 B 클릭 시 undo 스택 / cursor 위치 비-누설.
  - CaptureOverlay: plain textarea 그대로 동작 확인, Enter→save, Shift+Enter→newline, Esc→dismiss.
  - 한글 IME: NoteDetail에서 한 줄 입력, 조합 중 글자 깨짐 없음(CM6 native IME 동작).
  - 다크/라이트 토글: 에디터 텍스트 가독성 유지.
  - `⌘Z`로 되돌리기, `⌘⇧Z`로 재실행.
- **재배포**: 프론트 변경이므로 `cargo build -p oxinot-desktop --release` + 앱 교체 + 재서명(임베드 프론트 갱신).

## 10. 마이그레이션 (데이터)

**없음**. 기존 노트는 plain text markdown(또는 plain text) 그대로 유지. atomic-editor가 plain text도 동일하게 표시. 이전 사용자가 `# Hello` 같은 markdown 제목으로 본문을 적었던 경우 즉시 카드의 큰 헤더로 표시됨(긍정적 부수효과).

`MirrorTagEditor`는 internal-only 컴포넌트였고 외부 노출 없음. `NoteComposeForm`은 두 호출처를 모두 새 컴포넌트로 교체하므로 삭제 가능.
