import { Dialog } from "@base-ui-components/react";
import { Button, GPanel, Input, SegmentedControl } from "@garden/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, BookOpen, ChevronRight, Download, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useI18n } from "../lib/i18n";
import { lookupKoreanWord, writingLexiconQuery, type RelatedWords } from "../lib/koreanLexicon";
import { renderPreviewMarkdown } from "../lib/markdownPreview";
import type { Manuscript, WritingProfile } from "../lib/writing";
import { assembleBook, listBookNotes, readBookNotes } from "../lib/writingBook";
import { useUI } from "../stores/ui";
import { createWritingGlossary, findWritingGlossary, writingGlossaryEntries, writingGlossaryHeading, writingGlossaryKey } from "../lib/writingGlossary";

type GlossaryContext = {
  noteId: string | null;
  folder: string;
  open: (id: string, heading?: string) => void;
};

function ProjectGlossary({ context, word }: { context: GlossaryContext; word: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { folder, noteId, open } = context;
  const glossary = useQuery({
    queryKey: writingGlossaryKey(folder),
    queryFn: () => findWritingGlossary(folder),
  });
  const note = glossary.data;
  const entries = useMemo(() => note ? writingGlossaryEntries(note.body) : [], [note]);
  const query = word.normalize("NFC").trim().toLocaleLowerCase();
  const matches = entries.filter((entry) => entry.word.normalize("NFC").toLocaleLowerCase().includes(query)).slice(0, 8);
  const inherited = note && note.folder !== folder;
  const create = useMutation({
    mutationFn: (term: string) => createWritingGlossary(folder, t.writing_glossary, t.writing_glossary_source_hint, term),
    onSuccess: (memo, term) => {
      qc.setQueryData(["memo", memo.id], memo);
      void qc.invalidateQueries({ queryKey: ["memos"] });
      if (useUI.getState().selectedId === noteId) open(memo.id, writingGlossaryHeading(term) || undefined);
    },
  });

  return (
    <section className="space-y-2">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium">{t.writing_glossary}</h3>
          <p title={note?.folder ?? folder} className="truncate text-[11px] text-text-subtle">{note?.folder ?? folder}</p>
        </div>
        {note && <Button size="sm" variant="ghost" onClick={() => open(note.id)}>{t.writing_glossary_edit}</Button>}
      </header>
      {glossary.isPending ? (
        <p className="text-text-subtle">{t.word_lookup_loading}</p>
      ) : glossary.isError ? (
        <p role="alert" className="text-text-muted">{t.writing_glossary_error}</p>
      ) : note ? (
        <>
          {matches.length ? (
            <ul className="divide-y divide-line">
              {matches.map((entry, index) => (
                <li key={`${entry.word}:${index}`}>
                  <button
                    type="button"
                    className="w-full rounded-md px-1 py-1.5 text-left hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring"
                    onClick={() => open(note.id, entry.heading)}
                  >
                    <span className="block font-medium">{entry.word}</span>
                    {entry.definition && <span className="line-clamp-2 block break-words text-text-muted">{entry.definition}</span>}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-text-subtle">{query ? t.writing_glossary_no_match : t.writing_glossary_source_hint}</p>
          )}
        </>
      ) : null}
      {!glossary.isPending && !glossary.isError && (!note || inherited) && (
        <Button size="sm" variant="secondary" disabled={create.isPending} onClick={() => create.mutate(word)}>
          <Plus size={14} aria-hidden />{inherited ? t.writing_glossary_create_here : t.writing_glossary_create}
        </Button>
      )}
      {create.isError && <p role="alert" className="text-text-muted">{t.writing_glossary_create_error}</p>}
    </section>
  );
}

export function WordLookupPanel({ initialWord, onClose, glossary }: {
  initialWord: string;
  onClose: () => void;
  glossary?: GlossaryContext;
}) {
  const { t } = useI18n();
  const installed = useQuery(writingLexiconQuery);
  const [word, setWord] = useState(initialWord);
  const [attempt, setAttempt] = useState(0);
  const [lookup, setLookup] = useState<{ input: string; tier: string; result: RelatedWords | null; failed?: boolean }>();
  useEffect(() => {
    const tier = installed.data;
    if (!tier || !word.trim()) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const result = await lookupKoreanWord(word);
        if (active) setLookup({ input: word, tier, result });
      } catch {
        if (active) setLookup({ input: word, tier, result: null, failed: true });
      }
    }, 160);
    return () => { active = false; window.clearTimeout(timer); };
  }, [installed.data, word, attempt]);

  const current = word.trim() && lookup?.input === word && lookup?.tier === installed.data ? lookup : null;
  return (
    <GPanel title={t.word_lookup} closeLabel={t.close} onClose={onClose} className="writing-inspector">
      <div className="space-y-3 text-xs">
        {(glossary || installed.data) && (
          <Input
            autoFocus
            aria-label={t.word_lookup_input}
            placeholder={t.word_lookup_placeholder}
            value={word}
            maxLength={40}
            onChange={(event) => setWord(event.target.value)}
          />
        )}
        {glossary && <ProjectGlossary key={glossary.folder} context={glossary} word={word} />}
        <section className={glossary ? "space-y-2 border-t border-line pt-3" : "space-y-2"}>
          {installed.isPending ? (
            <p className="text-text-subtle">{t.word_lookup_loading}</p>
          ) : installed.isError ? (
            <p role="alert" className="text-text-muted">{t.word_lookup_error}</p>
          ) : !installed.data ? (
            <>
              <p className="text-text-muted">{t.word_lookup_setup}</p>
              <Button size="sm" variant="secondary" onClick={() => {
                onClose();
                const ui = useUI.getState();
                ui.setSettingsTab("writing");
                ui.setSettingsOpen(true);
              }}>{t.settings}</Button>
            </>
          ) : word.trim() && (
            current?.failed ? (
              <>
                <p role="alert" className="text-text-muted">{t.word_lookup_error}</p>
                <Button size="sm" variant="secondary" onClick={() => { setLookup(undefined); setAttempt(attempt + 1); }}>{t.word_lookup_retry}</Button>
              </>
            ) : !current ? (
              <p className="text-text-subtle">{t.word_lookup_loading}</p>
            ) : current.result?.words.length ? (
              <>
                <h3 className="font-medium">
                  {current.result.headword === word.trim()
                    ? t.word_lookup_related
                    : t.word_lookup_query.replace("{word}", current.result.headword)}
                </h3>
                <ul className="flex flex-wrap gap-1.5">
                  {current.result.words.map((related) => (
                    <li key={related}><Button size="sm" variant="secondary" onClick={() => setWord(related)}>{related}</Button></li>
                  ))}
                </ul>
                <p className="text-text-subtle">{t.word_lookup_note}</p>
              </>
            ) : (
              <p className="text-text-muted">{t.word_lookup_empty}</p>
            )
          )}
        </section>
      </div>
    </GPanel>
  );
}

export function WordLookupDialog({ open, onClose, glossary }: {
  open: boolean;
  onClose: () => void;
  glossary?: GlossaryContext;
}) {
  const { t } = useI18n();
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="memo-backdrop fixed inset-0 z-50" />
        <Dialog.Popup className="word-lookup-dialog">
          <Dialog.Title className="sr-only">{t.word_lookup}</Dialog.Title>
          <WordLookupPanel initialWord="" onClose={onClose} glossary={glossary} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type Tab = "review" | "outline" | "book";
type PlanningAction = { kind: "character"; name: string } | { kind: "scenario" };

interface WritingPanelProps {
  profile: WritingProfile;
  manuscript: Manuscript;
  updating: boolean;
  title: string;
  noteId: string;
  folder: string;
  storedTags: string[];
  onClearStoredTags?: () => void;
  onClose: () => void;
  onJump: (line: number) => void;
  onInsert: (action: PlanningAction) => boolean;
  onCopilot?: (task: "review" | "scenario") => void;
}

export function WritingPanel({ profile, manuscript, updating, title, noteId, folder, storedTags, onClearStoredTags, onClose, onJump, onInsert, onCopilot }: WritingPanelProps) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<Tab>("review");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [noteOrder, setNoteOrder] = useState([noteId]);
  const [customTitle, setCustomTitle] = useState<string | null>(null);
  const [exportState, setExportState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const isStory = profile === "fiction" || profile === "screenplay";
  const { chapters, characters, scenario } = manuscript;
  const currentTitle = manuscript.title || title;
  const bookTitle = customTitle ?? (noteOrder.length === 1 && noteOrder[0] === noteId ? currentTitle : folder.split("/").at(-1) || currentTitle);
  const candidates = useQuery({
    queryKey: ["memos", "writing-book", folder],
    queryFn: () => listBookNotes(folder),
    enabled: tab === "book" && !!folder,
  });
  const otherIds = useMemo(() => noteOrder.filter((id) => id !== noteId).sort(), [noteOrder, noteId]);
  const sources = useQuery({
    queryKey: ["memos", "writing-book-sources", folder, otherIds],
    queryFn: () => readBookNotes(otherIds, folder),
    enabled: tab === "book" && otherIds.length > 0,
  });
  const current = useMemo(() => ({ id: noteId, title: currentTitle, manuscript }), [noteId, currentTitle, manuscript]);
  const makeBook = (otherNotes: Awaited<ReturnType<typeof readBookNotes>>) => {
    const byId = new Map([current, ...otherNotes].map((note) => [note.id, note]));
    return assembleBook(noteOrder.flatMap((id) => byId.get(id) ?? []), t.empty_memo, t.writing_opening);
  };
  const book = makeBook(sources.data ?? []);
  const bookReady = !otherIds.length || (sources.isSuccess && !sources.isFetching);
  const count = book.count;
  const previewChapter = bookReady ? book.chapters[Math.min(previewIndex, book.chapters.length - 1)] : undefined;
  const previewHtml = useMemo(() => preview && previewChapter
    ? renderPreviewMarkdown(previewChapter.markdown, 4_000) : "", [preview, previewChapter]);
  const number = new Intl.NumberFormat(locale);
  const pageMin = Math.ceil(count / 600);
  const pageMax = Math.ceil(count / 400);
  const pages = pageMin === pageMax ? number.format(pageMax) : `${number.format(pageMin)}–${number.format(pageMax)}`;
  const canEditBook = exportState !== "saving";
  const candidatesById = new Map(candidates.data?.map((note) => [note.id, note]));
  const noteLabel = (id: string) => {
    if (id === noteId) return currentTitle;
    const note = candidatesById.get(id);
    return note?.title || note?.path.split("/").at(-1) || sources.data?.find((source) => source.id === id)?.title || t.empty_memo;
  };

  const changeOrder = (order: string[]) => {
    setNoteOrder(order);
    setPreviewIndex(0);
    setExportState("idle");
  };

  const moveBookNote = (index: number, direction: -1 | 1) => {
    const next = [...noteOrder];
    const other = index + direction;
    [next[index], next[other]] = [next[other], next[index]];
    changeOrder(next);
  };

  const exportBook = async () => {
    setExportState("saving");
    try {
      const { saveEpub } = await import("../lib/writingEpub");
      const publication = makeBook(await readBookNotes(otherIds, folder));
      if (publication.unclosedComment || publication.fencedWritingNotes || !publication.count || !publication.chapters.length) {
        setExportState("error");
        return;
      }
      const saved = await saveEpub(bookTitle, publication.chapters, /[가-힣]/u.test(bookTitle)
        || publication.chapters.some(({ title, markdown }) => /[가-힣]/u.test(title + markdown)) ? "ko" : "en");
      setExportState(saved ? "saved" : "idle");
    } catch {
      setExportState("error");
    }
  };

  const addCharacter = (event: FormEvent) => {
    event.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    if (onInsert({ kind: "character", name: clean })) setName("");
  };

  return (
    <GPanel title={t[`writing_${profile}`]} closeLabel={t.close} onClose={onClose} className="writing-inspector">
      <div className="space-y-4 text-xs">
        <SegmentedControl<Tab>
          aria-label={t.writing_tools}
          value={tab}
          onValueChange={setTab}
          options={[
            { value: "review", label: t.writing_review },
            { value: "outline", label: t.writing_outline },
            { value: "book", label: t.writing_book },
          ]}
        />
        {tab === "review" && (
          <div className="space-y-3">
            <p className="text-text-muted">{t[`writing_guide_${profile}`]}</p>
            {storedTags.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-1 border-b border-line pb-2">
                <span className="break-words text-text-subtle">{storedTags.map((tag) => `#${tag}`).join(" ")}</span>
                <Button size="sm" variant="ghost" disabled={!onClearStoredTags} onClick={onClearStoredTags}>{t.writing_clear_stored_tags}</Button>
              </div>
            )}
            {manuscript.unclosedComment && <p className="text-text-muted">{t.writing_unclosed_comment}</p>}
            {onCopilot ? (
              <div className="space-y-1">
                <p className="leading-relaxed text-text-muted">{t.writing_review_ai_hint}</p>
                <Button size="sm" variant="secondary" onClick={() => onCopilot("review")}>{t.writing_copilot_review}</Button>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="leading-relaxed text-text-muted">{t.writing_review_setup}</p>
                <Button size="sm" variant="secondary" onClick={() => {
                  onClose();
                  const ui = useUI.getState();
                  ui.setSettingsTab("copilot");
                  ui.setSettingsOpen(true);
                }}>{t.settings}</Button>
              </div>
            )}
          </div>
        )}
        {tab === "outline" && (
          <>
            <section className="space-y-2">
              <h3 className="font-medium">{profile === "fiction" ? t.writing_chapters : t.writing_sections}</h3>
              {chapters.some((chapter) => chapter.title) ? (
                <ol className="space-y-0.5">
                  {chapters.map((chapter) => (
                    <li key={chapter.line}>
                      <Button variant="ghost" size="sm" className="h-auto w-full justify-between px-1 text-left" disabled={updating} onClick={() => onJump(chapter.line)}>
                        <span className="min-w-0 truncate">{chapter.title || t.writing_opening}</span><ChevronRight size={12} aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ol>
              ) : <p className="text-text-subtle">{t.writing_no_chapters}</p>}
            </section>
            {isStory && (
              <>
                <section className="space-y-2 border-t border-line pt-3">
                  <h3 className="font-medium">{t.writing_characters}</h3>
                  {characters.map((card) => (
                    <div key={card.line} className="space-y-1">
                      <Button variant="ghost" size="sm" className="h-auto w-full justify-between px-1 text-left" disabled={updating} onClick={() => onJump(card.line)}>
                        <span className="min-w-0 truncate">{card.name}</span><ChevronRight size={12} aria-hidden />
                      </Button>
                      {card.details && <p className="whitespace-pre-wrap break-words px-1 text-text-muted">{card.details}</p>}
                    </div>
                  ))}
                  <form onSubmit={addCharacter} className="flex items-center gap-1">
                    <Input aria-label={t.writing_character_name} placeholder={t.writing_character_name} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
                    <Button size="icon" variant="secondary" type="submit" aria-label={t.writing_character_add} title={t.writing_character_add} disabled={!name.trim()}><Plus size={14} aria-hidden /></Button>
                  </form>
                </section>
                <section className="flex flex-wrap gap-2 border-t border-line pt-3">
                  <Button size="sm" variant="secondary" disabled={updating} onClick={() => scenario ? onJump(scenario.line) : onInsert({ kind: "scenario" })}>
                    {scenario ? t.writing_scenario : t.writing_scenario_add}
                  </Button>
                  {onCopilot && <Button size="sm" variant="secondary" onClick={() => onCopilot("scenario")}>{t.writing_copilot_scenario}</Button>}
                </section>
              </>
            )}
          </>
        )}
        {tab === "book" && (
          <>
            {folder && (
              <section className="space-y-2 border-b border-line pb-3">
                <h3 className="font-medium">{t.writing_book_order}</h3>
                <Input aria-label={t.writing_book_title} placeholder={t.writing_book_title} value={bookTitle} disabled={!canEditBook}
                  onChange={(event) => { setCustomTitle(event.target.value); setExportState("idle"); }} />
                <ol className="divide-y divide-line">
                  {noteOrder.map((id, index) => {
                    const label = noteLabel(id);
                    return (
                      <li key={id} className="flex min-w-0 items-center gap-1 py-1">
                        <span className="shrink-0 tabular-nums text-text-subtle">{index + 1}</span>
                        <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
                        <Button size="icon" variant="ghost" disabled={!canEditBook || index === 0}
                          aria-label={t.writing_book_move_up.replace("{title}", label)} onClick={() => moveBookNote(index, -1)}><ArrowUp size={13} aria-hidden /></Button>
                        <Button size="icon" variant="ghost" disabled={!canEditBook || index === noteOrder.length - 1}
                          aria-label={t.writing_book_move_down.replace("{title}", label)} onClick={() => moveBookNote(index, 1)}><ArrowDown size={13} aria-hidden /></Button>
                        <Button size="icon" variant="ghost" disabled={!canEditBook}
                          aria-label={t.writing_book_remove.replace("{title}", label)} onClick={() => changeOrder(noteOrder.filter((candidate) => candidate !== id))}><X size={13} aria-hidden /></Button>
                      </li>
                    );
                  })}
                </ol>
                <select className="w-full rounded-md border border-line bg-surface px-2 py-1" aria-label={t.writing_book_add}
                  value="" disabled={!canEditBook || candidates.isPending}
                  onChange={(event) => { if (event.target.value) changeOrder([...noteOrder, event.target.value]); }}>
                  <option value="">{t.writing_book_add}</option>
                  {!noteOrder.includes(noteId) && <option value={noteId}>{currentTitle}</option>}
                  {candidates.data?.filter((note) => note.id !== noteId && !noteOrder.includes(note.id))
                    .map((note) => <option key={note.id} value={note.id}>{noteLabel(note.id)}</option>)}
                </select>
                {candidates.isError && <p role="alert" className="text-text-muted">{t.writing_book_list_error}</p>}
              </section>
            )}
            {bookReady && <div className="space-y-1 border-b border-line pb-3">
              <p className="text-sm font-semibold tabular-nums">{t.writing_total_characters.replace("{n}", number.format(count))}</p>
              <p className="text-text-muted">{t.writing_manuscript_pages.replace("{n}", number.format(Math.ceil(count / 200)))}</p>
              <p className="text-text-muted">{t.writing_book_pages.replace("{n}", pages)}</p>
              <p className="pt-1 leading-relaxed text-text-subtle">{t.writing_page_basis}</p>
            </div>}
            {otherIds.length > 0 && (sources.isError
              ? <p role="alert" className="text-text-muted">{t.writing_book_read_error}</p>
              : !bookReady && <p role="status" className="text-text-subtle">{t.writing_book_loading}</p>)}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={!bookReady || !book.chapters.length} aria-expanded={preview} onClick={() => setPreview(!preview)}><BookOpen size={14} aria-hidden />{t.writing_book_preview}</Button>
              <Button size="sm" disabled={!bookReady || !count || !book.chapters.length || (noteOrder.includes(noteId) && updating) || book.unclosedComment || book.fencedWritingNotes || !canEditBook} onClick={() => void exportBook()}><Download size={14} aria-hidden />{exportState === "saving" ? t.writing_epub_saving : t.writing_epub}</Button>
            </div>
            <p className="text-text-subtle">{t.writing_book_scope}</p>
            {book.unclosedComment && <p className="text-text-muted">{t.writing_unclosed_comment}</p>}
            {book.fencedWritingNotes && <p className="text-text-muted">{t.writing_book_fenced_notes}</p>}
            {exportState === "error" && <p role="alert" className="text-text-muted">{t.writing_epub_error}</p>}
            {exportState === "saved" && <p role="status" className="text-text-muted">{t.writing_epub_saved}</p>}
            {preview && previewChapter && (
              <div className="space-y-2">
                {book.chapters.length > 1 && (
                  <select className="w-full rounded-md border border-line bg-surface px-2 py-1" aria-label={t.writing_chapters} value={Math.min(previewIndex, book.chapters.length - 1)} onChange={(event) => setPreviewIndex(Number(event.target.value))}>
                    {book.chapters.map((chapter, index) => <option key={index} value={index}>{chapter.title}</option>)}
                  </select>
                )}
                <article className="writing-book-preview">
                  <h3>{previewChapter.title || bookTitle}</h3>
                  <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
                </article>
              </div>
            )}
          </>
        )}
      </div>
    </GPanel>
  );
}
