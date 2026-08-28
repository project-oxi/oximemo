/**
 * Tests for the slash-command insertion builders (tasks spec §8,
 * Plan D Task 2) — 날짜/서식/링크/쿼리/템플릿 groups.
 *
 * Every assertion is byte-exact: these builders ARE the text the
 * catalog (Task 3) inserts, so tests pin the exact `text`, the exact
 * `caret` offset, indent propagation to EVERY inserted line, and the
 * two structural invariants — link skeletons extend the app's real
 * wiki grammar (`lib/wiki.ts` WIKI_RE / `lib/embeds.ts`), and a
 * template body containing a fence run is wrapped in a LONGER fence
 * so it can never break the note's fence structure.
 */
import { describe, test, expect } from "bun:test";

import {
  codeBlockInsertion,
  dailyTasksBlockInsertion,
  dateInsertion,
  headingInsertion,
  imageEmbedInsertion,
  memoEmbedInsertion,
  memoLinkInsertion,
  queryBlockInsertion,
  quoteInsertion,
  ruleInsertion,
  tableInsertion,
  templateInsertion,
  timeInsertion,
} from "./slashInsertions";
import { extractLinks } from "./wiki";

/** The spec §9 daily fence, byte-for-byte
 * (docs/superpowers/specs/2026-08-27-tasks-design.md §9). */
const DAILY_FENCE = `\`\`\`query
source: tasks
filters:
  and:
    - 'task.type != "DONE" && task.type != "CANCELLED"'
    - '(task.due != null && task.due <= this.file.name) || (task.scheduled != null && task.scheduled <= this.file.name)'
views:
  - { type: tasks, name: 오늘 }
\`\`\``;

describe("dateInsertion (날짜)", () => {
  test("오늘 → today's local ISO, caret at end", () => {
    expect(dateInsertion("", "2026-08-29", 0)).toEqual({ text: "2026-08-29", caret: 10 });
  });

  test("내일/어제 shift from the injected today", () => {
    expect(dateInsertion("", "2026-08-29", 1)).toEqual({ text: "2026-08-30", caret: 10 });
    expect(dateInsertion("", "2026-08-29", -1)).toEqual({ text: "2026-08-28", caret: 10 });
  });

  test("month and year rollovers (local date math, no UTC drift)", () => {
    expect(dateInsertion("", "2026-12-31", 1).text).toBe("2027-01-01");
    expect(dateInsertion("", "2026-03-01", -1).text).toBe("2026-02-28");
    expect(dateInsertion("", "2028-02-28", 1).text).toBe("2028-02-29"); // leap year
  });

  test("indent prefixes the single line and shifts the caret", () => {
    expect(dateInsertion("  ", "2026-08-29", 0)).toEqual({ text: "  2026-08-29", caret: 12 });
  });
});

describe("timeInsertion (현재 시각)", () => {
  test("local HH:mm, zero-padded", () => {
    expect(timeInsertion("", new Date(2026, 7, 29, 9, 5))).toEqual({ text: "09:05", caret: 5 });
  });
  test("afternoon stays 24-hour (never AM/PM, never UTC)", () => {
    expect(timeInsertion("", new Date(2026, 7, 29, 13, 45))).toEqual({ text: "13:45", caret: 5 });
  });

  test("midnight pads both fields", () => {
    expect(timeInsertion("", new Date(2026, 7, 29, 0, 0))).toEqual({ text: "00:00", caret: 5 });
  });


  test("indent prefixes and shifts the caret", () => {
    expect(timeInsertion("\t", new Date(2026, 7, 29, 23, 59))).toEqual({
      text: "\t23:59",
      caret: 6,
    });
  });
});

describe("headingInsertion (제목 1-3)", () => {
  test("levels 1-3: hash run + space, caret after the space — no placeholder", () => {
    expect(headingInsertion("", 1)).toEqual({ text: "# ", caret: 2 });
    expect(headingInsertion("", 2)).toEqual({ text: "## ", caret: 3 });
    expect(headingInsertion("", 3)).toEqual({ text: "### ", caret: 4 });
  });

  test("indent prefixes the heading", () => {
    expect(headingInsertion("  ", 2)).toEqual({ text: "  ## ", caret: 5 });
  });
});

describe("tableInsertion (표)", () => {
  test("2×2 skeleton with alignment row, caret in the first header cell", () => {
    expect(tableInsertion("")).toEqual({
      text: "|  |  |\n| --- | --- |\n|  |  |",
      caret: 2, // right after the opening "| "
    });
  });

  test("indent lands on EVERY line of the table", () => {
    expect(tableInsertion("  ")).toEqual({
      text: "  |  |  |\n  | --- | --- |\n  |  |  |",
      caret: 4,
    });
  });
});

describe("codeBlockInsertion (코드 블록)", () => {
  test("bare ``` fence pair — no language, no placeholder text", () => {
    expect(codeBlockInsertion("")).toEqual({ text: "```\n\n```", caret: 4 });
  });

  test("caret sits on the empty line INSIDE the fence, after the indent", () => {
    const ins = codeBlockInsertion("  ");
    expect(ins.text).toBe("  ```\n  \n  ```");
    // "  ```⏎" is 6 chars, then the second line's "  " → caret 8.
    expect(ins.caret).toBe(8);
    expect(ins.text.slice(0, ins.caret)).toBe("  ```\n  ");
    expect(ins.text[ins.caret]).toBe("\n");
  });
});

describe("quoteInsertion / ruleInsertion (인용/구분선)", () => {
  test("인용: '> ' with the caret at end", () => {
    expect(quoteInsertion("")).toEqual({ text: "> ", caret: 2 });
    expect(quoteInsertion("  ")).toEqual({ text: "  > ", caret: 4 });
  });

  test("구분선: '---' with the caret at end", () => {
    expect(ruleInsertion("")).toEqual({ text: "---", caret: 3 });
    expect(ruleInsertion("  ")).toEqual({ text: "  ---", caret: 5 });
  });
});

describe("link skeletons mirror the app's wiki grammar (링크)", () => {
  test("메모 링크: empty `[[]]` skeleton, caret inside the braces", () => {
    // lib/wiki.ts parses `[[Title]]` / `[[Title|alias]]` — the alias
    // pipe is OPTIONAL in that grammar, so it is never pre-typed.
    expect(memoLinkInsertion("")).toEqual({ text: "[[]]", caret: 2 });
  });

  test("메모 임베드: empty `![[]]` skeleton — lib/embeds.ts's `![[memo-id]]` form", () => {
    expect(memoEmbedInsertion("")).toEqual({ text: "![[]]", caret: 3 });
  });

  test("이미지: `![[.png]]` skeleton with the caret before the extension", () => {
    expect(imageEmbedInsertion("")).toEqual({ text: "![[.png]]", caret: 3 });
  });

  test("a target typed at the caret parses through lib/wiki.ts's grammar", () => {
    // The host inserts the skeleton, the user types at `caret`, and
    // the result must be a first-class wiki link for the app's parser.
    const link = memoLinkInsertion("");
    const typedLink = link.text.slice(0, link.caret) + "Target" + link.text.slice(link.caret);
    expect(typedLink).toBe("[[Target]]");
    expect(extractLinks(typedLink)).toEqual([{ target: "Target", label: "Target" }]);

    const img = imageEmbedInsertion("");
    const typedImg = img.text.slice(0, img.caret) + "photo" + img.text.slice(img.caret);
    expect(typedImg).toBe("![[photo.png]]");

    // The grammar's optional alias form also parses (typed by hand later).
    expect(extractLinks("[[Target|별칭]]")).toEqual([{ target: "Target", label: "별칭" }]);
  });

  test("indent prefixes the skeletons and shifts the caret", () => {
    expect(memoLinkInsertion("  ")).toEqual({ text: "  [[]]", caret: 4 });
    expect(memoEmbedInsertion("  ")).toEqual({ text: "  ![[]]", caret: 5 });
    expect(imageEmbedInsertion("  ")).toEqual({ text: "  ![[.png]]", caret: 5 });
  });
});

describe("queryBlockInsertion (쿼리 블록)", () => {
  test("minimal ```query stub: one table view, no placeholder rows", () => {
    expect(queryBlockInsertion("")).toEqual({
      text: "```query\nviews:\n  - type: table\n```",
      caret: 35, // end of the closing fence (8+1+6+1+15+1+3)
    });
  });

  test("indent lands on the fence lines AND the YAML body lines", () => {
    expect(queryBlockInsertion("  ")).toEqual({
      text: "  ```query\n  views:\n    - type: table\n  ```",
      caret: 43, // 35 + indent on each of the 4 lines
    });
  });
});

describe("dailyTasksBlockInsertion (오늘의 할 일 블록)", () => {
  test("byte-for-byte the spec §9 daily fence, caret at end", () => {
    const ins = dailyTasksBlockInsertion("");
    expect(ins.text).toBe(DAILY_FENCE);
    expect(ins.caret).toBe(DAILY_FENCE.length);
  });

  test("indent lands on every line of the fence", () => {
    const { text } = dailyTasksBlockInsertion("\t");
    expect(text).toBe(DAILY_FENCE.split("\n").map((l) => `\t${l}`).join("\n"));
    expect(text.split("\n").every((l) => l.startsWith("\t"))).toBe(true);
  });
});

describe("templateInsertion (템플릿)", () => {
  test("fence-free body inserted verbatim, indent on every line, caret at end", () => {
    const body = "## 회의록\n\n- 안건:\n- 결정:";
    expect(templateInsertion("  ", body)).toEqual({
      text: "  ## 회의록\n  \n  - 안건:\n  - 결정:",
      caret: "  ## 회의록\n  \n  - 안건:\n  - 결정:".length,
    });
  });

  test("trailing newlines of the file body are stripped", () => {
    expect(templateInsertion("", "A\nB\n\n\n").text).toBe("A\nB");
  });

  test("a body containing ``` is wrapped in a longer (4-backtick) fence", () => {
    const body = "intro\n\n```ts\nconst x = 1;\n```\n\noutro";
    const { text } = templateInsertion("", body);
    expect(text).toBe("````\n" + body + "\n````");
    // The inner ``` runs cannot close the outer ```` fence (CommonMark).
    expect(text.match(/`{4}/g)!.length).toBe(2);
    expect(text.includes("```ts")).toBe(true);
  });

  test("a 4-backtick run forces a 5-backtick wrapper", () => {
    const body = "````\ninner\n````";
    expect(templateInsertion("", body).text).toBe("`````\n" + body + "\n`````");
  });

  test("the wrap fence lines carry the indent too, caret at end", () => {
    const body = "```js\nx\n```";
    const ins = templateInsertion("  ", body);
    expect(ins.text).toBe("  ````\n  ```js\n  x\n  ```\n  ````");
    expect(ins.caret).toBe(ins.text.length);
  });

  test("empty body inserts nothing", () => {
    expect(templateInsertion("", "")).toEqual({ text: "", caret: 0 });
    expect(templateInsertion("  ", "\n\n")).toEqual({ text: "", caret: 0 });
  });

  test("backticks shorter than a fence (inline code) do NOT trigger wrapping", () => {
    expect(templateInsertion("", "use `code` here").text).toBe("use `code` here");
  });
});
