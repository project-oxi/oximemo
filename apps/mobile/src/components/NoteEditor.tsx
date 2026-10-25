import { useLayoutEffect, useRef, useState } from "react";
import { Bold, CheckSquare, ChevronDown, Eye, FileCode2, Heading2, Italic, List, LockKeyhole, Quote, Redo2, Undo2 } from "lucide-react";
import { titleOf, type Document } from "../types";
import { canPreviewMarkdown } from "../lib/presentation";
import { continueList, formatBody, preserveInput, type Edit, type Format } from "../lib/editing";
import { MarkdownPreview } from "./MarkdownPreview";
import type { NavDirection } from "../lib/useNavigation";

interface Props {
  onLink?: (reference: string) => Promise<void>;
  initialScroll: number;
  motion?: NavDirection;
  onScroll: (value: number) => void;
  document?: Document;
  isNew: boolean;
  editing: boolean;
  onEditing: (value: boolean) => void;
  title: string;
  body: string;
  profile: string;
  raw: boolean;
  editable: boolean;
  busy: boolean;
  dirty: boolean;
  onTitle: (value: string) => void;
  onBody: (value: string) => void;
  onProfile: (value: string) => void;
  onRaw: (value: boolean) => void;
  onRetry: () => void;
  onResolve: (keep: boolean) => void;
  onFocus: (field: HTMLTextAreaElement) => void;
}

export function NoteEditor(props: Props) {
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const selection = useRef({ start: 0, end: 0, scroll: 0 });
  const pendingSelection = useRef<Edit | undefined>(undefined);
  const composing = useRef(false);
  const history = useRef<Edit[]>([{ body: props.body, start: 0, end: 0 }]);
  const historyIndex = useRef(0);
  const lastInput = useRef({ time: 0, typing: false });
  const [, refreshHistory] = useState(0);
  const rememberSelection = () => {
    const field = bodyRef.current;
    if (field) selection.current = { start: field.selectionStart, end: field.selectionEnd, scroll: field.scrollTop };
  };
  const changeBody = (edit: Edit, typing = false) => {
    if (props.busy || !props.editable) return;
    const now = Date.now();
    const coalesce = typing && lastInput.current.typing && now - lastInput.current.time < 750 && historyIndex.current > 0;
    const entries = history.current.slice(0, historyIndex.current + 1);
    if (coalesce) entries[entries.length - 1] = edit;
    else entries.push(edit);
    // Bound temporary undo memory; canonical source remains in the native cache.
    let size = entries.reduce((sum, item) => sum + item.body.length, 0);
    while (entries.length > 2 && (entries.length > 80 || size > 8 * 1024 * 1024)) size -= entries.shift()!.body.length;
    history.current = entries; historyIndex.current = entries.length - 1;
    lastInput.current = { time: now, typing };
    selection.current = { ...selection.current, start: edit.start, end: edit.end };
    if (!typing) pendingSelection.current = edit;
    props.onBody(edit.body); refreshHistory(value => value + 1);
  };
  const travelHistory = (direction: number) => {
    if (props.busy || !props.editable || composing.current) return;
    const index = historyIndex.current + direction;
    const edit = history.current[index];
    if (!edit) return;
    historyIndex.current = index; lastInput.current.typing = false;
    pendingSelection.current = edit;
    props.onBody(edit.body); refreshHistory(value => value + 1);
  };
  const applyFormat = (format: Format) => {
    if (composing.current) return;
    if (document.activeElement === bodyRef.current) rememberSelection();
    const { start, end } = selection.current;
    // Record the pre-command caret for Undo, including selections made by touch.
    history.current[historyIndex.current] = { body: props.body, start, end };
    changeBody(formatBody(props.body, start, end, format));
  };
  useLayoutEffect(() => {
    const edit = pendingSelection.current;
    if (!edit || !bodyRef.current) return;
    bodyRef.current.focus({ preventScroll: true });
    bodyRef.current.setSelectionRange(edit.start, edit.end);
    pendingSelection.current = undefined;
  });
  const markdown = !props.raw && props.profile === "pdc-markdown/1" && canPreviewMarkdown(props.document);
  const preview = markdown && !props.editing;
  const writing = props.editing && props.editable;
  const value = props.raw ? props.document?.source?.content || "" : props.body;
  const displayTitle = props.title || (props.document ? titleOf(props.document) : "제목 없음");
  useLayoutEffect(() => {
    const input = titleRef.current;
    if (input) { input.style.height = "auto"; input.style.height = `${input.scrollHeight}px`; }
    const body = bodyRef.current;
    if (body) {
      if (writing) {
        body.style.height = "";
        // Keep an appended line in the textarea's own scrollport. Asking the
        // outer WebView to reveal it can move the navigation off the screen.
        if (document.activeElement === body && body.selectionEnd === body.value.length && body.selectionStart === body.selectionEnd) body.scrollTop = body.scrollHeight;
      }
      else { body.style.height = "auto"; body.style.height = `${body.scrollHeight}px`; }
    }
  }); // Also remeasure when the visible viewport or wrapped line width changes.
  useLayoutEffect(() => { if (props.isNew) titleRef.current?.focus({ preventScroll: true }); else mainRef.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => { if (!writing && mainRef.current) mainRef.current.scrollTop = props.initialScroll; }, []);
  const previousEditing = useRef(props.editing);
  useLayoutEffect(() => {
    if (props.editing && !previousEditing.current && props.editable && bodyRef.current) {
      const field = bodyRef.current;
      field.focus({ preventScroll: true });
      field.setSelectionRange(selection.current.start, selection.current.end);
      field.scrollTop = selection.current.scroll;
    }
    if (!props.editing && previousEditing.current) mainRef.current?.focus({ preventScroll: true });
    previousEditing.current = props.editing;
  }, [props.editing, props.editable]);
  const doc = props.document;
  const hasDetails = props.isNew || !!doc?.entry || !!doc?.source;
  return <main className={`scroll-region editor-scroll route-enter ${props.motion === "push" ? "route-push" : props.motion === "pop" ? "route-pop" : ""} ${writing ? "is-writing" : ""}`} ref={mainRef} onScroll={event => { if (!writing) props.onScroll(event.currentTarget.scrollTop); }} tabIndex={-1} aria-label={writing ? "메모 편집" : "메모 읽기"}>
    <div className="editor-page">
      {doc?.pending && doc.attempted && <aside className="editor-callout"><LockKeyhole aria-hidden="true" size={17}/><div><p>전송 결과를 확인할 때까지 편집이 잠겨 있어요.</p>{!doc.error && <button className="text-button" onClick={props.onRetry} disabled={props.busy}>전송 결과 확인</button>}</div></aside>}
      {doc?.error && <aside className="editor-callout error-callout" role="alert"><div><p>{doc.error.replace(/^rejected: /, "")}</p>{doc.error.startsWith("rejected:") ? <div className="recovery-actions"><button className="button secondary" onClick={() => props.onResolve(true)} disabled={props.busy}>초안을 새 메모로 보관</button><button className="text-button" onClick={() => props.onResolve(false)} disabled={props.busy}>PC 원문 사용</button></div> : <button className="text-button" onClick={props.onRetry} disabled={props.busy}>전송 결과 다시 확인</button>}</div></aside>}
      {!props.editable && !doc?.attempted && <p className="read-only-hint"><LockKeyhole aria-hidden="true" size={14}/>{props.raw ? "파일 원문은 읽기 전용이에요." : preview ? "이 메모는 읽기 전용이에요." : "이 메모의 원문을 읽기 전용으로 표시해요."}</p>}
      {props.editing && props.editable ? <textarea ref={titleRef} rows={1} className="note-title-input" aria-label="메모 제목" placeholder="제목" value={props.title} onChange={event => props.onTitle(event.target.value)} onFocus={event => props.onFocus(event.currentTarget)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); bodyRef.current?.focus(); } }} readOnly={props.busy} enterKeyHint="next"/> : <h1 className="note-reading-title">{displayTitle}</h1>}
      {writing && <div className="note-toolbar">{props.isNew ? <label className="writing-format"><select aria-label="메모 형식" value={props.profile} onChange={event => props.onProfile(event.target.value)} disabled={props.busy}><option value="pdc-markdown/1">일반 메모</option><option value="pdc-html/1">HTML 원문</option></select><ChevronDown aria-hidden="true" size={13}/></label> : <span>{markdown ? "본문" : "HTML 원문"}</span>}{markdown && <button className="text-button" onClick={() => { rememberSelection(); lastInput.current.typing = false; props.onEditing(false); }}><Eye aria-hidden="true" size={17}/>미리보기</button>}</div>}
      {markdown && !props.editable && <div className="source-switch reading-switch"><button aria-pressed={!props.editing} onClick={() => props.onEditing(false)}>읽기</button><button aria-pressed={props.editing} onClick={() => props.onEditing(true)}>마크다운 원문</button></div>}
      {!props.raw && !writing && props.profile === "pdc-html/1" && <p className="source-format-hint">HTML 원문 읽기</p>}
      {preview ? <MarkdownPreview body={props.body} title={displayTitle} documentKey={props.document?.key} onLink={props.onLink}/> : <textarea ref={bodyRef} rows={8} className={`note-body-input ${props.raw || props.profile === "pdc-html/1" ? "source-text" : ""}`} aria-label={props.raw ? "파일 원문" : "메모 본문"} placeholder="메모를 적어 보세요." value={value} onSelect={rememberSelection} onBlur={rememberSelection}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; lastInput.current.typing = false; }}
        onChange={event => changeBody({ body: preserveInput(props.body, event.target.value), start: event.target.selectionStart, end: event.target.selectionEnd }, true)}
        onKeyDown={event => {
          if (!writing || props.busy || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          const key = event.key.toLowerCase();
          if ((event.metaKey || event.ctrlKey) && key === "z") { event.preventDefault(); travelHistory(event.shiftKey ? 1 : -1); return; }
          if (markdown && (event.metaKey || event.ctrlKey) && (key === "b" || key === "i")) { event.preventDefault(); rememberSelection(); applyFormat(key === "b" ? "bold" : "italic"); return; }
          if (markdown && event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
            const field = event.currentTarget;
            const edit = continueList(props.body, field.selectionStart, field.selectionEnd);
            if (edit) { event.preventDefault(); rememberSelection(); history.current[historyIndex.current] = { body: props.body, start: field.selectionStart, end: field.selectionEnd }; changeBody(edit); }
          }
        }}
        onFocus={event => props.onFocus(event.currentTarget)} readOnly={!props.editable || !props.editing || props.busy} spellCheck={!props.raw && props.profile === "pdc-markdown/1"}/>}
      {writing && <div className="writing-tools" role="group" aria-label="본문 편집 도구">
        <div className="writing-history">
          <button type="button" aria-label="본문 실행 취소" title="실행 취소" disabled={props.busy || historyIndex.current === 0} onPointerDown={event => event.preventDefault()} onClick={() => travelHistory(-1)}><Undo2 size={19}/></button>
          <button type="button" aria-label="본문 다시 실행" title="다시 실행" disabled={props.busy || historyIndex.current >= history.current.length - 1} onPointerDown={event => event.preventDefault()} onClick={() => travelHistory(1)}><Redo2 size={19}/></button>
        </div>
        {markdown && <div className="writing-formats" role="group" aria-label="서식">
          {([{ format: "checklist", label: "체크리스트", Icon: CheckSquare }, { format: "bold", label: "굵게", Icon: Bold }, { format: "bullet", label: "글머리 목록", Icon: List }, { format: "heading", label: "소제목", Icon: Heading2 }, { format: "italic", label: "기울임", Icon: Italic }, { format: "quote", label: "인용", Icon: Quote }] as const).map(({format, label, Icon}) => <button type="button" key={format} aria-label={label} title={label} disabled={props.busy} onPointerDown={event => event.preventDefault()} onClick={() => applyFormat(format)}><Icon size={19}/></button>)}
        </div>}
      </div>}
      {hasDetails && !writing && <details className="document-details"><summary><FileCode2 aria-hidden="true" size={15}/>문서 정보<ChevronDown aria-hidden="true" size={15}/></summary><div className="document-details-content">
        {props.isNew ? <label className="format-picker"><span>메모 형식</span><select aria-label="메모 형식" value={props.profile} onChange={event => props.onProfile(event.target.value)} disabled={props.busy}><option value="pdc-markdown/1">일반 메모</option><option value="pdc-html/1">HTML 원문</option></select><ChevronDown aria-hidden="true" size={14}/></label> : doc?.source && <div className="source-switch" aria-label="본문 표시"><button aria-pressed={!props.raw} disabled={props.dirty || props.busy} onClick={() => props.onRaw(false)}>본문</button><button aria-pressed={props.raw} disabled={props.dirty || props.busy} onClick={() => props.onRaw(true)}>파일 원문</button></div>}
        {doc?.entry && <><p className="file-path">{doc.entry.path}</p>{doc.entry.diagnostic && <p>{doc.entry.diagnostic.code}: {doc.entry.diagnostic.message}</p>}{!!(doc.entry.broken_document_links.length || doc.entry.missing_assets.length) && <p>연결되지 않은 링크 {doc.entry.broken_document_links.length}개 · 누락된 첨부 {doc.entry.missing_assets.length}개</p>}</>}
      </div></details>}
    </div>
  </main>;
}
