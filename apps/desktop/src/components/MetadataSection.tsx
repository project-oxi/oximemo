/**
 * Metadata settings pane (spec 2026-08-23 §3.4): enabled toggle, region
 * selector (auto-detect default), and the eight providers grouped by
 * domain with key inputs. Per-provider badges mark keyless / keyed /
 * approval-pending; region-priority listings rank recommended providers
 * first. Save commits the whole `[metadata]` config in one shot.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, EyeOff } from "lucide-react";

import {
  getConfig,
  setMetadataConfig,
  type MetadataConfig,
} from "../lib/api";
import type { I18nContextValue } from "../lib/i18n";
import { useI18n } from "../lib/i18n";
import { ToggleRow } from "./SettingsMenu";
import { effectiveRegion } from "../lib/metadataRegion";

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

function PaneHeader({ title }: { title: string }) {
  return <h2 className="mb-3 text-sm font-semibold text-text">{title}</h2>;
}

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
  // The "keyed + key set" success state is rendered by ProviderCard
  // itself (키 구성됨); the badge only reports the requirement.
  return (
    <span className="rounded-full bg-status-warning-subtle px-1.5 py-0.5 text-[10px] text-status-warning">{t.metadata_provider_keyed}</span>
  );
}

export function MetadataSection() {
  const i18n = useI18n();
  const { t } = i18n;
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const [draft, setDraft] = useState<MetadataConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const m = cfg.data?.metadata;
    if (!m) return;
    if (!draft) setDraft({
      enabled: m.enabled ?? true,
      region: m.region ?? "",
      google_books_key: m.google_books_key ?? "",
      aladin_key: m.aladin_key ?? "",
      tmdb_key: m.tmdb_key ?? "",
      omdb_key: m.omdb_key ?? "",
      kmdb_key: m.kmdb_key ?? "",
    });
  }, [cfg.data, draft]);

  // "" (auto) resolves through Intl detection for the badges and the
  // group ordering; the stored value stays "" until the user picks.
  const region = effectiveRegion(draft?.region ?? "");
  const storedRegion = draft?.region ?? "";
  const detectedLabel =
    region === "KR" ? t.metadata_region_kr
      : region === "JP" ? t.metadata_region_jp
        : region === "DE" ? t.metadata_region_de
          : null;
  const autoLabel = detectedLabel
    ? `${t.metadata_region_auto} · ${detectedLabel}`
    : t.metadata_region_auto;
  const isRecommended = useMemo(
    () => (p: ProviderDisplay) => p.recommended.includes(region),
    [region],
  );
  const update = (patch: Partial<MetadataConfig>) =>
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

  const [saved, setSaved] = useState(false);
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaved(false);
    try {
      await setMetadataConfig(draft);
      await qc.invalidateQueries({ queryKey: ["config"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } finally {
      setSaving(false);
    }
  };

  const grouped = (domain: ProviderDisplay["domain"]) =>
    [...PROVIDERS.filter((p) => p.domain === domain)].sort(
      (a, b) => Number(isRecommended(b)) - Number(isRecommended(a)),
    );

  if (!draft) {
    return (
      <section>
        <PaneHeader title={t.metadata} />
        <p className="text-[11px] text-text-subtle">…</p>
      </section>
    );
  }

  return (
    <section>
      <PaneHeader title={t.metadata} />
      <div className="space-y-3">
        <ToggleRow
          label={t.metadata_enabled}
          checked={draft.enabled}
          onChange={(v) => update({ enabled: v })}
        />
        <div>
          <p className="mb-1 text-[11px] text-text-subtle">{t.metadata_region}</p>
          <select
            value={storedRegion}
            onChange={(e) => update({ region: e.target.value })}
            className="w-full rounded-md bg-surface-sunken px-2.5 py-1.5 text-xs text-text outline-none focus:ring-1 focus:ring-line"
          >
            <option value="">
              {autoLabel}
            </option>
            <option value="KR">{t.metadata_region_kr}</option>
            <option value="JP">{t.metadata_region_jp}</option>
            <option value="DE">{t.metadata_region_de}</option>
            <option value="US">{t.metadata_region_other}</option>
          </select>
        </div>
        <ProviderGroup
          label={t.metadata_domain_book}
          providers={grouped("book")}
          draft={draft}
          update={update}
          isRecommended={isRecommended}
          t={t}
        />
        <ProviderGroup
          label={t.metadata_domain_movie}
          providers={grouped("movie")}
          draft={draft}
          update={update}
          isRecommended={isRecommended}
          t={t}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
        >
          <Check size={13} />
          {saving ? "…" : saved ? t.metadata_saved : t.metadata_save}
        </button>
      </div>
    </section>
  );
}

function ProviderGroup({
  label,
  providers,
  draft,
  update,
  isRecommended,
  t,
}: {
  label: string;
  providers: ProviderDisplay[];
  draft: MetadataConfig;
  update: (patch: Partial<MetadataConfig>) => void;
  isRecommended: (p: ProviderDisplay) => boolean;
  t: I18nContextValue["t"];
}) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] text-text-subtle">{label}</p>
      <div className="space-y-1.5">
        {providers.map((p) => (
          <ProviderCard
            key={p.id}
            p={p}
            draft={draft}
            update={update}
            recommended={isRecommended(p)}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One provider as a two-row card: identity + status on top, a
 * full-width key input below. The old layout squeezed a 128px
 * password field into the trailing slot of a single row — invisible
 * in practice (a screenshot reviewer read it as a "…" menu). Keys
 * now get the whole width, a paste-friendly placeholder, a per-card
 * reveal toggle, and a green "키 구성됨" state.
 */
function ProviderCard({
  p,
  draft,
  update,
  recommended,
  t,
}: {
  p: ProviderDisplay;
  draft: MetadataConfig;
  update: (patch: Partial<MetadataConfig>) => void;
  recommended: boolean;
  t: I18nContextValue["t"];
}) {
  const [reveal, setReveal] = useState(false);
  const field = KEY_FIELD[p.id];
  const value = field ? (draft[field] ?? "") : "";
  const hasKey = value.trim() !== "";
  const keyed = p.access === "keyed" || p.access === "approval";
  return (
    <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-xs font-medium text-text">
          {p.id === "aladin" ? t.metadata_provider_aladin : p.name}
        </span>
        {recommended && (
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
        <div className="mt-1.5 flex gap-1">
          <input
            type={reveal ? "text" : "password"}
            value={value}
            onChange={(e) => field && update({ [field]: e.target.value } as Partial<MetadataConfig>)}
            placeholder={t.metadata_key_placeholder}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] text-text outline-none placeholder:font-sans placeholder:text-text-subtle focus:ring-1 focus:ring-line"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? t.metadata_key_hide : t.metadata_key_show}
            className="shrink-0 rounded-md border border-line bg-surface px-2 text-text-subtle transition-colors hover:bg-surface-muted hover:text-text"
          >
            {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
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
