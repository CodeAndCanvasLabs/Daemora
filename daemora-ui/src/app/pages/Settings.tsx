import { useEffect, useState } from "react";
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
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

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

  useEffect(() => {
    Promise.all([
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/profile").then((r) => r.json()),
      fetch("/api/skills/custom").then((r) => r.json()),
      fetch("/api/memory").then((r) => r.json()),
    ])
      .then(([settingsData, profileData, skillsData, memoryData]) => {
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
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      if (res.ok) {
        setSaved(true);
        setDirty(false);
        const d = await fetch("/api/settings").then((r) => r.json());
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
      const res = await fetch("/api/profile", {
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
      const res = await fetch("/api/skills/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newSkill),
      });
      if (res.ok) {
        const skillsRes = await fetch("/api/skills/custom").then((r) => r.json());
        setCustomSkills(skillsRes.skills || []);
        setNewSkill({ name: "", description: "", triggers: "", content: "" });
        setShowNewSkill(false);
      }
    } catch { /* ignore */ } finally { setSkillSaving(false); }
  };

  const handleDeleteSkill = async (name: string) => {
    try {
      const res = await fetch(`/api/skills/custom/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (res.ok) setCustomSkills((prev) => prev.filter((s) => s.name !== name));
    } catch { /* ignore */ }
  };

  const handleMemorySave = async () => {
    setMemorySaving(true);
    try {
      const res = await fetch("/api/memory", {
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

  const inputClass =
    "w-full bg-slate-900/60 border border-slate-700/50 rounded-md px-3 py-1.5 text-sm font-mono text-white placeholder-gray-600 focus:border-[#00d9ff]/50 focus:outline-none focus:ring-1 focus:ring-[#00d9ff]/20 transition-colors";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-white mb-2 uppercase tracking-tighter">Settings</h2>
        <p className="text-gray-400 font-mono text-sm tracking-widest">PROFILE, SKILLS, MEMORY & ENVIRONMENT</p>
      </div>

      {/* User Profile */}
      <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <User className="w-5 h-5 text-[#00d9ff]" />
              <CardTitle className="text-white uppercase tracking-tight text-base">User Profile</CardTitle>
            </div>
            <SaveBtn dirty={profileDirty} saving={profileSaving} saved={profileSaved} onSave={handleProfileSave} />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-mono text-gray-400 uppercase mb-1 block">Name</label>
              <input className={inputClass} placeholder="Your name" value={profile.name} onChange={(e) => handleProfileChange("name", e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-mono text-gray-400 uppercase mb-1 block">Personality</label>
              <input className={inputClass} placeholder="e.g. friendly, professional" value={profile.personality} onChange={(e) => handleProfileChange("personality", e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-mono text-gray-400 uppercase mb-1 block">Tone</label>
              <input className={inputClass} placeholder="e.g. casual, formal" value={profile.tone} onChange={(e) => handleProfileChange("tone", e.target.value)} />
            </div>
          </div>
          <div>
            <label className="text-xs font-mono text-gray-400 uppercase mb-1 block">Sub-Agent Model</label>
            <input className={inputClass} placeholder="Same as main agent (e.g. openai:gpt-4.1-mini, anthropic:claude-haiku-4-5)" value={profile.subAgentModel} onChange={(e) => handleProfileChange("subAgentModel", e.target.value)} />
            <p className="text-[10px] font-mono text-gray-600 mt-1">Default model for sub-agents. Leave empty to use the main agent's model. Format: provider:model</p>
          </div>
          <div>
            <label className="text-xs font-mono text-gray-400 uppercase mb-1 block">Custom Instructions</label>
            <textarea className={inputClass + " min-h-[80px] resize-y"} placeholder="Any special instructions for the agent..." value={profile.instructions} onChange={(e) => handleProfileChange("instructions", e.target.value)} rows={3} />
          </div>
        </CardContent>
      </Card>

      {/* Custom Skills */}
      <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Sparkles className="w-5 h-5 text-[#00d9ff]" />
              <CardTitle className="text-white uppercase tracking-tight text-base">Custom Skills</CardTitle>
              <span className="text-[9px] font-mono text-gray-500 bg-slate-800 px-1.5 py-0.5 rounded">{customSkills.length}</span>
            </div>
            <button onClick={() => setShowNewSkill(!showNewSkill)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono bg-[#00d9ff]/10 text-[#00d9ff] border border-[#00d9ff]/30 hover:bg-[#00d9ff]/20 transition-colors">
              {showNewSkill ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
              {showNewSkill ? "Cancel" : "Add Skill"}
            </button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {showNewSkill && (
            <div className="p-4 bg-slate-800/40 rounded-lg border border-slate-700/50 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-gray-400 uppercase mb-1 block">Name *</label>
                  <input className={inputClass} placeholder="my-skill" value={newSkill.name} onChange={(e) => setNewSkill((p) => ({ ...p, name: e.target.value }))} />
                </div>
                <div>
                  <label className="text-xs font-mono text-gray-400 uppercase mb-1 block">Triggers</label>
                  <input className={inputClass} placeholder="keyword1, keyword2" value={newSkill.triggers} onChange={(e) => setNewSkill((p) => ({ ...p, triggers: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className="text-xs font-mono text-gray-400 uppercase mb-1 block">Description</label>
                <input className={inputClass} placeholder="What this skill does..." value={newSkill.description} onChange={(e) => setNewSkill((p) => ({ ...p, description: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs font-mono text-gray-400 uppercase mb-1 block">Content (Markdown) *</label>
                <textarea className={inputClass + " min-h-[120px] resize-y"} placeholder={"# My Skill\n\nInstructions for the agent..."} value={newSkill.content} onChange={(e) => setNewSkill((p) => ({ ...p, content: e.target.value }))} rows={5} />
              </div>
              <div className="flex justify-end">
                <button onClick={handleCreateSkill} disabled={!newSkill.name || !newSkill.content || skillSaving} className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-mono bg-[#00d9ff]/20 text-[#00d9ff] border border-[#00d9ff]/40 hover:bg-[#00d9ff]/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                  {skillSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  Create Skill
                </button>
              </div>
            </div>
          )}
          {customSkills.length === 0 && !showNewSkill ? (
            <p className="text-gray-500 font-mono text-sm text-center py-4">No custom skills yet</p>
          ) : (
            customSkills.map((skill) => (
              <div key={skill.name} className="flex items-center justify-between p-3 bg-slate-800/30 rounded-lg border border-slate-800/50">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono text-white">{skill.name}</span>
                    <span className="text-[9px] font-mono text-[#00d9ff] bg-[#00d9ff]/10 px-1.5 py-0.5 rounded uppercase">custom</span>
                  </div>
                  {skill.description && <p className="text-xs text-gray-500 mt-0.5 truncate">{skill.description}</p>}
                </div>
                <button onClick={() => handleDeleteSkill(skill.name)} className="p-1.5 text-gray-500 hover:text-red-400 transition-colors" title="Delete skill">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Agent Memory */}
      <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Brain className="w-5 h-5 text-[#00d9ff]" />
              <CardTitle className="text-white uppercase tracking-tight text-base">Agent Memory</CardTitle>
            </div>
            <SaveBtn dirty={memoryDirty} saving={memorySaving} saved={memorySaved} onSave={handleMemorySave} />
          </div>
        </CardHeader>
        <CardContent>
          <textarea className={inputClass + " min-h-[200px] resize-y"} placeholder="MEMORY.md content — the agent reads this at the start of every task..." value={memory} onChange={(e) => { setMemory(e.target.value); setMemoryDirty(true); setMemorySaved(false); }} rows={10} />
          <p className="text-[10px] font-mono text-gray-600 mt-2">This file is injected into the agent's system prompt. Use it for persistent instructions, preferences, and context.</p>
        </CardContent>
      </Card>

      {/* Environment Variables */}
      <div className="flex items-center justify-between">
        <p className="text-gray-400 font-mono text-sm tracking-widest uppercase">Environment Variables</p>
        <SaveBtn dirty={dirty} saving={saving} saved={saved} onSave={handleSave} />
      </div>

      {Object.entries(sections).map(([section, keys]) => (
        <Card key={section} className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <SettingsIcon className="w-5 h-5 text-[#00d9ff]" />
              <CardTitle className="text-white uppercase tracking-tight text-base">{section}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {keys.map((key) => {
              const currentMasked = data.vars[key] || "";
              const isSet = !!currentMasked;
              const isVisible = visibleKeys.has(key);
              const editVal = editValues[key];
              const hasEdit = editVal !== undefined;
              return (
                <div key={key} className="flex items-center gap-3 p-3 bg-slate-800/30 rounded-lg border border-slate-800/50">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-xs font-mono text-gray-400 uppercase">{key}</span>
                      {isSet && !hasEdit && <span className="text-[9px] font-mono text-[#00ff88] bg-[#00ff88]/10 px-1.5 py-0.5 rounded uppercase">set</span>}
                      {hasEdit && <span className="text-[9px] font-mono text-[#ffaa00] bg-[#ffaa00]/10 px-1.5 py-0.5 rounded uppercase">modified</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <input type={isVisible ? "text" : "password"} placeholder={isSet ? currentMasked : "Not set"} value={hasEdit ? editVal : ""} onChange={(e) => handleChange(key, e.target.value)} className="flex-1 bg-slate-900/60 border border-slate-700/50 rounded-md px-3 py-1.5 text-sm font-mono text-white placeholder-gray-600 focus:border-[#00d9ff]/50 focus:outline-none focus:ring-1 focus:ring-[#00d9ff]/20 transition-colors" />
                      <button onClick={() => toggleVisible(key)} className="p-1.5 text-gray-500 hover:text-[#00d9ff] transition-colors" title={isVisible ? "Hide" : "Show"}>
                        {isVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SaveBtn({ dirty, saving, saved, onSave }: { dirty: boolean; saving: boolean; saved: boolean; onSave: () => void }) {
  return (
    <button onClick={onSave} disabled={!dirty || saving} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono transition-all ${dirty ? "bg-[#00d9ff]/20 text-[#00d9ff] border border-[#00d9ff]/40 hover:bg-[#00d9ff]/30 cursor-pointer" : saved ? "bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/30" : "bg-slate-800/50 text-gray-500 border border-slate-700/50 cursor-not-allowed"}`}>
      {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <CheckCircle className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
      {saving ? "Saving..." : saved ? "Saved" : "Save"}
    </button>
  );
}
