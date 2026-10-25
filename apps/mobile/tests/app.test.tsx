import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { dom } from "./dom";
import type { View } from "../src/types";

let state: View;
let syncFailure = "";
let calls: string[] = [];
let savedKeys: unknown[] = [];
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    calls.push(command);
    if (command === "mobile_connect") state = { ...state, paired: true, endpoint: String(args.endpoint) };
    if (command === "mobile_sync") {
      if (syncFailure) throw new Error(syncFailure);
      state.cache.last_sync = "1792300000";
      state.cache.documents = state.cache.documents.map(document => {
        if (!document.pending || document.error) return document;
        const change = document.pending.change;
        const key = document.key.startsWith("pc-") ? document.key : `pc-${document.key}`;
        state.key_updates = { ...state.key_updates, [document.key]: key };
        return { key, attempted: false, entry: { path: `${document.key}.md`, class: "document", deleted: false, title: change.title, broken_document_links: [], missing_assets: [] }, source: { path: `${document.key}.md`, content: change.body, editable_body: change.body, sha256: "confirmed", body_profile: "pdc-markdown/1", title: change.title } };
      });
    }
    if (command === "mobile_save") {
      if (args.key) {
        const current = state.cache.documents.find(d => d.key === args.key);
        if (JSON.stringify(args.expected) !== JSON.stringify({ source: current?.source ?? null, pending: current?.pending ?? null })) throw new Error("원문이 바뀌었습니다.");
      }
      savedKeys.push(args.key);
      const key = String(args.key || "saved");
      state.cache.documents = [...state.cache.documents.filter(document => document.key !== key), { key, attempted: false, pending: { operation_id: "immutable-id", change: { kind: "create", title: String(args.title), body: String(args.body), body_profile: String(args.profile) } } }];
    }
    return structuredClone(state);
  },
}));
mock.module("@tauri-apps/plugin-barcode-scanner", () => ({ scan: async () => ({ content: "test" }), cancel: async () => {}, Format: { QRCode: "qr" }, checkPermissions: async () => "granted", requestPermissions: async () => "granted" }));
const { createRoot } = await import("react-dom/client");
const { App } = await import("../src/App");
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  window.localStorage.clear();
  state = { paired: false, endpoint: "", cache: { documents: [], diagnostics: [] } };
  syncFailure = ""; calls = []; savedKeys = [];
});
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.replaceChildren(); });
const mount = async () => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<App/>));
};
const button = (label: string) => Array.from(document.querySelectorAll("button")).find(button => button.textContent === label || button.getAttribute("aria-label") === label)!;
const click = async (label: string) => { expect(button(label)).toBeTruthy(); await act(async () => { button(label).click(); await new Promise(resolve => setTimeout(resolve, 25)); }); };
const fill = async (selector: string, value: string) => {
  const input = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  const prototype = input.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
};
const manualConnect = async () => {
  await click("설정");
  await click("PC 연결");
  await fill("#pc-address", "https://pc.tail123.ts.net");
  await fill("#pc-token", "t".repeat(64));
  await act(async () => document.querySelector("#pc-address")!.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
};

describe("mobile connection and save flows", () => {
  test("manual connection immediately verifies synchronization instead of declaring a saved token connected", async () => {
    await mount();
    await manualConnect();
    expect(calls.indexOf("mobile_sync")).toBeGreaterThan(calls.indexOf("mobile_connect"));
    expect(document.querySelector(".connection-result")?.textContent).toContain("PC와 동기화했어요");
  });
  test("a failed connection remains visibly failed while local notes and pairing remain available", async () => {
    syncFailure = "error sending request: connection refused";
    await mount(); await manualConnect();
    expect(document.querySelector(".connection-result")?.textContent).toContain("PC 연결 확인 필요");
    expect(document.querySelector(".connection-result")?.textContent).not.toContain("PC와 동기화했어요");
    expect(document.querySelector(".connection-help")?.hasAttribute("open")).toBe(true);
    expect(state.paired).toBe(true);
    await click("설정으로");
    await click("메모 목록으로");
    expect(document.querySelector(".sync-overview")?.getAttribute("aria-label")).toContain("PC 연결 확인 필요");
  });
  test("saving durably queues the draft before automatically syncing with the paired PC", async () => {
    state.paired = true; state.endpoint = "https://pc.tail123.ts.net";
    await mount(); calls = [];
    await click("새 메모 작성");
    await fill('textarea[aria-label="메모 제목"]', "휴대폰에서 적은 메모");
    await fill('textarea[aria-label="메모 본문"]', "**원문 그대로**\n\n- [ ] 할 일\n");
    await click("메모 저장");
    expect(calls.indexOf("mobile_sync")).toBeGreaterThan(calls.indexOf("mobile_save"));
    expect(state.cache.documents[0].source?.editable_body).toBe("**원문 그대로**\n\n- [ ] 할 일\n");
    expect(state.cache.documents[0].pending).toBeUndefined();
    expect(document.querySelector("article strong")?.textContent).toBe("원문 그대로");
    await click("편집");
    await fill('textarea[aria-label="메모 본문"]', "두 번째 수정");
    await click("메모 저장");
    expect(savedKeys).toEqual([null, "pc-saved"]);
    await click("메모 목록으로");
    expect(document.querySelector(".sync-overview")).toBeNull();
    await click("설정");
    expect(document.querySelector(".settings-row")?.textContent).toContain("PC와 동기화했어요");
  });
  test("reading, editing and previewing never write until save; save keeps the note open", async () => {
    state.cache.documents = [{ key: "local", attempted: false, pending: { operation_id: "original", change: { kind: "create", title: "원래 제목", body: "**보존**\n\n%% 주석 %%\n", body_profile: "pdc-markdown/1" } } }];
    await mount();
    await click("원래 제목");
    expect(document.querySelector("article strong")?.textContent).toBe("보존");
    expect(document.querySelector('textarea[aria-label="메모 본문"]')).toBeNull();
    await click("편집");
    await fill('textarea[aria-label="메모 본문"]', "**수정**\n\n%% 주석 %%\n");
    await click("미리보기");
    expect(document.querySelector("article strong")?.textContent).toBe("수정");
    await click("편집");
    expect((document.querySelector('textarea[aria-label="메모 본문"]') as HTMLTextAreaElement).value).toBe("**수정**\n\n%% 주석 %%\n");
    await click("미리보기");
    expect(calls).not.toContain("mobile_save");
    await click("메모 목록으로");
    expect(document.querySelector("dialog")?.hasAttribute("open")).toBe(true);
    await click("계속 작성");
    await click("메모 저장");
    expect(document.querySelector("article strong")?.textContent).toBe("수정");
    expect(calls.filter(call => call === "mobile_save")).toHaveLength(1);
  });
  test("HTML source stays read-only until explicitly entering edit mode", async () => {
    const source = '<article data-custom="keep"><h1>HTML</h1>\r\n<!-- preserve -->\r\n</article>';
    state.cache.documents = [{ key: "html", attempted: false, entry: { path: "note.html", class: "document", deleted: false, broken_document_links: [], missing_assets: [] }, source: { path: "note.html", content: source, editable_body: source, body_profile: "pdc-html/1", title: "HTML", sha256: "original" } }];
    await mount(); await click("HTML");
    const body = () => document.querySelector('textarea[aria-label="메모 본문"]') as HTMLTextAreaElement;
    expect(body().readOnly).toBe(true);
    expect(body().value).toBe(source.replaceAll("\r\n", "\n")); // Textarea's display normalizes line breaks; source state stays exact.
    await click("편집");
    expect(body().readOnly).toBe(false);
    expect(calls).not.toContain("mobile_save");
    expect(state.cache.documents[0].source?.content).toBe(source);
  });
});


describe("native history routes", () => {
  const historyGo = async (delta: number) => act(async () => { window.history.go(delta); await new Promise(resolve => setTimeout(resolve, 60)); });
  test("back and forward traverse settings and connection without writes", async () => {
    await mount(); await click("설정"); await click("PC 연결");
    await historyGo(-1);
    expect(button("PC 연결")).toBeTruthy();
    await historyGo(-1);
    expect(button("새 메모 작성")).toBeTruthy();
    await historyGo(1);
    expect(button("PC 연결")).toBeTruthy();
    await historyGo(1);
    expect(button("설정으로")).toBeTruthy();
    expect(calls).not.toContain("mobile_save");
  });
  test("search has its own back entry and restores the query after reading", async () => {
    state.cache.documents = [{ key: "search-note", attempted: false, pending: { operation_id: "original", change: { kind: "create", title: "검색 대상", body: "찾을 문장", body_profile: "pdc-markdown/1" } } }];
    await mount();
    await act(async () => (document.querySelector('input[aria-label="메모 검색"]') as HTMLInputElement).focus());
    await fill('input[aria-label="메모 검색"]', "문장");
    await click("검색 대상"); await historyGo(-1);
    expect((document.querySelector('input[aria-label="메모 검색"]') as HTMLInputElement).value).toBe("문장");
    expect(document.querySelector("mark")?.textContent).toBe("문장");
    await historyGo(-1);
    expect(document.querySelector(".app")?.classList.contains("is-searching")).toBe(false);
    expect(button("새 메모 작성")).toBeTruthy();
  });
  test("save-and-leave commits before history returns, and forward reads the saved note", async () => {
    await mount(); await click("새 메모 작성");
    await fill('textarea[aria-label="메모 본문"]', "**saved draft**");
    await historyGo(-1); await click("저장하고 나가기");
    expect(button("새 메모 작성")).toBeTruthy();
    expect(calls.filter(call => call === "mobile_save")).toHaveLength(1);
    await historyGo(1);
    expect(document.querySelector("article strong")?.textContent).toBe("saved draft");
  });
  test("a browser back gesture guards an exact draft and discard never writes it", async () => {
    await mount(); await click("새 메모 작성");
    await fill('textarea[aria-label="메모 본문"]', "**unsent**\n\n%% preserve %%");
    await historyGo(-1);
    expect(document.querySelector("dialog")?.hasAttribute("open")).toBe(true);
    await click("계속 작성");
    expect((document.querySelector('textarea[aria-label="메모 본문"]') as HTMLTextAreaElement).value).toBe("**unsent**\n\n%% preserve %%");
    await historyGo(-1); await click("저장하지 않고 나가기");
    expect(button("새 메모 작성")).toBeTruthy();
    expect(calls).not.toContain("mobile_save");
    await historyGo(1);
    expect((document.querySelector('textarea[aria-label="메모 본문"]') as HTMLTextAreaElement).value).toBe("");
  });
});

describe("mobile authoring journey", () => {
  test("compose checklist, undo/redo, preview, save, find and reopen exact source", async () => {
    await mount(); await click("새 메모 작성");
    await fill('textarea[aria-label="메모 제목"]', "주말 준비");
    const selector = 'textarea[aria-label="메모 본문"]';
    await fill(selector, "우유 사기");
    const field = () => document.querySelector(selector) as HTMLTextAreaElement;
    await act(async () => { field().focus(); field().setSelectionRange(5, 5); field().dispatchEvent(new dom.window.Event("select", { bubbles: true })); });
    await click("체크리스트");
    expect(field().value).toBe("- [ ] 우유 사기");
    await click("본문 실행 취소"); expect(field().value).toBe("우유 사기");
    await click("본문 다시 실행"); expect(field().value).toBe("- [ ] 우유 사기");
    const cursor = field().selectionStart;
    await click("미리보기");
    expect(document.querySelector('article input[type="checkbox"]:disabled')).not.toBeNull();
    expect(calls).not.toContain("mobile_save");
    await click("편집"); expect(field().selectionStart).toBe(cursor);
    await click("메모 저장");
    expect(state.cache.documents[0].pending?.change.body).toBe("- [ ] 우유 사기");
    await click("메모 목록으로");
    await fill('input[aria-label="메모 검색"]', "주말");
    await click("주말 준비"); await click("편집");
    expect(field().value).toBe("- [ ] 우유 사기");
    expect(calls.filter(call => call === "mobile_save")).toHaveLength(1);
  });

  test("format and save preserve mixed source terminators", async () => {
    const body = "첫 줄\r\n%% 주석 %%\n마지막";
    state.cache.documents = [{ key: "mixed", attempted: false, entry: { path: "mixed.md", class: "document", title: "혼합 개행", deleted: false, broken_document_links: [], missing_assets: [] }, source: { path: "mixed.md", content: `envelope\r\n${body}`, editable_body: body, title: "혼합 개행", body_profile: "pdc-markdown/1", sha256: "original" } }];
    await mount(); await click("혼합 개행"); await click("편집");
    const field = document.querySelector('textarea[aria-label="메모 본문"]') as HTMLTextAreaElement;
    await act(async () => { field.focus(); field.setSelectionRange(0, 3); field.dispatchEvent(new dom.window.Event("select", { bubbles: true })); });
    await click("굵게"); await click("메모 저장");
    expect(state.cache.documents[0].pending?.change.body).toBe("**첫 줄**\r\n%% 주석 %%\n마지막");
  });
});

describe("IME and read-only authoring boundaries", () => {
  test("IME Enter does not continue a list; ordinary Enter does", async () => {
    await mount(); await click("새 메모 작성");
    await fill('textarea[aria-label="메모 본문"]', "- [ ] 항목");
    const field = document.querySelector('textarea[aria-label="메모 본문"]') as HTMLTextAreaElement;
    await act(async () => { field.focus(); field.setSelectionRange(field.value.length, field.value.length); field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })); });
    expect(field.value).toBe("- [ ] 항목");
    await act(async () => { field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(field.value).toBe("- [ ] 항목\n- [ ] ");
    expect(calls).not.toContain("mobile_save");
  });
});


describe("unsaved recovery", () => {
  test("relaunch restores exact unsaved text without queueing or syncing", async () => {
    await mount(); await click("새 메모 작성");
    await fill('textarea[aria-label="메모 제목"]', "복구 확인");
    await fill('textarea[aria-label="메모 본문"]', "**아직 저장 전**\n- [ ] 확인");
    await act(async () => root.unmount()); document.body.replaceChildren(); calls = [];
    await mount();
    expect((document.querySelector('textarea[aria-label="메모 본문"]') as HTMLTextAreaElement).value).toBe("**아직 저장 전**\n- [ ] 확인");
    expect(calls).not.toContain("mobile_save"); expect(calls).not.toContain("mobile_sync");
    await click("메모 목록으로");
    expect(document.querySelector("dialog")?.hasAttribute("open")).toBe(true);
    await click("계속 작성");
    await click("메모 저장");
    expect(window.localStorage.getItem("oximemo.unsaved.v1")).toBeNull();
  });
});


test("a recovered stale snapshot cannot overwrite changed PC source and can be kept as a new note", async () => {
  const original = { key: "old", attempted: false, entry: { path: "old.md", class: "document", title: "원문", deleted: false, broken_document_links: [], missing_assets: [] }, source: { path: "old.md", sha256: "before", content: "before", editable_body: "before", title: "원문", body_profile: "pdc-markdown/1" } };
  window.localStorage.setItem("oximemo.unsaved.v1", JSON.stringify({ version: 1, original, title: "원문", body: "recovered", profile: "pdc-markdown/1" }));
  state.cache.documents = [{ ...original, source: { ...original.source, sha256: "after", content: "after", editable_body: "after" } }];
  await mount(); await click("메모 저장");
  expect(savedKeys).toHaveLength(0);
  expect(state.cache.documents[0].source?.content).toBe("after");
  expect(window.localStorage.getItem("oximemo.unsaved.v1")).toContain("recovered");
  await click("새 메모로 보관"); await click("메모 저장");
  expect(savedKeys).toEqual([null]);
  expect(state.cache.documents.find(d => d.key === "old")?.source?.content).toBe("after");
});

test("following a note link from an unsaved preview keeps the leave guard", async () => {
  state.cache.documents = ["a", "b"].map(key => ({ key, attempted: false, entry: { path: `${key}.md`, class: "document", title: key, deleted: false, broken_document_links: [], missing_assets: [] }, source: { path: `${key}.md`, sha256: key, content: key, editable_body: key, title: key, body_profile: "pdc-markdown/1" } }));
  await mount(); await click("a"); await click("편집");
  await fill('textarea[aria-label="메모 본문"]', "[다른 메모](b.md)\n\n작성 중");
  await click("미리보기"); await click("다른 메모 · 링크");
  expect(document.querySelector("dialog")?.hasAttribute("open")).toBe(true);
  await click("계속 작성"); await click("편집");
  expect((document.querySelector('textarea[aria-label="메모 본문"]') as HTMLTextAreaElement).value).toContain("작성 중");
});
