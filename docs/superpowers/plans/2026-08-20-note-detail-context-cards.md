# Note Detail Context Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `MemoDetail.tsx`'s stacked Backlinks/Brain accordion panels and the Immersive expand mode with a fixed-size dialog, a slim bottom `ContextDock` status bar, and two floating context popovers (Links, Brain) — one open at a time, layout-stable.

**Architecture:** Two new presentational components (`LinksCard`, `BrainCard`) render inside `@base-ui-components/react` `Popover.Popup`s. A new orchestrator (`ContextDock`) owns the backlinks query, the brain status/gather/distill state machine, and which popover is open. `MemoDetail.tsx` drops its `immersive` state and renders `ContextDock` instead of `BacklinksPanel`/`BrainPanel`. `MemoEditorForm.tsx` drops its now-dead `immersive` prop.

**Tech Stack:** React 19, TypeScript 5, `@base-ui-components/react` Popover (already used by `FolderCombobox.tsx`), `@tanstack/react-query`, Zustand (`stores/ui.ts`), Tailwind v4 with the project's semantic/component CSS tokens.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-20-note-detail-context-cards-design.md` — every task below implements a numbered section of it; do not deviate from the sizes, states, or behaviors it locks in.
- No frontend unit/component test framework is configured in `apps/desktop` (no vitest/jest, no existing `*.test.*` files anywhere in `apps/desktop/src`). Per-task verification is `bun run build` (runs `tsc -b && vite build`) as the type-check/build gate — this matches the project's own established verification convention (`docs/superpowers/plans/2026-08-14-notebook-remaining-work.md`: "Frontend builds green (`bun run build`)", "Runtime: browser-verified"). The final task adds a manual runtime smoke pass; do not introduce a new test framework as part of this plan.
- i18n: every new string needs both a `ko.ts` and an `en.ts` key (`apps/desktop/src/lib/locales/`); the `DictKey` type is derived from the `ko` dict, so a missing `en` key is a type error, and a missing `ko` key is a silent gap — add both together.
- Follow the existing `Popover` pattern from `apps/desktop/src/components/FolderCombobox.tsx` (`Popover.Root` → `Popover.Trigger` with `render={<button>…</button>}` → `Popover.Portal` → `Popover.Positioner` → `Popover.Popup`). Do not hand-roll outside-click/Escape/focus-return logic — Base UI's Popover already provides it.
- Radius/shadow/color: use the existing CSS custom properties (`var(--popover-radius)`, `var(--tag-radius)`, `--color-status-success`, etc.) exactly as the files being replaced already do. Never introduce a raw hex/px value where a token exists.
- Commit messages: Conventional Commits, English, per repo `AGENTS.md` (`feat:`, `refactor:`, etc.).
- Run all commands with `cwd: apps/desktop` (the Vite/TS project root), not the monorepo root.
- Motion: apply the existing `animate-popover-in` utility (`apps/desktop/src/app.css:88`, `@keyframes popover-in` at `app.css:138-141` — 4px slide + fade, `var(--duration-fast)` = 120ms) to both `Popover.Popup` elements in Task 4. `prefers-reduced-motion` is already handled globally by `apps/desktop/src/tokens/components.css:42-46` (collapses `--duration-fast` to `0ms`) — no extra reduced-motion handling needed in this task.

---

### Task 1: Add `dock_saved` / `dock_saving` i18n keys

**Files:**
- Modify: `apps/desktop/src/lib/locales/ko.ts`
- Modify: `apps/desktop/src/lib/locales/en.ts`

**Interfaces:**
- Produces: `t.dock_saved: string`, `t.dock_saving: string` — consumed by Task 4 (`ContextDock.tsx`).

- [ ] **Step 1: Add the Korean keys**

Open `apps/desktop/src/lib/locales/ko.ts`. Find this existing block (it currently ends the dict, per `docs/superpowers/specs/2026-08-13-memo-to-notebook-design.md` locale conventions):

```ts
  brain_layer_other: "기타",
} as const satisfies Record<string, string>;
```

Replace it with:

```ts
  brain_layer_other: "기타",
  dock_saved: "저장됨",
  dock_saving: "저장 중…",
} as const satisfies Record<string, string>;
```

- [ ] **Step 2: Add the English keys**

Open `apps/desktop/src/lib/locales/en.ts`. Find the matching closing block for the `brain_layer_other` key (mirrors `ko.ts` structure) and add the two keys the same way, in English:

```ts
  dock_saved: "Saved",
  dock_saving: "Saving…",
```

- [ ] **Step 3: Verify the build**

Run: `bun run build` (cwd `apps/desktop`)
Expected: exits 0. If `en.ts` is missing a key present in `ko.ts` (or vice versa), `tsc -b` fails on the `DictKey` type — fix immediately, don't proceed with a red build.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/lib/locales/ko.ts apps/desktop/src/lib/locales/en.ts
git commit -m "feat: add dock_saved/dock_saving i18n keys"
```

---

### Task 2: Create `LinksCard.tsx`

**Files:**
- Create: `apps/desktop/src/components/LinksCard.tsx`

**Interfaces:**
- Consumes: `BacklinkInfo` from `apps/desktop/src/lib/types.ts` (`{ id: string; title: string; preview: string }`), `useI18n()` from `apps/desktop/src/lib/i18n.tsx` (existing keys `t.backlinks_title`, `t.backlinks_empty`).
- Produces: `LinksCard({ backlinks, isLoading, onNavigate })` — a presentational component with no data fetching of its own. Consumed by Task 4 (`ContextDock.tsx`).

- [ ] **Step 1: Write the component**

```tsx
/**
 * Links context card (§3.2, docs/superpowers/specs/2026-08-20-note-detail-context-cards-design.md).
 * Presentational only — data fetching and open/close state live in ContextDock.
 * Renders inside a Popover.Popup, sized per the spec: 320px wide, 360px max height.
 */
import { useI18n } from "../lib/i18n";
import type { BacklinkInfo } from "../lib/types";

export interface LinksCardProps {
  backlinks: BacklinkInfo[];
  isLoading: boolean;
  onNavigate: (id: string) => void;
}

export function LinksCard({ backlinks, isLoading, onNavigate }: LinksCardProps) {
  const { t } = useI18n();

  return (
    <div className="flex max-h-[360px] w-80 flex-col overflow-hidden">
      <div className="border-b border-line px-3 py-2 text-xs font-medium text-text-subtle">
        {t.backlinks_title.replace("{n}", String(backlinks.length))}
      </div>
      <div className="overflow-y-auto px-1 py-1">
        {isLoading ? (
          <p className="px-2 py-2 text-xs text-text-subtle">…</p>
        ) : backlinks.length === 0 ? (
          <p className="px-2 py-2 text-xs text-text-subtle">{t.backlinks_empty}</p>
        ) : (
          <ul className="space-y-0.5">
            {backlinks.map((bl) => (
              <li key={bl.id}>
                <button
                  type="button"
                  onClick={() => onNavigate(bl.id)}
                  className="block w-full truncate rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-muted"
                >
                  <span className="font-medium text-text">{bl.title}</span>
                  <span className="mt-0.5 block truncate text-text-subtle">
                    {bl.preview}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the build**

Run: `bun run build` (cwd `apps/desktop`)
Expected: exits 0. `LinksCard` is not imported anywhere yet, so this only checks the file itself type-checks (unused-export is not an error in this project's `tsconfig`).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/LinksCard.tsx
git commit -m "feat: add LinksCard context popover component"
```

---

### Task 3: Create `BrainCard.tsx`

**Files:**
- Create: `apps/desktop/src/components/BrainCard.tsx`

**Interfaces:**
- Consumes: `BrainStatus`, `BrainLayer` from `apps/desktop/src/lib/types.ts`; `useI18n()` (existing keys `t.brain_title`, `t.brain_offline`, `t.brain_retry`, `t.brain_gather`, `t.brain_gathering`, `t.brain_distill`, `t.brain_episodes`, `t.brain_layer_*`).
- Produces:
  - `layerLabel(t: Dict, kind: string): string` — exported, reused by Task 4's `distill()` for markdown section headers (must render identically to the current `BrainPanel.tsx` output — no regression in the generated note body).
  - `BrainCard({ status, layers, gathering, offline, onGather, onRetryStatus, onDistill })` — presentational; state and API calls live in `ContextDock` (Task 4) so gathered layers persist across the popover closing and reopening.

- [ ] **Step 1: Write the component**

```tsx
/**
 * Brain context card (§3.3, docs/superpowers/specs/2026-08-20-note-detail-context-cards-design.md).
 * Presentational only — the gather/distill state machine lives in ContextDock
 * so results survive the popover closing and reopening. Renders inside a
 * Popover.Popup, sized per the spec: 360px wide, min(480px, 65vh) max height.
 */
import { Sparkles } from "lucide-react";
import { useI18n, type Dict } from "../lib/i18n";
import type { BrainLayer, BrainStatus } from "../lib/types";

const LAYER_LABEL_KEYS: Partial<
  Record<
    string,
    | "brain_layer_recent_episodes"
    | "brain_layer_query_neighborhood"
    | "brain_layer_high_salience_beliefs"
    | "brain_layer_summaries"
  >
> = {
  recent_episodes: "brain_layer_recent_episodes",
  query_neighborhood: "brain_layer_query_neighborhood",
  high_salience_beliefs: "brain_layer_high_salience_beliefs",
  summaries: "brain_layer_summaries",
};

export function layerLabel(t: Dict, kind: string): string {
  const key = LAYER_LABEL_KEYS[kind] ?? "brain_layer_other";
  return t[key];
}

export interface BrainCardProps {
  status: BrainStatus | undefined;
  layers: BrainLayer[] | null;
  gathering: boolean;
  offline: boolean;
  onGather: () => void;
  onRetryStatus: () => void;
  onDistill: () => void;
}

export function BrainCard({
  status,
  layers,
  gathering,
  offline,
  onGather,
  onRetryStatus,
  onDistill,
}: BrainCardProps) {
  const { t } = useI18n();
  const online = status?.online === true;

  return (
    <div className="flex max-h-[min(480px,65vh)] w-[360px] flex-col overflow-hidden">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2 text-xs font-medium text-text">
        <span
          aria-label={online ? "online" : "offline"}
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            online ? "bg-status-success" : "bg-text-subtle/40"
          }`}
        />
        {t.brain_title}
        {online && (
          <span className="ml-1 font-normal text-text-subtle">
            {t.brain_episodes
              .replace("{n}", String(status?.episodes ?? 0))
              .replace("{e}", String(status?.entities ?? 0))}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {!online ? (
          <div className="flex items-center gap-2 py-1 text-xs text-text-subtle">
            {t.brain_offline}
            <button
              type="button"
              onClick={onRetryStatus}
              className="rounded-md px-1.5 py-0.5 text-xs hover:bg-surface-muted hover:text-text"
            >
              {t.brain_retry}
            </button>
          </div>
        ) : layers === null ? (
          <button
            type="button"
            onClick={onGather}
            disabled={gathering}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-xs text-text-subtle transition-colors hover:bg-surface-muted hover:text-text disabled:opacity-50"
          >
            <Sparkles size={12} />
            {gathering ? t.brain_gathering : t.brain_gather}
          </button>
        ) : (
          <div className="space-y-2">
            {layers.length === 0 && (
              <p className="py-1 text-xs text-text-subtle">{t.brain_layer_other}</p>
            )}
            {layers.map((l, i) => (
              <div key={`${l.kind}-${i}`} className="rounded-md bg-surface-muted/60 px-2 py-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
                  {layerLabel(t, l.kind)}
                </p>
                <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-text">
                  {l.text.trim()}
                </pre>
              </div>
            ))}
          </div>
        )}
        {offline && online && (
          <p className="pt-1 text-[10px] text-text-subtle">{t.brain_offline}</p>
        )}
      </div>
      {online && layers !== null && (
        <div className="flex gap-2 border-t border-line px-3 py-2">
          <button
            type="button"
            onClick={onGather}
            disabled={gathering}
            className="rounded-lg border border-line px-2 py-1 text-xs text-text-subtle hover:bg-surface-muted hover:text-text disabled:opacity-50"
          >
            {gathering ? t.brain_gathering : t.brain_gather}
          </button>
          <button
            type="button"
            onClick={onDistill}
            disabled={layers.length === 0}
            className="rounded-lg bg-interactive-primary px-2 py-1 text-xs text-interactive-primary-foreground hover:bg-interactive-primary/90 disabled:opacity-40"
          >
            {t.brain_distill}
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify the build**

Run: `bun run build` (cwd `apps/desktop`)
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/BrainCard.tsx
git commit -m "feat: add BrainCard context popover component"
```

---

### Task 4: Create `ContextDock.tsx`

**Files:**
- Create: `apps/desktop/src/components/ContextDock.tsx`

**Interfaces:**
- Consumes:
  - `LinksCard` from `./LinksCard` (Task 2), `BrainCard`/`layerLabel` from `./BrainCard` (Task 3)
  - `getBacklinks`, `brainStatus`, `brainGather`, `createMemo`, `getConfig` from `../lib/api` (all existing, unchanged signatures)
  - `useUI` from `../stores/ui` — `select(id: string | null)`, `setDraftId(id: string | null)`, `setError(msg: string)` (same calls `BrainPanel.tsx`/`BacklinksPanel.tsx` already made)
  - `t.dock_saved`, `t.dock_saving` (Task 1)
- Produces: `ContextDock({ noteId, title, tags, dirty })` — consumed by Task 5 (`MemoDetail.tsx`).

- [ ] **Step 1: Write the component**

```tsx
/**
 * Context Dock (§3.1, docs/superpowers/specs/2026-08-20-note-detail-context-cards-design.md).
 * Bottom status bar for the note detail dialog. Owns the backlinks query,
 * the brain status/gather/distill state, and which context card (if any)
 * is open — only one card open at a time, per the interaction contract (§3.4).
 * Replaces the former BacklinksPanel + BrainPanel accordion stack.
 */
import { Popover } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Brain, Link2 } from "lucide-react";

import { brainGather, brainStatus, createMemo, getBacklinks, getConfig } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import type { BrainLayer } from "../lib/types";
import { BrainCard, layerLabel } from "./BrainCard";
import { LinksCard } from "./LinksCard";

export interface ContextDockProps {
  noteId: string;
  title: string | null;
  tags: string[];
  dirty: boolean;
}

type OpenCard = "links" | "brain" | null;

/** recall() returns `{layers: [{kind, text}, ...]}`; be defensive about
 * shape drift between daemon versions (mirrors the check BrainPanel used). */
function layersOf(value: unknown): BrainLayer[] {
  if (!value || typeof value !== "object") return [];
  const raw = (value as { layers?: unknown }).layers;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((l) =>
    l &&
    typeof l === "object" &&
    typeof (l as BrainLayer).kind === "string" &&
    typeof (l as BrainLayer).text === "string"
      ? [l as BrainLayer]
      : [],
  );
}

export function ContextDock({ noteId, title, tags, dirty }: ContextDockProps) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const select = useUI((s) => s.select);
  const setDraftId = useUI((s) => s.setDraftId);
  const setError = useUI((s) => s.setError);

  const [open, setOpen] = useState<OpenCard>(null);
  const [layers, setLayers] = useState<BrainLayer[] | null>(null);
  const [gathering, setGathering] = useState(false);
  const [offline, setOffline] = useState(false);

  const config = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const brainEnabled = config.data?.brain?.enabled !== false;

  const backlinks = useQuery({
    queryKey: ["backlinks", noteId],
    queryFn: () => getBacklinks(noteId),
    enabled: !!noteId,
  });

  const status = useQuery({
    queryKey: ["brain-status"],
    queryFn: brainStatus,
    staleTime: 60_000,
    enabled: brainEnabled,
  });

  // The dialog swaps `noteId` in place when navigating (backlink click, wiki
  // link, distill). Gathered layers and the open card must not leak across
  // notes.
  useEffect(() => {
    setLayers(null);
    setGathering(false);
    setOffline(false);
    setOpen(null);
  }, [noteId]);

  const query = [title, ...tags].filter(Boolean).join(" ") || "최근 노트";

  const gather = () => {
    setGathering(true);
    setOffline(false);
    brainGather(query, 4000)
      .then((v) => setLayers(layersOf(v)))
      .catch(() => {
        setOffline(true);
        setLayers(null);
      })
      .finally(() => {
        setGathering(false);
        qc.invalidateQueries({ queryKey: ["brain-status"] });
      });
  };

  const distill = () => {
    if (!layers?.length) return;
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const body = [
      title ? `# ${title} — Brain 컨텍스트` : "# Brain 컨텍스트",
      "",
      `> ${stamp} · oxibrain recall ("${query}")`,
      "",
      ...layers.map((l) => `## ${layerLabel(t, l.kind)}\n\n${l.text.trim()}\n`),
      "---",
      `출처: Brain 컨텍스트 수집 (노트 ${noteId.slice(0, 8)})`,
    ].join("\n");
    createMemo(body, null)
      .then((n) => {
        setOpen(null);
        setDraftId(n.id);
        select(n.id);
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const navigateToBacklink = (id: string) => {
    setOpen(null);
    select(id);
  };

  return (
    <div className="flex items-center gap-1 border-t border-line px-1 py-1 text-xs text-text-subtle">
      <Popover.Root open={open === "links"} onOpenChange={(o) => setOpen(o ? "links" : null)}>
        <Popover.Trigger
          render={
            <button
              type="button"
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors duration-150 ${
                open === "links" ? "bg-surface-muted text-text" : "hover:bg-surface-muted hover:text-text"
              }`}
            >
              <Link2 size={12} />
              {t.backlinks_title.replace("{n}", String(backlinks.data?.length ?? 0))}
            </button>
          }
        />
        <Popover.Portal>
          <Popover.Positioner side="top" align="start" sideOffset={4}>
            <Popover.Popup className="z-50 animate-popover-in rounded-[var(--popover-radius)] border border-line bg-surface-raised shadow-lg">
              <LinksCard
                backlinks={backlinks.data ?? []}
                isLoading={backlinks.isLoading}
                onNavigate={navigateToBacklink}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>

      {brainEnabled && (
        <Popover.Root open={open === "brain"} onOpenChange={(o) => setOpen(o ? "brain" : null)}>
          <Popover.Trigger
            render={
              <button
                type="button"
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors duration-150 ${
                  open === "brain" ? "bg-surface-muted text-text" : "hover:bg-surface-muted hover:text-text"
                }`}
              >
                <Brain size={12} />
                {t.brain_title}
                <span
                  aria-label={status.data?.online ? "online" : "offline"}
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    status.data?.online ? "bg-status-success" : "bg-text-subtle/40"
                  }`}
                />
              </button>
            }
          />
          <Popover.Portal>
            <Popover.Positioner side="top" align="start" sideOffset={4}>
              <Popover.Popup className="z-50 animate-popover-in rounded-[var(--popover-radius)] border border-line bg-surface-raised shadow-lg">
                <BrainCard
                  status={status.data}
                  layers={layers}
                  gathering={gathering}
                  offline={offline}
                  onGather={gather}
                  onRetryStatus={() => void status.refetch()}
                  onDistill={distill}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )}

      <span className="ml-auto">{dirty ? t.dock_saving : t.dock_saved}</span>
    </div>
  );
}
```

- [ ] **Step 2: Verify the build**

Run: `bun run build` (cwd `apps/desktop`)
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/ContextDock.tsx
git commit -m "feat: add ContextDock orchestrator for note detail context cards"
```

---

### Task 5: Wire `ContextDock` into `MemoDetail.tsx`; remove Immersive mode; delete old panels

**Files:**
- Modify: `apps/desktop/src/components/MemoDetail.tsx`
- Modify: `apps/desktop/src/components/MemoEditorForm.tsx`
- Delete: `apps/desktop/src/components/BacklinksPanel.tsx`
- Delete: `apps/desktop/src/components/BrainPanel.tsx`

**Interfaces:**
- Consumes: `ContextDock` from `./ContextDock` (Task 4).
- Produces: `MemoDetail` renders a single fixed-size dialog (`h-[80vh] w-[min(640px,92vw)] p-5`) with no Immersive toggle.

- [ ] **Step 1: `MemoDetail.tsx` — trim the import list**

Find (current lines 7-21):

```tsx
import { Dialog } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Folder, Maximize2, Minimize2, Star } from "lucide-react";

import { deleteMemo, getMemo, updateMemo, listFolders } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import { BacklinksPanel } from "./BacklinksPanel";
import { BrainPanel } from "./BrainPanel";
import { TagChipRow } from "./TagChipRow";
import { HtmlNoteEditor } from "./HtmlNoteEditor";
import { MemoEditorForm } from "./MemoEditorForm";
import type { FolderComboboxHandle } from "./FolderCombobox";
import type { FolderEntry } from "../lib/types";
```

Replace with:

```tsx
import { Dialog } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Folder, Star } from "lucide-react";

import { deleteMemo, getMemo, updateMemo, listFolders } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import { ContextDock } from "./ContextDock";
import { TagChipRow } from "./TagChipRow";
import { HtmlNoteEditor } from "./HtmlNoteEditor";
import { MemoEditorForm } from "./MemoEditorForm";
import type { FolderComboboxHandle } from "./FolderCombobox";
import type { FolderEntry } from "../lib/types";
```

- [ ] **Step 2: `MemoDetail.tsx` — drop the `immersive` state**

Find (current line 45):

```tsx
  const [immersive, setImmersive] = useState(false);
```

Delete this line entirely (do not replace with anything).

- [ ] **Step 3: `MemoDetail.tsx` — drop `setImmersive(false)` from the seeding effect**

Find (current lines 52-62):

```tsx
  useEffect(() => {
    if (open && memo.data && seededId !== memo.data.id) {
      setBody(memo.data.body);
      setFolder(memo.data.folder);
      setFavorite(memo.data.favorite);
      setDirty(false);
      setSeededId(memo.data.id);
      setImmersive(false);
    }
    if (!open && seededId !== null) setSeededId(null);
  }, [open, memo.data, seededId]);
```

Replace with:

```tsx
  useEffect(() => {
    if (open && memo.data && seededId !== memo.data.id) {
      setBody(memo.data.body);
      setFolder(memo.data.folder);
      setFavorite(memo.data.favorite);
      setDirty(false);
      setSeededId(memo.data.id);
    }
    if (!open && seededId !== null) setSeededId(null);
  }, [open, memo.data, seededId]);
```

- [ ] **Step 4: `MemoDetail.tsx` — fix the dialog size to Compact only**

Find (current lines 125-127):

```tsx
  const popupSize = immersive
    ? "h-[94vh] w-[min(900px,96vw)] p-6"
    : "h-[80vh] w-[min(640px,92vw)] p-5";
```

Replace with:

```tsx
  const popupSize = "h-[80vh] w-[min(640px,92vw)] p-5";
```

- [ ] **Step 5: `MemoDetail.tsx` — remove the Maximize/Minimize toggle button**

Find (current lines 158-165, the button between the favorite star and the Done button):

```tsx
              <button
                type="button"
                onClick={() => setImmersive((v) => !v)}
                className="rounded-md p-1.5 text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                aria-label={immersive ? "Exit immersive" : "Enter immersive"}
              >
                {immersive ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
```

Delete this button block entirely — the toolbar goes straight from the favorite star button to the Done button.

- [ ] **Step 6: `MemoDetail.tsx` — drop the `immersive` prop on `MemoEditorForm`**

Find (current lines 186-195):

```tsx
              <MemoEditorForm
                documentId={memo.data.id}
                folder={folder}
                onFolderChange={edit(setFolder)}
                folders={folders}
                body={body}
                onBodyChange={edit(setBody)}
                folderPickerRef={folderPickerRef}
                immersive={immersive}
              />
```

Replace with:

```tsx
              <MemoEditorForm
                documentId={memo.data.id}
                folder={folder}
                onFolderChange={edit(setFolder)}
                folders={folders}
                body={body}
                onBodyChange={edit(setBody)}
                folderPickerRef={folderPickerRef}
              />
```

- [ ] **Step 7: `MemoDetail.tsx` — replace the Backlinks/Brain block with `ContextDock`**

Find (current lines 197-206):

```tsx
            {!immersive && memo.data && seededId === memo.data.id && (
              <>
                <BacklinksPanel noteId={memo.data.id} />
                <BrainPanel
                  noteId={memo.data.id}
                  title={memo.data.title}
                  tags={memo.data.tags}
                />
              </>
            )}
```

Replace with:

```tsx
            {memo.data && seededId === memo.data.id && (
              <ContextDock
                noteId={memo.data.id}
                title={memo.data.title}
                tags={memo.data.tags}
                dirty={dirty}
              />
            )}
```

- [ ] **Step 8: `MemoEditorForm.tsx` — remove the `immersive` prop**

Find (current lines 24-34):

```tsx
export interface MemoEditorFormProps {
  body: string;
  onBodyChange: (v: string) => void;
  documentId: string;
  folder: string;
  onFolderChange: (f: string) => void;
  folders: FolderEntry[];
  folderPickerRef?: Ref<FolderComboboxHandle>;
  className?: string;
  immersive?: boolean;
}
```

Replace with:

```tsx
export interface MemoEditorFormProps {
  body: string;
  onBodyChange: (v: string) => void;
  documentId: string;
  folder: string;
  onFolderChange: (f: string) => void;
  folders: FolderEntry[];
  folderPickerRef?: Ref<FolderComboboxHandle>;
  className?: string;
}
```

- [ ] **Step 9: `MemoEditorForm.tsx` — remove `immersive` from the destructured params**

Find (current lines 36-46):

```tsx
export function MemoEditorForm({
  body,
  onBodyChange,
  documentId,
  folder,
  onFolderChange,
  folders,
  folderPickerRef,
  className,
  immersive,
}: MemoEditorFormProps) {
```

Replace with:

```tsx
export function MemoEditorForm({
  body,
  onBodyChange,
  documentId,
  folder,
  onFolderChange,
  folders,
  folderPickerRef,
  className,
}: MemoEditorFormProps) {
```

- [ ] **Step 10: `MemoEditorForm.tsx` — remove the dead refocus-on-immersive effect**

Find (current lines 64-67, the second `useEffect` — keep the first one, which refocuses on `documentId` change):

```tsx
  useEffect(() => {
    const id = requestAnimationFrame(() => editorHandleRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [immersive]);
```

Delete this effect block entirely.

- [ ] **Step 11: Delete the replaced panel components**

```bash
git rm apps/desktop/src/components/BacklinksPanel.tsx apps/desktop/src/components/BrainPanel.tsx
```

- [ ] **Step 12: Verify the build**

Run: `bun run build` (cwd `apps/desktop`)
Expected: exits 0. If `tsc` reports `Maximize2`/`Minimize2`/`BacklinksPanel`/`BrainPanel` as unresolved or unused, confirm every reference from Steps 1-10 was removed — no orphaned imports.

- [ ] **Step 13: Commit**

```bash
git add apps/desktop/src/components/MemoDetail.tsx apps/desktop/src/components/MemoEditorForm.tsx
git commit -m "refactor: replace immersive dialog and stacked panels with ContextDock"
```

---

### Task 6: Manual runtime verification and final check

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server**

Run (cwd `apps/desktop`, background): `bun run dev`
Expected: Vite prints a local URL (default `http://localhost:5173`).

- [ ] **Step 2: Open the app in a browser and drive it**

Use the browser tool to open the dev URL, then:
1. Open any note card → the detail dialog appears at `640px`-class width (Compact size only — there must be no way to trigger a larger dialog; the Maximize/Minimize button no longer exists in the toolbar).
2. Confirm the bottom of the dialog shows the Context Dock: `Links {n}` button, `Brain` button with a status dot (unless `config.brain.enabled === false`), and a `Saved`/`Saving…` indicator on the right.
3. Click the `Links` button → a popover opens above the dock showing the backlinks list (or the empty-state text if none). Click elsewhere in the dialog (outside the popover) → it closes. Reopen it, press `Escape` → it closes and the dialog itself stays open.
4. Click the `Brain` button → the Links popover (if open) closes and the Brain popover opens in its place — never both at once.
5. Type in the editor body while a popover is open (if one is open) or closed — confirm the editor's height, line wrapping, and scroll position never shift when a popover opens or closes.
6. Note: in plain browser dev mode (no Tauri backend), `get_backlinks`/`brain_status` calls may resolve to empty/offline states rather than real data — this is expected and matches the project's existing browser-fallback behavior documented in `docs/superpowers/plans/2026-08-14-notebook-remaining-work.md` §2. Confirm the UI renders the empty/offline states cleanly (no thrown errors, no blank popover) rather than requiring live Tauri data to check the interaction contract itself.
7. Keyboard only: click somewhere neutral to clear focus, then press `Tab` repeatedly until the `Links` dock button is focused (visible focus ring), press `Enter` → the Links popover opens; press `Escape` → it closes and focus returns to the `Links` button (confirm the visible focus ring is back on that button, not lost to the document body).
8. Close the dialog (`Done` or ⌘⏎) after having opened/closed a popover and navigated via a backlink — confirm the main window's file tree selection, folder, search text, view mode, and scroll position are all exactly as they were before the dialog was opened (this behavior is untouched by this plan's changes; the check exists to catch an accidental regression).
9. Check the browser console for errors during all of the above — expect none.

- [ ] **Step 3: Final full build**

Run: `bun run build` (cwd `apps/desktop`)
Expected: exits 0 with no warnings about unused `BacklinksPanel`/`BrainPanel`/`Maximize2`/`Minimize2`/`immersive` symbols anywhere in the codebase.

- [ ] **Step 4: Confirm no stray references remain**

Run: `grep -rn "immersive\|BacklinksPanel\|BrainPanel" apps/desktop/src --include=*.tsx --include=*.ts` (or equivalent — use the `grep` tool, not shell `grep`, if running inside an agent session)
Expected: zero matches. (`BrainCard.tsx`/`LinksCard.tsx`/`ContextDock.tsx` do not contain these identifiers.)

- [ ] **Step 5: Commit if Step 2-4 required any fixes**

If verification surfaced no changes, this step is a no-op — Task 5's commit already covers the working state. If any fix was needed, commit it with an appropriately scoped message (`fix: …`).
