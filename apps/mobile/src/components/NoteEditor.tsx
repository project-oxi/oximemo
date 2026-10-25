import { useLayoutEffect, useRef } from "react";
import { ChevronDown, Eye, FileCode2, LockKeyhole } from "lucide-react";
import { titleOf, type Document } from "../types";
import { canPreviewMarkdown } from "../lib/presentation";
import { MarkdownPreview } from "./MarkdownPreview";
import type { NavDirection } from "../lib/useNavigation";

interface Props {
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
    if (props.editing && !previousEditing.current && props.editable) bodyRef.current?.focus({ preventScroll: true });
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
      {writing && <div className="note-toolbar">{props.isNew ? <label className="writing-format"><select aria-label="메모 형식" value={props.profile} onChange={event => props.onProfile(event.target.value)} disabled={props.busy}><option value="pdc-markdown/1">Markdown</option><option value="pdc-html/1">HTML 원문</option></select><ChevronDown aria-hidden="true" size={13}/></label> : <span>{markdown ? "Markdown" : "HTML 원문"}</span>}{markdown && <button className="text-button" onClick={() => props.onEditing(false)}><Eye aria-hidden="true" size={17}/>미리보기</button>}</div>}
      {markdown && !props.editable && <div className="source-switch reading-switch"><button aria-pressed={!props.editing} onClick={() => props.onEditing(false)}>읽기</button><button aria-pressed={props.editing} onClick={() => props.onEditing(true)}>마크다운 원문</button></div>}
      {!props.raw && !writing && props.profile === "pdc-html/1" && <p className="source-format-hint">HTML 원문 읽기</p>}
      {preview ? <MarkdownPreview body={props.body} title={displayTitle}/> : <textarea ref={bodyRef} rows={8} className={`note-body-input ${props.raw || props.profile === "pdc-html/1" ? "source-text" : ""}`} aria-label={props.raw ? "파일 원문" : "메모 본문"} placeholder="메모를 적어 보세요." value={value} onChange={event => props.onBody(event.target.value)} onFocus={event => props.onFocus(event.currentTarget)} readOnly={!props.editable || !props.editing || props.busy} spellCheck={!props.raw && props.profile === "pdc-markdown/1"}/>}
      {hasDetails && !writing && <details className="document-details"><summary><FileCode2 aria-hidden="true" size={15}/>문서 정보<ChevronDown aria-hidden="true" size={15}/></summary><div className="document-details-content">
        {props.isNew ? <label className="format-picker"><span>메모 형식</span><select aria-label="메모 형식" value={props.profile} onChange={event => props.onProfile(event.target.value)} disabled={props.busy}><option value="pdc-markdown/1">Markdown</option><option value="pdc-html/1">HTML 원문</option></select><ChevronDown aria-hidden="true" size={14}/></label> : doc?.source && <div className="source-switch" aria-label="본문 표시"><button aria-pressed={!props.raw} disabled={props.dirty || props.busy} onClick={() => props.onRaw(false)}>본문</button><button aria-pressed={props.raw} disabled={props.dirty || props.busy} onClick={() => props.onRaw(true)}>파일 원문</button></div>}
        {doc?.entry && <><p className="file-path">{doc.entry.path}</p>{doc.entry.diagnostic && <p>{doc.entry.diagnostic.code}: {doc.entry.diagnostic.message}</p>}{!!(doc.entry.broken_document_links.length || doc.entry.missing_assets.length) && <p>연결되지 않은 링크 {doc.entry.broken_document_links.length}개 · 누락된 첨부 {doc.entry.missing_assets.length}개</p>}</>}
      </div></details>}
    </div>
  </main>;
}
