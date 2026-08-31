/**
 * The §8 slash menu's CM6 wiring (tasks spec §8, Plan D Task 3).
 *
 * `slashCompletionSource` is the CompletionSource: `slashTriggerAt`
 * decides WHEN the menu is armed (word-start '/', including the bare
 * `/` with an empty query; no whitespace in the query; never inside
 * fenced/indented/inline code), `rankSlashCommands`
 * + `slashOptionsFor` decide WHAT it shows (palette ranking + recency,
 * sub-options for dates/priority), and each option's `apply` replays
 * the command's pure `patch` against the doc.
 *
 * Mount contract (see taskSuggest.ts — discovered empirically): CM6
 * allows exactly ONE `autocompletion({override})` per editor. The
 * editor host therefore merges `slashCompletionSource` into
 * `taskSuggestExtension`'s single override (`extraSources`); the
 * triggers are disjoint (`/query` vs task-line tokens), and on a task
 * line the '/' in the typed query filters every task-field label out
 * of CM6's matcher, so the two surfaces never fight over a keystroke.
 * `slashExtension` remains for hosts WITHOUT the wiki/task source —
 * it mounts its own autocompletion.
 *
 * `filter: false` on the result: ranking already happened against the
 * fresh query (Korean labels + English aliases), so CM6's fuzzy
 * re-filter would only re-hide rows and destroy the ranked order.
 */
import {
  autocompletion,
  type Completion,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { dict as enDict } from "./locales/en";
import { dict as koDict } from "./locales/ko";
import type { RecencyLog } from "./paletteCommands";
import {
  buildSlashCatalog,
  rankSlashCommands,
  slashOptionsFor,
  SLASH_GROUP_RANK,
  SLASH_ICONS,
  type SlashDeps,
  type SlashOption,
} from "./slashCommands";
import { slashTriggerAt } from "./slashTrigger";
import { completionIconRenderer, type TaskCompletion } from "./taskSuggest";

/** localStorage key for the slash menu's pick recency (the palette's
 *  sibling key is `oximemo.paletteRecency`). */
export const SLASH_RECENCY_KEY = "oximemo.editorSlashRecency";

function persistRecency(recency: RecencyLog): void {
  try {
    localStorage.setItem(SLASH_RECENCY_KEY, JSON.stringify(recency.snapshot()));
  } catch {
    // Storage full/blocked — ranking just loses the boost.
  }
}

/** Map one expanded option to a CM6 row: localized label, token-preview
 *  detail (the hint), the lucide glyph (inline SVG via the merged
 *  renderer), the group as a section header, and an apply that replays
 *  the pure patch and records the pick. */
function slashCompletion(
  opt: SlashOption,
  deps: SlashDeps & { onPick?: (id: string) => void },
): TaskCompletion {
  const dict = deps.locale === "ko" ? koDict : enDict;
  return {
    label: opt.label,
    detail: opt.detail,
    type: "text",
    iconSvg: SLASH_ICONS[opt.choice.icon ?? opt.command.icon],
    section: {
      name: dict[opt.command.groupKey],
      rank: SLASH_GROUP_RANK[opt.command.group],
    },
    apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
      const patch = opt.command.patch(view.state.doc.toString(), from, to, deps, opt.choice);
      view.dispatch({
        changes: patch.changes,
        selection: patch.caret !== undefined ? { anchor: patch.caret } : undefined,
      });
      deps.recency.record(opt.command.id);
      persistRecency(deps.recency);
      deps.onPick?.(opt.command.id);
    },
  };
}

/** The §8 CompletionSource. IME-composition-gated like the task
 *  suggest; the bare `/` opens the menu with the full catalog (spec
 *  docs/superpowers/specs/2026-08-31-slash-notion-design.md) and a
 *  space inside the query disarms it — `slashTriggerAt`'s own rules,
 *  shared with no other source. */
export function slashCompletionSource(
  deps: SlashDeps & { onPick?: (id: string) => void },
): CompletionSource {
  return (context): CompletionResult | null => {
    // IME gate (project doctrine): never fire mid-composition; CM6's
    // ChangedAndMoved machinery re-queries on compositionend.
    if (context.view?.composing) return null;
    const doc = context.state.doc.toString();
    const trigger = slashTriggerAt(doc, context.pos);
    if (!trigger) return null;
    const ranked = rankSlashCommands(buildSlashCatalog(deps), trigger.query, deps.recency);
    if (ranked.length === 0) return null;
    const options = ranked.flatMap((command) => slashOptionsFor(command, deps));
    if (options.length === 0) return null;
    return {
      from: trigger.from,
      to: context.pos,
      // Order pinning: with `filter: false` CM6 ranks options by
      // position, but when the merged override turns the result into
      // the matcher path (real editor) the tiebreak is a label
      // localeCompare that scrambles the curated order (observed:
      // alphabetical). `sortText` replaces the label in that compare,
      // so every path — standalone, merged, matcher or not — shows
      // catalog order. Zero-padded to compare as strings.
      options: options.map((opt, i) => ({
        ...slashCompletion(opt, deps),
        sortText: String(i).padStart(4, "0"),
      })),
      filter: false,
    };
  };
}

/** Standalone mount for editors WITHOUT the wiki/task completion
 *  source (tests, future hosts): one autocompletion, the slash source
 *  alone. MemoEditorForm does NOT use this — it merges
 *  `slashCompletionSource` into `taskSuggestExtension`'s single
 *  override (CM6 rejects a second one). */
export function slashExtension(
  deps: SlashDeps & { onPick?: (id: string) => void },
): Extension[] {
  return [
    autocompletion({
      activateOnTyping: true,
      icons: false,
      override: [slashCompletionSource(deps)],
      addToOptions: [{ position: 20, render: completionIconRenderer }],
    }),
  ];
}
