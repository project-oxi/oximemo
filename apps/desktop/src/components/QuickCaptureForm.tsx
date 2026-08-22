/**
 * Fast capture shell. A neutral, keyboard-first input keeps the captured
 * thought primary; a selected folder carries its hue only in the compact chip.
 */
import {
  type Ref,
  type TextareaHTMLAttributes,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { TextCtxMenu } from "./TextCtxMenu";

import { useI18n } from "../lib/i18n";
import { Folder, FolderPlus, X } from "lucide-react";

import { colorForFolder } from "../lib/color";
import { createFolder } from "../lib/api";
import type { FolderEntry } from "../lib/types";

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
  folder: string;
  onFolderChange: (v: string) => void;
  folders: FolderEntry[];
  hint: string;
  className?: string;
}

function SlashFolderMenu({
  query,
  filtered,
  isNew,
  sel,
  onSelect,
  onCreate,
}: {
  query: string;
  filtered: FolderEntry[];
  isNew: boolean;
  sel: number;
  onSelect: (path: string) => void;
  onCreate: (path: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-32 overflow-y-auto rounded-xl bg-surface-raised/80 px-1 py-1 shadow-lg ring-1 ring-line backdrop-blur-xl">
      {filtered.map((f, i) => (
        <button
          key={f.path || "root"}
          className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-text ${i === sel ? "bg-surface-muted" : ""}`}
          onClick={() => onSelect(f.path)}
        >
          <Folder size={14} className="shrink-0 text-text-subtle" />
          <span className="truncate">{f.path || t.folder_root}</span>
          <span className="ml-auto text-[10px] text-text-subtle">{f.note_count}</span>
        </button>
      ))}
      {isNew && (
        <button
          className={`mt-0.5 flex w-full items-center gap-2 rounded-md border-t border-line px-2.5 py-1.5 text-left text-sm text-hue-purple ${filtered.length === sel ? "bg-surface-muted" : ""}`}
          onClick={() => onCreate(query)}
        >
          <FolderPlus size={14} />
          <span className="truncate">'{query}' 만들기</span>
        </button>
      )}
    </div>
  );
}

function FolderChip({
  path,
  onDismiss,
}: {
  path: string;
  onDismiss: () => void;
}) {
  const color = colorForFolder(path);
  return (
    <span className="inline-flex items-center gap-1 rounded-[var(--tag-radius)] bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-text">
      {color && (
        <span
          aria-hidden
          className="size-1.5 rounded-[2px]"
          style={{ backgroundColor: color }}
        />
      )}
      {path}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="ml-0.5 text-text-subtle transition-colors duration-150 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        <X size={11} />
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
  folder,
  onFolderChange,
  folders,
  hint,
  className,
}: QuickCaptureFormProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const setRef = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof bodyRef === "function") bodyRef(el);
    else if (bodyRef) bodyRef.current = el;
  };

  useLayoutEffect(() => {
    const ta = innerRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [body]);

  const [menuOpen, setMenuOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [sel, setSel] = useState(0);
  const filtered = useMemo(
    () => folders.filter((f) => f.path !== "" && f.path.toLowerCase().includes(slashQuery.toLowerCase())),
    [folders, slashQuery],
  );
  const isNew =
    slashQuery.length > 0 &&
    !folders.some((f) => f.path === slashQuery);

  const handleChange = useCallback(
    (v: string) => {
      if (menuOpen) {
        setSlashQuery(v);
        setSel(0);
        if (v === "") setMenuOpen(false);
        onBodyChange(v);
        return;
      }
      if (v === "/" && !folder) {
        setMenuOpen(true);
        setSlashQuery("");
        setSel(0);
        onBodyChange("");
        return;
      }
      onBodyChange(v);
    },
    [folder, menuOpen, onBodyChange],
  );

  const handleSlashSelect = useCallback(
    (path: string) => {
      onFolderChange(path);
      setMenuOpen(false);
      setSlashQuery("");
      onBodyChange("");
      innerRef.current?.focus();
    },
    [onBodyChange, onFolderChange],
  );

  const handleSlashCreate = useCallback(
    async (path: string) => {
      try {
        await createFolder(path);
        onFolderChange(path);
        setMenuOpen(false);
        setSlashQuery("");
        onBodyChange("");
        innerRef.current?.focus();
      } catch {
        // silently fail — folder already exists or other transient error
      }
    },
    [onBodyChange, onFolderChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!menuOpen) {
        bodyProps?.onKeyDown?.(e);
        return;
      }
      const count = filtered.length + (isNew ? 1 : 0);
      switch (e.key) {
        case "Escape":
          setMenuOpen(false);
          setSlashQuery("");
          e.preventDefault();
          return;
        case "ArrowDown":
          e.preventDefault();
          setSel((s) => (count === 0 ? 0 : Math.min(s + 1, count - 1)));
          return;
        case "ArrowUp":
          e.preventDefault();
          setSel((s) => Math.max(s - 1, 0));
          return;
        case "Enter":
          e.preventDefault();
          if (sel < filtered.length) handleSlashSelect(filtered[sel].path);
          else if (isNew && sel === filtered.length) void handleSlashCreate(slashQuery);
          return;
        default:
          bodyProps?.onKeyDown?.(e);
      }
    },
    [menuOpen, filtered, isNew, sel, slashQuery, handleSlashSelect, handleSlashCreate, bodyProps],
  );

  return (
    <div className={cx("flex w-full flex-col", className)}>
      <div className="relative rounded-[var(--popover-radius)] bg-surface-raised px-3 py-2.5 shadow-[var(--input-shadow)] transition-shadow duration-150 focus-within:shadow-[var(--input-shadow-focus)]">
        {folder && (
          <div className="mb-1.5 flex items-center gap-1">
            <FolderChip path={folder} onDismiss={() => onFolderChange("")} />
          </div>
        )}
        <div className="relative">
          {menuOpen && (
            <SlashFolderMenu
              query={slashQuery}
              filtered={filtered}
              isNew={isNew}
              sel={sel}
              onSelect={handleSlashSelect}
              onCreate={handleSlashCreate}
            />
          )}
          <TextCtxMenu
            render={
              <textarea
                ref={setRef}
                onChange={(e) => handleChange(e.target.value)}
                spellCheck={false}
                rows={1}
                {...bodyProps}
                onKeyDown={handleKeyDown}
                className={cx(
                  "block w-full resize-none border-0 bg-transparent p-0 text-[0.9375rem] leading-relaxed text-text placeholder:text-text-subtle focus:outline-none",
                  "min-h-[1.5rem] max-h-[7.5rem] overflow-y-auto",
                  bodyClassName,
                )}
              />
            }
          />
        </div>
        <div className="mt-1 flex items-center justify-end">
          <span className="font-mono text-[10px] tracking-tight text-text-subtle">
            {hint}
          </span>
        </div>
      </div>
    </div>
  );
}