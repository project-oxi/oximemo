import { getMemo, listMemos } from "./api";
import type { MemoSummary } from "./types";
import { readManuscript, type Manuscript } from "./writing";
import { hasFencedWritingNotes } from "./writingComments";
import { WRITING_GLOSSARY_TAG } from "./writingGlossary";

export async function listBookNotes(folder: string): Promise<MemoSummary[]> {
  const notes = new Map<string, MemoSummary>();
  let cursor: string | null = null;
  do {
    const page = await listMemos(cursor, 100, { folder, immediate: true });
    for (const note of page.items) {
      if (note.folder === folder && note.path.endsWith(".md") && !note.tags.includes(WRITING_GLOSSARY_TAG)) {
        notes.set(note.id, note);
      }
    }
    cursor = page.next_cursor;
  } while (cursor);
  return [...notes.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

export async function readBookNotes(ids: readonly string[], folder: string) {
  return Promise.all(ids.map(async (id) => {
    const note = await getMemo(id);
    if (note.deleted_at || note.folder !== folder || note.format !== "markdown" || note.tags.includes(WRITING_GLOSSARY_TAG)) {
      throw new Error("A selected chapter note is no longer available in this folder");
    }
    return { id, title: note.title, manuscript: readManuscript(note.body) };
  }));
}

type BookNote = { id: string; title: string | null; manuscript: Manuscript };

export function assembleBook(notes: readonly BookNote[], fallback: string, opening: string) {
  const chapters = notes.flatMap(({ id, title, manuscript }) => manuscript.chapters.map((chapter, index) => ({
    sourceId: id,
    markdown: chapter.markdown,
    title: chapter.title || (index === 0 && manuscript.chapters.length === 1
      ? manuscript.title || title || fallback : opening),
  })));
  return {
    count: notes.reduce((count, note) => count + note.manuscript.charactersWithSpaces, 0),
    unclosedComment: notes.some(({ manuscript }) => manuscript.unclosedComment),
    fencedWritingNotes: chapters.some(({ markdown }) => hasFencedWritingNotes(markdown)),
    chapters,
  };
}
