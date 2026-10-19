import type { Document, View } from "../src/types";

const scenario = new URLSearchParams(location.search).get("case") || "populated";
// Browser-only accessibility fixtures; never imported by the native build.
const qaParams = new URLSearchParams(location.search);
const textScale = Number(qaParams.get("scale") || 1);
if (textScale >= .8 && textScale <= 2) document.documentElement.style.fontSize = `${17 * textScale}px`;
if (["light", "dark"].includes(qaParams.get("theme") || "")) document.documentElement.dataset.theme = qaParams.get("theme")!;
const entry = (key: string, title: string, body: string, profile = "pdc-markdown/1"): Document => ({
  key,
  attempted: false,
  entry: { path: `notes/${key}.${profile === "pdc-html/1" ? "html" : "md"}`, class: "document", title, deleted: false, broken_document_links: [], missing_assets: [] },
  source: { path: `notes/${key}.md`, content: body, editable_body: body, title, body_profile: profile, sha256: "ui-fixture-source-digest", document_id: key },
});
const docs: Document[] = [
  entry("reading", "이번 주에 읽고 싶은 것들", "# 이번 주에 읽고 싶은 것들\n\n읽다가 멈춘 책을 다시 펼쳤다. 기억에 남는 문장과 다음에 읽을 책을 여기 모아 둔다.\n\n- 책 한 권을 끝까지 읽기\n- 좋았던 문장은 내 말로 다시 적기"),
  { key: "draft", attempted: false, pending: { operation_id: "fixture-draft", change: { kind: "create", title: "산책하면서 떠오른 생각", body: "돌아오는 길에 생각난 작은 아이디어. 잊기 전에 적어 두기.", body_profile: "pdc-markdown/1" } } },
  entry("project", "프로젝트를 시작하기 전에", "## 확인할 것\n\n어떤 문제를 해결하려는지 한 문장으로 적는다. 해야 할 일보다 하지 않아도 되는 일을 먼저 줄인다.\n\n- [ ] 지금 필요한 범위 정하기\n- [ ] 작은 결과부터 확인하기"),
  entry("html", "공간을 기록하는 방법", "<article><h1>공간을 기록하는 방법</h1><p>작업하는 공간의 배치와 빛을 기록합니다.</p><section>창가의 책상과 오후의 햇빛.</section></article>", "pdc-html/1"),
  { ...entry("legacy", "예전에 적어 둔 메모", "# 예전에 적어 둔 메모\n\n이 문서는 원문 그대로 보관합니다. [[연결된 메모]]\n%% 보존할 주석 %%"), entry: { path: "archive/예전 메모.md", title: "예전에 적어 둔 메모", class: "legacy_markdown", deleted: false, broken_document_links: [], missing_assets: [] }, source: { path: "archive/예전 메모.md", content: "# 예전에 적어 둔 메모\n\n[[연결된 메모]]\n%% 보존할 주석 %%", sha256: "legacy-fixture" } },
  { ...entry("conflict", "PC에서 함께 편집한 메모", "이 원문은 PC에서 바뀌었습니다."), attempted: true, error: "rejected: PC에서 원문이 바뀌었습니다. 초안은 기기에 보관되어 있습니다.", pending: { operation_id: "fixture-conflict", change: { kind: "update", document_id: "conflict", expected_sha256: "fixture-original", title: "PC에서 함께 편집한 메모", body: "내가 작성한 초안은 그대로 보관합니다." } } },
  entry("long-title", "제목이 아주 긴 메모도 작은 화면에서 다른 버튼을 밀어내지 않고 끝까지 읽을 수 있어야 한다", "긴 제목과 폴더 이름을 확인하는 UI 테스트용 메모입니다. 본문은 두 줄 안에서 편안하게 읽히도록 합니다."),
];
const deleted = entry("deleted", "잠시 보관해 둔 메모", "휴지통의 원문입니다.");
deleted.entry!.deleted = true;
docs.push(deleted);
let state: View = {
  endpoint: ["paired", "connected", "sync-error"].includes(scenario) ? "https://garden-mac.tail123.ts.net" : "",
  paired: ["paired", "connected", "sync-error"].includes(scenario),
  cache: { documents: scenario === "empty" ? [] : scenario === "connected" ? docs.filter(document => document.key !== "conflict") : docs, last_sync: String(Math.floor(Date.now() / 1000) - 600), diagnostics: [], vault_id: "ui-fixture-vault" },
};
let serial = 0;

export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (scenario === "load-error" && command === "mobile_state") throw new Error("기기에 저장된 메모를 불러오지 못했습니다.");
  if (command === "mobile_pair_preview") {
    if (!String(args.code).startsWith("OM1:")) throw new Error("연결 코드를 확인해 주세요.");
    return "https://garden-mac.tail123.ts.net" as T;
  }
  if (command === "mobile_pair" || command === "mobile_connect") {
    state.paired = true;
    state.endpoint = String(args.endpoint || "https://garden-mac.tail123.ts.net");
  }
  if (command === "mobile_save") {
    await new Promise(resolve => setTimeout(resolve, scenario === "slow" ? 1500 : 100));
    const key = String(args.key || `local-${++serial}`);
    const old = state.cache.documents.find(d => d.key === key);
    const change = { kind: "create" as const, title: String(args.title), body: String(args.body), body_profile: String(args.profile) };
    const saved = { ...old, key, attempted: false, pending: { operation_id: `save-${serial}`, change } };
    state.cache.documents = [saved, ...state.cache.documents.filter(d => d.key !== key)];
  }
  if (command === "mobile_resolve") state.cache.documents = state.cache.documents.filter(d => d.key !== args.key);
  if (command === "mobile_sync") {
    if (!state.paired) throw new Error("먼저 PC를 연결해 주세요.");
    if (scenario === "sync-error") throw new Error("error sending request for url: connection refused");
    state.cache.documents = state.cache.documents.map(document => {
      if (!document.pending || document.error) return document;
      const change = document.pending.change;
      const synchronized = entry(document.key, change.title, change.body, change.kind === "create" ? change.body_profile : "pdc-markdown/1");
      return synchronized;
    });
    state.cache.last_sync = String(Math.floor(Date.now() / 1000));
  }
  return structuredClone(state) as T;
}
