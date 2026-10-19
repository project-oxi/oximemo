import { describe, expect, test } from "bun:test";
import { connectionError, connectionStatus } from "../src/lib/connection";
import { filterDocuments, foldersOf } from "../src/lib/presentation";
import type { Document, View } from "../src/types";

const view: View = { endpoint: "https://pc.tail123.ts.net", paired: true, cache: { documents: [], diagnostics: [], last_sync: "1792300000" } };

describe("truthful PC connection status", () => {
  test("a saved token and an old successful sync never imply live connectivity", () => {
    expect(connectionStatus(view, { phase: "idle" }).state).toBe("saved");
    expect(connectionStatus(view, { phase: "idle" }).label).toBe("PC 연결 정보가 저장되어 있어요");
    expect(connectionStatus(view, { phase: "error", error: "PC not reachable" }).state).toBe("error");
    expect(connectionStatus(view, { phase: "success" }).state).toBe("success");
    expect(connectionStatus({ ...view, paired: false }, { phase: "idle" }).state).toBe("unpaired");
  });
  test("successful network contact still exposes rejected or incomplete note transfers", () => {
    const draft: Document = { key: "draft", attempted: true, error: "rejected: 409", pending: { operation_id: "same-request", change: { kind: "create", title: "Draft", body: "Keep me", body_profile: "pdc-markdown/1" } } };
    const value = { ...view, cache: { ...view.cache, documents: [draft] } };
    expect(connectionStatus(value, { phase: "success" }).state).toBe("warning");
    expect(connectionStatus(value, { phase: "success" }).label).toBe("메모 1개 확인 필요");
    expect(draft.pending?.change.body).toBe("Keep me");
  });
  test("connection errors explain authentication, missing service, and reachability", () => {
    expect(connectionError("HTTP 401 Unauthorized")).toContain("새 연결 코드");
    expect(connectionError("HTTP 404 Not Found")).toContain("OxiMemo 서버");
    expect(connectionError("error sending request: connection refused")).toContain("동기화 서버");
    expect(connectionError("다른 vault에 연결되었습니다.")).toBe("다른 vault에 연결되었습니다.");
  });
});

test("folder browsing uses full path segments and never changes the document collection", () => {
  const note = (path: string, deleted = false): Document => ({ key: path, attempted: false, entry: { path, class: "document", deleted, broken_document_links: [], missing_assets: [] } });
  const documents = [note("notes/a.md"), note("notes/work/b.md"), note("notes-copy/c.md"), note("archive/deleted.md", true), note("root.md")];
  expect(foldersOf(documents)).toEqual(["notes", "notes-copy", "notes/work"].sort((a, b) => a.localeCompare(b, "ko")));
  expect(filterDocuments(documents, "all", "", "notes").map(document => document.key)).toEqual(["notes/a.md", "notes/work/b.md"]);
  expect(documents).toHaveLength(5);
});
