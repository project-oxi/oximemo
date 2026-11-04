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
  age?: number;
  birthYear?: number;
  handedness?: string;
};
type Passage = { line: number; text: string; raw: string };

export interface Manuscript {
  title: string;
  chapters: WritingChapter[];
  characters: CharacterCard[];
  planning: PlanningSection | null;
  scenario: SourceSection | null;
  characterSection: PlanningSection | null;
  passages: Passage[];
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
  const passages: Passage[] = [];
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
        const age = /^(?:나이|age)\s*[:：]\s*(\d{1,3})\s*(?:세|살)?\s*$/imu.exec(text);
        if (age) card.age = Number(age[1]);
        const birthYear = /^(?:출생\s*연도|birth year)\s*[:：]\s*(\d{3,4})\s*년?\s*$/imu.exec(text);
        if (birthYear) card.birthYear = Number(birthYear[1]);
        const hand = /^(?:주로 쓰는 손|handedness)\s*[:：]\s*(왼손|오른손|양손)(?:잡이)?\s*$/imu.exec(text);
        if (hand) card.handedness = hand[1];
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
      if (token.type === "paragraph") passages.push({ line: blockLine, text, raw: token.raw });
    }
  }
  if (!inPlanning && cursor < source.length) chapter.markdown += source.slice(cursor);
  finishChapter();
  const charactersWithSpaces = [...counts.join(" ").replace(/\s+/gu, " ")].length;
  return { title, chapters, characters, planning, scenario, characterSection, passages, charactersWithSpaces, unclosedComment };
}

export function preservesPublishedChapters(before: Manuscript, after: Manuscript): boolean {
  return !after.unclosedComment && before.title === after.title
    && before.chapters.length === after.chapters.length
    && before.chapters.every((chapter, index) => chapter.title === after.chapters[index].title
      && chapter.markdown === after.chapters[index].markdown);
}

const STYLE_RULES = [
  ["passive", /되어지(?:다|고|는|며|니|면)|되어졌|보여지(?:다|고|는|며|니|면)|보여졌|쓰여지(?:다|고|는|며|니|면)|쓰여졌/gu],
  ["translation", /에 있어서|에 다름 아니|에 의해(?:서)?|를 가지고 있(?:다|었|는|고)|을 가지고 있(?:다|었|는|고)/gu],
  ["redundant", /미리 예(?:상|측)|사전에 미리|과반수 이상|서로 상호|다시 재검토/gu],
] as const;

export type WritingIssueKind = typeof STYLE_RULES[number][0] | "long" | "repetition" | "register" | "age" | "birthYear" | "handedness" | "source" | "scene" | "generalization";
export interface WritingIssue {
  kind: WritingIssueKind;
  line: number;
  excerpt: string;
  detail?: string;
}

const QUOTES = /“[^”]*”|‘[^’]*’|"[^"\n]*"|「[^」]*」|『[^』]*』/gu;
const SENTENCES = /(?<!\d)[.!?。！？]+\s+|\n+/u;
const escapeRegex = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CHARACTER_FACTS = [
  ["age", "(?:올해(?:로)?\\s+)?(\\d{1,3})\\s*(?:살|세)(?![0-9])"],
  ["birthYear", "(\\d{3,4})\\s*년생"],
  ["handedness", "(왼손|오른손|양손)잡이"],
] as const;

// Require an affirmative predicate so a negative statement or a bare age
// in a flashback cannot seed a character fact.
const AFFIRMATIVE_FACT = "(?:이었다|였다|이다|입니다|이었어요|였어요|이에요|예요)(?=$|[^\\p{L}\\p{N}])";

export function reviewManuscript(manuscript: Manuscript, profile: WritingProfile): WritingIssue[] {
  const findings: WritingIssue[] = [];
  const formal: Passage[] = [];
  const plain: Passage[] = [];
  const trackCharacters = profile === "fiction" || profile === "screenplay";
  const hasSceneHeading = manuscript.chapters.some((chapter) => chapter.title) || manuscript.passages.some(({ text }) =>
    /^(?:INT[./]|EXT[./]|S#\s*\d|장면\s*\d|씬\s*\d)/imu.test(text),
  );
  if (profile === "screenplay" && manuscript.charactersWithSpaces >= 450 && !hasSceneHeading && manuscript.passages[0]) {
    findings.push({ kind: "scene", line: manuscript.passages[0].line, excerpt: manuscript.passages[0].text.slice(0, 65) });
  }
  const facts = trackCharacters ? manuscript.characters.flatMap((card) => CHARACTER_FACTS.map(([kind, pattern]) => ({
    kind,
    name: card.name,
    expected: card[kind]?.toString(),
    pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(card.name)}(?:은|는|이|가)?\\s+${pattern}${AFFIRMATIVE_FACT}`, "gu"),
  }))) : [];
  for (const passage of manuscript.passages) {
    const narration = passage.text.replace(QUOTES, (quote) => quote.replace(/[^\n]/gu, " "));
    for (const fact of facts) {
      for (const hit of narration.matchAll(fact.pattern)) {
        const actual = fact.kind === "handedness" ? hit[1] : String(Number(hit[1]));
        if (fact.expected === undefined) {
          fact.expected = actual;
        } else if (fact.expected !== actual) {
          findings.push({ kind: fact.kind, line: passage.line, excerpt: hit[0], detail: `${fact.name} · ${fact.expected}` });
        }
      }
    }
    if (profile === "screenplay") continue;
    if (profile === "column") {
      const sourceCue = /(?:통계|연구|보고서)에 따르면|조사 결과에 따르면/u.exec(narration);
      if (sourceCue && !/https?:\/\/|\[\[|\[\^/u.test(passage.raw)) {
        findings.push({ kind: "source", line: passage.line, excerpt: sourceCue[0] });
      }
    }
    if (profile === "essay") {
      const generalization = /(?:^|\s)(누구나 다|요즘 사람들은|사람이라면 누구나)(?:\s|$)/u.exec(narration);
      if (generalization) findings.push({ kind: "generalization", line: passage.line, excerpt: generalization[1] });
    }
    for (const [kind, pattern] of STYLE_RULES) {
      const match = narration.match(pattern)?.[0];
      if (match) findings.push({ kind, line: passage.line, excerpt: match });
    }
    const sentences = narration.split(SENTENCES).map((sentence) => sentence.trim()).filter(Boolean);
    const long = sentences.find((sentence) => sentence.length >= (profile === "fiction" ? 120 : 100));
    if (long) findings.push({ kind: "long", line: passage.line, excerpt: long.slice(0, 65) + "…" });
    const repeated = sentences.map((sentence) => /^(그리고|그러나|하지만|그래서|그런데)\s/u.exec(sentence)?.[1]);
    const same = repeated.find((word, index) => word && index > 0 && word === repeated[index - 1]);
    if (same) findings.push({ kind: "repetition", line: passage.line, excerpt: same });
    for (const sentence of sentences) {
      if (/(?:습니다|ㅂ니다|입니다|합니다|됩니다|겠어요|했어요|이에요|예요)[.!?]?$/u.test(sentence)) {
        formal.push({ ...passage, text: sentence });
      } else if (/(?:했다|었다|았다|였다|이다|한다|된다|있다|없다)[.!?]?$/u.test(sentence)) {
        plain.push({ ...passage, text: sentence });
      }
    }
  }
  if (profile !== "screenplay" && plain.length && formal.length && Math.max(plain.length, formal.length) >= 3) {
    const outlier = plain.length < formal.length ? plain[0] : formal[0];
    findings.push({ kind: "register", line: outlier.line, excerpt: outlier.text.slice(0, 70) });
  }
  return findings.sort((a, b) => a.line - b.line);
}
