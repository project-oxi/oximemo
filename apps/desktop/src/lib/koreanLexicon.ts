import { isTauri } from "@tauri-apps/api/core";
import { invoke } from "./tauri";

export const writingLexiconTiers = {
  small: { words: 20_056, storageMb: 6, downloadMb: 100 },
  medium: { words: 60_000, storageMb: 18, downloadMb: 140 },
  large: { words: 200_000, storageMb: 60, downloadMb: 335 },
} as const;

export type WritingLexiconTier = keyof typeof writingLexiconTiers;

export interface RelatedWords {
  headword: string;
  words: string[];
}

export const writingLexiconQuery = {
  queryKey: ["writing-lexicon"] as const,
  queryFn: () => isTauri() ? invoke<WritingLexiconTier | null>("writing_lexicon_installed") : Promise.resolve(null),
  staleTime: Infinity,
};

export async function changeWritingLexicon(tier: WritingLexiconTier | null): Promise<void> {
  if (tier) {
    await invoke<void>("install_writing_lexicon", { tier });
  } else {
    await invoke<void>("remove_writing_lexicon");
  }
}

export function lookupKoreanWord(word: string): Promise<RelatedWords | null> {
  return invoke<RelatedWords | null>("lookup_writing_lexicon", { word });
}
