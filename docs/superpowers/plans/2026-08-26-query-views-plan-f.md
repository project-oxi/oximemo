# Query Views — Plan F (Alternate Layouts) Implementation Plan

**Goal:** Spec §4 tail + §3 board loading — `board` kanban with per-group
paging and BoardCard drag semantics, plus note-only `cards` / `list`
adapters over a base's rows.

**Landed design:**
- `views/BoardView.tsx`: one `run_base(includeGroupCounts, limit 1)` call
  derives the column set + counts over the view's capped dataset; each
  column pages its own `run_base(group: key, limit 20)` slice (spec §3 —
  per-group pages cannot exceed the view limit). Card drag commits the
  scalar group prop through `updateMemo` (`removes` for 그룹 없음);
  List-valued group props (base_props observed types) disable drag while
  table grouping keeps working (spec §4). 그룹 없음 column sorts last.
- `views/BaseAdapters.tsx`: `BaseCardsAdapter` reuses the browse `Card`
  renderer on `BaseRow.summary` (folder-card handlers deliberately
  absent), `BaseListAdapter` is a lean title/preview/folder/relative-time
  row list. Both consume the shared BaseView run query (filters/order/
  limit honored; columns/summaries ignored; no cell editing).
- BaseView dispatch: table/board/cards/list all render; unknown types
  keep the errored-tab notice (spec §1); the interim 「지원 예정」 panel is
  gone.

**Verification:** build + suite green; behavior reviewed in the final
whole-feature pass.
