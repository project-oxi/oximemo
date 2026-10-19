import { Popover } from "@base-ui-components/react";
import { Button, Input } from "@garden/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { copilotDisclosure, copilotModels, copilotSetModel, copilotStatus } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";

/** Settings and conversation use one durable, app-scoped preference. */
export function CopilotModelPicker({ agent, disabled = false }: { agent: string; disabled?: boolean }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const busy = useUI(s => s.copilotBusy);
  const status = useQuery({ queryKey: ["copilot-status"], queryFn: copilotStatus });
  const disclosure = useQuery({ queryKey: ["copilot-disclosure", agent], queryFn: () => copilotDisclosure(agent), enabled: !!agent });
  const models = useQuery({ queryKey: ["copilot-models", agent], queryFn: copilotModels, enabled: open && !!agent, staleTime: 300_000 });
  const selected = status.data?.default_model || "";
  const label = selected || disclosure.data?.model || t.copilot_model_auto;
  const list = (models.data ?? []).filter(model => `${model.name} ${model.id} ${model.provider}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  const choose = async (model: string) => {
    if (saving || disabled || useUI.getState().copilotBusy) return;
    setSaving(true); setError("");
    try {
      const next = await copilotSetModel(model, agent);
      useUI.getState().setCopilotModel(null);
      qc.setQueryData(["copilot-disclosure", agent], next);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["copilot-status"] }),
        qc.invalidateQueries({ queryKey: ["config"] }),
      ]);
      setOpen(false);
    } catch (e) { setError(String(e).split("\n")[0]); }
    finally { setSaving(false); }
  };
  return <Popover.Root open={open} onOpenChange={value => { if (!saving) { setOpen(value); setFilter(""); setError(""); } }}>
    <Popover.Trigger render={<Button variant="ghost" size="sm" aria-label={t.copilot_default_model} disabled={disabled || busy || saving || !agent} className="max-w-[180px] gap-1 text-xs"><span className="truncate">{label.split("/").pop()}</span>{saving ? <Loader2 size={12} className="animate-spin"/> : <ChevronDown size={12}/>}</Button>}/>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={12} className="z-[80]">
        <Popover.Popup className="glass-menu viewport-popup w-[320px] [--popup-max-width:340px] [--popup-max-height:400px] p-2" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>
          <Popover.Title className="px-2 pt-1 text-sm font-semibold text-text">{t.copilot_default_model}</Popover.Title>
          <p className="px-2 pb-2 pt-1 text-xs leading-relaxed text-text-muted">{agent === "oxios" ? t.copilot_model_global_hint : t.copilot_default_model_hint}</p>
          <Input aria-label={t.copilot_model_filter} placeholder={t.copilot_model_filter} value={filter} onChange={event => setFilter(event.target.value)} autoFocus className="mb-2"/>
          {models.isLoading && <p role="status" className="p-2 text-xs text-text-muted">{t.copilot_detecting}</p>}
          {models.isError && <div role="alert" className="p-2 text-xs text-text-muted"><p>{t.copilot_model_none}</p><Button variant="ghost" size="sm" onClick={() => void models.refetch()}>{t.copilot_retry}</Button></div>}
          <fieldset disabled={saving || busy} className="m-0 min-w-0 border-0 p-0">
            <legend className="sr-only">{t.copilot_default_model}</legend>
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs text-text hover:bg-surface-muted">
              <input type="radio" name={id} checked={!selected} onChange={() => void choose("")} className="sr-only peer"/>
              <span className="flex size-4 items-center justify-center rounded peer-focus-visible:outline peer-focus-visible:outline-2">{!selected && <Check size={12}/>}</span><span>{t.copilot_model_auto}</span>
            </label>
            {list.map(model => <label key={model.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs text-text hover:bg-surface-muted">
              <input type="radio" name={id} checked={selected === model.id} onChange={() => void choose(model.id)} className="sr-only peer"/>
              <span className="flex size-4 shrink-0 items-center justify-center rounded peer-focus-visible:outline peer-focus-visible:outline-2">{selected === model.id && <Check size={12}/>}</span>
              <span className="min-w-0"><span className="block truncate">{model.name}</span><span className="block text-[10px] text-text-subtle">{model.provider}{model.context_window ? ` · ${Math.round(model.context_window / 1000)}K` : ""}</span></span>
            </label>)}
          </fieldset>
          {!models.isLoading && !models.isError && !list.length && <p className="px-2 py-3 text-xs text-text-muted">{filter ? t.copilot_model_no_match : t.copilot_model_unlisted}</p>}
          {!models.isLoading && !models.isError && !models.data?.length && filter.trim() && <Button size="sm" variant="secondary" disabled={saving || busy} onClick={() => void choose(filter.trim())}>{t.copilot_model_use_id}</Button>}
          {error && <p role="alert" className="px-2 py-2 text-xs text-text">{error}</p>}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
