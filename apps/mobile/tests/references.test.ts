import { expect, test } from "bun:test";
import { resolveNote, imageMime } from "../src/lib/references";
import { previewOf } from "../src/lib/presentation";
import type { Document } from "../src/types";
const note: Document = { key: "id", attempted: false, source: { path: "notes/a.md", sha256: "digest", content: "", document_id: "uuid" } };
test("note resolution refuses escapes, ambiguous identities and active schemes", () => {
  expect(resolveNote("a.md", "notes/b.md", [note])).toBe(note);
  expect(resolveNote("pdc://document/uuid", "", [note])).toBe(note);
  for (const target of ["../../notes/a.md", "file:///notes/a.md", "javascript:alert(1)", "/notes/a.md"]) expect(resolveNote(target, "notes/b.md", [note])).toBeUndefined();
  expect(resolveNote("pdc://document/uuid", "", [note, note])).toBeUndefined();
});
test("image preview only admits recognized raster signatures", () => {
  expect(imageMime([137,80,78,71,13,10,26,10])).toBe("image/png");
  expect(imageMime([...new TextEncoder().encode('<svg onload="bad"/>')])).toBeUndefined();
});
test("list excerpt preserves line boundaries and readable checklist/formatting", () => {
  const document = { ...note, pending: { operation_id: "id", change: { kind: "create" as const, title: "제목", body_profile: "pdc-markdown/1", body: "# 제목\n\n**첫 문단**\n\n- [ ] 준비\n- [x] 완료\n\n[[다른 메모|참고]]\n%%비공개 주석%%" } } };
  expect(previewOf(document)).toBe("첫 문단\n☐ 준비\n☑ 완료\n참고");
});
