// Settings page - agent identity, skills, memory, API keys, and environment config
import { useEffect, useState, useRef } from "react";
import { apiFetch } from "../api";
import {
  Settings as SettingsIcon,
  Eye,
  EyeOff,
  Save,
  Loader2,
  CheckCircle,
  Sparkles,
  Brain,
  Trash2,
  Plus,
  X,
  ChevronDown,
  KeyRound,
  Bot,
  FileCode2,
  Search,
  Check,
  Shield,
  ShieldCheck,
  Lock,
  Unlock,
  Cpu,
  DollarSign,
  Zap,
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { FaTelegram, FaDiscord, FaSlack, FaWhatsapp, FaLine } from "react-icons/fa6";
import { SiSignal, SiGooglechat, SiOpenai, SiAnthropic, SiGooglegemini } from "react-icons/si";
import { BsMicrosoftTeams } from "react-icons/bs";
import { MdEmail } from "react-icons/md";

const OpenRouterIcon = ({ className = "" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z"/>
  </svg>
);

interface SettingsData {
  vars: Record<string, string>;
  vaultActive?: boolean;
}

interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
}

interface UserProfile {
  subAgentModel: string;
}

interface CustomSkill {
  name: string;
  description: string;
  triggers: string;
  filename: string;
  content: string;
}

interface ModelOption {
  id: string;
  provider: string;
  tier?: string;
}

// ── Collapsible Section ──────────────────────────────────────────────────────

function Section({
  icon: Icon,
  title,
  subtitle,
  badge,
  defaultOpen = false,
  actions,
  children,
}: {
  icon: any;
  title: string;
  subtitle?: string;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(defaultOpen ? undefined : 0);

  useEffect(() => {
    if (!contentRef.current) return;
    if (open) {
      setHeight(contentRef.current.scrollHeight);
      const timer = setTimeout(() => setHeight(undefined), 350);
      return () => clearTimeout(timer);
    } else {
      setHeight(contentRef.current.scrollHeight);
      requestAnimationFrame(() => setHeight(0));
    }
  }, [open]);

  return (
    <div className={`bg-slate-900/50 border border-slate-800 rounded-2xl backdrop-blur-sm shadow-xl transition-all duration-300 hover:border-slate-700/80 ${open ? "relative z-20" : ""}`}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-6 py-5 group cursor-pointer"
      >
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-[#00d9ff]/10 border border-[#00d9ff]/20 flex items-center justify-center group-hover:bg-[#00d9ff]/15 transition-colors">
            <Icon className="w-5 h-5 text-[#00d9ff]" />
          </div>
          <div className="text-left">
            <div className="flex items-center gap-2.5">
              <span className="text-white font-semibold text-[15px] uppercase tracking-tight">{title}</span>
              {badge}
            </div>
            {subtitle && <p className="text-[11px] font-mono text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {open && actions && <div onClick={(e) => e.stopPropagation()}>{actions}</div>}
          <ChevronDown className={`w-5 h-5 text-gray-500 transition-transform duration-300 ${open ? "rotate-180" : ""}`} />
        </div>
      </button>
      <div
        ref={contentRef}
        style={{ height: height !== undefined ? `${height}px` : "auto" }}
        className={`transition-[height] duration-350 ease-in-out ${height !== undefined ? "overflow-hidden" : "overflow-visible"}`}
      >
        <div className="px-6 pb-6 pt-1">{children}</div>
      </div>
    </div>
  );
}

// ── Searchable Model Selector ────────────────────────────────────────────────

function ModelSelect({
  value,
  onChange,
  modelsByProvider,
}: {
  value: string;
  onChange: (v: string) => void;
  modelsByProvider: Record<string, (ModelOption & { available?: boolean })[]>;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "configured">("configured");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const q = search.toLowerCase();
  const filtered: Record<string, (ModelOption & { available?: boolean })[]> = {};
  for (const [provider, models] of Object.entries(modelsByProvider)) {
    const matches = models.filter((m) => {
      const matchesSearch = m.id.toLowerCase().includes(q) || provider.toLowerCase().includes(q);
      const matchesFilter = filter === "all" || m.available !== false;
      return matchesSearch && matchesFilter;
    });
    if (matches.length > 0) filtered[provider] = matches;
  }

  const configuredCount = Object.values(modelsByProvider).flat().filter(m => m.available !== false).length;
  const totalCount = Object.values(modelsByProvider).flat().length;

  const selectedLabel = value ? (value.split(":")[1] || value) : "Same as main agent (default)";
  const tierColor = (tier?: string) => {
    if (!tier) return "text-gray-500";
    if (tier === "cheap" || tier === "free") return "text-[#00ff88]";
    if (tier === "expensive") return "text-amber-400";
    return "text-gray-400";
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => { setOpen(!open); if (!open) setTimeout(() => inputRef.current?.focus(), 50); }}
        className="w-full bg-slate-950/60 border border-slate-700/50 rounded-xl px-4 py-3 text-sm font-mono text-left flex items-center justify-between hover:border-slate-600/60 focus:border-[#00d9ff]/50 focus:outline-none focus:ring-1 focus:ring-[#00d9ff]/20 transition-colors"
      >
        <span className={value ? "text-white" : "text-gray-500"}>{selectedLabel}</span>
        <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute z-50 top-full mt-1.5 w-full bg-slate-950 border border-slate-700/60 rounded-xl shadow-2xl shadow-black/50 overflow-hidden">
          {/* Search */}
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-slate-800/60">
            <Search className="w-4 h-4 text-gray-500 shrink-0" />
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models..."
              className="w-full bg-transparent text-sm font-mono text-white placeholder-gray-600 outline-none"
            />
            {search && (
              <button onClick={() => setSearch("")} className="text-gray-500 hover:text-gray-300">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Filter tabs */}
          <div className="flex gap-1 px-3 py-2 border-b border-slate-800/60">
            <button
              onClick={() => setFilter("configured")}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-wider transition-colors ${filter === "configured" ? "bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/20" : "text-gray-500 hover:text-gray-300"}`}
            >
              Configured ({configuredCount})
            </button>
            <button
              onClick={() => setFilter("all")}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-wider transition-colors ${filter === "all" ? "bg-[#00d9ff]/10 text-[#00d9ff] border border-[#00d9ff]/20" : "text-gray-500 hover:text-gray-300"}`}
            >
              All ({totalCount})
            </button>
          </div>

          {/* Options */}
          <div className="max-h-[280px] overflow-y-auto overscroll-contain">
            {/* Default option */}
            <button
              onClick={() => { onChange(""); setOpen(false); setSearch(""); }}
              className={`w-full flex items-center gap-3 px-4 py-3 text-sm font-mono text-left hover:bg-slate-800/50 transition-colors ${!value ? "text-[#00d9ff]" : "text-gray-400"}`}
            >
              {!value ? <Check className="w-4 h-4 text-[#00d9ff] shrink-0" /> : <div className="w-4" />}
              Same as main agent (default)
            </button>

            {Object.keys(filtered).length === 0 ? (
              <div className="px-4 py-6 text-center text-gray-600 font-mono text-xs">No models match "{search}"</div>
            ) : (
              Object.entries(filtered).map(([provider, models]) => (
                <div key={provider}>
                  <div className="px-4 py-2 text-[10px] font-mono text-gray-500 uppercase tracking-widest bg-slate-900/80 sticky top-0 border-t border-slate-800/40">
                    {provider}
                  </div>
                  {models.map((m) => {
                    const isSelected = m.id === value;
                    const modelName = m.id.split(":")[1] || m.id;
                    const isAvailable = m.available !== false;
                    return (
                      <button
                        key={m.id}
                        onClick={() => { onChange(m.id); setOpen(false); setSearch(""); }}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm font-mono text-left hover:bg-slate-800/50 transition-colors ${isSelected ? "text-[#00d9ff] bg-[#00d9ff]/5" : isAvailable ? "text-gray-300" : "text-gray-600"}`}
                      >
                        {isSelected ? <Check className="w-4 h-4 text-[#00d9ff] shrink-0" /> : <div className="w-4" />}
                        <span className="flex-1 truncate">{modelName}</span>
                        {!isAvailable && <span className="text-[8px] uppercase tracking-wider text-gray-600 border border-slate-800 px-1.5 py-0.5 rounded">no key</span>}
                        {m.tier && <span className={`text-[9px] uppercase tracking-wider ${tierColor(m.tier)}`}>{m.tier}</span>}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Save Button ──────────────────────────────────────────────────────────────

function SaveBtn({ dirty, saving, saved, onSave }: { dirty: boolean; saving: boolean; saved: boolean; onSave: () => void }) {
  return (
    <button
      onClick={onSave}
      disabled={!dirty || saving}
      className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[10px] font-mono uppercase tracking-wider transition-all ${
        dirty
          ? "bg-[#00d9ff]/15 text-[#00d9ff] border border-[#00d9ff]/40 hover:bg-[#00d9ff]/25 cursor-pointer shadow-[0_0_12px_rgba(0,217,255,0.1)]"
          : saved
          ? "bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/30"
          : "bg-slate-800/50 text-gray-600 border border-slate-700/50 cursor-not-allowed"
      }`}
    >
      {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <CheckCircle className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
      {saving ? "Saving..." : saved ? "Saved" : "Save"}
    </button>
  );
}

// ── Main Settings Page ───────────────────────────────────────────────────────

export function Settings() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [profile, setProfile] = useState<UserProfile>({ subAgentModel: "" });
  const [profileDirty, setProfileDirty] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);

  const [customSkills, setCustomSkills] = useState<CustomSkill[]>([]);
  const [showNewSkill, setShowNewSkill] = useState(false);
  const [newSkill, setNewSkill] = useState({ name: "", description: "", triggers: "", content: "" });
  const [skillSaving, setSkillSaving] = useState(false);

  const [memory, setMemory] = useState("");
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [memorySaving, setMemorySaving] = useState(false);
  const [memorySaved, setMemorySaved] = useState(false);

  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [allModels, setAllModels] = useState<(ModelOption & { available?: boolean })[]>([]);

  const [globalConfig, setGlobalConfig] = useState<Record<string, any>>({});
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);

  const [vault, setVault] = useState<VaultStatus>({ exists: false, unlocked: false });
  const [vaultPassphrase, setVaultPassphrase] = useState("");
  const [vaultUnlocking, setVaultUnlocking] = useState(false);
  const [vaultError, setVaultError] = useState("");

  useEffect(() => {
    Promise.all([
      apiFetch("/api/settings").then((r) => r.json()),
      apiFetch("/api/profile").then((r) => r.json()),
      apiFetch("/api/skills/custom").then((r) => r.json()),
      apiFetch("/api/memory").then((r) => r.json()),
      apiFetch("/api/models").then((r) => r.json()),
      apiFetch("/api/vault/status").then((r) => r.json()),
      apiFetch("/api/config").then((r) => r.json()),
      apiFetch("/api/models/all").then((r) => r.json()).catch(() => ({ models: [] })),
    ])
      .then(([settingsData, profileData, skillsData, memoryData, modelsData, vaultData, configData, allModelsData]) => {
        setData(settingsData);
        setGlobalConfig(configData || {});
        setProfile({
          subAgentModel: profileData.subAgentModel || "",
        });
        setCustomSkills(skillsData.skills || []);
        setMemory(memoryData.content || "");
        setAvailableModels(modelsData.available || []);
        setAllModels(allModelsData.models || []);
        setVault(vaultData);
        setIsLoading(false);
      })
      .catch(() => setIsLoading(false));
  }, []);

  const handleConfigChange = (key: string, value: string) => {
    setGlobalConfig((prev: Record<string, any>) => ({ ...prev, [key]: value }));
    setConfigDirty(true);
    setConfigSaved(false);
  };

  const handleConfigSave = async () => {
    setConfigSaving(true);
    try {
      const envMap: Record<string, string> = {
        defaultModel:   "DEFAULT_MODEL",
        permissionTier: "PERMISSION_TIER",
        maxCostPerTask: "MAX_COST_PER_TASK",
        maxDailyCost:   "MAX_DAILY_COST",
        sttModel:       "STT_MODEL",
        ttsModel:       "TTS_MODEL",
        ttsVoice:       "TTS_VOICE",
        ttsGroqModel:   "TTS_GROQ_MODEL",
        meetingLlm:       "MEETING_LLM",
        ollamaBaseUrl:    "OLLAMA_BASE_URL",
      };
      const updates: Record<string, string> = {};
      for (const [configKey, envKey] of Object.entries(envMap)) {
        if (globalConfig[configKey] !== undefined) updates[envKey] = String(globalConfig[configKey]);
      }
      const res = await apiFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      if (res.ok) {
        setConfigSaved(true);
        setConfigDirty(false);
        const d = await apiFetch("/api/config").then((r) => r.json());
        setGlobalConfig(d);
      }
    } catch { /* ignore */ } finally { setConfigSaving(false); }
  };

  const handleVaultUnlock = async () => {
    if (!vaultPassphrase) return;
    setVaultUnlocking(true);
    setVaultError("");
    try {
      const res = await apiFetch("/api/vault/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: vaultPassphrase }),
      });
      if (res.ok) {
        setVault({ exists: true, unlocked: true });
        setVaultPassphrase("");
        const d = await apiFetch("/api/settings").then((r) => r.json());
        setData(d);
      } else {
        const err = await res.json();
        setVaultError(err.error || "Failed to unlock vault");
      }
    } catch { setVaultError("Connection error"); } finally { setVaultUnlocking(false); }
  };

  const handleVaultLock = async () => {
    await apiFetch("/api/vault/lock", { method: "POST" });
    setVault({ exists: true, unlocked: false });
    const d = await apiFetch("/api/settings").then((r) => r.json());
    setData(d);
  };

  const toggleVisible = (key: string) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const handleChange = (key: string, value: string) => {
    setEditValues((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setSaved(false);
  };

  const handleSave = async () => {
    const updates: Record<string, string> = {};
    for (const [key, value] of Object.entries(editValues)) {
      if (value !== undefined && value !== "") updates[key] = value;
    }
    if (Object.keys(updates).length === 0) return;
    setSaving(true);
    try {
      const res = await apiFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      if (res.ok) {
        setSaved(true);
        setDirty(false);
        const d = await apiFetch("/api/settings").then((r) => r.json());
        setData(d);
        setEditValues({});
      }
    } catch { /* ignore */ } finally { setSaving(false); }
  };

  const handleProfileChange = (field: keyof UserProfile, value: string) => {
    setProfile((prev) => ({ ...prev, [field]: value }));
    setProfileDirty(true);
    setProfileSaved(false);
  };

  const handleProfileSave = async () => {
    setProfileSaving(true);
    try {
      const res = await apiFetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      if (res.ok) { setProfileSaved(true); setProfileDirty(false); }
    } catch { /* ignore */ } finally { setProfileSaving(false); }
  };

  const handleCreateSkill = async () => {
    if (!newSkill.name || !newSkill.content) return;
    setSkillSaving(true);
    try {
      const res = await apiFetch("/api/skills/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newSkill),
      });
      if (res.ok) {
        const skillsRes = await apiFetch("/api/skills/custom").then((r) => r.json());
        setCustomSkills(skillsRes.skills || []);
        setNewSkill({ name: "", description: "", triggers: "", content: "" });
        setShowNewSkill(false);
      }
    } catch { /* ignore */ } finally { setSkillSaving(false); }
  };

  const handleDeleteSkill = async (name: string) => {
    try {
      const res = await apiFetch(`/api/skills/custom/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (res.ok) setCustomSkills((prev) => prev.filter((s) => s.name !== name));
    } catch { /* ignore */ }
  };

  const handleMemorySave = async () => {
    setMemorySaving(true);
    try {
      const res = await apiFetch("/api/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: memory }),
      });
      if (res.ok) { setMemorySaved(true); setMemoryDirty(false); }
    } catch { /* ignore */ } finally { setMemorySaving(false); }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-[#00d9ff] animate-spin" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-12">
        <p className="text-red-400 font-mono">ERROR: COULD NOT LOAD SETTINGS</p>
      </div>
    );
  }

  // Group ALL models by provider for the dropdown (show available status)
  const modelsByProvider: Record<string, (ModelOption & { available?: boolean })[]> = {};
  const modelsSource = allModels.length > 0 ? allModels : availableModels.map(m => ({ ...m, available: true }));
  for (const m of modelsSource) {
    const p = m.provider || "other";
    if (!modelsByProvider[p]) modelsByProvider[p] = [];
    modelsByProvider[p].push(m);
  }

  const inputClass =
    "w-full bg-slate-950/60 border border-slate-700/50 rounded-xl px-4 py-3 text-sm font-mono text-white placeholder-gray-600 focus:border-[#00d9ff]/50 focus:outline-none focus:ring-1 focus:ring-[#00d9ff]/20 transition-colors";

  return (
    <div className="space-y-5 pb-10">
      {/* Header */}
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-white mb-2 uppercase tracking-tighter">Settings</h2>
        <p className="text-gray-500 font-mono text-xs tracking-widest uppercase">Configure your agent's identity, skills, memory & environment</p>
      </div>

      {/* ── Global Config ────────────────────────────────────────────── */}
      <Section
        icon={Cpu}
        title="Global Config"
        subtitle="Core agent settings - model, permissions, cost limits"
        defaultOpen={true}
        actions={<SaveBtn dirty={configDirty} saving={configSaving} saved={configSaved} onSave={handleConfigSave} />}
      >
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] font-mono text-gray-400 uppercase mb-2 block tracking-wider">Default Model</label>
              <ModelSelect
                value={globalConfig.defaultModel || ""}
                onChange={(v) => handleConfigChange("defaultModel", v)}
                modelsByProvider={modelsByProvider}
              />
            </div>
            <div>
              <label className="text-[11px] font-mono text-gray-400 uppercase mb-2 block tracking-wider">Permission Tier</label>
              <Select value={globalConfig.permissionTier || "standard"} onValueChange={(v) => handleConfigChange("permissionTier", v)}>
                <SelectTrigger className="w-full bg-slate-950/60 border border-slate-700/50 rounded-xl px-4 py-3 text-sm font-mono text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-950 border-slate-800 text-white">
                  <SelectItem value="minimal" className="text-xs font-mono">MINIMAL - read-only tools, no shell</SelectItem>
                  <SelectItem value="standard" className="text-xs font-mono">STANDARD - most tools, guarded shell</SelectItem>
                  <SelectItem value="full" className="text-xs font-mono">FULL - all tools, unrestricted</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] font-mono text-gray-400 uppercase mb-2 block tracking-wider">Transcription Model (STT)</label>
              <div className="relative">
                <input
                  type="text"
                  list="stt-models"
                  className="w-full bg-slate-950/60 border border-slate-700/50 rounded-xl px-4 py-3 text-sm font-mono text-white placeholder-gray-600 focus:border-[#00d9ff]/50 focus:outline-none"
                  placeholder="gpt-4o-mini-transcribe"
                  value={globalConfig.sttModel || ""}
                  onChange={(e) => handleConfigChange("sttModel", e.target.value)}
                />
                <datalist id="stt-models">
                  <option value="gpt-4o-mini-transcribe">$0.003/min - fast, cheap</option>
                  <option value="gpt-4o-transcribe">$0.006/min - best accuracy</option>
                  <option value="gpt-4o-transcribe-diarize">$0.006/min - speaker ID</option>
                  <option value="whisper-1">legacy</option>
                  <option value="whisper-large-v3-turbo">Groq - free tier</option>
                </datalist>
              </div>
            </div>
            <div>
              <label className="text-[11px] font-mono text-gray-400 uppercase mb-2 block tracking-wider">Speech Model (TTS)</label>
              <div className="relative">
                <input
                  type="text"
                  list="tts-models"
                  className="w-full bg-slate-950/60 border border-slate-700/50 rounded-xl px-4 py-3 text-sm font-mono text-white placeholder-gray-600 focus:border-[#00d9ff]/50 focus:outline-none"
                  placeholder="gpt-4o-mini-tts"
                  value={globalConfig.ttsModel || ""}
                  onChange={(e) => handleConfigChange("ttsModel", e.target.value)}
                />
                <datalist id="tts-models">
                  <option value="groq">Groq PlayAI - free tier</option>
                  <option value="edge">Edge TTS - free, no API key</option>
                  <option value="gpt-4o-mini-tts">steerable, 14 voices</option>
                  <option value="tts-1">standard</option>
                  <option value="tts-1-hd">high quality</option>
                </datalist>
              </div>
            </div>
          </div>

          {/* ── Meeting Bot ─────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] font-mono text-gray-400 uppercase mb-2 block tracking-wider">TTS Voice</label>
              <div className="relative">
                <input
                  type="text"
                  list="tts-voices"
                  className="w-full bg-slate-950/60 border border-slate-700/50 rounded-xl px-4 py-3 text-sm font-mono text-white placeholder-gray-600 focus:border-[#00d9ff]/50 focus:outline-none"
                  placeholder="auto (based on model)"
                  value={globalConfig.ttsVoice || ""}
                  onChange={(e) => handleConfigChange("ttsVoice", e.target.value)}
                />
                <datalist id="tts-voices">
                  <option value="nova">nova - OpenAI female</option>
                  <option value="alloy">alloy - OpenAI neutral</option>
                  <option value="echo">echo - OpenAI male</option>
                  <option value="fable">fable - OpenAI UK</option>
                  <option value="onyx">onyx - OpenAI deep</option>
                  <option value="shimmer">shimmer - OpenAI soft</option>
                  <option value="hannah">hannah - Groq orpheus</option>
                  <option value="fritz">fritz - Groq orpheus</option>
                </datalist>
              </div>
            </div>
            <div>
              <label className="text-[11px] font-mono text-gray-400 uppercase mb-2 block tracking-wider">Meeting LLM</label>
              <div className="relative">
                <input
                  type="text"
                  list="meeting-llm-models"
                  className="w-full bg-slate-950/60 border border-slate-700/50 rounded-xl px-4 py-3 text-sm font-mono text-white placeholder-gray-600 focus:border-[#00d9ff]/50 focus:outline-none"
                  placeholder="auto (best available)"
                  value={globalConfig.meetingLlm || ""}
                  onChange={(e) => handleConfigChange("meetingLlm", e.target.value)}
                />
                <datalist id="meeting-llm-models">
                  <option value="openai:gpt-4o-mini">gpt-4o-mini - fast, cheap</option>
                  <option value="groq:llama-3.3-70b-versatile">groq llama-3.3-70b - fast free</option>
                  <option value="anthropic:claude-haiku-4-5-20251001">claude haiku - fast</option>
                  <option value="ollama:llama3.2">ollama llama3.2 - local</option>
                </datalist>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] font-mono text-gray-400 uppercase mb-2 block tracking-wider">Ollama Base URL</label>
              <input
                type="text"
                className="w-full bg-slate-950/60 border border-slate-700/50 rounded-xl px-4 py-3 text-sm font-mono text-white placeholder-gray-600 focus:border-[#00d9ff]/50 focus:outline-none"
                placeholder="http://localhost:11434/v1"
                value={globalConfig.ollamaBaseUrl || ""}
                onChange={(e) => handleConfigChange("ollamaBaseUrl", e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] font-mono text-gray-400 uppercase mb-2 block tracking-wider flex items-center gap-1.5">
                <DollarSign className="w-3.5 h-3.5" /> Max Cost / Task
              </label>
              <input
                type="number"
                step="0.01"
                className={inputClass}
                placeholder="e.g. 0.50"
                value={globalConfig.maxCostPerTask ?? ""}
                onChange={(e) => handleConfigChange("maxCostPerTask", e.target.value)}
              />
            </div>
            <div>
              <label className="text-[11px] font-mono text-gray-400 uppercase mb-2 block tracking-wider flex items-center gap-1.5">
                <DollarSign className="w-3.5 h-3.5" /> Max Daily Cost
              </label>
              <input
                type="number"
                step="0.01"
                className={inputClass}
                placeholder="e.g. 10.00"
                value={globalConfig.maxDailyCost ?? ""}
                onChange={(e) => handleConfigChange("maxDailyCost", e.target.value)}
              />
            </div>
          </div>

          {/* Channel Status */}
          {globalConfig.channels && (
            <div>
              <label className="text-[11px] font-mono text-gray-400 uppercase mb-2 block tracking-wider flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5" /> Active Channels
              </label>
              <div className="flex flex-wrap gap-2">
                {Object.entries(globalConfig.channels as Record<string, { enabled: boolean }>).map(([ch, cfg]) => (
                  <span key={ch} className={`text-[10px] font-mono px-2.5 py-1 rounded-lg border ${cfg.enabled ? "text-[#00ff88] bg-[#00ff88]/8 border-[#00ff88]/20" : "text-gray-600 bg-slate-800/30 border-slate-800"}`}>
                    {ch}
                  </span>
                ))}
              </div>
              <p className="text-[10px] font-mono text-gray-600 mt-1.5">Enable/disable channels via environment variables or CLI</p>
            </div>
          )}

          {globalConfig.daemonMode !== undefined && (
            <div className="flex items-center gap-3 p-3 bg-slate-800/20 rounded-xl border border-slate-800/40">
              <span className={`w-2 h-2 rounded-full ${globalConfig.daemonMode ? "bg-[#00ff88]" : "bg-gray-600"}`} />
              <span className="text-[11px] font-mono text-gray-400">Daemon Mode: <span className={globalConfig.daemonMode ? "text-[#00ff88]" : "text-gray-500"}>{globalConfig.daemonMode ? "ACTIVE" : "OFF"}</span></span>
            </div>
          )}
        </div>
      </Section>

      {/* ── Secret Vault ─────────────────────────────────────────────── */}
      <Section
        icon={vault.unlocked ? ShieldCheck : Shield}
        title="Secret Vault"
        subtitle="Encrypted storage for API keys & tokens (AES-256-GCM)"
        badge={
          vault.unlocked ? (
            <span className="text-[9px] font-mono text-[#00ff88] bg-[#00ff88]/10 px-2 py-0.5 rounded-md border border-[#00ff88]/20 flex items-center gap-1">
              <Unlock className="w-2.5 h-2.5" /> unlocked
            </span>
          ) : vault.exists ? (
            <span className="text-[9px] font-mono text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-md border border-amber-400/20 flex items-center gap-1">
              <Lock className="w-2.5 h-2.5" /> locked
            </span>
          ) : null
        }
        defaultOpen={!vault.unlocked && vault.exists}
      >
        {vault.unlocked ? (
          <div className="flex items-center gap-4 p-4 bg-[#00ff88]/5 rounded-xl border border-[#00ff88]/20">
            <ShieldCheck className="w-6 h-6 text-[#00ff88] shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-mono text-[#00ff88] font-medium">Vault is unlocked</p>
              <p className="text-[11px] font-mono text-gray-500 mt-1">Sensitive keys are encrypted at rest. Non-sensitive config stays in .env.</p>
            </div>
            <button
              onClick={handleVaultLock}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-mono uppercase tracking-wider bg-slate-800/60 text-gray-400 border border-slate-700/50 hover:text-white hover:border-slate-600 transition-colors"
            >
              <Lock className="w-3.5 h-3.5" /> Lock
            </button>
          </div>
        ) : vault.exists ? (
          <div className="space-y-4">
            <p className="text-sm font-mono text-gray-400">Enter your vault passphrase to unlock encrypted secrets.</p>
            <div className="flex items-center gap-3">
              <input
                type="password"
                className={inputClass}
                placeholder="Vault passphrase"
                value={vaultPassphrase}
                onChange={(e) => { setVaultPassphrase(e.target.value); setVaultError(""); }}
                onKeyDown={(e) => e.key === "Enter" && handleVaultUnlock()}
              />
              <button
                onClick={handleVaultUnlock}
                disabled={!vaultPassphrase || vaultUnlocking}
                className="flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-mono uppercase tracking-wider bg-[#00d9ff]/15 text-[#00d9ff] border border-[#00d9ff]/40 hover:bg-[#00d9ff]/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {vaultUnlocking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlock className="w-4 h-4" />}
                Unlock
              </button>
            </div>
            {vaultError && <p className="text-sm font-mono text-red-400">{vaultError}</p>}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-mono text-gray-400">No vault configured. Set up encrypted storage via CLI:</p>
            <code className="block text-sm font-mono text-[#00d9ff]/80 bg-slate-950/60 rounded-xl px-4 py-3 border border-slate-800/50">
              daemora vault import &lt;passphrase&gt;
            </code>
            <p className="text-[11px] font-mono text-gray-600">This imports your .env keys into an encrypted vault and removes them from plaintext.</p>
          </div>
        )}
      </Section>

      {/* ── Sub-Agent Model ──────────────────────────────────────────── */}
      <Section
        icon={Bot}
        title="Sub-Agent Model"
        subtitle="Model used when spawning sub-agents for parallel tasks"
        actions={<SaveBtn dirty={profileDirty} saving={profileSaving} saved={profileSaved} onSave={handleProfileSave} />}
      >
        <ModelSelect
          value={profile.subAgentModel}
          onChange={(v) => handleProfileChange("subAgentModel", v)}
          modelsByProvider={modelsByProvider}
        />
      </Section>

      {/* ── Custom Skills ─────────────────────────────────────────────── */}
      <Section
        icon={Sparkles}
        title="Custom Skills"
        subtitle="Teach the agent new abilities with markdown instructions"
        badge={
          customSkills.length > 0 ? (
            <span className="text-[9px] font-mono text-[#00d9ff] bg-[#00d9ff]/10 px-2 py-0.5 rounded-md border border-[#00d9ff]/20">
              {customSkills.length}
            </span>
          ) : null
        }
        actions={
          <button
            onClick={() => setShowNewSkill(!showNewSkill)}
            className="flex items-center gap-2 px-3.5 py-2 rounded-lg text-[10px] font-mono uppercase tracking-wider bg-[#00d9ff]/15 text-[#00d9ff] border border-[#00d9ff]/40 hover:bg-[#00d9ff]/25 transition-colors"
          >
            {showNewSkill ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            {showNewSkill ? "Cancel" : "New Skill"}
          </button>
        }
      >
        <div className="space-y-3">
          {showNewSkill && (
            <div className="p-5 bg-slate-800/30 rounded-xl border border-slate-700/40 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-[11px] font-mono text-gray-400 uppercase mb-2 block tracking-wider">Skill Name *</label>
                  <input className={inputClass} placeholder="my-skill" value={newSkill.name} onChange={(e) => setNewSkill((p) => ({ ...p, name: e.target.value }))} />
                </div>
                <div>
                  <label className="text-[11px] font-mono text-gray-400 uppercase mb-2 block tracking-wider">Trigger Keywords</label>
                  <input className={inputClass} placeholder="keyword1, keyword2" value={newSkill.triggers} onChange={(e) => setNewSkill((p) => ({ ...p, triggers: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className="text-[11px] font-mono text-gray-400 uppercase mb-2 block tracking-wider">Description</label>
                <input className={inputClass} placeholder="What this skill does..." value={newSkill.description} onChange={(e) => setNewSkill((p) => ({ ...p, description: e.target.value }))} />
              </div>
              <div>
                <label className="text-[11px] font-mono text-gray-400 uppercase mb-2 block tracking-wider flex items-center gap-2">
                  <FileCode2 className="w-3.5 h-3.5" /> Instructions (Markdown) *
                </label>
                <textarea className={inputClass + " min-h-[140px] resize-y"} placeholder={"# My Skill\n\nStep-by-step instructions for the agent..."} value={newSkill.content} onChange={(e) => setNewSkill((p) => ({ ...p, content: e.target.value }))} rows={6} />
              </div>
              <div className="flex justify-end">
                <button
                  onClick={handleCreateSkill}
                  disabled={!newSkill.name || !newSkill.content || skillSaving}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-mono uppercase tracking-wider bg-[#00d9ff]/15 text-[#00d9ff] border border-[#00d9ff]/40 hover:bg-[#00d9ff]/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {skillSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Create Skill
                </button>
              </div>
            </div>
          )}
          {customSkills.length === 0 && !showNewSkill ? (
            <div className="text-center py-10 border border-dashed border-slate-800 rounded-xl">
              <Sparkles className="w-6 h-6 text-gray-700 mx-auto mb-3" />
              <p className="text-gray-600 font-mono text-xs">No custom skills yet - create one to extend the agent</p>
            </div>
          ) : (
            customSkills.map((skill) => (
              <div key={skill.name} className="flex items-center justify-between p-4 bg-slate-800/20 rounded-xl border border-slate-800/50 hover:border-slate-700/60 transition-colors group">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5">
                    <FileCode2 className="w-4 h-4 text-[#00d9ff]/60" />
                    <span className="text-sm font-mono text-white font-medium">{skill.name}</span>
                    <span className="text-[9px] font-mono text-[#00d9ff]/70 bg-[#00d9ff]/5 px-2 py-0.5 rounded uppercase border border-[#00d9ff]/10">custom</span>
                  </div>
                  {skill.description && <p className="text-xs text-gray-500 mt-1 ml-6.5 truncate">{skill.description}</p>}
                </div>
                <button onClick={() => handleDeleteSkill(skill.name)} className="p-2 text-gray-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100" title="Delete skill">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))
          )}
        </div>
      </Section>

      {/* ── Agent Memory ──────────────────────────────────────────────── */}
      <Section
        icon={Brain}
        title="Agent Memory"
        subtitle="Persistent knowledge the agent reads at the start of every task"
        actions={<SaveBtn dirty={memoryDirty} saving={memorySaving} saved={memorySaved} onSave={handleMemorySave} />}
      >
        <div>
          <textarea
            className={inputClass + " min-h-[200px] resize-y"}
            placeholder={"Write persistent instructions, preferences, project context...\n\nThe agent reads this at the start of every conversation."}
            value={memory}
            onChange={(e) => { setMemory(e.target.value); setMemoryDirty(true); setMemorySaved(false); }}
            rows={8}
          />
          <p className="text-[11px] font-mono text-gray-600 mt-3 flex items-center gap-2">
            <Brain className="w-3.5 h-3.5" />
            Injected into the system prompt - the agent learns from this across all sessions
          </p>
        </div>
      </Section>

      {/* ── AI Provider Keys ──────────────────────────────────────────── */}
      <Section
        icon={KeyRound}
        title="AI Provider Keys"
        subtitle="API keys for LLM providers - encrypted in vault"
        badge={(() => {
          const providerKeys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_AI_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY"];
          const set = providerKeys.filter(k => data.vars[k]);
          return set.length > 0 ? (
            <span className="text-[9px] font-mono text-[#00ff88] bg-[#00ff88]/10 px-2 py-0.5 rounded-md border border-[#00ff88]/20">
              {set.length}/{providerKeys.length} set
            </span>
          ) : null;
        })()}
        actions={<SaveBtn dirty={dirty} saving={saving} saved={saved} onSave={handleSave} />}
      >
        <div className="space-y-3">
          {[
            { name: "OpenAI", key: "OPENAI_API_KEY", color: "#00d9ff", icon: <SiOpenai className="w-3.5 h-3.5" /> },
            { name: "Anthropic", key: "ANTHROPIC_API_KEY", color: "#d4a574", icon: <SiAnthropic className="w-3.5 h-3.5" /> },
            { name: "Google AI", key: "GOOGLE_AI_API_KEY", color: "#4285f4", icon: <SiGooglegemini className="w-3.5 h-3.5" /> },
            { name: "xAI (Grok)", key: "XAI_API_KEY", color: "#1DA1F2", icon: <Cpu className="w-3.5 h-3.5" /> },
            { name: "DeepSeek", key: "DEEPSEEK_API_KEY", color: "#4f6ef7", icon: <Cpu className="w-3.5 h-3.5" /> },
            { name: "Mistral", key: "MISTRAL_API_KEY", color: "#ff7000", icon: <Cpu className="w-3.5 h-3.5" /> },
            { name: "Groq", key: "GROQ_API_KEY", color: "#f55036", icon: <Zap className="w-3.5 h-3.5" /> },
            { name: "OpenRouter", key: "OPENROUTER_API_KEY", color: "#6366f1", icon: <OpenRouterIcon className="w-3.5 h-3.5" /> },
          ].map(({ name, key, color, icon }) => {
            const isSet = !!data.vars[key];
            const hasEdit = editValues[key] !== undefined;
            return (
              <div key={key} className="p-4 bg-slate-800/20 rounded-xl border border-slate-800/40">
                <div className="flex items-center gap-2 mb-2.5">
                  <span style={{ color }}>{icon}</span>
                  <span className="text-[12px] font-mono font-medium" style={{ color }}>{name}</span>
                  {isSet && !hasEdit && <span className="text-[8px] font-mono text-[#00ff88] bg-[#00ff88]/8 px-1.5 py-0.5 rounded border border-[#00ff88]/15">CONFIGURED</span>}
                  {data.vaultActive && isSet && <span className="text-[8px] font-mono text-[#00d9ff] bg-[#00d9ff]/8 px-1.5 py-0.5 rounded border border-[#00d9ff]/15 flex items-center gap-0.5"><Shield className="w-2.5 h-2.5" /> vault</span>}
                  {hasEdit && <span className="text-[8px] font-mono text-amber-400 bg-amber-400/8 px-1.5 py-0.5 rounded border border-amber-400/15">modified</span>}
                </div>
                <div className="flex items-center gap-3">
                  <input type={visibleKeys.has(key) ? "text" : "password"} placeholder={isSet ? data.vars[key] : "Not set"} value={editValues[key] ?? ""} onChange={(e) => handleChange(key, e.target.value)} className={inputClass} />
                  <button onClick={() => toggleVisible(key)} className="p-2.5 text-gray-500 hover:text-[#00d9ff] transition-colors rounded-xl hover:bg-slate-800/50">
                    {visibleKeys.has(key) ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {/* ── Web Search & Fetch ─────────────────────────────────────── */}
      <Section
        icon={Search}
        title="Web Search & Fetch"
        subtitle="API keys for web search and page extraction tools"
        badge={(() => {
          const webKeys = ["BRAVE_API_KEY", "TAVILY_API_KEY", "PERPLEXITY_API_KEY", "FIRECRAWL_API_KEY", "SEARXNG_URL"];
          const set = webKeys.filter(k => data.vars[k]);
          return set.length > 0 ? (
            <span className="text-[9px] font-mono text-[#00ff88] bg-[#00ff88]/10 px-2 py-0.5 rounded-md border border-[#00ff88]/20">
              {set.length}/{webKeys.length} set
            </span>
          ) : null;
        })()}
        actions={<SaveBtn dirty={dirty} saving={saving} saved={saved} onSave={handleSave} />}
      >
        <div className="space-y-3">
          {[
            { name: "Brave Search", key: "BRAVE_API_KEY", color: "#fb542b", icon: <Search className="w-3.5 h-3.5" />, isUrl: false },
            { name: "Tavily", key: "TAVILY_API_KEY", color: "#6366f1", icon: <Search className="w-3.5 h-3.5" />, isUrl: false },
            { name: "Perplexity", key: "PERPLEXITY_API_KEY", color: "#20b2aa", icon: <Search className="w-3.5 h-3.5" />, isUrl: false },
            { name: "Firecrawl", key: "FIRECRAWL_API_KEY", color: "#ff6b35", icon: <Zap className="w-3.5 h-3.5" />, isUrl: false },
            { name: "SearXNG URL", key: "SEARXNG_URL", color: "#4caf50", icon: <Search className="w-3.5 h-3.5" />, isUrl: true },
          ].map(({ name, key, color, icon, isUrl }) => {
            const isSet = !!data.vars[key];
            const hasEdit = editValues[key] !== undefined;
            return (
              <div key={key} className="p-4 bg-slate-800/20 rounded-xl border border-slate-800/40">
                <div className="flex items-center gap-2 mb-2.5">
                  <span style={{ color }}>{icon}</span>
                  <span className="text-[12px] font-mono font-medium" style={{ color }}>{name}</span>
                  {isSet && !hasEdit && <span className="text-[8px] font-mono text-[#00ff88] bg-[#00ff88]/8 px-1.5 py-0.5 rounded border border-[#00ff88]/15">CONFIGURED</span>}
                  {data.vaultActive && isSet && !isUrl && <span className="text-[8px] font-mono text-[#00d9ff] bg-[#00d9ff]/8 px-1.5 py-0.5 rounded border border-[#00d9ff]/15 flex items-center gap-0.5"><Shield className="w-2.5 h-2.5" /> vault</span>}
                  {hasEdit && <span className="text-[8px] font-mono text-amber-400 bg-amber-400/8 px-1.5 py-0.5 rounded border border-amber-400/15">modified</span>}
                </div>
                <div className="flex items-center gap-3">
                  <input type={isUrl || visibleKeys.has(key) ? "text" : "password"} placeholder={isSet ? data.vars[key] : "Not set"} value={editValues[key] ?? ""} onChange={(e) => handleChange(key, e.target.value)} className={inputClass} />
                  {!isUrl && (
                    <button onClick={() => toggleVisible(key)} className="p-2.5 text-gray-500 hover:text-[#00d9ff] transition-colors rounded-xl hover:bg-slate-800/50">
                      {visibleKeys.has(key) ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {/* ── Global Channels ──────────────────────────────────────────── */}
      <Section
        icon={Zap}
        title="Global Channels"
        subtitle="Default channel tokens - tenants can override with their own"
        badge={(() => {
          const channelTokens = ["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN", "TWILIO_ACCOUNT_SID", "LINE_CHANNEL_ACCESS_TOKEN"];
          const set = channelTokens.filter(k => data.vars[k]);
          return set.length > 0 ? (
            <span className="text-[9px] font-mono text-[#00ff88] bg-[#00ff88]/10 px-2 py-0.5 rounded-md border border-[#00ff88]/20">
              {set.length} connected
            </span>
          ) : null;
        })()}
        actions={<SaveBtn dirty={dirty} saving={saving} saved={saved} onSave={handleSave} />}
      >
        <div className="space-y-3">
          {[
            { name: "Telegram", icon: FaTelegram, color: "#29B6F6", keys: [{ key: "TELEGRAM_BOT_TOKEN", label: "Bot Token" }] },
            { name: "Discord", icon: FaDiscord, color: "#5865F2", keys: [{ key: "DISCORD_BOT_TOKEN", label: "Bot Token" }] },
            { name: "Slack", icon: FaSlack, color: "#E01E5A", keys: [{ key: "SLACK_BOT_TOKEN", label: "Bot Token" }, { key: "SLACK_APP_TOKEN", label: "App Token" }] },
            { name: "WhatsApp", icon: FaWhatsapp, color: "#25D366", keys: [{ key: "TWILIO_ACCOUNT_SID", label: "Account SID" }, { key: "TWILIO_AUTH_TOKEN", label: "Auth Token" }, { key: "TWILIO_WHATSAPP_FROM", label: "From Number" }] },
            { name: "LINE", icon: FaLine, color: "#00B900", keys: [{ key: "LINE_CHANNEL_ACCESS_TOKEN", label: "Access Token" }, { key: "LINE_CHANNEL_SECRET", label: "Channel Secret" }] },
            { name: "Email", icon: MdEmail, color: "#a78bfa", keys: [{ key: "RESEND_API_KEY", label: "Resend API Key" }, { key: "RESEND_FROM", label: "From Address" }] },
            { name: "Signal", icon: SiSignal, color: "#3a76f0", keys: [{ key: "SIGNAL_CLI_URL", label: "CLI URL" }, { key: "SIGNAL_PHONE_NUMBER", label: "Phone Number" }] },
            { name: "Teams", icon: BsMicrosoftTeams, color: "#6264A7", keys: [{ key: "TEAMS_APP_ID", label: "App ID" }, { key: "TEAMS_APP_PASSWORD", label: "App Password" }] },
            { name: "Google Chat", icon: SiGooglechat, color: "#00AC47", keys: [{ key: "GOOGLE_CHAT_SERVICE_ACCOUNT", label: "Service Account" }, { key: "GOOGLE_CHAT_PROJECT_NUMBER", label: "Project Number" }] },
          ].map(({ name, icon: Icon, color, keys }) => {
            const tokenKey = keys[0].key;
            const isConnected = !!data.vars[tokenKey];
            return (
              <div key={name} className="p-4 bg-slate-800/20 rounded-xl border border-slate-800/40">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    <Icon className="w-5 h-5" style={{ color }} />
                    <span className="text-[13px] font-mono font-medium text-white">{name}</span>
                  </div>
                  {isConnected && <span className="text-[8px] font-mono text-[#00ff88] bg-[#00ff88]/8 px-2 py-0.5 rounded border border-[#00ff88]/15">CONNECTED</span>}
                </div>
                <div className="space-y-2">
                  {keys.map(({ key, label }) => {
                    const isSet = !!data.vars[key];
                    const hasEdit = editValues[key] !== undefined;
                    return (
                      <div key={key}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] font-mono text-gray-500">{label}</span>
                          {isSet && !hasEdit && <span className="text-[7px] font-mono text-[#00ff88]/60">set</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <input type={visibleKeys.has(key) ? "text" : "password"} placeholder={isSet ? data.vars[key] : "Not set"} value={editValues[key] ?? ""} onChange={(e) => handleChange(key, e.target.value)} className={inputClass + " !py-2 !text-xs"} />
                          <button onClick={() => toggleVisible(key)} className="p-2 text-gray-600 hover:text-[#00d9ff] transition-colors">
                            {visibleKeys.has(key) ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {/* ── Tool API Keys ─────────────────────────────────────────── */}
      <Section
        icon={SettingsIcon}
        title="Tool Config"
        subtitle="API keys and settings for built-in tools"
        badge={(() => {
          const toolKeys = ["ELEVENLABS_API_KEY"];
          const set = toolKeys.filter(k => data.vars[k]);
          return set.length > 0 ? (
            <span className="text-[9px] font-mono text-[#00ff88] bg-[#00ff88]/10 px-2 py-0.5 rounded-md border border-[#00ff88]/20">
              {set.length} configured
            </span>
          ) : null;
        })()}
        actions={<SaveBtn dirty={dirty} saving={saving} saved={saved} onSave={handleSave} />}
      >
        <div className="space-y-3">
          {[
            { name: "Text-to-Speech (ElevenLabs)", color: "#f0883e", keys: [{ key: "ELEVENLABS_API_KEY", label: "API Key" }] },
          ].map(({ name, color, keys }) => {
            const anySet = keys.some(k => data.vars[k.key]);
            return (
              <div key={name} className="p-4 bg-slate-800/20 rounded-xl border border-slate-800/40">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[13px] font-mono font-medium" style={{ color }}>{name}</span>
                  {anySet && <span className="text-[8px] font-mono text-[#00ff88] bg-[#00ff88]/8 px-2 py-0.5 rounded border border-[#00ff88]/15">CONFIGURED</span>}
                </div>
                <div className="space-y-2">
                  {keys.map(({ key, label }) => {
                    const isSet = !!data.vars[key];
                    const hasEdit = editValues[key] !== undefined;
                    return (
                      <div key={key}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] font-mono text-gray-500">{label}</span>
                          {isSet && !hasEdit && <span className="text-[7px] font-mono text-[#00ff88]/60">set</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <input type={visibleKeys.has(key) ? "text" : "password"} placeholder={isSet ? data.vars[key] : "Not set"} value={editValues[key] ?? ""} onChange={(e) => handleChange(key, e.target.value)} className={inputClass + " !py-2 !text-xs"} />
                          <button onClick={() => toggleVisible(key)} className="p-2 text-gray-600 hover:text-[#00d9ff] transition-colors">
                            {visibleKeys.has(key) ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
