// Korean strings. Source-of-truth dictionary: every locale must define the
// same keys with string values. `en.ts` derives from this via
// `Record<keyof typeof dict, string>` so missing keys are a compile error.
export const dict = {
  app_title: "oxinot",
  search_placeholder: "검색",
  empty_hint: "아직 메모가 없어요. 캡처를 시작해 보세요.",
  new_note: "새 메모",
  capture_placeholder: "생각을 적어보세요…",
  capture_save: "저장",
  capture_cancel: "취소",
  pinned: "고정",
  color: "색상",
  language: "언어",
  theme_system: "시스템",
  theme_light: "라이트",
  theme_dark: "다크",
  locale_ko: "한국어",
  locale_en: "English",
  settings: "설정",
  theme: "테마",
  capture_shortcut: "캡처 단축키",
  vault: "볼트",
  copy: "복사",
  copied: "복사됨",
  reindex: "인덱스 재구성",
  reindexing: "재구성 중…",
  reindex_done: "인덱스 재구성 완료",
  doctor: "볼트 점검",
  checking: "점검 중…",
  vault_ok: "볼트 상태 정상",
  vault_issues: "문제 발견",
  note_count: "메모 {n}개",
  pinned_count: "고정 {n}개",
  empty_cta: "첫 메모 작성",
  copy_failed: "복사 실패",
} as const satisfies Record<string, string>;

export type DictKey = keyof typeof dict;
