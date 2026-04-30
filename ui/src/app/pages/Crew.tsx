import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "../api";
import {
  Puzzle, RefreshCw, Loader2, PowerOff, RotateCcw, Trash2, Download,
  CheckCircle2, XCircle, AlertTriangle, Wrench, Radio, Settings2,
  ChevronDown, ChevronRight, Save, Eye, EyeOff
} from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { toast } from "sonner";

interface CrewMemberRecord {
  id: string;
  name: string;
  version: string | null;
  description: string | null;
  enabled: boolean;
  status: "loaded" | "disabled" | "error" | "needs-config";
  error: string | null;
  toolNames: string[];
  channelIds: string[];
  hookEvents: string[];
  serviceIds: string[];
  cliCommands: string[];
  httpRouteCount: number;
  configSchema: Record<string, { type: string; label?: string; required?: boolean; default?: string }> | null;
  model: string | null;
  temperature: number;
}

interface ProviderModel {
  id: string;       // "provider:model"
  name: string;
}
interface ProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  models: ProviderModel[];
}

export function Crew() {
  const [crewMembers, setCrewMembers] = useState<CrewMemberRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [installPkg, setInstallPkg] = useState("");
  const [installing, setInstalling] = useState(false);
  const [configMember, setConfigMember] = useState<CrewMemberRecord | null>(null);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [configSaving, setConfigSaving] = useState(false);
  const [visibleSecrets, setVisibleSecrets] = useState<Set<string>>(new Set());
  const [crewConfigStatus, setCrewConfigStatus] = useState<Record<string, { configured: boolean; missing: string[] }>>({});
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [profileModel, setProfileModel] = useState<string>(""); // "" = use main agent's default
  const [profileTemperature, setProfileTemperature] = useState<number>(0.7);
  const [profileSaving, setProfileSaving] = useState(false);

  const fetchCrew = useCallback(async () => {
    try {
      const res = await apiFetch("/api/crew");
      if (res.ok) {
        const d = await res.json();
        const crewList = d.crew || [];
        setCrewMembers(crewList);
        // Check config status for each member with configSchema
        const statuses: Record<string, { configured: boolean; missing: string[] }> = {};
        for (const p of crewList) {
          if (p.configSchema && Object.keys(p.configSchema).length > 0) {
            try {
              const cfgRes = await apiFetch(`/api/crew/${p.id}/config`);
              if (cfgRes.ok) {
                const cfg = await cfgRes.json();
                const missing: string[] = [];
                for (const [key, field] of Object.entries(cfg.schema as Record<string, any>)) {
                  if (field.required && !cfg.values[key]) missing.push(field.label || key);
                }
                statuses[p.id] = { configured: missing.length === 0, missing };
              }
            } catch {}
          }
        }
        setCrewConfigStatus(statuses);
      }
    } catch {} finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchCrew(); }, [fetchCrew]);

  const handleToggle = async (id: string, enable: boolean) => {
    try {
      const res = await apiFetch(`/api/crew/${id}/${enable ? "enable" : "disable"}`, { method: "POST" });
      if (res.ok) {
        toast.success(enable ? "Crew member enabled" : "Crew member disabled");
        fetchCrew();
      } else {
        toast.error((await res.json()).error || "Failed");
      }
    } catch { toast.error("API error"); }
  };

  const handleReload = async (id: string) => {
    try {
      const res = await apiFetch(`/api/crew/${id}/reload`, { method: "POST" });
      if (res.ok) {
        toast.success("Crew member reloaded");
        fetchCrew();
      } else {
        toast.error((await res.json()).error || "Reload failed");
      }
    } catch { toast.error("API error"); }
  };

  const handleInstall = async () => {
    if (!installPkg.trim()) return;
    setInstalling(true);
    try {
      const res = await apiFetch("/api/crew/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pkg: installPkg.trim() }),
      });
      if (res.ok) {
        toast.success(`Installed: ${installPkg}`);
        setInstallPkg("");
        fetchCrew();
      } else {
        toast.error((await res.json()).error || "Install failed");
      }
    } catch { toast.error("Install failed"); }
    finally { setInstalling(false); }
  };

  const [uninstallTarget, setUninstallTarget] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const handleUninstall = (id: string) => setUninstallTarget(id);
  const confirmUninstall = async () => {
    if (!uninstallTarget) return;
    setUninstalling(true);
    try {
      const res = await apiFetch(`/api/crew/${uninstallTarget}/uninstall`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Crew member removed");
        fetchCrew();
        setUninstallTarget(null);
      } else {
        toast.error((await res.json()).error || "Remove failed");
      }
    } catch { toast.error("Remove failed"); }
    finally { setUninstalling(false); }
  };

  const openConfig = async (member: CrewMemberRecord) => {
    setConfigMember(member);
    setVisibleSecrets(new Set());
    setProfileModel(member.model ?? "");
    setProfileTemperature(typeof member.temperature === "number" ? member.temperature : 0.7);
    // Fetch config values (for env-style schema) + providers (for model dropdown) in parallel.
    const [cfgRes, provRes] = await Promise.allSettled([
      member.configSchema && Object.keys(member.configSchema).length > 0
        ? apiFetch(`/api/crew/${member.id}/config`)
        : Promise.resolve(null as unknown as Response),
      apiFetch("/api/providers"),
    ]);
    if (cfgRes.status === "fulfilled" && cfgRes.value && cfgRes.value.ok) {
      try {
        const d = await cfgRes.value.json();
        setConfigValues(d.values || {});
      } catch {}
    } else {
      setConfigValues({});
    }
    if (provRes.status === "fulfilled" && provRes.value.ok) {
      try {
        const d = await provRes.value.json();
        setProviders(d.providers || []);
      } catch {}
    }
  };

  const saveProfile = async () => {
    if (!configMember) return;
    setProfileSaving(true);
    try {
      const body: Record<string, unknown> = {
        // null explicitly clears the crew-level override -> main agent's model.
        model: profileModel === "" ? null : profileModel,
        temperature: profileTemperature,
      };
      const res = await apiFetch(`/api/crew/${configMember.id}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success("Model settings saved");
        fetchCrew();
      } else {
        toast.error((await res.json()).error || "Save failed");
      }
    } catch { toast.error("Save failed"); }
    finally { setProfileSaving(false); }
  };

  const saveConfig = async () => {
    if (!configMember) return;
    setConfigSaving(true);
    try {
      const res = await apiFetch(`/api/crew/${configMember.id}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: configValues }),
      });
      if (res.ok) {
        toast.success("Config saved");
        setConfigMember(null);
      } else {
        toast.error((await res.json()).error || "Save failed");
      }
    } catch { toast.error("Save failed"); }
    finally { setConfigSaving(false); }
  };

  const statusIcon = (member: CrewMemberRecord) => {
    if (member.status === "disabled") return <PowerOff className="w-4 h-4 text-gray-500" />;
    if (member.status === "error") return <XCircle className="w-4 h-4 text-red-400" />;
    const cfg = crewConfigStatus[member.id];
    if (cfg && !cfg.configured) return <AlertTriangle className="w-4 h-4 text-amber-400" />;
    return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-[#38bdf8] animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-white mb-2">Crew</h2>
          <p className="text-gray-400 text-sm">Your Daemora Crew</p>
        </div>
        <Button onClick={fetchCrew} variant="ghost" size="sm" className="text-gray-400 hover:text-[#38bdf8] text-sm">
          <RefreshCw className="w-4 h-4 mr-2" /> Refresh
        </Button>
      </div>

      {/* Install from npm */}
      <Card className="bg-slate-900/50 border-slate-800">
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <Download className="w-5 h-5 text-[#38bdf8] shrink-0" />
            <Input
              value={installPkg}
              onChange={(e) => setInstallPkg(e.target.value)}
              placeholder="Install from npm - e.g. daemora-crew-weather"
              className="bg-slate-900 border-slate-700 text-sm flex-1"
              onKeyDown={(e) => e.key === "Enter" && handleInstall()}
            />
            <Button
              onClick={handleInstall}
              disabled={!installPkg.trim() || installing}
              size="sm"
              className="bg-gradient-to-r from-[#0891b2] to-[#0d9488] text-white text-sm px-6"
            >
              {installing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Install"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="flex items-center gap-6 text-sm text-gray-500">
        <span>{crewMembers.length} crew member(s)</span>
        <span className="text-emerald-400">{crewMembers.filter(p => p.status === "loaded").length} active</span>
        {crewMembers.some(p => p.status === "error") && (
          <span className="text-red-400">{crewMembers.filter(p => p.status === "error").length} error(s)</span>
        )}
        <span>{crewMembers.reduce((sum, p) => sum + p.toolNames.length, 0)} tools</span>
      </div>

      {/* Crew List */}
      {crewMembers.length === 0 ? (
        <Card className="bg-slate-900/50 border-slate-800">
          <CardContent className="py-16 text-center">
            <Puzzle className="w-12 h-12 text-gray-700 mx-auto mb-4" />
            <p className="text-gray-500 text-base mb-2">No crew members installed</p>
            <p className="text-gray-600 text-sm">Install from npm above, or drop folders in <code className="text-[#38bdf8] bg-slate-800 px-2 py-0.5 rounded">crew/</code></p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {crewMembers.map(member => (
            <Card key={member.id} className={`bg-slate-900/50 border-slate-800 hover:border-slate-700 transition-colors ${
              member.status === "error" ? "border-red-500/30" : ""
            }`}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2">
                      {statusIcon(member)}
                      <span className="text-base font-semibold text-white">{member.name}</span>
                      <span className="text-sm text-gray-500">v{member.version || "0.0.0"}</span>
                      <Badge variant="outline" className={`text-xs ${
                        member.status === "error" ? "border-red-500/30 text-red-400" :
                        member.status === "disabled" ? "border-gray-700 text-gray-500" :
                        crewConfigStatus[member.id] && !crewConfigStatus[member.id].configured ? "border-amber-500/30 text-amber-400" :
                        "border-emerald-500/30 text-emerald-400"
                      }`}>
                        {member.status === "error" ? "error" :
                         member.status === "disabled" ? "disabled" :
                         member.status === "needs-config" ? "needs config" :
                         crewConfigStatus[member.id] && !crewConfigStatus[member.id].configured ? "needs config" :
                         "active"}
                      </Badge>
                    </div>

                    {member.description && (
                      <p className="text-sm text-gray-400 mb-2">{member.description}</p>
                    )}

                    {crewConfigStatus[member.id] && !crewConfigStatus[member.id].configured && (
                      <div className="flex items-center gap-2 mb-3 p-2 bg-amber-500/5 border border-amber-500/20 rounded-lg">
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                        <span className="text-sm text-amber-400">
                          Missing: {crewConfigStatus[member.id].missing.join(", ")}
                        </span>
                        <button onClick={() => openConfig(member)} className="text-xs text-[#38bdf8] hover:underline ml-auto">Configure</button>
                      </div>
                    )}

                    <div className="flex flex-wrap gap-3 text-sm text-gray-500">
                      {member.toolNames.length > 0 && (
                        <span className="flex items-center gap-1">
                          <Wrench className="w-3.5 h-3.5" />
                          {member.toolNames.length} tool{member.toolNames.length > 1 ? "s" : ""}
                          <span className="text-xs text-gray-600">({member.toolNames.join(", ")})</span>
                        </span>
                      )}
                      {member.channelIds.length > 0 && (
                        <span className="flex items-center gap-1">
                          <Radio className="w-3.5 h-3.5" />
                          {member.channelIds.join(", ")}
                        </span>
                      )}
                      {member.hookEvents.length > 0 && (
                        <span className="text-xs text-gray-600">hooks: {member.hookEvents.join(", ")}</span>
                      )}
                      {member.serviceIds.length > 0 && (
                        <span className="text-xs text-gray-600">services: {member.serviceIds.join(", ")}</span>
                      )}
                      <span className="text-xs text-gray-600">
                        model: <span className="text-gray-400">{member.model ?? "default"}</span>
                      </span>
                    </div>

                    {member.error && (
                      <div className="flex items-center gap-2 mt-2 text-sm text-red-400">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        {member.error}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    <Button variant="ghost" size="icon" onClick={() => openConfig(member)} className="text-gray-500 hover:text-[#38bdf8]" title="Configure">
                      <Settings2 className="w-4 h-4" />
                    </Button>
                    <Switch
                      checked={member.enabled}
                      onCheckedChange={(v) => handleToggle(member.id, v)}
                      className="data-[state=checked]:bg-emerald-500"
                    />
                    <Button variant="ghost" size="icon" onClick={() => handleReload(member.id)} className="text-gray-500 hover:text-[#38bdf8]" title="Reload">
                      <RotateCcw className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleUninstall(member.id)} className="text-gray-500 hover:text-red-400" title="Remove">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Config Dialog */}
      <Dialog open={!!configMember} onOpenChange={(v) => { if (!v) setConfigMember(null); }}>
        <DialogContent className="bg-slate-950 border-slate-800 text-white max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-lg border-b border-slate-800 pb-4">
              Configure: {configMember?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-6 pt-4 max-h-[70vh] overflow-y-auto pr-1">
            {/* Model & Temperature profile */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-200">Model</h3>
                <span className="text-[11px] text-gray-500">Overrides main agent's model for this crew</span>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-gray-400">Provider : model</label>
                <select
                  value={profileModel}
                  onChange={(e) => setProfileModel(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-md text-sm px-3 py-2 text-gray-200 focus:outline-none focus:ring-1 focus:ring-[#38bdf8]"
                >
                  <option value="">Use main agent's default</option>
                  {providers.filter((p) => p.configured && p.models.length > 0).map((p) => (
                    <optgroup key={p.id} label={p.name}>
                      {p.models.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {providers.length > 0 && providers.every((p) => !p.configured) && (
                  <p className="text-[11px] text-amber-400">No providers configured — add an API key in Settings → Secrets.</p>
                )}
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-gray-400">Temperature</label>
                  <span className="text-xs text-gray-300 tabular-nums">{profileTemperature.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={profileTemperature}
                  onChange={(e) => setProfileTemperature(Number(e.target.value))}
                  className="w-full accent-[#38bdf8]"
                />
                <div className="flex justify-between text-[10px] text-gray-600">
                  <span>focused</span>
                  <span>creative</span>
                </div>
              </div>

              <Button
                onClick={saveProfile}
                disabled={profileSaving}
                className="w-full bg-gradient-to-r from-[#0891b2] to-[#0d9488] text-white text-sm"
              >
                {profileSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                Save Model Settings
              </Button>
              <p className="text-[11px] text-gray-500">
                Takes effect on the next delegation — no restart needed.
              </p>
            </section>

            {/* Plugin env config (if any) */}
            {configMember?.configSchema && Object.keys(configMember.configSchema).length > 0 && (
              <section className="space-y-3 border-t border-slate-800 pt-5">
                <h3 className="text-sm font-semibold text-gray-200">Plugin Settings</h3>
                {Object.entries(configMember.configSchema).map(([key, field]) => {
                  const isSecret = field.type === "secret" || field.type === "password";
                  const visible = visibleSecrets.has(key);
                  return (
                    <div key={key} className="space-y-1.5">
                      <label className="text-sm text-gray-300 flex items-center gap-2">
                        {field.label || key}
                        {field.required && <span className="text-red-400 text-xs">required</span>}
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          type={isSecret && !visible ? "password" : "text"}
                          value={configValues[key] || ""}
                          onChange={(e) => setConfigValues(prev => ({ ...prev, [key]: e.target.value }))}
                          placeholder={field.default || `Enter ${field.label || key}`}
                          className="bg-slate-900 border-slate-700 text-sm flex-1"
                        />
                        {isSecret && (
                          <Button variant="ghost" size="icon" onClick={() => {
                            const s = new Set(visibleSecrets);
                            s.has(key) ? s.delete(key) : s.add(key);
                            setVisibleSecrets(s);
                          }} className="text-gray-500 hover:text-[#38bdf8]">
                            {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </Button>
                        )}
                      </div>
                      {field.type && field.type !== "secret" && field.type !== "password" && field.type !== "string" && (
                        <p className="text-xs text-gray-600">Type: {field.type}</p>
                      )}
                    </div>
                  );
                })}
                <Button
                  onClick={saveConfig}
                  disabled={configSaving}
                  className="w-full bg-slate-800 hover:bg-slate-700 text-white text-sm"
                >
                  {configSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                  Save Plugin Settings
                </Button>
              </section>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!uninstallTarget} onOpenChange={(open) => !open && setUninstallTarget(null)}>
        <AlertDialogContent className="bg-slate-950 border-slate-800/80 text-gray-200 font-mono">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white tracking-tight flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-red-400" />
              Remove {uninstallTarget}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-gray-400 text-sm leading-relaxed">
              Deletes the crew member folder. You'll need to reinstall to get it back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-slate-900 border-slate-800 text-gray-300 hover:bg-slate-800 hover:text-white">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmUninstall}
              disabled={uninstalling}
              className="bg-red-600 hover:bg-red-500 text-white border border-red-500/40"
            >
              {uninstalling ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
