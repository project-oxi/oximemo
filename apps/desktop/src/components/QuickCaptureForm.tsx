/**
 * 캡처 입력창 형태 — 본문은 메시지 버블 안에 auto-grow textarea,
 * 그 아래에 Enter 저장 액션이 한 줄로 모인다. 윈도우는 200pt 고정이고
 * 카드만 콘텐츠 높이를 따라가며, 짧은 카드 위의 빈 공간은 투명한
 * 윈도우 배경으로 보이지 않는다.
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
import { Check } from "lucide-react";

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
  /** Primary action — "save" in CaptureOverlay. */
  onConfirm: () => void;
  confirmLabel: string;
  confirmDisabled?: boolean;
  /** Keyboard hint rendered inside the confirm button (e.g. "↵"). */
  confirmKbd?: string;
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
    <div className="absolute bottom-full left-0 z-50 mb-1 w-48 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
      {filtered.map((c, i) => (
        <button
          key={c.id}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${i === sel ? "bg-zinc-100 dark:bg-zinc-700" : ""}`}
          onClick={() => onSelect(c.id)}
          onMouseEnter={() => setSel(i)}
        >
          <span
            className="inline-block h-3 w-3 rounded-full"
            style={{ backgroundColor: c.color }}
          />
          <span>{c.id}</span>
          {c.builtin && (
            <span className="ml-auto text-[10px] text-zinc-400">built-in</span>
          )}
        </button>
      ))}
      {isNew && (
        <button
          className={`flex w-full items-center gap-2 border-t border-zinc-100 px-3 py-1.5 text-left text-sm text-purple-600 dark:border-zinc-700 dark:text-purple-400 ${filtered.length === sel ? "bg-zinc-100 dark:bg-zinc-700" : ""}`}
          onClick={() => onCreate(query)}
          onMouseEnter={() => setSel(filtered.length)}
        >
          ✨ '{query}' 만들기
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
  onConfirm,
  confirmLabel,
  confirmDisabled,
  confirmKbd,
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
    <div className={cx("flex w-full flex-col gap-2", className)}>
      {/* 메시지 버블 — 카테고리가 선택되면 paper tint로 동일 색조. */}
      <div
        className={cx(
          "relative rounded-2xl border px-3 pb-2 pt-1 shadow-sm backdrop-blur transition-colors",
          category
            ? "border-black/5"
            : "border-zinc-200/80 bg-white/70 dark:border-zinc-700/80 dark:bg-zinc-800/70",
        )}
        style={
          category
            ? { backgroundColor: paperFor(colorForCategory(category, categories)) }
            : undefined
        }
      >
        {category && (
          <div className="mb-1 flex items-center gap-1">
            <CategoryChip
              id={category}
              categories={categories}
              onDismiss={() => onCategoryChange("")}
            />
          </div>
        )}
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
            "block w-full resize-none border-0 bg-transparent p-0 text-sm leading-relaxed text-zinc-800 placeholder:text-zinc-400 focus:outline-none focus:ring-0 dark:text-zinc-100 dark:placeholder:text-zinc-500",
            // 한 줄 기본, max 8줄. 그 이상은 내부 스크롤로 흡수.
            "min-h-[1.625rem] max-h-[13rem] overflow-y-auto",
            bodyClassName,
          )}
        />
      </div>

      {/* 액션 행 — Enter 저장. 카테고리는 `/` 슬래시 메뉴로 선택하므로
          컬러 스왓치는 제거. 한 줄로 압축. */}
      <div className="flex items-center justify-end gap-2 px-1">
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirmDisabled}
          aria-label={confirmLabel}
          title={confirmLabel}
          className="group ml-auto inline-flex h-7 items-center gap-1.5 rounded-md bg-zinc-900 px-2 text-white shadow-sm transition-all hover:bg-zinc-800 active:scale-95 disabled:pointer-events-none disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          <Check
            size={14}
            strokeWidth={2.5}
            className="transition-transform group-hover:scale-110"
          />
          {confirmKbd && (
            <kbd className="font-mono text-[10px] leading-none text-white/60 dark:text-zinc-500">
              {confirmKbd}
            </kbd>
          )}
        </button>
      </div>
    </div>
  );
}
