import { describe, expect, test } from "bun:test";
import { gardenMarkdownParser, parseWikiTarget } from "../src/syntax";

function nodes(source: string, name: string): Array<{ from: number; to: number }> {
  const found: Array<{ from: number; to: number }> = [];
  const cursor = gardenMarkdownParser.parse(source).cursor();
  do {
    if (cursor.name === name) found.push({ from: cursor.from, to: cursor.to });
  } while (cursor.next());
  return found;
}

function raw(source: string, range: { from: number; to: number }): string {
  return source.slice(range.from, range.to);
}

describe("shared Garden Markdown syntax", () => {
  test("composes CommonMark and GFM with the Garden extensions", () => {
    const source = "- [ ] task\n\n| head |\n| --- |\n| cell |\n\n~~old~~ and ==highlight==";
    const tree = gardenMarkdownParser.parse(source).toString();

    expect(tree).toContain("Task(TaskMarker)");
    expect(tree).toContain("Table(");
    expect(tree).toContain("Strikethrough(");
    expect(tree).toContain("Highlight(");
  });

  test("emits full-range wiki, callout, highlight, footnote, tag and block-ID nodes", () => {
    const wiki = "[[Notes/Plan#Next|Read this]] [[Notes/Plan#^section-2]] ![[images/leaf.png]]";
    const linkNodes = nodes(wiki, "GardenWikiLink");
    const embedNodes = nodes(wiki, "GardenWikiEmbed");
    expect(linkNodes.map((range) => raw(wiki, range))).toEqual([
      "[[Notes/Plan#Next|Read this]]",
      "[[Notes/Plan#^section-2]]",
    ]);
    expect(embedNodes.map((range) => raw(wiki, range))).toEqual(["![[images/leaf.png]]"]);

    const quote = "> [!warning] Keep the source\n> More text";
    expect(raw(quote, nodes(quote, "GardenCalloutMarker")[0]!)).toBe("[!warning]");
    expect(nodes("==marked==", "Highlight")).toHaveLength(1);
    expect(raw("[^ref]", nodes("[^ref]", "GardenFootnoteReference")[0]!)).toBe("[^ref]");
    expect(raw("> [!a] title", nodes("> [!a] title", "GardenCalloutMarker")[0]!)).toBe("[!a]");
    expect(raw("[^a]", nodes("[^a]", "GardenFootnoteReference")[0]!)).toBe("[^a]");
    expect(raw("See #topic/subtopic", nodes("See #topic/subtopic", "GardenTag")[0]!)).toBe("#topic/subtopic");
    expect(raw("Paragraph ^stable-id", nodes("Paragraph ^stable-id", "GardenBlockId")[0]!)).toBe("^stable-id");
  });

  test("keeps code and escaped tokens outside the compatibility nodes", () => {
    const source = '\\[[escaped]] and \\![[escaped-embed]] plus `[[code]]` and [[real]]';
    expect(nodes(source, "GardenWikiLink").map((range) => raw(source, range))).toEqual(["[[real]]"]);
    expect(nodes(source, "GardenWikiEmbed")).toHaveLength(0);

    const escaped = '\\#tag \\^id';
    expect(nodes(escaped, "GardenTag")).toHaveLength(0);
    expect(nodes(escaped, "GardenBlockId")).toHaveLength(0);

    const fenced = "```md\n%%\n#tag ^id\n$$x$$\n[^note]: definition\n```";
    expect(nodes(fenced, "GardenComment")).toHaveLength(0);
    expect(nodes(fenced, "GardenMathBlock")).toHaveLength(0);
    expect(nodes(fenced, "GardenBlockId")).toHaveLength(0);
    expect(nodes(fenced, "GardenTag")).toHaveLength(0);
    expect(nodes(fenced, "GardenFootnoteDefinition")).toHaveLength(0);
  });

  test("makes wiki aliases and anchors available without rewriting source", () => {
    expect(parseWikiTarget("[[Notes/Plan#Next|Read this]]")).toEqual({
      target: "Notes/Plan#Next",
      alias: "Read this",
      heading: "Next",
      blockId: null,
      embedded: false,
    });
    expect(parseWikiTarget("[[Notes/Plan#^section-2]]")).toEqual({
      target: "Notes/Plan#^section-2",
      alias: null,
      heading: null,
      blockId: "section-2",
      embedded: false,
    });
    expect(parseWikiTarget("![[Notes/Plan\\|Read this]]")).toEqual({
      target: "Notes/Plan",
      alias: "Read this",
      heading: null,
      blockId: null,
      embedded: true,
    });
    expect(parseWikiTarget("[[Notes/Plan|Read \\| review]]")?.alias).toBe("Read | review");
    expect(parseWikiTarget("[[incomplete")).toBeNull();
  });

  test("treats comments and display math as opaque blocks across blank lines", () => {
    const comment = "%%\n\ncomment ^hidden-id\n\n%%\n\nParagraph ^visible-id";
    const commentRange = nodes(comment, "GardenComment")[0]!;
    expect(raw(comment, commentRange)).toBe("%%\n\ncomment ^hidden-id\n\n%%");
    expect(nodes(comment, "GardenBlockId").map((range) => raw(comment, range))).toEqual(["^visible-id"]);

    const math = "$$\n\nformula ^hidden-id\n\n$$\n\nParagraph ^visible-id";
    const mathRange = nodes(math, "GardenMathBlock")[0]!;
    expect(raw(math, mathRange)).toBe("$$\n\nformula ^hidden-id\n\n$$");
    expect(nodes(math, "GardenBlockId").map((range) => raw(math, range))).toEqual(["^visible-id"]);

    const inlineBlock = "$$x^2$$\n\nParagraph ^visible-id";
    expect(raw(inlineBlock, nodes(inlineBlock, "GardenMathBlock")[0]!)).toBe("$$x^2$$");
    expect(nodes(inlineBlock, "GardenBlockId").map((range) => raw(inlineBlock, range))).toEqual(["^visible-id"]);
  });

  test("keeps inline comments and math opaque and does not mistake currency for math", () => {
    const source = "%% hidden ^comment-id %% and $x^2$ plus ^visible-id";
    expect(raw(source, nodes(source, "GardenComment")[0]!)).toBe("%% hidden ^comment-id %%");
    expect(raw(source, nodes(source, "GardenMathInline")[0]!)).toBe("$x^2$");
    expect(nodes(source, "GardenBlockId").map((range) => raw(source, range))).toEqual(["^visible-id"]);
    expect(nodes("Prices are $5 and $10 today", "GardenMathInline")).toHaveLength(0);
  });

  test("keeps footnote definitions and indented continuation source opaque", () => {
    const source = "[^ref]: first line\n    continuation ^not-a-block-id\n\nParagraph ^real-id";
    const definition = nodes(source, "GardenFootnoteDefinition")[0]!;
    expect(raw(source, definition)).toBe("[^ref]: first line\n    continuation ^not-a-block-id");
    expect(nodes(source, "GardenBlockId").map((range) => raw(source, range))).toEqual(["^real-id"]);
  });

  test("keeps syntax source ranges exact across CRLF input", () => {
    const source = "First line\r\n[[Note#Heading|Header]]\r\nLast line ^last-id";
    const wiki = nodes(source, "GardenWikiLink")[0]!;
    const blockId = nodes(source, "GardenBlockId")[0]!;
    expect(wiki.from).toBe(source.indexOf("[[Note"));
    expect(raw(source, wiki)).toBe("[[Note#Heading|Header]]");
    expect(raw(source, blockId)).toBe("^last-id");
  });
});
