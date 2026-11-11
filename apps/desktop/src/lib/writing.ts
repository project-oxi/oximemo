import { Lexer, type Token, type Tokens } from "marked";
import { extractTags } from "./tags";
import { projectWritingComments } from "./writingComments";

const PROFILES = {
  screenplay: ["screenplay", "시나리오"],
  essay: ["essay", "에세이"],
  column: ["column", "칼럼"],
  fiction: ["novel", "소설", "writing"],
} as const;

export type WritingProfile = keyof typeof PROFILES;
const WRITING_TAGS = new Set<string>(Object.values(PROFILES).flat());

export function isWritingTag(tag: string): boolean {
  return WRITING_TAGS.has(tag.normalize("NFC").toLowerCase());
}

export function writingProfile(body: string, metadataTags: readonly string[] = []): WritingProfile | null {
  const tags = new Set([...extractTags(body), ...metadataTags.map((tag) => tag.normalize("NFC").toLowerCase())]);
  for (const [profile, names] of Object.entries(PROFILES)) {
    if (names.some((name) => tags.has(name))) return profile as WritingProfile;
  }
  return null;
}

const PLAIN = /!\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]|\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]|(^|[\s(])#[\p{L}\p{N}_][\p{L}\p{N}_/-]*|\s+\^[\w-]+(?=\s*$)/gmu;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
};

function decodedText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name: string) => {
    if (!name.startsWith("#")) return ENTITIES[name.toLowerCase()] ?? entity;
    const scalar = Number(name.slice(1).replace(/^x/i, "0x"));
    return scalar > 0 && scalar <= 0x10ffff && !(scalar >= 0xd800 && scalar <= 0xdfff)
      ? String.fromCodePoint(scalar) : "\uFFFD";
  });
}

function plainText(value: string): string {
  return value.replace(PLAIN, (_match, attachment, link, label, before) =>
    attachment ?? label ?? link ?? before ?? "",
  );
}

function tokenText(token: Token): string {
  switch (token.type) {
    case "html":
    case "code":
    case "def":
      return "";
    case "list":
      return (token as Tokens.List).items.map(tokenText).join("\n");
    case "table": {
      const table = token as Tokens.Table;
      return [table.header, ...table.rows].map((row) => row.map((cell) => cell.tokens.map(tokenText).join("")).join(" ")).join("\n");
    }
    case "space":
    case "br":
      return "\n";
    default: {
      const inline = token as { text?: string; tokens?: Token[] };
      return inline.tokens?.map(tokenText).join("") ?? inline.text ?? "";
    }
  }
}

export interface WritingChapter {
  title: string;
  markdown: string;
  line: number;
}

type SourceSection = { line: number; title: string; depth: number };
type PlanningSection = SourceSection & { endLine: number };
type CharacterCard = {
  name: string;
  line: number;
  details: string;
};

export interface Manuscript {
  title: string;
  chapters: WritingChapter[];
  characters: CharacterCard[];
  planning: PlanningSection | null;
  scenario: SourceSection | null;
  characterSection: PlanningSection | null;
  charactersWithSpaces: number;
  unclosedComment: boolean;
}

const PLANNING_TITLE = /^(집필 노트|writing notes)$/iu;
const CHARACTERS_TITLE = /^(등장인물|characters)$/iu;
const SCENARIO_TITLE = /^(시나리오|scenario)$/iu;
const NEWLINES = /\n/g;
function isWritingTagLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("#") && trimmed.split(/\s+/u).every((word) =>
    word.startsWith("#") && WRITING_TAGS.has(word.slice(1).normalize("NFC").toLowerCase()),
  );
}

export function readManuscript(body: string): Manuscript {
  const { text: source, unclosed: unclosedComment } = projectWritingComments(body.replace(/\r\n?/g, "\n"));
  const blocks = Lexer.lex(source, { gfm: true });
  let line = 1;
  let title = "";
  let cursor = 0;
  let chapter = { title: "", line: 1, markdown: "" };
  let planning: PlanningSection | null = null;
  let inPlanning = false;
  let primaryPlanning = false;
  let characterSection: PlanningSection | null = null;
  let scenario: SourceSection | null = null;
  let card: CharacterCard | undefined;
  let readingCards = false;
  const characters: CharacterCard[] = [];
  const chapters: WritingChapter[] = [];
  const counts: string[] = [];
  const finishChapter = () => {
    if (chapter.title || chapter.markdown.trim()) {
      chapters.push({ ...chapter, markdown: chapter.markdown.replace(/^\n+|\n+$/g, "") });
    }
  };

  for (const token of blocks) {
    const offset = source.indexOf(token.raw, cursor);
    // Marked can expand indentation for block tokens. The fallback still
    // advances over the previous token and counts physical line breaks.
    if (offset > cursor) {
      const gap = source.slice(cursor, offset);
      line += (gap.match(NEWLINES) ?? []).length;
      if (!inPlanning) chapter.markdown += gap;
    }
    const blockLine = line;
    cursor = Math.max(cursor, offset) + token.raw.length;
    line += (token.raw.match(NEWLINES) ?? []).length;
    const text = plainText(decodedText(tokenText(token))).trim();
    if (token.type === "heading") {
      const depth = (token as Tokens.Heading).depth;
      if (depth <= 3 && readingCards && characterSection) {
        characterSection.endLine = blockLine;
        readingCards = false;
        card = undefined;
      }
      if (depth <= 2 && inPlanning) {
        if (primaryPlanning && planning) planning.endLine = blockLine;
        inPlanning = false;
        primaryPlanning = false;
        card = undefined;
        readingCards = false;
      }
      if (depth === 2 && PLANNING_TITLE.test(text)) {
        primaryPlanning = planning === null;
        planning ??= { line: blockLine, title: text, depth, endLine: 0 };
        inPlanning = true;
        continue;
      }
      if (inPlanning) {
        if (!primaryPlanning) continue;
        if (depth === 3) {
          readingCards = CHARACTERS_TITLE.test(text) && !characterSection;
          if (readingCards) characterSection = { line: blockLine, title: text, depth, endLine: 0 };
          if (!scenario && SCENARIO_TITLE.test(text)) scenario = { line: blockLine, title: text, depth };
          card = undefined;
        }
        if (depth === 4 && readingCards && text) {
          card = { name: text, line: blockLine, details: "" };
          characters.push(card);
        }
        continue;
      }
      if (depth === 1 && !title) {
        title = text;
        continue;
      }
      if (depth <= 2) {
        finishChapter();
        chapter = { title: text, line: blockLine, markdown: "" };
        if (text) counts.push(text);
        continue;
      }
    }
    if (inPlanning) {
      if (card && text) {
        card.details = [card.details, text].filter(Boolean).join("\n");
      }
      continue;
    }
    if (token.type === "paragraph") {
      chapter.markdown += token.raw.split("\n").filter((row) => !isWritingTagLine(row)).join("\n");
    } else {
      chapter.markdown += token.raw;
    }
    if (text) {
      counts.push(text);
    }
  }
  if (!inPlanning && cursor < source.length) chapter.markdown += source.slice(cursor);
  finishChapter();
  const charactersWithSpaces = [...counts.join(" ").replace(/\s+/gu, " ")].length;
  return { title, chapters, characters, planning, scenario, characterSection, charactersWithSpaces, unclosedComment };
}

export function preservesPublishedChapters(before: Manuscript, after: Manuscript): boolean {
  return !after.unclosedComment && before.title === after.title
    && before.chapters.length === after.chapters.length
    && before.chapters.every((chapter, index) => chapter.title === after.chapters[index].title
      && chapter.markdown === after.chapters[index].markdown);
}
