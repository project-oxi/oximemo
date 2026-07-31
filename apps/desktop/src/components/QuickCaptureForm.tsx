/**
 * 캡처 입력창 셸 (§6.1) — 보더리스 유리 캡슐, 단일 auto-grow 입력,
 * 카테고리 칩은 입력 위, `/` 슬래시 메뉴도 입력 위 부양. 키보드 전용
 * (버튼 없음) — `Enter` 저장 · `Shift+Enter` 줄바꿈 · `Esc` 닫기 ·
 * `/` 카테고리. 하단에 희미한 힌트(`hint` prop, caller가 i18n 합성).
 *
 * 윈도우는 200pt 고정이고 캡슐은 콘텐츠 높이를 따라간다. 슬래시 메뉴는
 * 입력창이 비어있을 때(`!category` && `v === "/"`)만 열리며, 열리는
 * 순간 본문이 비워지므로 menu-open ⟹ 캡슐은 최소 높이(1줄). 5줄로
 * 자란 상태에서는 메뉴가 닫혀 있으므로 두 극단 상태가 동시에 최대로
 * 되지 않아 200pt 안에 들어간다.
 *
 * 카테고리는 `/` 슬래시 메뉴로 선택 — 입력창이 비어있을 때 `/`를
 * 치면 카테고리 드롭다운이 떠오르고, 선택하면 본문 위에 칩으로 표시.
 * 색상은 카테고리에서 파생 (`paperFor(colorForCategory(id, cats))`).
 *
 * 본문은 plain textarea 그대로 유지 — CM6 mount 비용은 캡처 윈도우의
 * 즉시성을 깎는다. 빠른 캡처의 본문은 거의 한 줄이라 시각적 칩 강조의
 * 가치가 작고, 본문 자체를 항상 plain text로 보여주는 편이 빠른 입력에
 * 더 적합. 태그는 `extractTags`로 저장 시 파싱되므로 입력 중 표시 안
 * 해도 무방.
 */
import {
  type Ref,
  type TextareaHTMLAttributes,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { colorForCategory, paperFor } from "../lib/color";
import { createCategory } from "../lib/api";
import type { CategoryDef } from "../lib/types";

const cx = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join(" ");

export interface QuickCaptureFormProps {
  body: string;
  onBodyChange: (v: string) => void;
  bodyRef?: Ref<HTMLTextAreaElement>;
  bodyProps?: Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "value" | "onChange" | "className"
  >;
  bodyClassName?: string;
  category: string;
  onCategoryChange: (v: string) => void;
  categories: CategoryDef[];
  /** Pre-localised keyboard hint rendered faint at the bottom of the
   *  capsule (e.g. `↵ ${t.capture_save} · esc ${t.close}`). The caller
   *  composes i18n so this component stays i18n-free. */
  hint: string;
  className?: string;
}

/**
 * `/` 슬래시 메뉴 — 카테고리 선택 + 신규 생성. 빈 입력창에서만 열리고,
 * 카테고리가 이미 선택된 상태에서는 다시 열리지 않는다.
 */
function SlashCategoryMenu({
  query,
  categories,
  onSelect,
  onCreate,
}: {
  query: string;
  categories: CategoryDef[];
  onSelect: (id: string) => void;
  onCreate: (id: string) => void;
}) {
  const filtered = categories.filter((c) =>
    c.id.includes(query.toLowerCase()),
  );
  const [sel, setSel] = useState(0);
  const isNew = query.length > 0 && !categories.some((c) => c.id === query);

  return (
    <div className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-32 overflow-y-auto rounded-xl bg-white/80 px-1 py-1 shadow-lg ring-1 ring-black/5 backdrop-blur-xl dark:bg-zinc-800/80 dark:ring-white/10">
      {filtered.map((c, i) => (
        <button
          key={c.id}
          className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-zinc-800 dark:text-zinc-100 ${i === sel ? "bg-zinc-900/5 dark:bg-white/10" : ""}`}
          onClick={() => onSelect(c.id)}
          onMouseEnter={() => setSel(i)}
        >
          <span
            className="inline-block h-3 w-3 rounded-full"
            style={{ backgroundColor: c.color }}
          />
          <span className="truncate">{c.id}</span>
          {c.builtin && (
            <span className="ml-auto text-[10px] text-zinc-400">built-in</span>
          )}
        </button>
      ))}
      {isNew && (
        <button
          className={`mt-0.5 flex w-full items-center gap-2 rounded-md border-t border-black/5 px-2.5 py-1.5 text-left text-sm text-purple-600 dark:border-white/10 dark:text-purple-400 ${filtered.length === sel ? "bg-zinc-900/5 dark:bg-white/10" : ""}`}
          onClick={() => onCreate(query)}
          onMouseEnter={() => setSel(filtered.length)}
        >
          <span>✨</span>
          <span className="truncate">'{query}' 만들기</span>
        </button>
      )}
    </div>
  );
}

/** 선택된 카테고리 칩 — 카테고리 색상 배경 + dismiss 버튼. */
function CategoryChip({
  id,
  categories,
  onDismiss,
}: {
  id: string;
  categories: CategoryDef[];
  onDismiss: () => void;
}) {
  const color = colorForCategory(id, categories);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-white"
      style={{ backgroundColor: color }}
    >
      ● {id}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="ml-0.5 text-white/70 hover:text-white"
      >
        ✕
      </button>
    </span>
  );
}

export function QuickCaptureForm({
  body,
  onBodyChange,
  bodyRef,
  bodyProps,
  bodyClassName,
  category,
  onCategoryChange,
  categories,
  hint,
  className,
}: QuickCaptureFormProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  // forward the inner ref to the caller for focus()
  const setRef = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof bodyRef === "function") bodyRef(el);
    else if (bodyRef) bodyRef.current = el;
  };

  // Auto-grow: snap textarea height to its scrollHeight so the card tracks
  // content. The window stays fixed (200pt); dead space above a short card
  // is the transparent window background.
  useLayoutEffect(() => {
    const ta = innerRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [body]);

  const [menuOpen, setMenuOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");

  const handleChange = useCallback(
    (v: string) => {
      if (menuOpen) {
        // 메뉴가 열린 상태에서는 입력값이 곧 검색어.
        setSlashQuery(v);
        if (v === "") {
          setMenuOpen(false);
        }
        onBodyChange(v);
        return;
      }
      if (v === "/" && !category) {
        setMenuOpen(true);
        setSlashQuery("");
        onBodyChange("");
        return;
      }
      onBodyChange(v);
    },
    [category, menuOpen, onBodyChange],
  );

  const handleSlashSelect = useCallback(
    (id: string) => {
      onCategoryChange(id);
      setMenuOpen(false);
      setSlashQuery("");
      // 카테고리 선택 후 필터 텍스트는 본문으로 새지 않도록 비운다 —
      // 메뉴가 열린 동안 입력값이 slashQuery로도 흘렀으므로 본문도 리셋.
      onBodyChange("");
      // 카테고리 선택 후 포커스는 textarea에 남겨둔다 — 사용자가 바로 본문 입력.
      innerRef.current?.focus();
    },
    [onBodyChange, onCategoryChange],
  );

  const handleSlashCreate = useCallback(
    async (id: string) => {
      try {
        const def = await createCategory(id, null);
        onCategoryChange(def.id);
        setMenuOpen(false);
        setSlashQuery("");
        // 신규 생성도 동일 — 메뉴가 떠있는 동안 입력한 검색어 텍스트는 본문이 아님.
        onBodyChange("");
        innerRef.current?.focus();
      } catch {
        // silently fail — category already exists or other transient error
      }
    },
    [onBodyChange, onCategoryChange],
  );

  // 슬래시 메뉴가 떠있을 때 외부 클릭/스크롤 등으로 닫히지 않도록
  // textarea keyDown에서 Escape로 닫기.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (menuOpen && e.key === "Escape") {
        setMenuOpen(false);
        setSlashQuery("");
        e.preventDefault();
        return;
      }
      bodyProps?.onKeyDown?.(e);
    },
    [menuOpen, bodyProps],
  );

  return (
    <div className={cx("flex w-full flex-col", className)}>
      {/* 보더리스 유리 캡슐 (§6.1) — 반투명 블러 + 연한 그림자, 크루마 없음.
          카테고리가 선택되면 paperFor로 카테고리 색조로 톤 다운. */}
      <div
        className={cx(
          "relative rounded-2xl px-3 py-2.5 shadow-[0_8px_32px_-8px_rgba(0,0,0,0.18)] ring-1 ring-black/5 backdrop-blur-xl transition-colors",
          category
            ? "dark:ring-white/10"
            : "bg-white/70 dark:bg-zinc-900/70 dark:ring-white/10",
        )}
        style={
          category
            ? { backgroundColor: paperFor(colorForCategory(category, categories)) }
            : undefined
        }
      >
        {/* 선택된 카테고리 칩 — 입력 위. */}
        {category && (
          <div className="mb-1.5 flex items-center gap-1">
            <CategoryChip
              id={category}
              categories={categories}
              onDismiss={() => onCategoryChange("")}
            />
          </div>
        )}
        {/* 입력 영역 — 슬래시 메뉴는 입력 wrapper 기준 bottom-full로
            캡슐 안에서 입력 바로 위에 부양. 메뉴는 항상 `!category` 상태에서만
            열리므로(아래 handleChange 참조) 칩과 동시 표시되지 않는다. */}
        <div className="relative">
          {menuOpen && (
            <SlashCategoryMenu
              query={slashQuery}
              categories={categories}
              onSelect={handleSlashSelect}
              onCreate={handleSlashCreate}
            />
          )}
          <textarea
            ref={setRef}
            value={body}
            onChange={(e) => handleChange(e.target.value)}
            spellCheck={false}
            rows={1}
            {...bodyProps}
            // Wrapper keydown MUST come after `{...bodyProps}` — later JSX
            // props win, so this overrides the caller's onKeyDown. The wrapper
            // itself calls `bodyProps?.onKeyDown?.(e)` to delegate, which gives
            // us the menu-Escape intercept BEFORE CaptureOverlay's window-close
            // branch fires.
            onKeyDown={handleKeyDown}
            className={cx(
              "block w-full resize-none border-0 bg-transparent p-0 text-[0.9375rem] leading-relaxed text-zinc-800 placeholder:text-zinc-400 focus:outline-none focus:ring-0 dark:text-zinc-100 dark:placeholder:text-zinc-500",
              // 한 줄 시작, ~5줄까지 자동 성장 후 내부 스크롤.
              "min-h-[1.5rem] max-h-[7.5rem] overflow-y-auto",
              bodyClassName,
            )}
          />
        </div>
        {/* 하단 희미한 키보드 힌트 — 캡슐 안, 입력 아래 한 줄. */}
        <div className="mt-1 flex items-center justify-end">
          <span className="font-mono text-[10px] tracking-tight text-zinc-400/70 dark:text-zinc-500/70">
            {hint}
          </span>
        </div>
      </div>
    </div>
  );
}
