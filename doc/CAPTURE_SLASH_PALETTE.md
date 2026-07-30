# Quick Capture: Slash-Command Palette (Design — Incomplete)

**Status:** ⛔ Design incomplete — not ready for implementation.
**Owner:** unassigned
**Last reviewed:** 2026-07-30

---

## Why this exists

During the capture-window redesign we investigated two external references
for a keyboard-only "fast capture with categorization" flow:

1. **`zakirullin/files.md`** — *not* a slash palette. Its quick capture uses
   **trailing/leading keyword aliases** (` jj`, ` jd`, `++`) parsed by regex
   (`^kw\s+|\s+kw$`, case-insensitive; see `server/bot.go:201-205`,
   `server/bot.go:438`). There is no `/`-prefix command surface and no popup.
   The checklist categorization (Later/Read/Shop/Watch) is mouse-only.

2. **`../oxios` web UI `⌘K` command palette** — *this* is the slash-command
   model worth studying. A federated provider registry + a deterministic
   verb-prefix grammar. See
   `docs/designs/2026-06-29-command-palette-design.md` and
   `web/src/components/layout/command-palette/{lexer,types,capture,...}.ts`.

The goal for oxinot: let the user pick a capture destination (color / pin /
category) **without leaving the keyboard**, while the composer stays a single
lightweight pill at the bottom-center of the screen.

## What oxios does (the pattern to adapt)

Grammar (deterministic, no NL classification):

```
input  ::= verb? entity? text?
verb   ::= '/' (capture) | '>' (run) | '!' (control) | '~' (switch) | '+' (new)
entity ::= '@' (type ':')? name
bare   ::= resolved per-mode (Knowledge → capture, Console → go, Chat → run)
```

- Lexer is pure, runs on every keystroke (`lexer.ts`).
- Each verb is owned by a `CommandProvider` (`capture.tsx`, `run.tsx`, …);
  the host (`command-palette.tsx`) merges + ranks with an explicit `score`
  (fuzzy title + mode-boost + recency from `localStorage`).
- `cmdk` filtering is **disabled** (`shouldFilter={false}`) so the ranker
  owns all ordering — without this the design collapses back into a
  composite-`value` hack.
- Capture example: `/later 빨래` → append to `Later.md`, counter increments,
  palette closes, zero mouse interaction.

## Open design questions (must be resolved before coding)

1. **Surface placement.** Two candidate shapes:
   - **X1 — embed inside the capture overlay.** Typing `/` in the composer
     spawns an inline picker (popover / cmdk list) of capture verbs. Lightest;
     matches the "composer stays a pill" intent.
   - **X2 — global `⌘K` palette on the main window.** Full oxios parity
     (verbs beyond capture: navigate, pin, new). Much larger scope; needs a
     verb catalog, mode system, provider split. Likely overkill for a card
     memo app.
   - **X3 — hybrid.** X1 first; add `⌘K` later only if demand appears.
   - **Default lean:** X1. Resolve before implementation.

2. **Verb catalog for oxinot.** oxios's six verbs are agent-OS-shaped
   (`run`/`switch`/`control`/…). oxinot has none of those nouns. Candidate
   oxinot verbs are unstaged: color shortcuts (`/r` `/g` `/b` …), pin
   (`/p`), tag/category routing, "append to last note" (`+`). The set — and
   whether categories even exist as first-class destinations — is undecided.

3. **Category model.** oxinot today has color + inline `#tag` extraction, no
   checklist/category files. Do we introduce destinations at all (à la
   files.md's `Later.md`), or keep capture as "one note, attributes inline"?
   This gates #2.

4. **Ranking & recency.** If we adopt a palette, do we replicate oxios's
   score model (exact-prefix + verb-explicit + entity-exact + fuzzy +
   mode-boost + recency), or ship a simpler static ordering first?

5. **Keyboard ergonomics on a pill composer.** `/` already has no existing
   meaning in the textarea, but IME/composition (Korean `ㅂ` lives on the
   `/` key) makes a bare `/` prefix ambiguous. oxios avoids this because the
   palette input is Latin-only command text; oxinot's composer is free-form
   Korean text. A modifier (`⌘/`, `Tab`-triggered palette) may be required.
   **This is the hardest unresolved issue.**

## Non-goals (for this document)

- Implementing anything. This file is a placeholder so the idea is not lost.
- Reproducing files.md's trailing-keyword scheme — evaluated and rejected as
  less discoverable than a palette for a GUI app.

## References

- `../oxios/docs/designs/2026-06-29-command-palette-design.md`
- `../oxios/web/src/components/layout/command-palette/lexer.ts`
- `../oxios/web/src/components/layout/command-palette/capture.tsx`
- `../oxios/web/src/components/layout/command-palette/types.ts`
- files.md: `server/bot.go:201-205` (`Shortcuts`), `:438` (regex match)
