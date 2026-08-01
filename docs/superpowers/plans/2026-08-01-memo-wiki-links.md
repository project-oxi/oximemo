# 메모 위키링크 + 임베드 구현 계획 — oxinot

> **For agentic workers:** 인라인 실행(동일 세션, 사용자 위임 "알아서 진행"). 단계는 체크박스로 추적.
> **Spec:** `docs/superpowers/specs/2026-08-01-memo-wiki-links-design.md`

**Goal:** 메모 본문에서 `[[memo-id]]` 위키링크(자동완성+칩)와 `![[memo-id]]` 임베드(읽기전용 트랜스클루전)를 지원한다.

**Architecture:** 프론트엔드 전용. 에디터 라이브러리 `@atomic-editor/editor`의 내장 `wikiLinks()` 확장을 `extensions` prop으로 활성화(`searchMemos`→suggest, `getMemo`→resolve, ID만 저장). 임베드는 CM6 `StateField` + block-replace(`image-blocks.js` 패턴)로 직접 구현. Rust/스키마 변경 없음.

**Tech Stack:** React 19, CodeMirror 6(`@codemirror/state`·`@codemirror/view` — 이미 직접 의존), `@atomic-editor/editor` wikiLinks, `marked`, TanStack Query, Zustand.

**Verification (프로젝트에 프론트엔드 테스트 러너 없음 → build + browser smoke):**
- `cd apps/desktop && bun run build` (tsc -b && vite build) 통과.
- `vite dev`(브라우저 localStorage 폴백 모드)에서 smoke: 메모 2개 생성 → `[[` 팝업 → Enter→`]]`+칩 → 칩 클릭으로 이동 → `![[` 임베드 블록 → missing 처리 → 카드 미리보기에 UUID 안 보임.

## Global Constraints
- 명칭: "메모"(note 아님). "즐겨찾기"(pin 아님).
- i18n: `ko.ts`가 source-of-truth, `en.ts`는 `Record<keyof typeof dict,string>`로 파생 → 키 추가 시 **양쪽 모두** 같은 키 추가(아니면 컴파일 에러).
- IPC 인자 camelCase(Tauri v2).
- 링크 저장은 `[[memo-id]]`(ID만). 임베드는 줄 단독 블록, 읽기전용, 1단계.

## File Structure
| 액션 | 파일 | 책임 |
|------|------|------|
| 추가 | `apps/desktop/src/lib/memoLinks.ts` | `buildWikiLinksConfig({onOpen})` → `WikiLinksConfig`. suggest/resolve/serialize + 매핑. |
| 추가 | `apps/desktop/src/lib/embeds.ts` | `embedExtension({onOpen})` → StateField block-replace. EmbedWidget. |
| 변경 | `apps/desktop/src/components/MarkdownEditor.tsx` | `extensions?: readonly Extension[]` prop 포워딩(공유 훅). |
| 변경 | `apps/desktop/src/components/MemoEditorForm.tsx` | extensions 조립(useMemo) 후 전달. |
| 변경 | `apps/desktop/src/lib/markdownPreview.ts` | 카드 미리보기에서 링크/임베드 구문을 칩 텍스트로 축약. |
| 변경 | `apps/desktop/src/lib/locales/{ko,en}.ts` | `missing_link`, `embed_loading`, `deleted_memo`. |

## Interfaces (계약)
- `memoLinks.ts`: `export function buildWikiLinksConfig(opts: { onOpen: (id:string)=>void }): WikiLinksConfig` (import 타입 `{ wikiLinks, type WikiLinksConfig, type WikiLinkSuggestion }` from `@atomic-editor/editor`).
- `embeds.ts`: `export function embedExtension(opts: { onOpen: (id:string)=>void }): Extension[]`. 내보내는 것은 `[embedField]`. `Extension`은 `@codemirror/state`.
- `MarkdownEditor.tsx`: Props에 `extensions?: readonly Extension[]` 추가 → `<AtomicCodeMirrorEditor extensions={extensions}>`.

---

### Task 1: i18n 키 추가
**Files:** Modify `lib/locales/ko.ts`, `lib/locales/en.ts`
- [ ] ko.ts `dict` 끝(`image_hint` 뒤)에 추가: `missing_link: "삭제된 링크"`, `embed_loading: "메모 불러오는 중…"`, `deleted_memo: "삭제된 메모"`.
- [ ] en.ts 동일 키 추가(영문): `missing_link: "Missing link"`, `embed_loading: "Loading memo…"`, `deleted_memo: "Deleted memo"`.
- [ ] `bun run build`로 컴파일 확인(키 누락 시 에러).

### Task 2: `lib/memoLinks.ts` 작성
**Files:** Create `lib/memoLinks.ts`
**Produces:** `buildWikiLinksConfig`
- [ ] 구현:
```ts
import { type WikiLinksConfig, type WikiLinkSuggestion } from "@atomic-editor/editor";
import { getMemo, listMemos, searchMemos } from "./api";
import type { MemoSummary } from "./types";

function toSuggestion(m: MemoSummary): WikiLinkSuggestion {
  return {
    target: m.id,
    label: (m.preview || m.id.slice(0, 8)).replace(/\s+/g, " ").trim().slice(0, 60),
    detail: [m.category && m.category !== "inbox" ? m.category : null, m.favorite ? "★" : null]
      .filter(Boolean).join(" ") || undefined,
    boost: m.favorite ? 1 : 0,
  };
}

export function buildWikiLinksConfig(opts: { onOpen: (id: string) => void }): WikiLinksConfig {
  return {
    suggest: async (query: string) => {
      const q = query.trim();
      if (!q) {
        const page = await listMemos(null, 24, { includeDeleted: false });
        const items = [...page.items].sort(
          (a, b) => Number(b.favorite) - Number(a.favorite) || b.updated_at.localeCompare(a.updated_at),
        );
        return items.map(toSuggestion);
      }
      return (await searchMemos(q, 12)).map(toSuggestion);
    },
    serializeSuggestion: (s) => `${s.target}]]`,
    resolve: async (id: string) => {
      try {
        const m = await getMemo(id);
        if (m.deleted_at) return { target: id, label: "삭제된 링크", status: "missing" };
        return { target: id, label: toSuggestion(m as any).label, status: "resolved" };
      } catch {
        return { target: id, label: "삭제된 링크", status: "missing" };
      }
    },
    shouldResolve: () => true,
    onOpen: opts.onOpen,
    openOnClick: true,
  };
}
```
- [ ] `Memo`엔 `preview`가 없으므로 resolve 라벨은 `m.body` 앞부분 사용하도록 보정(아래 실행 시 `makePreviewLabel(m.body)` 헬퍼 추가).

### Task 3: `lib/embeds.ts` 작성
**Files:** Create `lib/embeds.ts`
**Produces:** `embedExtension`
- [ ] 구현(StateField + block-replace, `image-blocks.js` 패턴):
```ts
import { Decoration, EditorView, StateField, type Extension } from "@codemirror/view" /* state에서 Extension */;
import { WidgetType } from "@codemirror/view";
import { getMemo } from "./api";
import { marked } from "marked";

const EMBED_RE = /^\s*!\[\[([^\]\n|]+)\]\]\s*$/;
const cache = new Map<string, { body?: string; status: "resolved" | "missing" }>();

class EmbedWidget extends WidgetType {
  constructor(readonly id: string, readonly onOpen: (id: string) => void) { super(); }
  eq(o: EmbedWidget) { return o.id === this.id; }
  toDOM() {
    const wrap = document.createElement("div"); wrap.className = "ox-embed";
    const hdr = document.createElement("div"); hdr.className = "ox-embed-hdr";
    hdr.textContent = "▢ " + this.id.slice(0, 8);
    hdr.onclick = () => this.onOpen(this.id);
    const body = document.createElement("div"); body.className = "ox-embed-body";
    wrap.append(hdr, body);
    const c = cache.get(this.id);
    if (c?.body) { body.innerHTML = marked.parse(c.body.slice(0, 800), { async: false }) as string; }
    else {
      body.textContent = "메모 불러오는 중…";
      if (!cache.has(this.id)) {
        cache.set(this.id, { status: "missing" });
        getMemo(this.id).then((m) => {
          cache.set(this.id, { body: m.deleted_at ? "" : m.body, status: m.deleted_at ? "missing" : "resolved" });
        }).catch(() => cache.set(this.id, { status: "missing" }));
      }
    }
    return wrap;
  }
  ignoreEvent() { return false; }
}

function buildEmbed(state: { doc: { iterLines: () => Iterable<string> } }, onOpen: (id: string) => void) {
  const decos: Range<Decoration>[] = [];
  let pos = 0;
  for (const line of state.doc.iterLines()) {
    const lineStart = pos;
    const next = pos + line.length + 1;
    const m = EMBED_RE.exec(line);
    if (m) decos.push(Decoration.replace({ block: true, widget: new EmbedWidget(m[1], onOpen) }).range(lineStart, next));
    pos = next;
  }
  return Decoration.set(decos, true);
}

export function embedExtension(opts: { onOpen: (id: string) => void }): Extension[] {
  const field = StateField.define({
    create: (s) => buildEmbed(s, opts.onOpen),
    update: (_v, tr) => buildEmbed(tr.state, opts.onOpen),
    provide: (f) => EditorView.decorations.from(f),
  });
  return [field];
}
```
- [ ] 실행 중 import 정리: `Extension`·`StateField`·`Decoration`은 `@codemirror/state`, `EditorView`·`WidgetType`은 `@codemirror/view`. `Range<Decoration>` 타입 import.

### Task 4: `MarkdownEditor.tsx` extensions 포워딩
**Files:** Modify `components/MarkdownEditor.tsx`
- [ ] Props에 `extensions?: readonly Extension[]` 추가(import `type Extension` from `@codemirror/state`).
- [ ] `<AtomicCodeMirrorEditor ... extensions={extensions}>` 전달. `documentId`/`markdownSource` 등 기존 prop 유지.

### Task 5: `MemoEditorForm.tsx` 확장 조립
**Files:** Modify `components/MemoEditorForm.tsx`
**Consumes:** `buildWikiLinksConfig`, `embedExtension`, `wikiLinks`(from `@atomic-editor/editor`), `useUI.select`.
- [ ] `useUI((s)=>s.select)`로 onOpen 획득.
- [ ] `useMemo`로 `const extensions = useMemo(() => [wikiLinks(cfg), ...embedExtension({onOpen:select})], [select])` (cfg = `buildWikiLinksConfig({onOpen:select})`).
- [ ] `<MarkdownEditor ... extensions={extensions} />` 전달.

### Task 6: `markdownPreview.ts` 링크/임베드 구문 정리
**Files:** Modify `lib/markdownPreview.ts`
- [ ] `marked.parse` 전, head 문자열에서 치환: `![[id]]` → `▢ 임베드`, `[[id|label]]` → `label`, `[[id]]` → `◆`. 정규식(순서 중요 — `![[]]` 먼저):
```ts
head = head.replace(/!\[\[([^\]\n|]+)(?:\|([^\]\n|]+))?\]\]/g, "▢ 임베드")
           .replace(/\[\[([^\]\n|]+)\|([^\]\n|]+)\]\]/g, "$2")
           .replace(/\[\[([^\]\n|]+)\]\]/g, "◆");
```

### Task 7: 빌드 검증
- [ ] `cd apps/desktop && bun run build` 통과.

### Task 8: 브라우저 smoke
- [ ] dev 서버(`vite`) 기동 → 메모 2개 생성 → `[[` 팝업/`]]`자동닫힘/칩/클릭이동/`![[`임베드/missing/미리보기 UUID 제거 확인. block-replace 칩 억제 최종 확인(결정 5).
