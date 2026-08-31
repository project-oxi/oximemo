// Visual harness for the §8 slash menu (slash-notion spec, Task 4).
// Merged mount — the MemoEditorForm wiring (wiki + task + slash in ONE
// autocompletion override) — so the harness reproduces the real editor's
// completion merge path, not just the standalone mount. Serve with
// `bun run dev` from apps/desktop, open /harness/slash.html.
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { RecencyLog } from "../src/lib/paletteCommands";
import { slashCompletionSource } from "../src/lib/slashExtension";
import { taskSuggestExtension } from "../src/lib/taskSuggest";
import { cfgFromJson } from "../src/lib/taskLine";
import "../src/app.css";

const cfg = cfgFromJson({
  global_filter: "",
  recurrence_insert: "below",
  statuses: [
    { symbol: " ", type: "TODO", next: "IN_PROGRESS" },
    { symbol: ">", type: "IN_PROGRESS", next: "DONE" },
    { symbol: "x", type: "DONE", next: "CANCELLED" },
  ],
});

const wiki = {
  suggest: async () => [],
  debounceMs: 0,
  maxSuggestions: 12,
};

new EditorView({
  parent: document.getElementById("editor")!,
  state: EditorState.create({
    doc: "메모\n\n",
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      taskSuggestExtension({
        cfg,
        labels: {},
        wiki,
        extraSources: [
          slashCompletionSource({
            cfg,
            locale: "ko",
            recency: new RecencyLog(),
            templateBody: () => "# 회의\n\n- 참석자: \n",
          }),
        ],
      }),
    ],
  }),
});
