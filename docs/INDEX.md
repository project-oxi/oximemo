# oximemo Documentation Index

> Generated for the oxi ecosystem doc sweep (2026-08-02). This index lists every `*.md` tracked by the oximemo repository and points to the canonical unified design system.

## Canonical design system

The single source of truth for the unified design system is:

- **`project-oxi/.github/DESIGN.md`** — v1.0 · 2026-07-31 · covers `oxinot`, `oxipage`, `oxios` (and historically `oximemo`).

oximemo also keeps local references (product-specific design + a pre-canonical snapshot):

- `doc/DESIGN.md` — **project-specific** design (product · data · CLI). Header note points to canonical.
- `doc/UNIFIED-DESIGN.md` — **project-local snapshot** of the design system (design-farmer Phase 4.5, predates canonical). Header note points to canonical.
- `.omp/DESIGN-REF.md` — pointer file pointing at canonical, with a backlink to the local snapshot.

## Directory layout

| Path | Purpose | `.md` count |
|---|---|---|
| `doc/` | Project design + readiness docs (project-specific; visual tokens follow canonical) | 4 |
| `docs/superpowers/plans/` | Implementation plans (date-stamped) | 7 |
| `docs/superpowers/specs/` | Design specs that produced the plans | 9 |
| `.omp/` | OMP runtime artifacts (master reports, auto-task descriptions, pointer) | 5 |
| Root `*.md` | `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md` | 3 |

**Total tracked `.md` files:** 28 (4 + 7 + 9 + 5 + 3).

## `doc/` — project docs

| File | Purpose |
|---|---|
| `doc/DESIGN.md` | oximemo product · data · CLI design (v0.2, 2026-07-28). Visual tokens follow `doc/UNIFIED-DESIGN.md`. Header note now points to `project-oxi/.github/DESIGN.md`. |
| `doc/UNIFIED-DESIGN.md` | Unified oxi ecosystem design system (v1.0, design-farmer Phase 4.5). Project-local snapshot; canonical now lives in `project-oxi/.github/DESIGN.md`. |
| `doc/PRODUCTION_READINESS.md` | Production-readiness checklist / status for oximemo. |


## `docs/superpowers/plans/` — implementation plans

| File | Topic |
|---|---|
| `2026-07-30-category-system-plan.md` | Category data-model migration plan. |
| `2026-07-30-inline-tags-sidebar.md` | Inline-tag sidebar implementation. |
| `2026-07-30-markdown-editor.md` | Markdown editor integration. |
| `2026-07-31-category-management-ux.md` | Category management UX flow. |
| `2026-07-31-category-picker-keyboard.md` | Keyboard navigation for category picker. |
| `2026-07-31-context-menus.md` | Right-click / context-menu behavior. |
| `2026-08-01-memo-wiki-links.md` | Memo ↔ memo wiki-link syntax. |

## `docs/superpowers/specs/` — design specs

| File | Topic |
|---|---|
| `2026-07-30-category-system-design.md` | Category system design spec. |
| `2026-07-30-inline-tags-sidebar-design.md` | Inline-tag sidebar design spec. |
| `2026-07-30-markdown-editor-design.md` | Markdown editor design spec. |
| `2026-07-31-category-management-ux-design.md` | Category management UX spec. |
| `2026-07-31-category-picker-keyboard-design.md` | Keyboard-driven category picker spec. |
| `2026-07-31-context-menus-design.md` | Context-menu design spec. |
| `2026-08-01-image-insertion-design.md` | Image insertion in memos. |
| `2026-08-01-memo-wiki-links-design.md` | Memo wiki-link design spec. |
| `2026-08-01-quick-capture-lifecycle-design.md` | Quick-capture lifecycle design spec. |

## `.omp/` — runtime artifacts

| File | Purpose |
|---|---|
| `.omp/DESIGN-REF.md` | Canonical-pointer file → `project-oxi/.github/DESIGN.md`. |
| `.omp/auto-design-2026-07-31.md` | Auto-task description: extract unified design system. |
| `.omp/auto-master-report-2026-07-31.md` | Auto-task description: master report composition. |
| `.omp/auto-task-2026-07-31.md` | Auto-task description. |
| `.omp/master-report-2026-08-01.md` | Oxi ecosystem master report (2026-08-01). |
| `.omp/master-report-2026-08-01.html` | HTML rendering of the same report. |

> The 3 `com.oxi-*.plist` files in `.omp/` are intentionally untracked (launchd jobs).

## Root files

| File | Purpose |
|---|---|
| `README.md` | Project overview + quickstart. |
| `CHANGELOG.md` | Release history. |
| `CONTRIBUTING.md` | Contribution guide. |

## Notes

- **Canonical:** `project-oxi/.github/DESIGN.md` — single source of truth for the unified design system.
- **Local:** oximemo keeps two project-local design docs (`doc/DESIGN.md`, `doc/UNIFIED-DESIGN.md`) — both annotated with a header pointing to canonical. No stale copy was archived (both are genuinely different docs, not stale duplicates).
- **Pointer:** `.omp/DESIGN-REF.md` now points at canonical.
- **No transient status docs** (no top-level `progress.md` / `*handoff*` / `.oxi-fixraf-*` / `.oxi-explore-*`) required moving.
