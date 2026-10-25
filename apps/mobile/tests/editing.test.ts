import { describe, expect, test } from "bun:test";
import { continueList, displayBody, formatBody, preserveInput } from "../src/lib/editing";

describe("source-preserving mobile authoring", () => {
  test("typing changes only the selected span across mixed line endings and extensions", () => {
    const source = "# 제목\r\n\r\n%% keep %%\n[[note]]\r\n본문 ^block";
    const edited = displayBody(source).replace("본문", "수정한 본문");
    expect(preserveInput(source, edited)).toBe(source.replace("본문", "수정한 본문"));
    expect(preserveInput(source, displayBody(source))).toBe(source);
    expect(preserveInput(source, displayBody(source) + "!")).toBe(source + "!");
  });
  test("formatting a selection preserves source outside it and toggles wrappers", () => {
    const source = "앞\r\n한글\r\n%% keep %%";
    const bold = formatBody(source, 2, 4, "bold");
    expect(bold).toEqual({ body: "앞\r\n**한글**\r\n%% keep %%", start: 4, end: 6 });
    expect(formatBody(bold.body, bold.start, bold.end, "bold")).toEqual({ body: source, start: 2, end: 4 });
  });
  test("multiline list formatting leaves terminators and next unselected line intact", () => {
    const source = "하나\r\n둘\n셋";
    const list = formatBody(source, 0, 5, "checklist");
    expect(list.body).toBe("- [ ] 하나\r\n- [ ] 둘\n셋");
    expect(formatBody(list.body, list.start, list.end, "checklist").body).toBe(source);
    expect(formatBody("\n끝", 0, 0, "heading").body).toBe("## \n끝");
  });
  test("Enter continues tasks as unchecked and exits an empty list", () => {
    expect(continueList("- [x] 완료", 8, 8)?.body).toBe("- [x] 완료\n- [ ] ");
    expect(continueList("3. 항목", 5, 5)?.body).toBe("3. 항목\n4. ");
    expect(continueList("- [ ] ", 6, 6)).toEqual({ body: "", start: 0, end: 0 });
    expect(continueList("- 첫째\r\n뒤", 4, 4)?.body).toBe("- 첫째\r\n- \r\n뒤");
  });
  test("Enter does not reinterpret code fences, custom task states, or midline selections", () => {
    for (const source of ["```md\n- example", "~~~\n- example", "- [/] extension", "    - code"]) {
      expect(continueList(source, displayBody(source).length, displayBody(source).length)).toBeUndefined();
    }
    expect(continueList("- item", 3, 3)).toBeUndefined();
    expect(continueList("- item", 0, 6)).toBeUndefined();
  });
});
