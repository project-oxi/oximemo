/**
 * useFolderCreate — 낙관적 폴더 생성 흐름의 공용 부분(CardGrid 빈 영역 메뉴와
 * 사이드바 배경 메뉴가 공유): "새 폴더" 자동 접미 결정 → create_folder IPC →
 * 쿼리 무효화. 성공 시 확정 경로, 실패 시 null을 돌려준다. 인라인 이름 바꾸기
 * 세션(namingPath)은 호출자 소유 — CardGrid만 해당(설계 CONTEXT-MENUS §3.1).
 */
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { createFolder } from "./api";
import { useI18n } from "./i18n";
import { useUI } from "../stores/ui";

export function useFolderCreate() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setError = useUI((s) => s.setError);

  return useCallback(
    (loc: string, existingPaths: string[]) => {
      // Auto-suffix "새 폴더" → "새 폴더 2" → "새 폴더 3" when the base
      // name is already taken. The backend create_folder now rejects
      // duplicates with an authoritative error (vault.rs create_folder
      // existence guard), so this client-side guard avoids a round-trip
      // and a visible toast for the common case. Falls back to the
      // backend error if the loop somehow misses.
      const taken = new Set(existingPaths);
      let def = loc ? `${loc}/${t.folder_new}` : t.folder_new;
      let n = 2;
      while (taken.has(def)) {
        const candidate = loc ? `${loc}/${t.folder_new} ${n}` : `${t.folder_new} ${n}`;
        if (!taken.has(candidate)) {
          def = candidate;
          break;
        }
        n += 1;
        if (n > 999) {
          setError(t.folder_name_invalid);
          return Promise.resolve(null);
        }
      }
      return createFolder(def)
        .then(() => {
          void qc.invalidateQueries({ queryKey: ["folderChildren"] });
          void qc.invalidateQueries({ queryKey: ["folders"] });
          return def;
        })
        .catch((e) => {
          setError(String(e).split("\n")[0]);
          return null;
        });
    },
    [t.folder_new, t.folder_name_invalid, qc, setError],
  );
}
