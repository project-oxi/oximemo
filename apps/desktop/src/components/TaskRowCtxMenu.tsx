/**
 * TaskRowCtxMenu — 할 일 패널 행의 우클릭 메뉴(설계 CONTEXT-MENUS §3.1).
 * 최소 유지 철학: 삭제 항목 없음 — 삭제는 할 일 베이스 뷰 소유.
 */
import { ClipboardCopy, FileText, Square, SquareCheck } from "lucide-react";

import { useI18n } from "../lib/i18n";

import { CtxMenu, CtxItem, CtxSeparator } from "./ContextMenu";

interface Props {
  done: boolean;
  text: string;
  onOpen: () => void;
  onToggle: () => void;
}

export function TaskRowCtxMenu({ done, text, onOpen, onToggle }: Props) {
  const { t } = useI18n();
  return (
    <CtxMenu>
      <CtxItem icon={FileText} label={t.task_menu_open} onClick={onOpen} />
      <CtxItem
        icon={done ? Square : SquareCheck}
        label={done ? t.task_menu_undone : t.task_menu_done}
        onClick={onToggle}
      />
      <CtxSeparator />
      <CtxItem
        icon={ClipboardCopy}
        label={t.task_menu_copy_text}
        onClick={() => {
          void navigator.clipboard.writeText(text);
        }}
      />
    </CtxMenu>
  );
}
