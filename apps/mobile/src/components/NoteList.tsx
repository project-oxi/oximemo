import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { ChevronDown, CircleAlert, Clock3, FileText, Folder, Inbox, LockKeyhole, Plus, Search, Trash2 } from "lucide-react";
import { titleOf, type Document } from "../types";
import { canEdit, formatOf, previewOf, type LibraryFilter } from "../lib/presentation";

interface Props {
  children?: ReactNode;
  searching: boolean;
  matches: Document[];
  query: string;
  filter: LibraryFilter;
  pending: number;
  total: number;
  folders: string[];
  folder: string;
  loaded: boolean;
  failed: boolean;
  busy: boolean;
  initialScroll: number;
  onScroll: (value: number) => void;
  onFilter: (filter: LibraryFilter) => void;
  onFolder: (folder: string) => void;
  onCreate: () => void;
  onClear: () => void;
  onOpen: (document: Document) => void;
  onRetry: () => void;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  const index = needle ? text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase()) : -1;
  return index < 0 ? text : <>{text.slice(0, index)}<mark>{text.slice(index, index + needle.length)}</mark>{text.slice(index + needle.length)}</>;
}

function NoteRow({ document, query, onOpen, busy }: { document: Document; query: string; onOpen: () => void; busy: boolean }) {
  const id = useId();
  const folder = document.entry?.path.split("/").slice(0, -1).join(" / ");
  const status = document.error ? "확인 필요" : document.attempted && document.pending ? "전송 확인 중" : document.pending ? "전송 대기" : !canEdit(document) ? "읽기 전용" : "";
  const StatusIcon = document.error ? CircleAlert : document.pending ? Clock3 : LockKeyhole;
  const preview = previewOf(document);
  const hit = query.trim() ? preview.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase()) : -1;
  const excerpt = hit > 50 ? `…${preview.slice(hit - 32)}` : preview;
  return <li className="note-row">
    <button className="note-link" aria-label={titleOf(document)} aria-describedby={`${id}-preview ${id}-meta`} disabled={busy} onClick={onOpen}>
      <div className="note-heading"><strong><Highlight text={titleOf(document)} query={query}/></strong></div>
      <p className="note-preview" id={`${id}-preview`}><Highlight text={excerpt} query={query}/></p>
      <div className="note-meta" id={`${id}-meta`}>
        <span className="note-location">{folder || (document.pending?.change.kind === "create" ? "새 메모" : "메모")}{formatOf(document) === "pdc-html/1" && <span className="format-tag">HTML</span>}</span>
        {status && <span className={`note-state ${document.error ? "text-error" : ""}`}><StatusIcon aria-hidden="true" size={12}/>{status}</span>}
      </div>
    </button>
  </li>;
}

export function NoteList(props: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = props.initialScroll; }, [props.query, props.filter, props.folder]);
  const browsing = props.searching && !props.query.trim();
  const matches = browsing ? props.matches.slice(0, 5) : props.matches;
  return <section className="library" aria-label="메모 보관함">
    <div className="scroll-region note-scroll" ref={scrollRef} onScroll={event => props.onScroll(event.currentTarget.scrollTop)}>
    {!props.searching && props.children}
    {browsing && <p className="search-guidance">제목이나 본문의 단어를 입력하세요.</p>}
    {!props.searching && props.filter !== "trash" && <div className="library-tools">
      <div className="library-filter" aria-label="메모 필터">
        <label className="view-picker"><select aria-label="메모 보기" value={props.filter} onChange={event => props.onFilter(event.target.value as LibraryFilter)}><option value="all">모든 메모 ({props.total})</option><option value="drafts">전송 대기{props.pending > 0 ? ` (${props.pending})` : ""}</option></select><ChevronDown aria-hidden="true" size={14}/></label>
        {!!props.folders.length && <label className="folder-picker"><Folder aria-hidden="true" size={15}/><select aria-label="폴더 선택" value={props.folder} onChange={event => props.onFolder(event.target.value)}><option value="">모든 폴더</option>{props.folders.map(folder => <option key={folder} value={folder}>{folder.replaceAll("/", " / ")}</option>)}</select><ChevronDown aria-hidden="true" size={13}/></label>}
      </div>
    </div>}
      {!props.loaded ? props.failed ? <div className="empty-state" role="alert"><CircleAlert aria-hidden="true" size={28}/><h2>메모를 불러오지 못했어요</h2><button className="button secondary" onClick={props.onRetry}>다시 불러오기</button></div> : <div className="note-skeleton" role="status" aria-label="메모를 불러오는 중">{[0, 1, 2, 3].map(index => <div key={index}><span/><span/><span/></div>)}</div> : matches.length ? <>{(props.searching || props.query || props.folder || props.filter !== "all") && <div className="list-caption"><span>{browsing ? "메모 둘러보기" : props.query ? "검색 결과" : props.folder ? props.folder.split("/").pop() : props.filter === "drafts" ? "전송 대기 중인 메모" : "삭제된 메모"}</span><span role="status" aria-live="polite">{matches.length}개</span></div>}<ul className="note-list" aria-label="메모 목록">{matches.map(document => <NoteRow key={document.key} document={document} query={props.query} onOpen={() => props.onOpen(document)} busy={props.busy}/>)}</ul></> : <div className="empty-state">
        {props.query ? <Search aria-hidden="true" size={28}/> : props.filter === "trash" ? <Trash2 aria-hidden="true" size={28}/> : props.filter === "drafts" ? <Inbox aria-hidden="true" size={28}/> : <FileText aria-hidden="true" size={28}/>}
        <h2>{props.query ? "검색 결과가 없어요" : props.filter === "trash" ? "휴지통이 비어 있어요" : props.filter === "drafts" ? "대기 중인 초안이 없어요" : "첫 메모를 남겨 보세요"}</h2>
        <p>{props.query ? "다른 단어나 문장으로 검색해 보세요." : props.filter === "trash" ? "삭제한 메모는 PC에서 복원할 수 있어요." : props.filter === "drafts" ? "저장한 초안은 PC와 동기화할 때 전송돼요." : "생각을 적거나 PC를 연결해\n기존 메모를 가져오세요."}</p>
        {!props.query && props.folder ? <button className="text-button" onClick={props.onClear}>모든 폴더 보기</button> : !props.query && !props.searching && props.filter === "all" && <button className="button primary" onClick={props.onCreate} disabled={props.busy}><Plus aria-hidden="true" size={17}/>새 메모</button>}
      </div>}
    {!props.searching && props.loaded && matches.length > 0 && <p className="library-count">{matches.length}개의 메모</p>}
    </div>
  </section>;
}
