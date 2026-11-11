import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { decideWritingReview, writingRevisionChange, writingRevisionUpdate, type WritingReviewItem } from "./writingReview";

test("applies one exact passage without touching Markdown extensions or surrounding bytes", () => {
  const source = "# 제목\r\n\r\n%% 숨긴 설정 %%\r\n😀 첫 구절이다.\r\n[[다른 노트|별칭]] ^block-id\r\n";
  const revision = { original: "첫 구절이다.", replacement: "첫 장면이다.", reason: "장면을 가리킴" };
  const change = writingRevisionChange(source, revision)!;
  expect(source.slice(0, change.from) + change.insert + source.slice(change.to))
    .toBe("# 제목\r\n\r\n%% 숨긴 설정 %%\r\n😀 첫 장면이다.\r\n[[다른 노트|별칭]] ^block-id\r\n");
});

test("refuses absent, ambiguous and overlapping source matches", () => {
  const revision = { original: "가가", replacement: "나", reason: "수정" };
  expect(writingRevisionChange("가가가", revision)).toBeNull();
  expect(writingRevisionChange("가가 그리고 가가", revision)).toBeNull();
  expect(writingRevisionChange("바뀐 원문", revision)).toBeNull();
  expect(writingRevisionChange("원문", { ...revision, original: "" })).toBeNull();
  expect(writingRevisionChange("가가", { ...revision, replacement: "가가" })).toBeNull();
});

test("keeps intentional replacement whitespace and allows explicit deletion", () => {
  expect(writingRevisionChange("앞 원문 뒤", { original: "원문", replacement: " 새 문장 ", reason: "수정" }))
    .toEqual({ from: 2, to: 4, insert: " 새 문장 " });
  expect(writingRevisionChange("앞 원문 뒤", { original: "원문", replacement: "", reason: "중복 삭제" }))
    .toEqual({ from: 2, to: 4, insert: "" });
});

test("applying and ignoring advance independently through the whole queue", () => {
  const items: WritingReviewItem[] = ["첫", "둘", "셋"].map((original) => ({
    revision: { original, replacement: `${original} 수정`, reason: "수정" }, decision: "pending",
  }));
  const first = decideWritingReview(items, 0, "applied");
  expect(first.find((item) => item.decision === "pending")?.revision.original).toBe("둘");
  const second = decideWritingReview(first, 1, "ignored");
  expect(second.find((item) => item.decision === "pending")?.revision.original).toBe("셋");
  const third = decideWritingReview(second, 2, "applied");
  expect(third.map((item) => item.decision)).toEqual(["applied", "ignored", "applied"]);
  expect(decideWritingReview(third, 1, "applied")[1].decision).toBe("ignored");
  expect(items.map((item) => item.decision)).toEqual(["pending", "pending", "pending"]);
});

test("projects consecutive CRLF revisions into CodeMirror without normalizing saved source", () => {
  let source = "# 제목\r\n\r\n😀 첫 구절.\r\n둘째 구절.\r\n\r\n%% 유지 %%\r\n";
  let state = EditorState.create({ doc: source });
  for (const revision of [
    { original: "첫 구절.\r\n둘째 구절.", replacement: "첫 장면.\r\n둘째 장면.", reason: "용어 통일" },
    { original: "둘째 장면.", replacement: "다음 장면.", reason: "순서 명확화" },
  ]) {
    const update = writingRevisionUpdate(source, revision)!;
    expect(state.doc.toString()).toBe(update.editorSource);
    state = state.update({ changes: update.change }).state;
    expect(state.doc.toString()).toBe(update.nextEditorSource);
    source = update.nextSource;
  }
  expect(source).toBe("# 제목\r\n\r\n😀 첫 장면.\r\n다음 장면.\r\n\r\n%% 유지 %%\r\n");
  expect(state.doc.toString()).toBe("# 제목\n\n😀 첫 장면.\n다음 장면.\n\n%% 유지 %%\n");
});
