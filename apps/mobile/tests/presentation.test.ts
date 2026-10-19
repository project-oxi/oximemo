import { describe, expect, test } from "bun:test";
import { canEdit, filterDocuments, formatOf, previewOf } from "../src/lib/presentation";
import type { Document } from "../src/types";

const note = (key = "note"): Document => ({ key, attempted: false, entry: { class: "document", path: `${key}.md`, title: "메모 제목", deleted: false, broken_document_links: [], missing_assets: [] }, source: { path: `${key}.md`, title: "메모 제목", editable_body: "# 메모 제목\n\n기록한 내용", content: "exact source bytes", sha256: "snapshot-digest", body_profile: "pdc-markdown/1" } });
const draft: Document = { key: "draft", attempted: false, pending: { operation_id: "immutable-request", change: { kind: "create", title: "새 초안", body: "초안 내용", body_profile: "pdc-markdown/1" } } };

describe("mobile edit availability", () => {
  test("allows empty canonical bodies and unsent offline drafts", () => {
    const empty = note(); empty.source!.editable_body = "";
    expect(canEdit(empty)).toBe(true);
    expect(canEdit(draft)).toBe(true);
  });
  test("locks sent payloads even when their original body remains available", () => {
    expect(canEdit({ ...draft, attempted: true })).toBe(false);
    expect(canEdit({ ...note(), attempted: true })).toBe(false);
  });
  test("never enables legacy, missing editable bodies or deleted documents", () => {
    const legacy = note(); legacy.entry!.class = "legacy-markdown";
    const missing = note(); delete missing.source!.editable_body;
    const deleted = note(); deleted.entry!.deleted = true;
    expect(canEdit(legacy)).toBe(false);
    expect(canEdit(missing)).toBe(false);
    expect(canEdit(deleted)).toBe(false);
  });
  test("HTML drafts retain their selected profile", () => {
    const html: Document = { key: "html-draft", attempted: false, pending: { operation_id: "html-request", change: { kind: "create", title: "HTML", body: "<p>원문</p>", body_profile: "pdc-html/1" } } };
    expect(formatOf(html)).toBe("pdc-html/1");
  });
});

describe("mobile library presentation", () => {
  test("separates trash and pending drafts without changing the source order", () => {
    const deleted = note("deleted"); deleted.entry!.deleted = true;
    const documents = [note(), draft, deleted];
    expect(filterDocuments(documents, "all", "").map(d => d.key)).toEqual(["note", "draft"]);
    expect(filterDocuments(documents, "drafts", "").map(d => d.key)).toEqual(["draft"]);
    expect(filterDocuments(documents, "trash", "").map(d => d.key)).toEqual(["deleted"]);
    expect(documents.map(d => d.key)).toEqual(["note", "draft", "deleted"]);
  });
  test("searches draft content and does not search a missing-source placeholder", () => {
    const notFetched: Document = { key: "missing", attempted: false, entry: { class: "document", title: "아직 원문 없음", path: "missing.md", deleted: false, broken_document_links: [], missing_assets: [] } };
    expect(filterDocuments([draft], "all", "초안 내용")).toHaveLength(1);
    expect(filterDocuments([notFetched], "all", "동기화해 주세요")).toHaveLength(0);
  });
  test("suppresses a repeated heading in an excerpt while preserving body bytes", () => {
    const document = note(); const original = document.source!.editable_body;
    expect(previewOf(document)).toBe("기록한 내용");
    expect(document.source!.editable_body).toBe(original);
  });
  test("HTML excerpts remain text and preserve the complete HTML source", () => {
    const document = note();
    const html = '<script>window.bad = true</script><p>작성한 <strong>HTML</strong></p>';
    document.source = { ...document.source!, body_profile: "pdc-html/1", content: html, editable_body: html };
    expect(previewOf(document)).toBe("작성한 HTML");
    expect(document.source.content).toBe(html);
    expect(document.source.editable_body).toBe(html);
  });
});
