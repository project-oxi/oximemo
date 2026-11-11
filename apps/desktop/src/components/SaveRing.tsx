/**
 * Save ring (2026-11-11 «SaveRing», 시안 「메모 시트 C」).
 *
 * 저장 상태를 꼬리 줄 오른쪽 끝 글자에서 시트 머리 맨 왼쪽 고리로 옮겼다 — 쓰는 눈길 안에 있다.
 * 모양은 공통 FillRing: 빈 = 바뀜 · 반 = 저장 중 · 꽉 = 저장됨 · 점선 = 저장 문제(충돌 포함).
 * 충돌 알림 박스는 MemoDetail 이 그대로 연다. 고리는 상태만 말한다.
 *
 * 「저장 중…」 글자는 저장이 0.8초를 넘길 때만 붙인다. 자동 저장은 대개 순간에 끝나서
 * 매번 글자를 깜박이면 쓰는 사람의 눈을 끈다.
 */
import { useEffect, useState } from "react";

import { useI18n } from "../lib/i18n";

import { FillRing, type FillState } from "./shapes";

import "./MarginLinks.css";

/** 2026.11.11 : 이 시간보다 오래 걸리는 저장만 글자로 알린다. */
const SAVING_TEXT_DELAY_MS = 800;

export function SaveRing({ dirty, saving, blocked }: { dirty: boolean; saving: boolean; blocked: boolean }) {
  const { t } = useI18n();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!saving) {
      setSlow(false);
      return;
    }
    const id = window.setTimeout(() => setSlow(true), SAVING_TEXT_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [saving]);

  const state: FillState = blocked ? "held" : saving ? "partial" : dirty ? "open" : "full";
  const label = blocked ? t.dock_unsaved : saving ? t.dock_saving : dirty ? t.dock_pending : t.dock_saved;

  return (
    <span className="save-ring" title={label}>
      <FillRing state={state} label={label} size={9} />
      {saving && slow && <span aria-hidden>{t.dock_saving}</span>}
    </span>
  );
}
