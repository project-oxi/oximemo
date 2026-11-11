import { expect, test } from "bun:test";
import { writingLexiconTiers } from "./koreanLexicon";
import { writingGlossaryEntries, writingGlossaryHeading } from "./writingGlossary";
import { assembleBook } from "./writingBook";
import { preservesPublishedChapters, readManuscript, writingProfile } from "./writing";

test("uses live writing tags, with a specific genre taking precedence", () => {
  expect(writingProfile("#writing #에세이", ["writing"])).toBe("essay");
  expect(writingProfile("수정 중인 원고")).toBeNull();
  expect(writingProfile("수정 중인 원고", ["Writing"])).toBe("fiction");
  expect(writingProfile("메모", ["screenplay"])).toBe("screenplay");
  expect(writingProfile("C#writing #writing-help")).toBeNull();
});

test("projects physical chapter positions and excludes planning from the manuscript", () => {
  const body = [
    "# 작품",
    "",
    "#writing",
    "",
    "## 강변",
    "첫 문단.",
    "",
    "```md",
    "## 가짜 제목",
    "```",
    "",
    "## 집필 노트",
    "### 등장인물",
    "#### 유진",
    "- 나이: 28",
    "- 역할: 우편배달부",
    "",
    "### 시나리오",
    "- 여기 적은 비밀은 책에 안 실린다.",
    "",
    "## 새벽",
    "둘째 문단.",
  ].join("\r\n");
  const book = readManuscript(body);
  expect(book.title).toBe("작품");
  expect(book.chapters.map(({ title, line }) => [title, line])).toEqual([["강변", 5], ["새벽", 21]]);
  expect(book.chapters[0].markdown).toContain("## 가짜 제목");
  expect(book.chapters[0].markdown).not.toContain("#writing");
  expect(book.chapters[1].markdown).toBe("둘째 문단.");
  expect(book.characterSection?.endLine).toBe(18);
  expect(book.characters[0]).toMatchObject({ name: "유진", line: 14 });
  expect(book.scenario?.line).toBe(18);
});

test("keeps source comments and their headings out of a book, preserving literal code", () => {
  const book = readManuscript([
    "# 작품", "", "## 강변", "첫 문장. %%비공개", "## 숨긴 제목", "비공개%%",
    "", "## 역", "둘째 문장. <!-- 비공개 -->", "", "`%%코드 예제%%`",
  ].join("\n"));
  expect(book.chapters.map(({ title, line }) => [title, line])).toEqual([["강변", 3], ["역", 8]]);
  expect(book.chapters.map(({ markdown }) => markdown).join("\n")).not.toContain("비공개");
  expect(book.chapters[1].markdown).toContain("`%%코드 예제%%`");
});

test("recognizes planning only when it leaves public chapters intact", () => {
  const planning = "\n\n## 집필 노트\n\n### 등장인물\n\n#### 은주\n\n- 나이: 32\n";
  for (const suffix of ["", "\n\n```\n"]) {
    const body = "# 원고\n\n## 첫 장\n\n    코드\n\n공개 문장." + suffix;
    const before = readManuscript(body);
    const after = readManuscript(body + planning);
    expect(before.chapters[0].markdown).toStartWith("    코드");
    expect(preservesPublishedChapters(before, after)).toBe(!suffix);
    expect(after.characters.length).toBe(suffix ? 0 : 1);
  }
});

test("assembles ordered memo sources and counts only public text", () => {
  const first = readManuscript("# 첫 메모\n\n첫 원고.\n\n## 집필 노트\n\n비공개.");
  const second = readManuscript("# 둘째 메모\n\n## 뒷장\n\n둘째 원고.");
  const book = assembleBook([
    { id: "b", title: null, manuscript: second },
    { id: "a", title: null, manuscript: first },
  ], "제목 없음", "서두");
  expect(book.chapters).toEqual([
    { sourceId: "b", title: "뒷장", markdown: "둘째 원고." },
    { sourceId: "a", title: "첫 메모", markdown: "첫 원고." },
  ]);
  expect(book.count).toBe(first.charactersWithSpaces + second.charactersWithSpaces);
  expect(book.unclosedComment).toBe(false);
});

test("detects writing notes inserted into an open fence by an earlier editor", () => {
  const body = "# 원고\n\n공개 본문.\n\n~~~\n## 집필 노트\n\n### 등장인물\n\n#### 은주";
  const book = (body: string) => assembleBook([{ id: "a", title: null, manuscript: readManuscript(body) }], "", "");
  expect(book(body).fencedWritingNotes).toBe(true);
  expect(book(body.replace("~~~\n", "~~~\n코드\n~~~\n")).fencedWritingNotes).toBe(false);
  expect(book(body + "\n~~~").fencedWritingNotes).toBe(false);
});

test("renders literal title text and keeps every planning section out of export", () => {
  const book = readManuscript([
    "# A & B", "", "## Don't stop", "불빛이 보였다.", "", "## 집필 노트", "계획 1",
    "", "## 새벽", "첫 문장.", "", "## Writing notes", "계획 2",
  ].join("\n"));
  expect(book.title).toBe("A & B");
  expect(book.chapters.map(({ title }) => title)).toEqual(["Don't stop", "새벽"]);
  expect(book.chapters.map(({ markdown }) => markdown).join("\n")).not.toContain("계획");
  expect(readManuscript("첫 문장. %%아직 작성 중").unclosedComment).toBe(true);
  expect(readManuscript("첫 문장. \\<!-- 그대로 보인다.").unclosedComment).toBe(false);
});

test("projects only glossary headings and the first definition outside source comments", () => {
  const text = [
    "# 작품 사전", "", "#oximemo/writing-glossary", "", "%%",
    "## 내부 제목", "숨김.", "%%", "", "## 은빛 성채", "",
    "동쪽 바다를 지키는 요새.", "", "### 세부 설정", "", "지도는 다음 장.",
    "", "```md", "## 예시", "```", "", `## ${writingGlossaryHeading("하린 [별명]")}`,
  ].join("\r\n");
  expect(writingGlossaryEntries(text)).toEqual([
    { word: "은빛 성채", heading: "은빛 성채", definition: "동쪽 바다를 지키는 요새." },
    { word: "하린 [별명]", heading: "하린 \\[별명\\]", definition: "" },
  ]);
});

test("ships nested vocabularies without their downloadable vector rows", async () => {
  const assets = new URL("../../public/ko-lexicon/", import.meta.url);
  const words = new Set<string>();
  for (const [tier, file] of [["small", "words.txt"], ["medium", "words-medium.txt"], ["large", "words-large.txt"]] as const) {
    const additions = (await Bun.file(new URL(file, assets)).text()).trimEnd().split(/\r?\n/u);
    for (const word of additions) words.add(word);
    expect(words.size).toBe(writingLexiconTiers[tier].words);
  }
  expect(words.has("적막")).toBe(true);
  expect(await Bun.file(new URL("vectors.bin", assets)).exists()).toBe(false);
});
