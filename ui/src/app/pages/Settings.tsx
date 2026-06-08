/**
 * Settings — rebuilt (new UI). General config saves through the ONE endpoint
 * (PUT /api/me/config, central Postgres) via react-query; secrets (API keys) go
 * through the vault path only. Tabbed, responsive, animated.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Settings as SettingsIcon, Cpu, KeyRound, Bot, Brain, Check, Eye, EyeOff, Trash2, Loader2, Mic } from "lucide-react";
import { toast } from "sonner";

import { api } from "../lib/api-client";
import { useConfig, useUpdateConfig } from "../lib/query";
import { apiFetch } from "../api";
import { PageHeader, Card, Btn, Toggle, Loading, Pill } from "../components/kit";

type Tab = "general" | "models" | "voice" | "keys" | "agent" | "memory";
const TABS: { id: Tab; label: string; icon: typeof Cpu }[] = [
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "models", label: "Models", icon: Cpu },
  { id: "voice", label: "Voice", icon: Mic },
  { id: "keys", label: "API Keys", icon: KeyRound },
  { id: "agent", label: "Agent", icon: Bot },
  { id: "memory", label: "Memory", icon: Brain },
];

const PROVIDERS = [
  { id: "anthropic", key: "ANTHROPIC_API_KEY", label: "Anthropic" },
  { id: "openai", key: "OPENAI_API_KEY", label: "OpenAI" },
  { id: "google", key: "GOOGLE_AI_API_KEY", label: "Google AI" },
  { id: "vertex", key: "GOOGLE_VERTEX_API_KEY", label: "Vertex (Express)" },
  { id: "groq", key: "GROQ_API_KEY", label: "Groq" },
  { id: "xai", key: "XAI_API_KEY", label: "xAI" },
  { id: "deepseek", key: "DEEPSEEK_API_KEY", label: "DeepSeek" },
  { id: "mistral", key: "MISTRAL_API_KEY", label: "Mistral" },
  { id: "openrouter", key: "OPENROUTER_API_KEY", label: "OpenRouter" },
];

export function Settings() {
  const [tab, setTab] = useState<Tab>("general");
  const config = useConfig();
  const updateConfig = useUpdateConfig();

  const num = (k: string, d = 0) => { const v = config.data?.[k]; return typeof v === "number" ? v : d; };
  const bool = (k: string) => config.data?.[k] === true;
  const str = (k: string) => (typeof config.data?.[k] === "string" ? (config.data?.[k] as string) : "");

  const save = (patch: Record<string, unknown>) =>
    updateConfig.mutate(patch, { onSuccess: () => toast.success("Saved"), onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed") });

  return (
    <div>
      <PageHeader title="Settings" description="Config saves centrally and applies live. Secrets are stored encrypted in your vault." icon={SettingsIcon}
        actions={updateConfig.isPending ? <Pill>Saving…</Pill> : config.isFetched ? <Pill tone="ok">Synced</Pill> : undefined} />

      <div className="flex gap-1 mb-5 overflow-x-auto pb-1">
        {TABS.map((t) => {
          const Icon = t.icon; const on = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm whitespace-nowrap transition-colors ${on ? "bg-[#00d9ff]/10 text-[#00d9ff] border border-[#00d9ff]/30" : "text-gray-400 hover:text-gray-200 border border-transparent"}`}>
              <Icon className="w-4 h-4" />{t.label}
            </button>
          );
        })}
      </div>

      {config.isLoading ? <Loading /> : (
        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}>
          {tab === "general" && (
            <div className="space-y-4 max-w-2xl">
              <Card className="p-4 space-y-4">
                <Row label="Max daily cost (USD)" hint="Hard stop on spend per day.">
                  <NumberInput value={num("MAX_DAILY_COST")} onSave={(v) => save({ MAX_DAILY_COST: v })} />
                </Row>
                <Row label="Max cost per task (USD)">
                  <NumberInput value={num("MAX_COST_PER_TASK")} onSave={(v) => save({ MAX_COST_PER_TASK: v })} />
                </Row>
                <Row label="Heartbeat (proactive checks)">
                  <Toggle checked={bool("HEARTBEAT_ENABLED")} onChange={(v) => save({ HEARTBEAT_ENABLED: v })} />
                </Row>
                <Row label="Heartbeat interval (minutes)">
                  <NumberInput value={num("HEARTBEAT_INTERVAL_MINUTES", 30)} onSave={(v) => save({ HEARTBEAT_INTERVAL_MINUTES: v })} />
                </Row>
                <Row label="Require auth" hint="Gate the tenant API/UI behind login.">
                  <Toggle checked={bool("AUTH_ENABLED")} onChange={(v) => save({ AUTH_ENABLED: v })} />
                </Row>
              </Card>
            </div>
          )}

          {tab === "models" && <ModelsTab value={str("DEFAULT_MODEL")} onSave={(m) => save({ DEFAULT_MODEL: m })} />}
          {tab === "voice" && <VoiceTab />}
          {tab === "keys" && <KeysTab />}
          {tab === "agent" && <AgentTab />}
          {tab === "memory" && <MemoryTab />}
        </motion.div>
      )}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div><div className="text-sm text-gray-200">{label}</div>{hint && <div className="text-xs text-gray-500 mt-0.5">{hint}</div>}</div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function NumberInput({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <input type="number" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { const n = Number(v); if (!Number.isNaN(n) && n !== value) onSave(n); }}
      className="w-28 px-3 py-1.5 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50" />
  );
}

function ModelsTab({ value, onSave }: { value: string; onSave: (m: string) => void }) {
  const models = useQuery({ queryKey: ["models-all"], queryFn: () => api.get<{ models: { id: string; provider?: string; name?: string }[] }>("/api/models/all").then((r) => r.models ?? []) });
  const list = models.data ?? [];
  return (
    <Card className="p-4 max-w-2xl">
      <div className="text-sm text-gray-200 mb-2">Default model</div>
      <p className="text-xs text-gray-500 mb-3">Used when a task doesn't specify one. Saved centrally (Postgres) — applies live.</p>
      {models.isLoading ? <Loading label="Loading models…" /> : (
        <select value={value} onChange={(e) => onSave(e.target.value)}
          className="w-full px-3 py-2 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50">
          <option value="">— pick a model —</option>
          {list.map((m) => <option key={m.id} value={m.id}>{m.name ? `${m.name} (${m.id})` : m.id}</option>)}
        </select>
      )}
    </Card>
  );
}

function KeysTab() {
  const qc = useQueryClient();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const status = useQuery({ queryKey: ["vault-status"], queryFn: () => apiFetch("/api/vault/status").then((r) => r.json()) });
  const unlocked = status.data?.vaultUnlocked ?? status.data?.unlocked;

  // Which keys are already configured (+ masked hint), from the config inspect.
  const cfg = useQuery({ queryKey: ["config-secrets"], queryFn: () => api.get<{ fields: { key: string; kind: string; isSet?: boolean; hint?: string }[] }>("/api/config").then((d) => d.fields ?? []) });
  const setMap = useMemo(() => {
    const m: Record<string, { isSet: boolean; hint?: string }> = {};
    for (const f of cfg.data ?? []) if (f.kind === "secret") m[f.key] = { isSet: !!f.isSet, hint: f.hint };
    return m;
  }, [cfg.data]);
  const refreshState = () => qc.invalidateQueries({ queryKey: ["config-secrets"] });

  const saveKey = async (key: string) => {
    const v = vals[key]; if (!v) return;
    setBusy(key);
    try { const r = await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify({ updates: { [key]: v } }) }); if (!r.ok) throw new Error("save failed"); toast.success("Key saved"); setVals((s) => ({ ...s, [key]: "" })); refreshState(); }
    catch { toast.error("Failed to save key"); } finally { setBusy(null); }
  };
  const validate = async (id: string, key: string | undefined) => {
    if (!key?.trim()) { toast.error("Paste the key in the box to test it"); return; }
    setBusy(id);
    try {
      const r = await apiFetch(`/api/providers/${id}/validate`, { method: "POST", body: JSON.stringify({ key: key.trim() }) });
      const d = await r.json().catch(() => ({}));
      toast[r.ok && d.ok !== false ? "success" : "error"](r.ok && d.ok !== false ? `Valid — ${d.models?.length ?? 0} models` : (d.message || d.error || "Invalid"));
    } catch { toast.error("Validation failed"); } finally { setBusy(null); }
  };
  const del = async (key: string) => { setBusy(key); try { await apiFetch(`/api/settings/${key}`, { method: "DELETE" }); toast.success("Key removed"); refreshState(); } catch { toast.error("Failed"); } finally { setBusy(null); } };

  return (
    <div className="space-y-3 max-w-2xl">
      {!unlocked && <Card className="p-3 text-xs text-[#ffaa00] border-[#ffaa00]/30">Vault is locked — unlock from the topbar to manage keys.</Card>}
      {PROVIDERS.map((p) => {
        const set = setMap[p.key];
        return (
          <Card key={p.id} className="p-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <div className="sm:w-36 shrink-0 flex items-center gap-2">
                <span className="text-sm text-gray-200">{p.label}</span>
                {set?.isSet && <Pill tone="ok">Set</Pill>}
              </div>
              <div className="flex-1 flex items-center gap-2">
                <input type={show[p.key] ? "text" : "password"} value={vals[p.key] ?? ""}
                  placeholder={set?.isSet ? `${set.hint ?? "configured"} — paste to replace` : "paste key…"}
                  onChange={(e) => setVals((s) => ({ ...s, [p.key]: e.target.value }))}
                  className="flex-1 min-w-0 px-3 py-1.5 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50 font-mono placeholder:text-gray-500" />
                <button onClick={() => setShow((s) => ({ ...s, [p.key]: !s[p.key] }))} className="text-gray-500 hover:text-gray-300 shrink-0">{show[p.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Btn variant="primary" onClick={() => void saveKey(p.key)} disabled={busy === p.key || !vals[p.key]}>{busy === p.key ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}</Btn>
                <Btn variant="ghost" onClick={() => void validate(p.id, vals[p.key])} disabled={busy === p.id}>Test</Btn>
                <Btn variant="danger" onClick={() => void del(p.key)} disabled={busy === p.key || !set?.isSet}><Trash2 className="w-4 h-4" /></Btn>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function AgentTab() {
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api.get<{ active: string; profiles: { id: string; name: string }[] }>("/api/profiles") });
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => { if (profiles.data?.active) setActive(profiles.data.active); }, [profiles.data?.active]);
  const pick = async (id: string) => { setActive(id); try { await apiFetch("/api/profiles/active", { method: "POST", body: JSON.stringify({ id }) }); toast.success("Agent switched"); } catch { toast.error("Failed"); } };
  if (profiles.isLoading) return <Loading />;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-w-3xl">
      {(profiles.data?.profiles ?? []).map((p) => (
        <Card key={p.id} className={`p-4 ${active === p.id ? "border-[#00d9ff]/50" : ""}`} onClick={() => void pick(p.id)}>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-100">{p.name}</span>
            {active === p.id && <Pill tone="ok">Active</Pill>}
          </div>
          <div className="text-xs text-gray-500 mt-1">{p.id}</div>
        </Card>
      ))}
    </div>
  );
}

interface VProvider { id: string; name: string; configured: boolean; models: { id: string; name: string }[]; voices?: { id: string; name: string }[] }
interface VoiceData { stt: VProvider[]; tts: VProvider[]; current: { stt?: string; tts?: string; ttsModel?: string; ttsVoice?: string; sttModel?: string } }

function VoiceTab() {
  const v = useQuery({ queryKey: ["voice-providers"], queryFn: () => api.get<VoiceData>("/api/voice/providers") });
  const saveKeys = async (updates: Record<string, string>) => {
    try { const r = await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify({ updates }) }); if (!r.ok) throw new Error(); toast.success("Voice settings saved"); v.refetch(); }
    catch { toast.error("Save failed"); }
  };
  if (v.isLoading) return <Loading />;
  const stt = v.data?.stt ?? []; const tts = v.data?.tts ?? []; const cur = v.data?.current ?? {};
  const sttProv = stt.find((p) => p.id === cur.stt);
  const ttsProv = tts.find((p) => p.id === cur.tts);
  return (
    <div className="space-y-4 max-w-2xl">
      <Card className="p-4 space-y-3">
        <div className="text-sm font-semibold text-gray-200">Speech-to-text (your voice → text)</div>
        <Select label="Provider" value={cur.stt ?? ""} options={stt.map((p) => ({ value: p.id, label: `${p.name}${p.configured ? "" : " (no key)"}` }))} onChange={(val) => saveKeys({ DAEMORA_STT_PROVIDER: val })} />
        {sttProv && <Select label="Model" value={cur.sttModel ?? ""} options={sttProv.models.map((m) => ({ value: m.id, label: m.name }))} onChange={(val) => saveKeys({ STT_MODEL: val })} />}
      </Card>
      <Card className="p-4 space-y-3">
        <div className="text-sm font-semibold text-gray-200">Text-to-speech (agent's voice)</div>
        <Select label="Provider" value={cur.tts ?? ""} options={tts.map((p) => ({ value: p.id, label: `${p.name}${p.configured ? "" : " (no key)"}` }))} onChange={(val) => saveKeys({ DAEMORA_TTS_PROVIDER: val })} />
        {ttsProv && <Select label="Model" value={cur.ttsModel ?? ""} options={ttsProv.models.map((m) => ({ value: m.id, label: m.name }))} onChange={(val) => saveKeys({ TTS_MODEL: val })} />}
        {ttsProv?.voices && ttsProv.voices.length > 0 && <Select label="Voice" value={cur.ttsVoice ?? ""} options={ttsProv.voices.map((vo) => ({ value: vo.id, label: vo.name }))} onChange={(val) => saveKeys({ TTS_VOICE: val })} />}
      </Card>
      <p className="text-xs text-gray-500">Providers without a key are greyed — add the key under the API Keys tab first.</p>
    </div>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-xs text-gray-500">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full mt-1 px-3 py-2 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50">
        <option value="">— select —</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function MemoryTab() {
  const mem = useQuery({ queryKey: ["memory-doc"], queryFn: () => apiFetch("/api/memory").then((r) => r.json()).then((d) => (typeof d?.content === "string" ? d.content : typeof d?.memory === "string" ? d.memory : "")) });
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (typeof mem.data === "string") setText(mem.data); }, [mem.data]);
  const save = async () => { setSaving(true); try { await apiFetch("/api/memory", { method: "PUT", body: JSON.stringify({ content: text }) }); toast.success("Memory saved"); } catch { toast.error("Failed"); } finally { setSaving(false); } };
  return (
    <Card className="p-4 max-w-2xl">
      <div className="text-sm text-gray-200 mb-2">Long-term memory</div>
      <p className="text-xs text-gray-500 mb-3">Persistent notes the agent always keeps in mind.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10}
        className="w-full px-3 py-2 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50 resize-y" />
      <div className="flex justify-end mt-3"><Btn onClick={() => void save()} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save</Btn></div>
    </Card>
  );
}
