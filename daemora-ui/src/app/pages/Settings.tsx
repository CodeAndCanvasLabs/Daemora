import { useEffect, useState, useRef } from "react";
import { apiFetch } from "../api";
import {
  Settings as SettingsIcon,
  Eye,
  EyeOff,
  Save,
  Loader2,
  CheckCircle,
  User,
  Sparkles,
  Brain,
  Trash2,
  Plus,
  X,
  ChevronDown,
  KeyRound,
  MessageSquareText,
  Bot,
  FileCode2,
} from "lucide-react";

interface AvailableVar {
  key: string;
  section: string;
}

interface SettingsData {
  vars: Record<string, string>;
  available: AvailableVar[];
}

interface UserProfile {
  name: string;
  personality: string;
  tone: string;
  instructions: string;
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
      const timer = setTimeout(() => setHeight(undefined), 300);
      return () => clearTimeout(timer);
    } else {
      setHeight(contentRef.current.scrollHeight);
      requestAnimationFrame(() => setHeight(0));
    }
  }, [open]);

  return (
    <div className="bg-slate-900/50 border border-slate-800 rounded-xl backdrop-blur-sm shadow-xl overflow-hidden transition-all duration-300 hover:border-slate-700/80">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-4 group cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#00d9ff]/10 border border-[#00d9ff]/20 flex items-center justify-center group-hover:bg-[#00d9ff]/15 transition-colors">
            <Icon className="w-4 h-4 text-[#00d9ff]" />
          </div>
          <div className="text-left">
            <div className="flex items-center gap-2">
              <span className="text-white font-semibold text-sm uppercase tracking-tight">{title}</span>
              {badge}
            </div>
            {subtitle && <p className="text-[10px] font-mono text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {open && actions && <div onClick={(e) => e.stopPropagation()}>{actions}</div>}
          <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform duration-300 ${open ? "rotate-180" : ""}`} />
        </div>
      </button>
      <div
        ref={contentRef}
        style={{ height: height !== undefined ? `${height}px` : "auto" }}
        className="transition-[height] duration-300 ease-in-out overflow-hidden"
      >
        <div className="px-5 pb-5 pt-1">{children}</div>
      </div>
    </div>
  );
}

// ── Save Button ──────────────────────────────────────────────────────────────

function SaveBtn({ dirty, saving, saved, onSave }: { dirty: boolean; saving: boolean; saved: boolean; onSave: () => void }) {
  return (
    <button
      onClick={onSave}
      disabled={!dirty || saving}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-wider transition-all ${
        dirty
          ? "bg-[#00d9ff]/15 text-[#00d9ff] border border-[#00d9ff]/40 hover:bg-[#00d9ff]/25 cursor-pointer shadow-[0_0_10px_rgba(0,217,255,0.1)]"
          : saved
          ? "bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/30"
          : "bg-slate-800/50 text-gray-600 border border-slate-700/50 cursor-not-allowed"
      }`}
    >
      {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <CheckCircle className="w-3 h-3" /> : <Save className="w-3 h-3" />}
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

  const [profile, setProfile] = useState<UserProfile>({ name: "", personality: "", tone: "", instructions: "", subAgentModel: "" });
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

  useEffect(() => {
    Promise.all([
      apiFetch("/api/settings").then((r) => r.json()),
      apiFetch("/api/profile").then((r) => r.json()),
      apiFetch("/api/skills/custom").then((r) => r.json()),
      apiFetch("/api/memory").then((r) => r.json()),
      apiFetch("/api/models").then((r) => r.json()),
    ])
      .then(([settingsData, profileData, skillsData, memoryData, modelsData]) => {
        setData(settingsData);
        setProfile({
          name: profileData.name || "",
          personality: profileData.personality || "",
          tone: profileData.tone || "",
          instructions: profileData.instructions || "",
          subAgentModel: profileData.subAgentModel || "",
        });
        setCustomSkills(skillsData.skills || []);
        setMemory(memoryData.content || "");
        setAvailableModels(modelsData.available || []);
        setIsLoading(false);
      })
      .catch(() => setIsLoading(false));
  }, []);

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

  const sections: Record<string, string[]> = {};
  for (const v of data.available) {
    if (!sections[v.section]) sections[v.section] = [];
    sections[v.section].push(v.key);
  }

  // Group models by provider for the dropdown
  const modelsByProvider: Record<string, ModelOption[]> = {};
  for (const m of availableModels) {
    const p = m.provider || "other";
    if (!modelsByProvider[p]) modelsByProvider[p] = [];
    modelsByProvider[p].push(m);
  }

  const inputClass =
    "w-full bg-slate-950/60 border border-slate-700/50 rounded-lg px-3 py-2 text-sm font-mono text-white placeholder-gray-600 focus:border-[#00d9ff]/50 focus:outline-none focus:ring-1 focus:ring-[#00d9ff]/20 transition-colors";

  return (
    <div className="space-y-4 pb-8">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-3xl font-bold text-white mb-1 uppercase tracking-tighter">Settings</h2>
        <p className="text-gray-500 font-mono text-xs tracking-widest uppercase">Configure your agent's identity, skills, memory & environment</p>
      </div>

      {/* ── User Profile ──────────────────────────────────────────────── */}
      <Section
        icon={User}
        title="User Profile"
        subtitle="How the agent knows you and adapts its behavior"
        defaultOpen={true}
        actions={<SaveBtn dirty={profileDirty} saving={profileSaving} saved={profileSaved} onSave={handleProfileSave} />}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] font-mono text-gray-400 uppercase mb-1.5 block tracking-wider">Name</label>
              <input className={inputClass} placeholder="Your name" value={profile.name} onChange={(e) => handleProfileChange("name", e.target.value)} />
            </div>
            <div>
              <label className="text-[10px] font-mono text-gray-400 uppercase mb-1.5 block tracking-wider">Personality</label>
              <input className={inputClass} placeholder="e.g. friendly, professional" value={profile.personality} onChange={(e) => handleProfileChange("personality", e.target.value)} />
            </div>
            <div>
              <label className="text-[10px] font-mono text-gray-400 uppercase mb-1.5 block tracking-wider">Tone</label>
              <input className={inputClass} placeholder="e.g. casual, formal" value={profile.tone} onChange={(e) => handleProfileChange("tone", e.target.value)} />
            </div>
          </div>

          <div>
            <label className="text-[10px] font-mono text-gray-400 uppercase mb-1.5 block tracking-wider flex items-center gap-1.5">
              <Bot className="w-3 h-3" /> Sub-Agent Model
            </label>
            <select
              className={inputClass + " appearance-none cursor-pointer"}
              value={profile.subAgentModel}
              onChange={(e) => handleProfileChange("subAgentModel", e.target.value)}
            >
              <option value="">Same as main agent (default)</option>
              {Object.entries(modelsByProvider).map(([provider, models]) => (
                <optgroup key={provider} label={provider.charAt(0).toUpperCase() + provider.slice(1)}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}{m.tier ? ` — ${m.tier}` : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <p className="text-[10px] font-mono text-gray-600 mt-1.5">Model used when spawning sub-agents for parallel tasks</p>
          </div>

          <div>
            <label className="text-[10px] font-mono text-gray-400 uppercase mb-1.5 block tracking-wider flex items-center gap-1.5">
              <MessageSquareText className="w-3 h-3" /> Custom Instructions
            </label>
            <textarea
              className={inputClass + " min-h-[80px] resize-y"}
              placeholder="Tell the agent how you want it to behave, what to prioritize, or any rules to follow..."
              value={profile.instructions}
              onChange={(e) => handleProfileChange("instructions", e.target.value)}
              rows={3}
            />
          </div>
        </div>
      </Section>

      {/* ── Custom Skills ─────────────────────────────────────────────── */}
      <Section
        icon={Sparkles}
        title="Custom Skills"
        subtitle="Teach the agent new abilities with markdown instructions"
        badge={
          customSkills.length > 0 ? (
            <span className="text-[9px] font-mono text-[#00d9ff] bg-[#00d9ff]/10 px-1.5 py-0.5 rounded-md border border-[#00d9ff]/20">
              {customSkills.length}
            </span>
          ) : null
        }
        actions={
          <button
            onClick={() => setShowNewSkill(!showNewSkill)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-wider bg-[#00d9ff]/15 text-[#00d9ff] border border-[#00d9ff]/40 hover:bg-[#00d9ff]/25 transition-colors"
          >
            {showNewSkill ? <X className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
            {showNewSkill ? "Cancel" : "New Skill"}
          </button>
        }
      >
        <div className="space-y-3">
          {showNewSkill && (
            <div className="p-4 bg-slate-800/30 rounded-xl border border-slate-700/40 space-y-3 animate-in slide-in-from-top-2 duration-200">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-mono text-gray-400 uppercase mb-1.5 block tracking-wider">Skill Name *</label>
                  <input className={inputClass} placeholder="my-skill" value={newSkill.name} onChange={(e) => setNewSkill((p) => ({ ...p, name: e.target.value }))} />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-gray-400 uppercase mb-1.5 block tracking-wider">Trigger Keywords</label>
                  <input className={inputClass} placeholder="keyword1, keyword2" value={newSkill.triggers} onChange={(e) => setNewSkill((p) => ({ ...p, triggers: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-mono text-gray-400 uppercase mb-1.5 block tracking-wider">Description</label>
                <input className={inputClass} placeholder="What this skill does..." value={newSkill.description} onChange={(e) => setNewSkill((p) => ({ ...p, description: e.target.value }))} />
              </div>
              <div>
                <label className="text-[10px] font-mono text-gray-400 uppercase mb-1.5 block tracking-wider flex items-center gap-1.5">
                  <FileCode2 className="w-3 h-3" /> Instructions (Markdown) *
                </label>
                <textarea className={inputClass + " min-h-[120px] resize-y"} placeholder={"# My Skill\n\nStep-by-step instructions for the agent..."} value={newSkill.content} onChange={(e) => setNewSkill((p) => ({ ...p, content: e.target.value }))} rows={5} />
              </div>
              <div className="flex justify-end">
                <button
                  onClick={handleCreateSkill}
                  disabled={!newSkill.name || !newSkill.content || skillSaving}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono uppercase tracking-wider bg-[#00d9ff]/15 text-[#00d9ff] border border-[#00d9ff]/40 hover:bg-[#00d9ff]/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {skillSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  Create Skill
                </button>
              </div>
            </div>
          )}
          {customSkills.length === 0 && !showNewSkill ? (
            <div className="text-center py-8 border border-dashed border-slate-800 rounded-xl">
              <Sparkles className="w-5 h-5 text-gray-700 mx-auto mb-2" />
              <p className="text-gray-600 font-mono text-xs">No custom skills yet — create one to extend the agent</p>
            </div>
          ) : (
            customSkills.map((skill) => (
              <div key={skill.name} className="flex items-center justify-between p-3 bg-slate-800/20 rounded-xl border border-slate-800/50 hover:border-slate-700/60 transition-colors group">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <FileCode2 className="w-3.5 h-3.5 text-[#00d9ff]/60" />
                    <span className="text-sm font-mono text-white">{skill.name}</span>
                    <span className="text-[8px] font-mono text-[#00d9ff]/70 bg-[#00d9ff]/5 px-1.5 py-0.5 rounded uppercase border border-[#00d9ff]/10">custom</span>
                  </div>
                  {skill.description && <p className="text-[11px] text-gray-500 mt-0.5 ml-5.5 truncate">{skill.description}</p>}
                </div>
                <button onClick={() => handleDeleteSkill(skill.name)} className="p-1.5 text-gray-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100" title="Delete skill">
                  <Trash2 className="w-3.5 h-3.5" />
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
            className={inputClass + " min-h-[180px] resize-y"}
            placeholder="Write persistent instructions, preferences, project context...&#10;&#10;The agent reads this at the start of every conversation."
            value={memory}
            onChange={(e) => { setMemory(e.target.value); setMemoryDirty(true); setMemorySaved(false); }}
            rows={8}
          />
          <p className="text-[10px] font-mono text-gray-600 mt-2 flex items-center gap-1.5">
            <Brain className="w-3 h-3" />
            Injected into the system prompt — the agent learns from this across all sessions
          </p>
        </div>
      </Section>

      {/* ── Environment Variables ──────────────────────────────────────── */}
      {Object.entries(sections).map(([section, keys]) => (
        <Section
          key={section}
          icon={section.toLowerCase().includes("key") || section.toLowerCase().includes("api") ? KeyRound : SettingsIcon}
          title={section}
          subtitle={`${keys.length} variable${keys.length !== 1 ? "s" : ""} — API keys, tokens & configuration`}
          badge={
            keys.some((k) => data.vars[k]) ? (
              <span className="text-[9px] font-mono text-[#00ff88] bg-[#00ff88]/10 px-1.5 py-0.5 rounded-md border border-[#00ff88]/20">
                {keys.filter((k) => data.vars[k]).length}/{keys.length} set
              </span>
            ) : null
          }
          actions={<SaveBtn dirty={dirty} saving={saving} saved={saved} onSave={handleSave} />}
        >
          <div className="space-y-2">
            {keys.map((key) => {
              const currentMasked = data.vars[key] || "";
              const isSet = !!currentMasked;
              const isVisible = visibleKeys.has(key);
              const editVal = editValues[key];
              const hasEdit = editVal !== undefined;
              return (
                <div key={key} className="flex items-center gap-3 p-3 bg-slate-800/20 rounded-xl border border-slate-800/40 hover:border-slate-700/50 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[10px] font-mono text-gray-400 uppercase tracking-wider">{key}</span>
                      {isSet && !hasEdit && (
                        <span className="text-[8px] font-mono text-[#00ff88] bg-[#00ff88]/8 px-1.5 py-0.5 rounded uppercase border border-[#00ff88]/15">configured</span>
                      )}
                      {hasEdit && (
                        <span className="text-[8px] font-mono text-amber-400 bg-amber-400/8 px-1.5 py-0.5 rounded uppercase border border-amber-400/15">modified</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type={isVisible ? "text" : "password"}
                        placeholder={isSet ? currentMasked : "Not set"}
                        value={hasEdit ? editVal : ""}
                        onChange={(e) => handleChange(key, e.target.value)}
                        className={inputClass}
                      />
                      <button
                        onClick={() => toggleVisible(key)}
                        className="p-2 text-gray-500 hover:text-[#00d9ff] transition-colors rounded-lg hover:bg-slate-800/50"
                        title={isVisible ? "Hide" : "Show"}
                      >
                        {isVisible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      ))}
    </div>
  );
}
