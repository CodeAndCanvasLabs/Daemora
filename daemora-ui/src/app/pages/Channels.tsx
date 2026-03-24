import { useEffect, useState } from "react";
import { apiGet, apiJson } from "../api";
import {
  Radio,
  ChevronDown,
  Save,
  Loader2,
  CheckCircle,
  Eye,
  EyeOff,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";

interface ChannelPrompt {
  key: string;
  label: string;
  type: "password" | "text";
  initialValue?: string;
  placeholder?: string;
}

interface ChannelDef {
  name: string;
  label: string;
  desc: string;
  tenantKey: string;
  envRequired: string[];
  envOptional: [string, string][];
  setup: string[];
  prompts: ChannelPrompt[];
  configured: boolean;
  running: boolean;
}

export function Channels() {
  const [channels, setChannels] = useState<ChannelDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [visible, setVisible] = useState<Record<string, boolean>>({});

  const load = async () => {
    try {
      const data = await apiGet<{ channels: ChannelDef[] }>("/api/channels/defs");
      setChannels(data.channels);
    } catch {
      toast.error("Failed to load channels");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggle = (name: string) => {
    if (expanded === name) {
      setExpanded(null);
      setValues({});
      return;
    }
    setExpanded(name);
    setValues({});
    setVisible({});
  };

  const handleSave = async (ch: ChannelDef) => {
    const updates: Record<string, string> = {};
    for (const [key, val] of Object.entries(values)) {
      if (val.trim()) updates[key] = val.trim();
    }
    if (Object.keys(updates).length === 0) {
      toast.error("No values to save");
      return;
    }
    setSaving(true);
    try {
      await apiJson("/api/settings", "PUT", { updates });
      setSaved(ch.name);
      toast.success(`${ch.label} configuration saved`);
      setTimeout(() => setSaved(null), 3000);
      await load();
    } catch (e: any) {
      toast.error(e.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-[#00d9ff] animate-spin" />
      </div>
    );
  }

  const active = channels.filter(c => c.running).length;
  const configured = channels.filter(c => c.configured).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#00d9ff]/10 border border-[#00d9ff]/20 flex items-center justify-center">
              <Radio className="w-5 h-5 text-[#00d9ff]" />
            </div>
            Channels
          </h2>
          <p className="text-sm text-gray-500 mt-1 font-mono">
            {channels.length} supported &middot; {configured} configured &middot; {active} running
          </p>
        </div>
      </div>

      {/* Channel Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {channels.map((ch) => {
          const isExpanded = expanded === ch.name;
          return (
            <div
              key={ch.name}
              className={`bg-slate-900/50 border rounded-2xl backdrop-blur-sm transition-all duration-300 overflow-hidden ${
                isExpanded
                  ? "border-[#00d9ff]/40 shadow-[0_0_20px_rgba(0,217,255,0.1)] col-span-1 md:col-span-2 xl:col-span-3"
                  : ch.running
                  ? "border-[#00ff88]/20 hover:border-[#00ff88]/40"
                  : ch.configured
                  ? "border-[#ffaa00]/20 hover:border-[#ffaa00]/40"
                  : "border-slate-800 hover:border-slate-700"
              }`}
            >
              {/* Card Header */}
              <button
                onClick={() => toggle(ch.name)}
                className="w-full flex items-center justify-between px-5 py-4 cursor-pointer group"
              >
                <div className="flex items-center gap-3">
                  <StatusDot running={ch.running} configured={ch.configured} />
                  <div className="text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-semibold text-sm">{ch.label}</span>
                      <StatusBadge running={ch.running} configured={ch.configured} />
                    </div>
                    <p className="text-[11px] font-mono text-gray-500 mt-0.5">{ch.desc}</p>
                  </div>
                </div>
                <ChevronDown
                  className={`w-4 h-4 text-gray-500 transition-transform duration-300 ${
                    isExpanded ? "rotate-180" : ""
                  }`}
                />
              </button>

              {/* Expanded Configuration */}
              {isExpanded && (
                <div className="px-5 pb-5 pt-1 border-t border-slate-800/50 space-y-5">
                  {/* Setup Instructions */}
                  <div>
                    <h4 className="text-xs font-semibold text-[#4ECDC4] uppercase tracking-wider mb-2">
                      Setup Instructions
                    </h4>
                    <div className="bg-slate-950/50 border border-slate-800 rounded-lg p-3 space-y-1">
                      {ch.setup.map((line, i) => (
                        <p key={i} className="text-xs font-mono text-gray-400">{line}</p>
                      ))}
                    </div>
                  </div>

                  {/* Required Env Vars - Input Fields */}
                  <div>
                    <h4 className="text-xs font-semibold text-[#4ECDC4] uppercase tracking-wider mb-3">
                      Configuration
                    </h4>
                    <div className="space-y-3">
                      {ch.prompts.map((prompt) => (
                        <div key={prompt.key}>
                          <label className="text-xs font-mono text-gray-400 mb-1 block">
                            {prompt.key}
                            {ch.envRequired.some(e => e.split("=")[0] === prompt.key) && (
                              <span className="text-[#ff4458] ml-1">*</span>
                            )}
                          </label>
                          <div className="flex gap-2">
                            <input
                              type={prompt.type === "password" && !visible[prompt.key] ? "password" : "text"}
                              value={values[prompt.key] ?? ""}
                              onChange={(e) => setValues({ ...values, [prompt.key]: e.target.value })}
                              placeholder={prompt.placeholder || prompt.initialValue || prompt.label}
                              className="flex-1 bg-slate-950/50 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder:text-gray-600 focus:outline-none focus:border-[#00d9ff]/50 transition-colors"
                            />
                            {prompt.type === "password" && (
                              <button
                                onClick={() => setVisible({ ...visible, [prompt.key]: !visible[prompt.key] })}
                                className="px-2 text-gray-500 hover:text-gray-300 transition-colors"
                              >
                                {visible[prompt.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Optional Env Vars */}
                  {ch.envOptional.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                        Optional
                      </h4>
                      <div className="space-y-2">
                        {ch.envOptional.map(([key, desc]) => (
                          <div key={key}>
                            <label className="text-xs font-mono text-gray-500 mb-1 block" title={desc}>
                              {key}
                              <span className="text-gray-600 ml-2 font-sans">{desc}</span>
                            </label>
                            <input
                              type="text"
                              value={values[key] ?? ""}
                              onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                              placeholder={desc}
                              className="w-full bg-slate-950/50 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder:text-gray-600 focus:outline-none focus:border-[#00d9ff]/50 transition-colors"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Save */}
                  <div className="flex items-center gap-3 pt-2">
                    <button
                      onClick={() => handleSave(ch)}
                      disabled={saving}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#00d9ff]/10 border border-[#00d9ff]/30 text-[#00d9ff] text-sm font-medium hover:bg-[#00d9ff]/20 disabled:opacity-50 transition-all cursor-pointer"
                    >
                      {saving ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : saved === ch.name ? (
                        <CheckCircle className="w-4 h-4" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      {saving ? "Saving..." : saved === ch.name ? "Saved" : "Save"}
                    </button>
                    {saved === ch.name && (
                      <span className="flex items-center gap-1.5 text-xs text-[#ffaa00] font-mono">
                        <AlertTriangle className="w-3 h-3" />
                        Restart Daemora to activate
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatusDot({ running, configured }: { running: boolean; configured: boolean }) {
  if (running)
    return <div className="w-2.5 h-2.5 rounded-full bg-[#00ff88] shadow-[0_0_6px_rgba(0,255,136,0.5)] animate-pulse" />;
  if (configured)
    return <div className="w-2.5 h-2.5 rounded-full bg-[#ffaa00] shadow-[0_0_6px_rgba(255,170,0,0.3)]" />;
  return <div className="w-2.5 h-2.5 rounded-full bg-slate-700" />;
}

function StatusBadge({ running, configured }: { running: boolean; configured: boolean }) {
  if (running) {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/20">
        Active
      </span>
    );
  }
  if (configured) {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider bg-[#ffaa00]/10 text-[#ffaa00] border border-[#ffaa00]/20">
        Configured
      </span>
    );
  }
  return null;
}
