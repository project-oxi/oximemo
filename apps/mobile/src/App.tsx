import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronLeft, CircleAlert, LockKeyhole, RefreshCw, Search, Settings as SettingsIcon, SquarePen, X } from "lucide-react";
import { scan, cancel, Format, checkPermissions, requestPermissions } from "@tauri-apps/plugin-barcode-scanner";
import { bodyOf, editorTitle, titleOf, type Document, type View } from "./types";
import { canEdit, filterDocuments, foldersOf, formatOf, type LibraryFilter } from "./lib/presentation";
import { connectionError, type SyncState } from "./lib/connection";
import { useViewport } from "./lib/useViewport";
import { useNavigation } from "./lib/useNavigation";
import { NoteList } from "./components/NoteList";
import { NoteEditor } from "./components/NoteEditor";
import { Connection } from "./components/Connection";
import { LeaveDialog } from "./components/LeaveDialog";
import { Settings } from "./components/Settings";
import { SyncStatus } from "./components/SyncStatus";
import type { Screen } from "./components/BottomNav";

type Notice = { text: string; error?: boolean };
type Route = { screen: Screen; key?: string; query: string; filter: LibraryFilter; folder: string; searching: boolean; scroll: number; connectionReturn: Screen };

export function App() {
  const viewport = useViewport();
  const [view, setView] = useState<View>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [screen, setScreen] = useState<Screen>("notes");
  const [selected, setSelected] = useState<Document | "new">();
  const [editing, setEditing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [connectionReturn, setConnectionReturn] = useState<Screen>("settings");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [profile, setProfile] = useState("pdc-markdown/1");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [folder, setFolder] = useState("");
  const [syncState, setSyncState] = useState<SyncState>({ phase: "idle" });
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [pairEndpoint, setPairEndpoint] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [raw, setRaw] = useState(false);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const busyRef = useRef(false);
  const pendingLeave = useRef<(() => void) | undefined>(undefined);
  const readerPositions = useRef(new Map<string, number>());
  const scrollRef = useRef(0);
  const editorFocusRef = useRef<HTMLTextAreaElement | null>(null);
  const selectedRef = useRef(selected);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const previousRoute = useRef<{ screen: typeof screen; editing: boolean; trash: boolean }>({ screen, editing: false, trash: false });
  selectedRef.current = selected;
  useLayoutEffect(() => {
    if (!selected && (previousRoute.current.editing || previousRoute.current.screen !== screen || previousRoute.current.trash !== (filter === "trash"))) headingRef.current?.focus({ preventScroll: true });
    previousRoute.current = { screen, editing: !!selected, trash: filter === "trash" };
  }, [screen, selected, filter]);

  const reload = async () => {
    const value = await invoke<View>("mobile_state");
    setView(value); setLoadFailed(false);
    return value;
  };
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setNotice(undefined);
    try { await action(); return true; }
    catch (error) {
      setNotice({ text: String(error).replace(/^Error:\s*/, ""), error: true });
      try { await reload(); } catch { /* Keep the last usable snapshot. */ }
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  };
  const syncOnce = async () => {
    setSyncState({ phase: "syncing" });
    try {
      const value = await invoke<View>("mobile_sync");
      setView(value); setSyncState({ phase: "success" });
      return value;
    } catch (error) {
      const message = connectionError(error);
      setSyncState({ phase: "error", error: message });
      throw new Error(message);
    }
  };
  const sync = () => run(async () => { await syncOnce(); });
  useEffect(() => {
    reload().then(value => { setEndpoint(value.endpoint); if (value.paired) void sync(); }).catch(error => {
      setLoadFailed(true); setNotice({ text: String(error).replace(/^Error:\s*/, ""), error: true });
    });
  }, []);
  useEffect(() => {
    const refresh = () => {
      // An open editor keeps its original source/draft snapshot on resume.
      if (!selectedRef.current && !busyRef.current) invoke<View>("mobile_state").then(value => { if (value.paired) void sync(); }).catch(() => {});
    };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("online", refresh); document.removeEventListener("visibilitychange", visible); };
  }, []);

  const navigation = useNavigation<Route>(
    () => ({ screen, key: selected === "new" ? "new" : selected?.key, query, filter, folder, searching, scroll: scrollRef.current, connectionReturn }),
    route => {
      setConnectionReturn(route.connectionReturn); setScreen(route.screen); setQuery(route.query); setFilter(route.filter); setFolder(route.folder);
      scrollRef.current = route.scroll;
      const key = route.key && (view?.key_updates?.[route.key] || route.key);
      const document = key === "new" ? "new" : view?.cache.documents.find(document => document.key === key);
      setSelected(document); setEditing(document === "new"); setRaw(false); setNotice(undefined);
      setSearching(!document && route.searching);
      setTitle(!document || document === "new" ? "" : editorTitle(document));
      setBody(!document || document === "new" ? "" : bodyOf(document));
      setProfile(!document || document === "new" ? "pdc-markdown/1" : formatOf(document));
      if (document || !route.searching) searchRef.current?.blur();
    },
    () => dirty || busyRef.current,
    proceed => { if (!busyRef.current) { pendingLeave.current = proceed; setLeavePrompt(true); } },
  );
  const route = (patch: Partial<Route>): Route => ({ screen, query, filter, folder, searching, scroll: scrollRef.current, connectionReturn, ...patch });
  const open = (document: Document | "new") => navigation.push(route({ screen: "notes", key: document === "new" ? "new" : document.key, searching: false }));
  const current = selected && selected !== "new" ? view?.cache.documents.find(document => document.key === selected.key) || selected : undefined;
  const editable = selected === "new" || !!current && !raw && canEdit(current);
  const dirty = !!selected && (selected === "new" ? !!(title || body) : title !== editorTitle(selected) || body !== bodyOf(selected));
  useEffect(() => {
    // A successful PC create replaces only the temporary draft key. Follow its
    // explicit native mapping without guessing document identity from content.
    if (!selected || selected === "new" || dirty || editing) return;
    const key = view?.key_updates?.[selected.key];
    const synchronized = key && view?.cache.documents.find(document => document.key === key);
    if (synchronized) {
      setSelected(synchronized); setTitle(editorTitle(synchronized)); setBody(bodyOf(synchronized));
    }
  }, [view, selected, dirty, editing]);
  const leave = () => navigation.back();
  const finishLeave = () => { setLeavePrompt(false); const proceed = pendingLeave.current; pendingLeave.current = undefined; proceed?.(); };
  useEffect(() => { navigation.replace(); }, [selected, screen, query, filter, folder, searching]);
  const save = async (exit = false) => {
    let paired = false;
    const saved = await run(async () => {
      if (!editable || !dirty) return;
      const oldKeys = new Set(view?.cache.documents.map(document => document.key));
      const value = await invoke<View>("mobile_save", { key: selected === "new" ? null : current?.key, title, body, profile });
      setView(value); paired = value.paired;
      if (selected === "new") { setFilter("all"); setQuery(""); setFolder(""); scrollRef.current = 0; }
      const savedDocument = value.cache.documents.find(document => selected === "new" ? !oldKeys.has(document.key) && document.pending?.change.title === title && document.pending.change.body === body : document.key === current?.key);
      navigation.replace(route({ key: savedDocument?.key, ...(selected === "new" ? { filter: "all", query: "", folder: "", scroll: 0 } : {}) }));
      setSelected(savedDocument); setEditing(false);
      if (exit) finishLeave();
    });
    if (saved && paired) void sync();
  };
  const resolve = (keep: boolean) => run(async () => {
    if (!current) return;
    setView(await invoke<View>("mobile_resolve", { key: current.key, keep }));
    setSelected(undefined);
    setNotice({ text: keep ? "초안을 새 메모로 보관했어요. 다시 동기화하세요." : "동기화하면 PC 원문을 다시 가져올 수 있어요." });
  });
  const previewPair = async (code: string) => {
    const address = await invoke<string>("mobile_pair_preview", { code });
    setPairCode(code.trim()); setPairEndpoint(address);
  };
  const scanPair = () => run(async () => {
    setScanning(true);
    try {
      let permission = await checkPermissions();
      if (permission !== "granted") permission = await requestPermissions();
      if (permission !== "granted") throw new Error("카메라 권한이 필요해요. 연결 코드를 붙여넣어도 연결할 수 있어요.");
      const result = await scan({ formats: [Format.QRCode], windowed: false });
      await previewPair(result.content);
    } finally { setScanning(false); }
  });
  const connectPair = () => run(async () => {
    const connected = await invoke<View>("mobile_pair", { code: pairCode });
    setView(connected); setEndpoint(connected.endpoint); setPairCode(""); setPairEndpoint(""); setToken("");
    const synced = await syncOnce();
    setScreen("notes");
    setNotice({ text: synced.cache.documents.some(document => document.pending) ? "PC를 연결했어요. 남은 초안의 상태를 확인하세요." : "PC를 연결하고 메모를 가져왔어요." });
  });
  const connectManual = () => run(async () => {
    const value = await invoke<View>("mobile_connect", { endpoint, token });
    setView(value); setEndpoint(value.endpoint); setToken("");
    await syncOnce();
  });

  const documents = view?.cache.documents.filter(document => document.source || document.entry || document.pending) ?? [];
  const matches = filterDocuments(documents, filter, query, folder);
  const pending = documents.filter(document => document.pending && !document.entry?.deleted).length;
  const total = documents.filter(document => !document.entry?.deleted).length;
  const pageTitle = screen === "connection" ? "PC 동기화" : screen === "settings" ? "설정" : filter === "trash" ? "휴지통" : "메모";
  const editorState = busy ? syncState.phase === "syncing" ? "동기화 중…" : "저장 중…" : dirty ? "저장 전" : selected === "new" ? "새 메모" : current?.pending ? "기기에 저장됨" : "";
  const clearSearch = () => { setQuery(""); setFolder(""); scrollRef.current = 0; };
  const navigate = (next: Screen) => navigation.push(route({ screen: next, searching: false }));
  const showConnection = () => navigation.push(route({ screen: "connection", connectionReturn: screen, searching: false }));
  const stopSearch = () => navigation.back();
  const beginSearch = () => { if (!searching) navigation.push(route({ searching: true, scroll: 0 })); };
  const searchField = <div className="library-search"><label className="search-field"><Search size={20} aria-hidden="true"/><input ref={searchRef} type="search" aria-label="메모 검색" placeholder={filter === "trash" ? "휴지통에서 검색" : "메모 검색"} value={query} onFocus={beginSearch} onChange={event => { scrollRef.current = 0; setQuery(event.target.value); }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); stopSearch(); } if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) event.currentTarget.blur(); }} autoComplete="off" enterKeyHint="search"/>{query && <button className="icon-button" aria-label="검색 지우기" onClick={() => { setQuery(""); scrollRef.current = 0; searchRef.current?.focus({ preventScroll: true }); }}><X aria-hidden="true" size={18}/></button>}</label>{searching && <button className="text-button search-cancel" onClick={stopSearch}>취소</button>}</div>;

  return <div className={`app ${selected ? "is-editing" : screen === "notes" ? "is-library" : "is-settings"} ${searching ? "is-searching" : ""} ${selected && notice ? "has-editor-notice" : ""}`} style={viewport} aria-busy={busy} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || !selected || busy || leavePrompt) return;
    if (event.key === "Escape") { event.preventDefault(); leave(); }
    if (event.key.toLowerCase() === "s" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (editable && dirty) void save(); }
  }}>
    <header className={`app-header ${selected ? "editor-header" : screen === "notes" ? "library-header" : "navigation-header"}`}>
      {selected ? <>
        <button className="back-button" aria-label="메모 목록으로" onClick={leave} disabled={busy}><ChevronLeft aria-hidden="true" size={23}/><span>메모</span></button>
        <span className="editor-status" role="status">{editorState}</span>
        <div className={`header-trailing ${!editing && dirty ? "preview-actions" : ""}`}>{editable ? <>{!editing && <button className="text-button" onClick={() => setEditing(true)} disabled={busy}>편집</button>}{(editing || dirty) && <button className="text-button editor-done" aria-label={dirty ? "메모 저장" : "편집 완료"} onClick={() => { if (dirty) void save(); else if (selected === "new") leave(); else setEditing(false); }} disabled={busy}>{busy && <RefreshCw aria-hidden="true" size={16} className="spinning"/>}{dirty ? "저장" : "완료"}</button>}</> : <span className="read-only-label"><LockKeyhole aria-hidden="true" size={14}/>읽기 전용</span>}</div>
      </> : screen !== "notes" || filter === "trash" ? <>
        <button className="back-button" aria-label={screen === "connection" && connectionReturn === "settings" ? "설정으로" : "메모 목록으로"} onClick={() => navigation.back()}><ChevronLeft aria-hidden="true" size={23}/><span>{screen === "connection" && connectionReturn === "settings" ? "설정" : "메모"}</span></button>
        <div className="page-title"><h1 ref={headingRef} tabIndex={-1}>{pageTitle}</h1></div><span className="navigation-spacer"/>
      </> : <><div className="page-title"><h1 ref={headingRef} tabIndex={-1}>메모</h1></div><div className="header-actions"><button className="icon-button" aria-label="설정" onClick={() => navigate("settings")}><SettingsIcon aria-hidden="true" size={22}/></button><button className="button primary header-compose" aria-label="새 메모 작성" onClick={() => open("new")} disabled={busy || !view}><SquarePen aria-hidden="true" size={20}/><span>새 메모</span></button></div></>}
    </header>
    {notice && <div className={`notice ${notice.error ? "notice-error" : ""}`} role={notice.error ? "alert" : "status"}>{notice.error && <CircleAlert aria-hidden="true" size={17}/>}<span>{notice.text}</span><button className="icon-button" aria-label="알림 닫기" onClick={() => setNotice(undefined)}><X aria-hidden="true" size={17}/></button></div>}
    {selected ? <NoteEditor key={selected === "new" ? "new" : selected.key} document={current} isNew={selected === "new"} editing={editing} onEditing={setEditing} title={!editable && current && !dirty ? titleOf(current) : title} body={body} profile={profile} raw={raw} editable={editable} busy={busy} dirty={dirty} onTitle={setTitle} onBody={setBody} onProfile={setProfile} onRaw={setRaw} onRetry={sync} onResolve={keep => void resolve(keep)} initialScroll={readerPositions.current.get(selected === "new" ? "new" : selected.key) || 0} onScroll={value => readerPositions.current.set(selected === "new" ? "new" : selected.key, value)} onFocus={field => { editorFocusRef.current = field; }}/>
    : screen === "notes" ? <>
      {searchField}
      <NoteList searching={searching} matches={matches} query={query} filter={filter} pending={pending} total={total} folders={foldersOf(documents)} folder={folder} loaded={!!view} failed={loadFailed} busy={busy} initialScroll={scrollRef.current} onScroll={value => { scrollRef.current = value; }} onFilter={value => { scrollRef.current = 0; setFilter(value); }} onFolder={value => { scrollRef.current = 0; setFolder(value); }} onCreate={() => open("new")} onClear={clearSearch} onOpen={open} onRetry={() => void run(async () => { await reload(); })}>

        {!!view?.cache.diagnostics.length && <p className="vault-notice"><CircleAlert aria-hidden="true" size={16}/>PC 보관함에 확인할 항목이 {view.cache.diagnostics.length}개 있어요.</p>}
        <SyncStatus view={view} sync={syncState} busy={busy} count={total} onConnection={showConnection} onSync={sync}/>
      </NoteList>
    </> : screen === "settings" ? <Settings view={view} pending={pending} sync={syncState} onConnection={showConnection} onTrash={() => navigation.push(route({ screen: "notes", filter: "trash", query: "", folder: "", searching: false, scroll: 0 }))}/>
    : <Connection view={view} sync={syncState} pending={pending} endpoint={endpoint} token={token} code={pairCode} pairEndpoint={pairEndpoint} scanning={scanning} busy={busy} onEndpoint={setEndpoint} onToken={setToken} onCode={value => { setPairCode(value); setPairEndpoint(""); }} onScan={scanPair} onCancelScan={() => void cancel().catch(() => setNotice({ text: "스캐너 화면의 취소 버튼으로 닫아 주세요.", error: true }))} onPreview={() => void run(() => previewPair(pairCode))} onConnectPair={connectPair} onConnectManual={connectManual} onSync={sync}/>}
    <LeaveDialog open={leavePrompt} busy={busy} onClose={() => { pendingLeave.current = undefined; setLeavePrompt(false); }} onSave={() => void save(true)} onDiscard={finishLeave} returnFocus={() => editorFocusRef.current?.focus({ preventScroll: true })}/>
  </div>;
}
