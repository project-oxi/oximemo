# `@atomic-editor/editor` 통합 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `NoteDetail` 편집기를 Obsidian 스타일 라이브 프리뷰 마크다운 에디터(`@atomic-editor/editor`)로 교체하고, 카드 미리보기를 `marked` 기반 HTML 렌더링으로 전환한다. `CaptureOverlay`의 빠른 캡처 textarea는 그대로 유지.

**Architecture:** 데스크톱 프론트엔드 변경. `MirrorTagEditor`(textarea+mirror)는 제거하고 그 자리에 `MarkdownEditor`(atomic-editor React 래퍼)와 `TagChipRow`(시각 보조)를 둔다. 기존 공통 폼 `NoteComposeForm`은 사용처가 두 곳뿐이며 의도가 달라졌으므로, `NoteEditorForm`(NoteDetail용)과 `QuickCaptureForm`(CaptureOverlay용)으로 분해. 카드 미리보기는 `marked`로 변환. atomic-editor의 CSS 변수는 `app.css`의 다크/라이트 스코프에서 oxinot 토큰에 매핑.

**Tech Stack:** React 19, TypeScript 5.6, Vite 6, Tailwind v4, CodeMirror 6 (transitive via atomic-editor), `marked` v14, atomic-editor v0.6.2.

**Spec:** `docs/superpowers/specs/2026-07-30-markdown-editor-design.md`

## Global Constraints

- macOS 단일 타겟. 프론트 변경이므로 임베드 번들 갱신 필요.
- `MirrorTagEditor`/`NoteComposeForm`은 외부 노출 없음 → 의존성 0이라 안심하고 삭제 가능.
- `#태그` 칩 추출 알고리즘은 `lib/tags.ts::extractTags` 그대로 사용 — Rust 코어와 동일 패턴.
- atomic-editor의 `documentId`는 `note.data.id`를 그대로 전달 → 노트 전환 시 view 자동 재마운트.
- `marked` 옵션: `breaks: false`, `gfm: true`. 외부 입력 없음(사용자 자기 자신의 노트 본문만 처리).
- 의존성 설치 후 `bun install`로 `bun.lock` 갱신.
- 검증: `cd apps/desktop && bun run build`(tsc -b + vite). 매 태스크 끝 커밋.
- 비목표: 코드 펜스 syntax 하이라이팅, wiki-links, NoteDetail 읽기 모드 토글, 카드 이미지 미리보기, 인라인 칩 클릭→필터.
- 진행 주의: Task 1(의존성 추가) 후 `bun install`이 다른 태스크들의 `tsc -b` 통과의 전제. Task 1 끝나기 전엔 새 import 사용 금지.

## File Structure

| 파일 | 역할 |
|---|---|
| `apps/desktop/package.json` | `@atomic-editor/editor`, `marked` 의존성 추가 |
| `apps/desktop/bun.lock` | `bun install`로 자동 갱신 |
| `apps/desktop/src/lib/markdownPreview.ts` (신규) | `marked` 래퍼 — `renderPreviewMarkdown(body)` |
| `apps/desktop/src/components/MarkdownEditor.tsx` (신규) | atomic-editor React 래퍼 |
| `apps/desktop/src/components/TagChipRow.tsx` (신규) | `extractTags` 시각 chip row |
| `apps/desktop/src/components/NoteEditorForm.tsx` (신규) | NoteDetail 전용 — atomic-editor + chip row + 컬러 + 완료 |
| `apps/desktop/src/components/QuickCaptureForm.tsx` (신규) | CaptureOverlay 전용 — textarea + 컬러 + 저장 |
| `apps/desktop/src/components/NoteComposeForm.tsx` | **삭제** |
| `apps/desktop/src/components/MirrorTagEditor.tsx` | **삭제** |
| `apps/desktop/src/components/NoteDetail.tsx` | `NoteComposeForm` → `NoteEditorForm` 교체 |
| `apps/desktop/src/components/CaptureOverlay.tsx` | `NoteComposeForm` → `QuickCaptureForm` 교체 |
| `apps/desktop/src/components/Card.tsx` | `renderInline`(bold regex) → `renderPreviewMarkdown` 교체 |
| `apps/desktop/src/app.css` | atomic-editor 테마 변수 오버라이드 + `.md-preview` 스타일 |

---

### Task 1: 의존성 추가 (`@atomic-editor/editor`, `marked`)

**Files:**
- Modify: `apps/desktop/package.json` (dependencies 2개 추가)
- Modify: `apps/desktop/bun.lock` (bun install로 자동 갱신)

**Produces:**
- `package.json.dependencies["@atomic-editor/editor"] = "^0.6.2"`
- `package.json.dependencies["marked"] = "^14.1.3"`

- [ ] **Step 1: package.json 수정**

`apps/desktop/package.json`의 `dependencies` 객체에 두 줄 추가(존재하는 dependencies 블록 끝에):

```json
    "@atomic-editor/editor": "^0.6.2",
    "marked": "^14.1.3",
```

알파벳 순 정렬 유지: `@base-ui-components/react` 다음, `@tanstack/react-query` 위에 오도록 위치 조정. 최종 dependencies 블록:

```json
  "dependencies": {
    "@atomic-editor/editor": "^0.6.2",
    "@base-ui-components/react": "1.0.0-rc.0",
    "@tanstack/react-query": "^5.59.0",
    "@tanstack/react-virtual": "^3.10.8",
    "@tauri-apps/api": "^2.0.0",
    "lucide-react": "^0.460.0",
    "marked": "^14.1.3",
    "motion": "^11.11.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0"
  }
```

- [ ] **Step 2: bun install 실행**

```bash
cd apps/desktop && bun install
```

Expected: lockfile 갱신, `@atomic-editor/editor/dist/`와 `marked/dist/`가 `node_modules`에 설치됨. 출력에서 peer dependency 경고가 떠도 무시 — atomic-editor는 peer로 codemirror를 요구하지만 atomic-editor 자신의 deps로 자동 설치됨.

- [ ] **Step 3: 설치 검증**

```bash
cd apps/desktop && ls node_modules/@atomic-editor/editor/dist/index.js && ls node_modules/marked/lib/marked.cjs
```

Expected: 두 파일 모두 존재. 둘 중 하나라도 없으면 `bun install` 재실행.

- [ ] **Step 4: 타입 체크 (실패 가능 — 새 코드 없음)**

```bash
cd apps/desktop && bunx tsc -b
```

Expected: PASS (변경한 게 package.json뿐). 만약 실패하면 `bun install`이 완전히 끝나지 않은 상태 → 재실행.

- [ ] **Step 5: 커밋**

```bash
cd /Volumes/MERCURY/PROJECTS/oxinot
git add apps/desktop/package.json apps/desktop/bun.lock
git commit -m "build(deps): add @atomic-editor/editor and marked

- @atomic-editor/editor ^0.6.2: Obsidian-style CM6 markdown editor
- marked ^14.1.3: lightweight GFM renderer for card previews"
```

---

### Task 2: `lib/markdownPreview.ts` — marked 래퍼

**Files:**
- Create: `apps/desktop/src/lib/markdownPreview.ts`

**Produces:**
```ts
export function renderPreviewMarkdown(body: string, maxLen?: number): string
```

- [ ] **Step 1: 파일 작성**

`apps/desktop/src/lib/markdownPreview.ts` 생성:

```ts
/**
 * Markdown → HTML for card previews (§5).
 *
 * The card receives `note.preview` from the Rust `make_preview` helper
 * (already trimmed to a non-empty first 160 chars). We re-parse it here as
 * markdown and render the first block (up to `maxLen` chars) to HTML so
 * users see headings, lists, code spans, etc. in the grid.
 *
 * External input never reaches this function — note bodies are the user's
 * own typing — so `dangerouslySetInnerHTML` in Card.tsx is safe given
 * marked's default HTML escaping.
 */
import { marked } from "marked";

marked.setOptions({
  breaks: false,
  gfm: true,
});

/** Card preview HTML. First block only; truncated at `maxLen` chars. */
export function renderPreviewMarkdown(body: string, maxLen = 200): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  // First block: everything up to the first blank line.
  const firstBlock = trimmed.split(/\n\s*\n/, 1)[0];
  const head =
    firstBlock.length <= maxLen
      ? firstBlock
      : firstBlock.slice(0, maxLen).trimEnd() + "\u2026";
  return marked.parse(head, { async: false }) as string;
}
```

- [ ] **Step 2: 타입 체크**

```bash
cd apps/desktop && bunx tsc -b
```

Expected: PASS.

- [ ] **Step 3: 커밋**

```bash
cd /Volumes/MERCURY/PROJECTS/oxinot
git add apps/desktop/src/lib/markdownPreview.ts
git commit -m "feat(preview): marked-based markdown renderer for card grid"
```

---

### Task 3: `Card.tsx` — 미리보기를 markdown HTML로 렌더링

**Files:**
- Modify: `apps/desktop/src/components/Card.tsx` (import + preview 렌더링 교체)
- Modify: `apps/desktop/src/app.css` (`.md-preview` 스타일 추가)

**Produces:**
- `Card`에서 `dangerouslySetInnerHTML`로 `note.preview`를 마크다운 HTML로 표시.
- `renderInline` 함수와 ReactNode import 제거.

- [ ] **Step 1: app.css에 `.md-preview` 스타일 추가**

`apps/desktop/src/app.css` 끝에 추가:

```css
/* Card preview markdown output (lib/markdownPreview.ts). */
.md-preview h1,
.md-preview h2,
.md-preview h3,
.md-preview h4,
.md-preview h5,
.md-preview h6 {
  font-size: 0.875rem;
  font-weight: 600;
  margin: 0.2rem 0;
}
.md-preview p {
  margin: 0.1rem 0;
}
.md-preview ul,
.md-preview ol {
  margin: 0.15rem 0 0.15rem 1.25rem;
  padding: 0;
  list-style: revert;
}
.md-preview blockquote {
  margin: 0.2rem 0;
  padding-left: 0.5rem;
  border-left: 2px solid var(--card-edge);
  color: var(--tag);
  opacity: 0.85;
}
.md-preview code {
  background: rgba(0, 0, 0, 0.06);
  padding: 0 0.2rem;
  border-radius: 3px;
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 0.85em;
}
.dark .md-preview code {
  background: rgba(255, 255, 255, 0.08);
}
.md-preview pre {
  background: rgba(0, 0, 0, 0.06);
  padding: 0.4rem 0.5rem;
  border-radius: 6px;
  overflow-x: auto;
}
.dark .md-preview pre {
  background: rgba(255, 255, 255, 0.06);
}
.md-preview pre code {
  background: transparent;
  padding: 0;
}
.md-preview a {
  color: var(--tag);
  text-decoration: underline;
}
.md-preview hr {
  border: 0;
  border-top: 1px solid var(--card-edge);
  margin: 0.4rem 0;
}
.md-preview strong {
  font-weight: 600;
}
.md-preview em {
  font-style: italic;
}
.md-preview del {
  text-decoration: line-through;
  opacity: 0.7;
}
```

- [ ] **Step 2: Card.tsx의 import 영역 갱신**

`apps/desktop/src/components/Card.tsx` 상단의 `import { useState, type ReactNode } from "react";`를 다음으로 교체:

```tsx
import { useMemo, useState } from "react";
```

- [ ] **Step 3: `renderInline` 함수와 ReactNode 사용 제거**

`apps/desktop/src/components/Card.tsx`의 `renderInline` 함수(현재 `function renderInline(text: string): ReactNode[] { ... }`)와 그 호출(`{note.preview ? renderInline(note.preview) : t.empty_note}`)을 다음으로 교체:

함수 제거:
```tsx
  function renderInline(text: string): ReactNode[] {
    if (!text) return [];
    return text
      .split(/\*\*(.+?)\*\*/)
      .map((seg, i) =>
        i % 2 === 1 ? (
          <strong key={i} className="font-semibold">
            {seg}
          </strong>
        ) : (
          seg
        ),
      );
  }
```

호출부 교체 (컴포넌트 내부, `useState` 다음 위치):
```tsx
  const previewHtml = useMemo(
    () => (note.preview ? renderPreviewMarkdown(note.preview) : ""),
    [note.preview],
  );
```

이 호출이 `const shortId = note.id.slice(0, 8);` 다음에 오도록 한다.

본문 영역의 `<p>` 태그를 다음으로 교체:

```tsx
      {note.preview ? (
        <div
          className="md-preview mt-2 line-clamp-4 flex-1 text-sm leading-relaxed text-zinc-700 dark:text-zinc-200"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      ) : (
        <p className="mt-2 line-clamp-4 flex-1 text-sm leading-relaxed text-zinc-700 dark:text-zinc-200">
          {t.empty_note}
        </p>
      )}
```

- [ ] **Step 4: renderPreviewMarkdown import 추가**

`apps/desktop/src/components/Card.tsx`의 import 영역 끝(`import { relativeTime } from "../lib/time";` 다음)에:

```tsx
import { renderPreviewMarkdown } from "../lib/markdownPreview";
```

- [ ] **Step 5: 타입 체크**

```bash
cd apps/desktop && bunx tsc -b
```

Expected: PASS.

- [ ] **Step 6: 빌드 (Vite)**

```bash
cd apps/desktop && bunx vite build
```

Expected: 정상 종료, `dist/` 갱신.

- [ ] **Step 7: 커밋**

```bash
cd /Volumes/MERCURY/PROJECTS/oxinot
git add apps/desktop/src/components/Card.tsx apps/desktop/src/app.css
git commit -m "feat(card): render previews as markdown HTML via marked

Replaces the prior inline-bold regex with a full markdown render so
headings, lists, code, blockquotes, links, and emphasis all show in the
grid. External input never reaches marked (note bodies are user input),
so dangerouslySetInnerHTML is safe given marked's HTML escaping."
```

---

### Task 4: `TagChipRow` 컴포넌트

**Files:**
- Create: `apps/desktop/src/components/TagChipRow.tsx`

**Produces:**
```tsx
export function TagChipRow({ body, onTagClick }: TagChipRowProps): JSX.Element | null
```

- [ ] **Step 1: 파일 작성**

`apps/desktop/src/components/TagChipRow.tsx` 생성:

```tsx
/**
 * Visual row of `#태그` chips extracted from the current body (§4.2).
 *
 * Storage is unchanged — `Note.tags` is still derived from the body on save.
 * This row is a read-only affordance so the user can see what tags their
 * current text would produce. Click-to-filter is intentionally not wired
 * (the sidebar owns filtering); `onTagClick` is provided as an escape hatch.
 *
 * Renders nothing when the body has no tags, so empty state is just an
 * empty row.
 */
import { useMemo } from "react";

import { extractTags } from "../lib/tags";

interface TagChipRowProps {
  body: string;
  onTagClick?: (tag: string) => void;
}

export function TagChipRow({ body, onTagClick }: TagChipRowProps) {
  const tags = useMemo(() => extractTags(body), [body]);
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onTagClick?.(t)}
          disabled={!onTagClick}
          className="rounded-full bg-[var(--tag-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--tag)] disabled:cursor-default"
        >
          #{t}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: 타입 체크**

```bash
cd apps/desktop && bunx tsc -b
```

Expected: PASS.

- [ ] **Step 3: 커밋**

```bash
cd /Volumes/MERCURY/PROJECTS/oxinot
git add apps/desktop/src/components/TagChipRow.tsx
git commit -m "feat(editor): TagChipRow — read-only visual tag chips"
```

---

### Task 5: `MarkdownEditor` — atomic-editor React 래퍼

**Files:**
- Create: `apps/desktop/src/components/MarkdownEditor.tsx`
- Modify: `apps/desktop/src/app.css` (atomic-editor CSS 변수 오버라이드)

**Produces:**
```tsx
export function MarkdownEditor({ body, onChange, documentId, className, onLinkClick }: Props): JSX.Element
```

- [ ] **Step 1: app.css에 atomic-editor 변수 매핑 추가**

`apps/desktop/src/app.css` 끝(`@keyframes` 블록 이후)에 추가:

```css
/* atomic-editor theme tokens (§6) — mapped to oxinot design tokens. */
:root {
  --atomic-editor-fg: #18181b;
  --atomic-editor-bg: transparent;
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
```

- [ ] **Step 2: MarkdownEditor.tsx 작성**

`apps/desktop/src/components/MarkdownEditor.tsx` 생성:

```tsx
/**
 * React wrapper around `@atomic-editor/editor` (§4.1).
 *
 * The wrapper:
 *  - forces a `documentId` prop so swapping notes remounts the CM6 view
 *    (undo/cursor state from the previous note never leaks into the next)
 *  - forwards link clicks to the optional handler, falling back to a plain
 *    `window.open` so external links work in both browser-dev and Tauri.
 *
 * Read-only mode, code-language highlighting, and wiki-links are
 * intentionally NOT exposed — they're deferred to v2 to keep the wrapper
 * small and the bundle slim. Per spec §2, this is a deliberate scope cut.
 */
import { useRef } from "react";
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle,
} from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";

interface Props {
  body: string;
  onChange: (v: string) => void;
  /** Note identity — change it to swap documents (forces remount). */
  documentId: string;
  className?: string;
  onLinkClick?: (url: string) => void;
}

function defaultOpenLink(url: string): void {
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    // window.open can throw in sandboxed contexts; nothing we can do.
  }
}

export function MarkdownEditor({
  body,
  onChange,
  documentId,
  className,
  onLinkClick,
}: Props) {
  const handleRef = useRef<AtomicCodeMirrorEditorHandle | null>(null);
  return (
    <div className={className}>
      <AtomicCodeMirrorEditor
        documentId={documentId}
        markdownSource={body}
        onMarkdownChange={onChange}
        editorHandleRef={handleRef}
        onLinkClick={onLinkClick ?? defaultOpenLink}
      />
    </div>
  );
}
```

- [ ] **Step 3: 타입 체크**

```bash
cd apps/desktop && bunx tsc -b
```

Expected: PASS. 만약 atomic-editor의 export 형식이 다르면 에러 메시지에 보이는 정확한 시그니처로 Step 2의 import와 호출부를 조정한다.

- [ ] **Step 4: 빌드 검증 (Vite 청크 분리 확인)**

```bash
cd apps/desktop && bunx vite build
```

Expected: 정상 종료. 출력에서 `atomic-editor` 또는 `@codemirror`가 별도 청크로 분리된 것을 확인 (메인 청크에 inline되지 않음). `dist/assets/` 디렉터리에서 `dist/assets/*-*.js` 파일 크기 확인 — 너무 크면 문제 없음(빌드 자체 통과가 검증의 핵심).

- [ ] **Step 5: 커밋**

```bash
cd /Volumes/MERCURY/PROJECTS/oxinot
git add apps/desktop/src/components/MarkdownEditor.tsx apps/desktop/src/app.css
git commit -m "feat(editor): MarkdownEditor — atomic-editor React wrapper

Forwards documentId so note swaps remount the CM6 view (prevents
undo/cursor leak). Theme tokens mapped in app.css so the editor
follows oxinot's dark/light scheme."
```

---

### Task 6: `NoteEditorForm` — NoteDetail 전용 form

**Files:**
- Create: `apps/desktop/src/components/NoteEditorForm.tsx`

**Produces:**
```tsx
export function NoteEditorForm({ body, onBodyChange, documentId, color, onColorChange, onConfirm, confirmLabel, confirmDisabled, confirmKbd, className }: Props): JSX.Element
```

- [ ] **Step 1: 파일 작성**

`apps/desktop/src/components/NoteEditorForm.tsx` 생성:

```tsx
/**
 * NoteDetail 전용 편집 폼 (§4.3). 본문은 atomic-editor 기반
 * `MarkdownEditor`, 추출된 `#태그`는 `TagChipRow`, 하단에 컬러 + 완료.
 *
 * 기존 `NoteComposeForm`에서 textarea+mirror 오버레이 분기를 떼어내고
 * 본문 영역을 atomic-editor로 교체한 형태. 두 폼이 사용 의도가 다르므로
 * (NoteDetail=본격 편집, CaptureOverlay=빠른 캡처) 공통 컴포넌트로 묶지
 * 않고 의도적으로 분리함.
 */
import { Check } from "lucide-react";

import { ColorSwatches } from "./ColorPicker";
import { MarkdownEditor } from "./MarkdownEditor";
import { TagChipRow } from "./TagChipRow";

const cx = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join(" ");

export interface NoteEditorFormProps {
  body: string;
  onBodyChange: (v: string) => void;
  documentId: string;
  color: string;
  onColorChange: (oklch: string) => void;
  /** Primary action — "done" in NoteDetail. */
  onConfirm: () => void;
  confirmLabel: string;
  confirmDisabled?: boolean;
  /** Keyboard hint rendered inside the confirm button (e.g. "⌘⏎"). */
  confirmKbd?: string;
  className?: string;
}

export function NoteEditorForm({
  body,
  onBodyChange,
  documentId,
  color,
  onColorChange,
  onConfirm,
  confirmLabel,
  confirmDisabled,
  confirmKbd,
  className,
}: NoteEditorFormProps) {
  return (
    <div className={cx("flex flex-1 flex-col gap-2.5", className)}>
      <MarkdownEditor
        body={body}
        onChange={onBodyChange}
        documentId={documentId}
        className="min-h-[160px] flex-1"
      />
      <TagChipRow body={body} />
      <div className="flex flex-wrap items-center gap-2.5">
        <ColorSwatches value={color} onChange={onColorChange} />
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirmDisabled}
          aria-label={confirmLabel}
          title={confirmLabel}
          className="group ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-2 text-white shadow-sm transition-all hover:bg-zinc-800 active:scale-95 disabled:pointer-events-none disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          <Check
            size={15}
            strokeWidth={2.5}
            className="transition-transform group-hover:scale-110"
          />
          {confirmKbd && (
            <kbd className="font-mono text-[10px] leading-none text-white/60 dark:text-zinc-500">
              {confirmKbd}
            </kbd>
          )}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 타입 체크**

```bash
cd apps/desktop && bunx tsc -b
```

Expected: PASS.

- [ ] **Step 3: 커밋**

```bash
cd /Volumes/MERCURY/PROJECTS/oxinot
git add apps/desktop/src/components/NoteEditorForm.tsx
git commit -m "feat(editor): NoteEditorForm — atomic-editor + chips + confirm"
```

---

### Task 7: `QuickCaptureForm` — CaptureOverlay 전용 form

**Files:**
- Create: `apps/desktop/src/components/QuickCaptureForm.tsx`

**Produces:**
```tsx
export function QuickCaptureForm({ body, onBodyChange, bodyRef, bodyProps, color, onColorChange, onConfirm, confirmLabel, confirmDisabled, confirmKbd, className }: Props): JSX.Element
```

- [ ] **Step 1: 파일 작성**

`apps/desktop/src/components/QuickCaptureForm.tsx` 생성:

```tsx
/**
 * CaptureOverlay 전용 빠른 캡처 폼 (§4.4). 본문은 plain textarea 그대로
 * 유지 — CM6 mount 비용은 캡처 윈도우의 즉시성을 깎는다. 색상 + 저장만.
 *
 * `NoteComposeForm`에서 textarea 분기만 남긴 형태. `MirrorTagEditor` 미러
 * 오버레이는 빠짐 — 빠른 캡처의 본문은 거의 한 줄이라 시각적 칩 강조의
 * 가치가 작고, 본문 자체를 항상 plain text로 보여주는 편이 빠른 입력에
 * 더 적합. 태그는 `extractTags`로 저장 시 파생되므로 입력 중 표시 안 해도
 * 무방.
 */
import { type Ref, type TextareaHTMLAttributes } from "react";
import { Check } from "lucide-react";

import { ColorSwatches } from "./ColorPicker";

const cx = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join(" ");

export interface QuickCaptureFormProps {
  body: string;
  onBodyChange: (v: string) => void;
  bodyRef?: Ref<HTMLTextAreaElement>;
  bodyProps?: Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "value" | "onChange" | "className"
  >;
  bodyClassName?: string;
  color: string;
  onColorChange: (oklch: string) => void;
  /** Primary action — "save" in CaptureOverlay. */
  onConfirm: () => void;
  confirmLabel: string;
  confirmDisabled?: boolean;
  /** Keyboard hint rendered inside the confirm button (e.g. "↵"). */
  confirmKbd?: string;
  className?: string;
}

export function QuickCaptureForm({
  body,
  onBodyChange,
  bodyRef,
  bodyProps,
  bodyClassName,
  color,
  onColorChange,
  onConfirm,
  confirmLabel,
  confirmDisabled,
  confirmKbd,
  className,
}: QuickCaptureFormProps) {
  return (
    <div className={cx("flex flex-1 flex-col gap-2.5", className)}>
      <textarea
        ref={bodyRef}
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        spellCheck={false}
        {...bodyProps}
        className={cx(
          "min-h-0 flex-1 resize-none rounded-md border border-transparent bg-transparent p-1.5 text-sm leading-relaxed text-zinc-800 placeholder:text-zinc-400 focus:border-zinc-300 focus:outline-none dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-zinc-700",
          bodyClassName,
        )}
      />
      <div className="flex flex-wrap items-center gap-2.5">
        <ColorSwatches value={color} onChange={onColorChange} />
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirmDisabled}
          aria-label={confirmLabel}
          title={confirmLabel}
          className="group ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-2 text-white shadow-sm transition-all hover:bg-zinc-800 active:scale-95 disabled:pointer-events-none disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          <Check
            size={15}
            strokeWidth={2.5}
            className="transition-transform group-hover:scale-110"
          />
          {confirmKbd && (
            <kbd className="font-mono text-[10px] leading-none text-white/60 dark:text-zinc-500">
              {confirmKbd}
            </kbd>
          )}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 타입 체크**

```bash
cd apps/desktop && bunx tsc -b
```

Expected: PASS.

- [ ] **Step 3: 커밋**

```bash
cd /Volumes/MERCURY/PROJECTS/oxinot
git add apps/desktop/src/components/QuickCaptureForm.tsx
git commit -m "feat(editor): QuickCaptureForm — CaptureOverlay textarea form

Split from NoteComposeForm. Plain textarea preserved so capture-window
instant-open isn't blocked by CM6 mount cost."
```

---

### Task 8: `NoteDetail`을 `NoteEditorForm`으로 교체

**Files:**
- Modify: `apps/desktop/src/components/NoteDetail.tsx`

**Produces:** `NoteDetail`이 `NoteEditorForm`을 사용해 atomic-editor로 본문을 편집. `documentId={note.data.id}`를 전달해 노트 전환 시 CM6 view 재마운트 보장.

- [ ] **Step 1: import 영역 갱신**

`apps/desktop/src/components/NoteDetail.tsx`의 import 영역에서:
- `import { NoteComposeForm } from "./NoteComposeForm";`를 다음으로 교체:
  ```tsx
  import { NoteEditorForm } from "./NoteEditorForm";
  ```

- [ ] **Step 2: 본문 영역 교체**

`apps/desktop/src/components/NoteDetail.tsx` 내부의 `NoteComposeForm` 사용 영역을 다음으로 교체:

```tsx
              <NoteEditorForm
                body={body}
                onBodyChange={edit(setBody)}
                documentId={note.data.id}
                color={color}
                onColorChange={edit(setColor)}
                onConfirm={close}
                confirmLabel={t.done}
                confirmKbd="⌘⏎"
              />
```

기존 사용 영역의 형태(문맥 위치는 그대로):

```tsx
              <NoteComposeForm
                body={body}
                onBodyChange={edit(setBody)}
                bodyProps={{ autoFocus: true }}
                bodyClassName="min-h-[160px]"
                color={color}
                onColorChange={edit(setColor)}
                onConfirm={close}
                confirmLabel={t.done}
                confirmKbd="⌘⏎"
              />
```

→ 위와 같이 교체. `bodyProps={{ autoFocus: true }}`/`bodyClassName=...`는 atomic-editor에선 불필요하므로 제거.

- [ ] **Step 3: 타입 체크**

```bash
cd apps/desktop && bunx tsc -b
```

Expected: PASS.

- [ ] **Step 4: 커밋**

```bash
cd /Volumes/MERCURY/PROJECTS/oxinot
git add apps/desktop/src/components/NoteDetail.tsx
git commit -m "refactor(NoteDetail): swap NoteComposeForm for NoteEditorForm

Routes NoteDetail through atomic-editor. documentId forces a CM6
remount on note swap so undo/cursor state never leaks between notes."
```

---

### Task 9: `CaptureOverlay`를 `QuickCaptureForm`으로 교체

**Files:**
- Modify: `apps/desktop/src/components/CaptureOverlay.tsx`

**Produces:** `CaptureOverlay`가 `QuickCaptureForm`을 사용. 동작(Enter→save, Shift+Enter=line, Esc→dismiss, bodyRef focus)은 모두 그대로.

- [ ] **Step 1: import 교체**

`apps/desktop/src/components/CaptureOverlay.tsx`의 import 영역에서:
- `import { NoteComposeForm } from "./NoteComposeForm";`를 다음으로 교체:
  ```tsx
  import { QuickCaptureForm } from "./QuickCaptureForm";
  ```

- [ ] **Step 2: 사용 영역 교체**

`CaptureOverlay.tsx` 내부의 `NoteComposeForm` 사용 영역을 다음으로 교체:

```tsx
      <QuickCaptureForm
        body={value}
        onBodyChange={setValue}
        bodyRef={ref}
        bodyProps={{
          placeholder: t.capture_placeholder,
          rows: 2,
          onKeyDown: onKey,
        }}
        color={color}
        onColorChange={setColor}
        onConfirm={save}
        confirmLabel={t.capture_save}
        confirmDisabled={busy || value.trim().length === 0}
        confirmKbd="↵"
      />
```

기존 `NoteComposeForm` 호출의 모든 props(`bodyRef`, `bodyProps` 등)는 그대로 유지 — QuickCaptureForm이 동일한 시그니처를 제공.

- [ ] **Step 3: 타입 체크**

```bash
cd apps/desktop && bunx tsc -b
```

Expected: PASS.

- [ ] **Step 4: 커밋**

```bash
cd /Volumes/MERCURY/PROJECTS/oxinot
git add apps/desktop/src/components/CaptureOverlay.tsx
git commit -m "refactor(CaptureOverlay): swap NoteComposeForm for QuickCaptureForm

Capture flow unchanged — plain textarea, Enter→save, Shift+Enter=line,
Esc→dismiss. The split from NoteEditorForm just makes the intent
explicit: capture is fast, detail is rich."
```

---

### Task 10: `NoteComposeForm`과 `MirrorTagEditor` 삭제 + 최종 검증

**Files:**
- Delete: `apps/desktop/src/components/NoteComposeForm.tsx`
- Delete: `apps/desktop/src/components/MirrorTagEditor.tsx`

- [ ] **Step 1: 잔존 참조 grep**

```bash
cd /Volumes/MERCURY/PROJECTS/oxinot
grep -rn "NoteComposeForm\|MirrorTagEditor" apps/desktop/src
```

Expected: 출력 없음. 만약 남아있으면 모두 새 컴포넌트로 교체.

- [ ] **Step 2: 파일 삭제**

```bash
cd /Volumes/MERCURY/PROJECTS/oxinot
rm apps/desktop/src/components/NoteComposeForm.tsx
rm apps/desktop/src/components/MirrorTagEditor.tsx
```

- [ ] **Step 3: 타입 체크 + Vite 빌드 (풀 검증)**

```bash
cd apps/desktop && bun run build
```

Expected: `tsc -b` 0 에러 + `vite build` 정상 종료. 출력에 `dist/` 갱신. 번들 사이즈 메인 청크 ~280-310KB gzipped 범위 (CM6 + atomic-editor 추가로 약 +120KB gzipped).

- [ ] **Step 4: Rust 코어 단위 테스트 (변경 없음 확인)**

```bash
cd /Volumes/MERCURY/PROJECTS/oxinot && cargo test --workspace
```

Expected: 모든 기존 테스트 PASS (변경 없음 확인).

- [ ] **Step 5: 커밋**

```bash
cd /Volumes/MERCURY/PROJECTS/oxinot
git add -u apps/desktop/src/components/
git commit -m "refactor(editor): remove NoteComposeForm and MirrorTagEditor

Both components were split into NoteEditorForm (atomic-editor + chip
row) and QuickCaptureForm (plain textarea). MirrorTagEditor's
textarea-mirror-overlay technique is incompatible with CM6, and the
chip row visual affordance is now served by TagChipRow."
```

- [ ] **Step 6: 수동 검증 (브라우저 smoke test)**

`bun run dev`로 Vite dev 서버를 띄워 다음을 확인:

1. 메인 윈도우: 카드 그리드의 미리보기에 `# 제목`이 큰 헤더로, `**bold**`가 굵게, `- list`가 점 리스트로 표시되는지.
2. 카드 클릭 → NoteDetail 열림 → 본문에서 `**test**` 입력 시 즉시 굵은 글씨로 표시, `# heading` 입력 시 큰 글씨로 표시, `- item` 입력 시 리스트로 표시되는지.
3. NoteDetail에서 `⌘Z`/실행취소 동작 확인.
4. 카드 A → 카드 B 전환 시 두 번째 노트 진입 후 `⌘Z`가 두 번째 노트의 마지막 변경부터 실행취소되는지(누설 없음).
5. NoteDetail 하단에 `#태그` 칩들이 표시되는지(본문에 `#태그` 입력 시 자동 갱신).
6. 색상 스와치 + 확인 버튼 정상 동작.
7. 설정 토글 → 다크 모드 → 에디터 텍스트 가독성 유지.
8. 글로벌 단축키로 CaptureOverlay 띄움 → Enter로 저장 → 카드 그리드에 새 노트 표시.
9. CaptureOverlay에서 Shift+Enter는 줄바꿈, Esc는 dismiss 동작 유지.

검증 끝나면 dev 서버 종료.

- [ ] **Step 7: Tauri 데스크톱 빌드 (재배포 검증)**

```bash
cd /Volumes/MERCURY/PROJECTS/oxinot && cargo build -p oxinot-desktop --release
```

Expected: 정상 종료. 임베드 프론트가 갱신된 새 노트가 들어있는지 빌드 출력 로그로 확인. 본 작업은 빌드까지만 수행. `cargo install --path`/`cp` 단계는 사용자 결정 후 별도 진행(메인 세션에서 코드서명 + 재서명 필요).

---

## Self-Review 결과

**스펙 커버리지 점검:**

| 스펙 항목 | 커버 태스크 |
|---|---|
| §3 NoteDetail 아키텍처 (atomic-editor + chip row + 색상 + 확인) | Task 6 (NoteEditorForm) + Task 8 (NoteDetail 교체) |
| §3 CaptureOverlay 미변경 | Task 7 (QuickCaptureForm) + Task 9 (CaptureOverlay 교체, 동작 동일) |
| §3 NoteComposeForm 분해 | Task 6+7 (NoteEditorForm/QuickCaptureForm 신규) + Task 10 (NoteComposeForm 삭제) |
| §4.1 MarkdownEditor 래퍼 | Task 5 |
| §4.2 TagChipRow | Task 4 |
| §4.3 NoteEditorForm | Task 6 |
| §4.4 QuickCaptureForm | Task 7 |
| §4.5 파일 정리 (추가/변경/삭제) | Tasks 1–10 |
| §5 카드 미리보기 marked | Tasks 2+3 |
| §5.1 백엔드 preview 그대로 | 코드 변경 없음으로 검증 |
| §6 CSS 변수 매핑 | Task 3 (.md-preview) + Task 5 (atomic-editor vars) |
| §7 의존성 | Task 1 |
| §9 검증 계획 (Rust + 빌드 + 수동) | Task 10 Steps 3–7 |

**누락 없음.** 모든 스펙 결정이 매핑됨.

**Placeholder 점검:** "TBD"/"TODO"/"유사하게" 표현 없음. 모든 코드 블록 완성.

**타입 일관성 점검:** `renderPreviewMarkdown(body, maxLen?)` 시그니처는 Task 2에서 정의, Task 3에서 호출 — 일치. `MarkdownEditor` props는 Task 5에서 정의, Task 6에서 호출 — 일치. `TagChipRow` props는 Task 4에서 정의, Task 6에서 호출 — 일치. `NoteEditorForm`/`QuickCaptureForm` 시그니처는 Task 6/7 정의, Task 8/9 호출 — 시그니처가 NoteComposeForm과 호환됨을 명시.

**잠재적 함정:**

- **Task 5 Step 3 (atomic-editor 시그니처):** v0.6.2에서 export 형태가 다를 경우 에러 메시지에 보이는 정확한 이름으로 import/사용처를 조정한다. 필요 시 `node_modules/@atomic-editor/editor/dist/index.d.ts`를 직접 읽고 시그니처 확인.
- **Task 1 Step 2 (bun install):** peer dependency 경고는 무시 가능. 만약 atomic-editor 자체가 설치 실패하면 `bun add`로 개별 설치 재시도.
- **Task 3 Step 3 (Card.tsx):** `useMemo` import 추가가 기존 import 라인과의 충돌 없이 들어가야 함. 충돌 시 import 블록을 한 줄로 합친다.
- **Task 10 Step 1 (grep):** 남아있으면 즉시 Task 8/9를 다시 점검. 흔한 누락은 Sidebar.tsx/TagInput 등 다른 컴포넌트의 import — 본 작업의 컴포넌트 분해는 NoteDetail/CaptureOverlay 두 곳에서만 일어나므로 다른 곳에 누수가 없을 가능성 99%.
