/**
 * Per-collection provider keys (user prompt 2026-08-24): the metadata
 * provider rows + region select that used to live in the standalone
 * 연동 → 메타데이터 pane, embedded directly into the collections
 * pane's book/movie expand areas — each collection owns its own
 * settings. Keys auto-save on commit (Enter/blur); the `[metadata]`
 * config struct and IPC are unchanged.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, EyeOff } from "lucide-react";

import { getConfig, setMetadataConfig, type MetadataConfig } from "../lib/api";
import type { I18nContextValue } from "../lib/i18n";
import { useI18n } from "../lib/i18n";
import { effectiveRegion } from "../lib/metadataRegion";
import type { Config } from "../lib/types";

interface ProviderDisplay {
  id: string;
  domain: "book" | "movie";
  name: string;
  access: "keyless" | "conditional" | "keyed" | "approval";
  recommended: string[];
}

const PROVIDERS: ProviderDisplay[] = [
  { id: "open_library", domain: "book", name: "Open Library", access: "keyless", recommended: ["", "KR", "JP", "DE"] },
  { id: "google_books", domain: "book", name: "Google Books", access: "keyed", recommended: ["", "JP", "DE"] },
  { id: "aladin", domain: "book", name: "알라딘", access: "keyed", recommended: ["KR"] },
  { id: "ndl_search", domain: "book", name: "NDL Search", access: "conditional", recommended: ["JP"] },
  { id: "dnb_sru", domain: "book", name: "DNB SRU", access: "keyless", recommended: ["DE"] },
  { id: "tmdb", domain: "movie", name: "TMDB", access: "keyed", recommended: ["", "KR", "JP", "DE"] },
  { id: "omdb", domain: "movie", name: "OMDb", access: "keyed", recommended: [] },
  { id: "kmdb", domain: "movie", name: "KMDB", access: "approval", recommended: ["KR"] },
];

type KeyField = "google_books_key" | "aladin_key" | "tmdb_key" | "omdb_key" | "kmdb_key";
const KEY_FIELD: Record<string, KeyField> = {
  google_books: "google_books_key",
  aladin: "aladin_key",
  tmdb: "tmdb_key",
  omdb: "omdb_key",
  kmdb: "kmdb_key",
};

function ProviderBadge({
  access,
  t,
}: {
  access: ProviderDisplay["access"];
  t: I18nContextValue["t"];
}) {
  if (access === "keyless") {
    return <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] text-text-subtle">{t.metadata_provider_keyless}</span>;
  }
  if (access === "conditional") {
    return <span className="rounded-full bg-status-warning-subtle px-1.5 py-0.5 text-[10px] text-status-warning">{t.metadata_provider_conditional}</span>;
  }
  if (access === "approval") {
    return <span className="rounded-full bg-status-warning-subtle px-1.5 py-0.5 text-[10px] text-status-warning">{t.metadata_provider_approval}</span>;
  }
  return (
    <span className="rounded-full bg-status-warning-subtle px-1.5 py-0.5 text-[10px] text-status-warning">{t.metadata_provider_keyed}</span>
  );
}

/**
 * The shared `[metadata]` section patcher: merge a partial update into
 * the live config and persist. Reads the query cache at call time so
 * concurrent edits (book row + movie row) never clobber each other.
 */
function useMetadataSaver() {
  const qc = useQueryClient();
  const { t } = useI18n();
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (patch: Partial<MetadataConfig>) => {
    try {
      const cfg = await qc.fetchQuery({
        queryKey: ["config"],
        queryFn: getConfig,
        staleTime: 0,
      });
      // Config-side metadata fields are optional (types.ts mirror of
      // serde defaults); the write IPC wants the full struct.
      const cur = cfg.metadata;
      await setMetadataConfig({
        enabled: cur?.enabled ?? true,
        region: cur?.region ?? "",
        google_books_key: cur?.google_books_key ?? "",
        aladin_key: cur?.aladin_key ?? "",
        tmdb_key: cur?.tmdb_key ?? "",
        omdb_key: cur?.omdb_key ?? "",
        kmdb_key: cur?.kmdb_key ?? "",
        ...patch,
      });
      await qc.invalidateQueries({ queryKey: ["config"] });
      setError(null);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1600);
    } catch (e) {
      setError(String(e).split("\n")[0]);
    }
  };
  return { save, savedFlash, error, savedLabel: t.metadata_key_saved };
}

/**
 * Region select for provider priority — shared field, shown inside both
 * the book and movie expand areas (writing one updates both on the next
 * render via the config query).
 */
export function MetadataRegionSelect() {
  const { t } = useI18n();
  const cfg = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const { save } = useMetadataSaver();
  const stored = cfg.data?.metadata?.region ?? "";
  const region = effectiveRegion(stored);
  const detectedLabel =
    region === "KR" ? t.metadata_region_kr
      : region === "JP" ? t.metadata_region_jp
        : region === "DE" ? t.metadata_region_de
          : null;
  const autoLabel = detectedLabel
    ? `${t.metadata_region_auto} · ${detectedLabel}`
    : t.metadata_region_auto;
  return (
    <div>
      <p className="mb-1 text-[11px] text-text-subtle">{t.metadata_region}</p>
      <select
        value={stored}
        onChange={(e) => void save({ region: e.target.value })}
        className="w-full rounded-md bg-surface-sunken px-2.5 py-1.5 text-xs text-text outline-none focus:ring-1 focus:ring-line"
      >
        <option value="">{autoLabel}</option>
        <option value="KR">{t.metadata_region_kr}</option>
        <option value="JP">{t.metadata_region_jp}</option>
        <option value="DE">{t.metadata_region_de}</option>
        <option value="US">{t.metadata_region_other}</option>
      </select>
    </div>
  );
}

/**
 * One domain's provider list: recommended-first ordering, key inputs
 * with reveal toggle, keyless providers as status-only rows. Keys save
 * on Enter/blur — no save button.
 */
export function ProviderKeys({ domain }: { domain: "book" | "movie" }) {
  const { t } = useI18n();
  const cfg = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const { save, savedFlash, error, savedLabel } = useMetadataSaver();
  const region = effectiveRegion(cfg.data?.metadata?.region ?? "");
  const providers = PROVIDERS.filter((p) => p.domain === domain).sort(
    (a, b) => Number(b.recommended.includes(region)) - Number(a.recommended.includes(region)),
  );

  return (
    <div className="space-y-1.5">
      {providers.map((p) => (
        <ProviderRow key={p.id} p={p} metadata={cfg.data?.metadata} save={save} region={region} t={t} />
      ))}
      <p className="flex h-4 items-center gap-1 text-[10px] text-status-success">
        {savedFlash && (
          <>
            <Check size={11} aria-hidden /> {savedLabel}
          </>
        )}
        {error && <span className="text-status-error">{error}</span>}
      </p>
    </div>
  );
}

function ProviderRow({
  p,
  metadata,
  save,
  region,
  t,
}: {
  p: ProviderDisplay;
  metadata: Config["metadata"];
  save: (patch: Partial<MetadataConfig>) => Promise<void>;
  region: string;
  t: I18nContextValue["t"];
}) {
  const [reveal, setReveal] = useState(false);
  const field = KEY_FIELD[p.id];
  const stored = field ? (metadata?.[field] ?? "") : "";
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [stored]); // external updates (other row)
  const hasKey = stored.trim() !== "";
  const keyed = p.access === "keyed" || p.access === "approval";
  const commit = () => {
    if (draft !== stored && field) void save({ [field]: draft });
  };
  return (
    <div className="rounded-lg border border-line bg-surface-sunken px-2.5 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[11px] font-medium text-text">
          {p.id === "aladin" ? t.metadata_provider_aladin : p.name}
        </span>
        {p.recommended.includes(region) && (
          <span className="shrink-0 rounded-full bg-interactive-primary-subtle px-1.5 py-0.5 text-[10px] text-interactive-primary">
            {t.metadata_provider_recommended}
          </span>
        )}
        <span className="ml-auto shrink-0">
          {keyed && hasKey ? (
            <span className="rounded-full bg-status-success-subtle px-1.5 py-0.5 text-[10px] text-status-success">
              {t.metadata_key_configured}
            </span>
          ) : (
            <ProviderBadge access={p.access} t={t} />
          )}
        </span>
      </div>
      {keyed && (
        <div className="mt-1 flex gap-1">
          <input
            type={reveal ? "text" : "password"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            placeholder={t.metadata_key_placeholder}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[10px] text-text outline-none placeholder:font-sans placeholder:text-text-subtle focus:ring-1 focus:ring-line"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? t.metadata_key_hide : t.metadata_key_show}
            className="shrink-0 rounded-md border border-line bg-surface px-1.5 text-text-subtle transition-colors hover:bg-surface-muted hover:text-text"
          >
            {reveal ? <EyeOff size={11} /> : <Eye size={11} />}
          </button>
        </div>
      )}
      {p.access === "conditional" && (
        <p className="mt-1 text-[10px] leading-snug text-text-subtle">
          {t.metadata_provider_ndl_note}
        </p>
      )}
    </div>
  );
}
