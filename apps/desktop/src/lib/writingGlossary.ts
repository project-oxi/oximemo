import { Lexer, type Tokens } from "marked";
import { createMemo, getMemo, listMemos } from "./api";
import { projectWritingComments } from "./writingComments";

export const WRITING_GLOSSARY_TAG = "oximemo/writing-glossary";

export const writingGlossaryKey = (folder: string) => ["memos", "writing-glossary", folder] as const;

async function findInFolder(folder: string) {
  const page = await listMemos(null, 24, {
    include_tags: [WRITING_GLOSSARY_TAG],
    folder,
    immediate: true,
  });
  const candidates = page.items.filter((note) => note.folder === folder && note.path.endsWith(".md"));
  for (const candidate of candidates.sort((a, b) => a.path.localeCompare(b.path))) {
    const memo = await getMemo(candidate.id);
    if (!memo.deleted_at && memo.folder === folder && memo.format === "markdown"
      && memo.tags.includes(WRITING_GLOSSARY_TAG)) return memo;
  }
  return null;
}

export async function findWritingGlossary(folder: string) {
  let ancestor = folder;
  while (ancestor) {
    const memo = await findInFolder(ancestor);
    if (memo) return memo;
    ancestor = ancestor.slice(0, Math.max(0, ancestor.lastIndexOf("/")));
  }
  return null;
}

export function writingGlossaryHeading(term: string): string {
  return term.trim().replace(/[\\`*_{}\[\]()#+!<>|%]/g, "\\$&");
}

const pendingCreates = new Map<string, ReturnType<typeof createMemo>>();

export function createWritingGlossary(folder: string, title: string, hint: string, initialWord: string) {
  const pending = pendingCreates.get(folder);
  if (pending) return pending;
  const operation = (async () => {
    const existing = await findInFolder(folder);
    if (existing) return existing;
    const word = writingGlossaryHeading(initialWord);
    const starter = word ? `\n## ${word}\n\n` : "";
    return createMemo(`# ${title}\n\n#${WRITING_GLOSSARY_TAG}\n\n%% ${hint} %%\n${starter}`, folder, "markdown");
  })().finally(() => pendingCreates.delete(folder));
  pendingCreates.set(folder, operation);
  return operation;
}

export function writingGlossaryEntries(body: string) {
  const { text } = projectWritingComments(body.replace(/\r\n?/g, "\n"));
  const entries: { word: string; heading: string; definition: string }[] = [];
  let entry: (typeof entries)[number] | undefined;
  for (const token of Lexer.lex(text, { gfm: true })) {
    if (token.type === "heading") {
      const heading = token as Tokens.Heading;
      if (heading.depth <= 2) entry = undefined;
      if (heading.depth === 2 && heading.text.trim()) {
        const sourceHeading = heading.text.trim();
        const word = sourceHeading.replace(/\\([\\`*_{}\[\]()#+!<>|%])/g, "$1");
        entry = { word, heading: sourceHeading, definition: "" };
        entries.push(entry);
      }
    } else if (entry && !entry.definition && token.type === "paragraph") {
      entry.definition = (token as Tokens.Paragraph).text.replace(/\s+/gu, " ").trim();
    }
  }
  return entries;
}
