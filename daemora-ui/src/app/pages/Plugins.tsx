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
import { toast } from "sonner";

interface PluginRecord {
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
  tenantPlans: string[] | null;
  configSchema: Record<string, { type: string; label?: string; required?: boolean; default?: string }> | null;
}

export function Plugins() {
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [installPkg, setInstallPkg] = useState("");
  const [installing, setInstalling] = useState(false);
  const [configPlugin, setConfigPlugin] = useState<PluginRecord | null>(null);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [configSaving, setConfigSaving] = useState(false);
  const [visibleSecrets, setVisibleSecrets] = useState<Set<string>>(new Set());
  const [pluginConfigStatus, setPluginConfigStatus] = useState<Record<string, { configured: boolean; missing: string[] }>>({});

  const fetchPlugins = useCallback(async () => {
    try {
      const res = await apiFetch("/api/plugins");
      if (res.ok) {
        const d = await res.json();
        const pluginList = d.plugins || [];
        setPlugins(pluginList);
        // Check config status for each plugin with configSchema
        const statuses: Record<string, { configured: boolean; missing: string[] }> = {};
        for (const p of pluginList) {
          if (p.configSchema && Object.keys(p.configSchema).length > 0) {
            try {
              const cfgRes = await apiFetch(`/api/plugins/${p.id}/config`);
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
        setPluginConfigStatus(statuses);
      }
    } catch {} finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchPlugins(); }, [fetchPlugins]);

  const handleToggle = async (id: string, enable: boolean) => {
    try {
      const res = await apiFetch(`/api/plugins/${id}/${enable ? "enable" : "disable"}`, { method: "POST" });
      if (res.ok) {
        toast.success(enable ? "Plugin enabled" : "Plugin disabled");
        fetchPlugins();
      } else {
        toast.error((await res.json()).error || "Failed");
      }
    } catch { toast.error("API error"); }
  };

  const handleReload = async (id: string) => {
    try {
      const res = await apiFetch(`/api/plugins/${id}/reload`, { method: "POST" });
      if (res.ok) {
        toast.success("Plugin reloaded");
        fetchPlugins();
      } else {
        toast.error((await res.json()).error || "Reload failed");
      }
    } catch { toast.error("API error"); }
  };

  const handleInstall = async () => {
    if (!installPkg.trim()) return;
    setInstalling(true);
    try {
      const res = await apiFetch("/api/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pkg: installPkg.trim() }),
      });
      if (res.ok) {
        toast.success(`Installed: ${installPkg}`);
        setInstallPkg("");
        fetchPlugins();
      } else {
        toast.error((await res.json()).error || "Install failed");
      }
    } catch { toast.error("Install failed"); }
    finally { setInstalling(false); }
  };

  const handleUninstall = async (id: string) => {
    if (!confirm(`Remove plugin "${id}"? This deletes the plugin folder.`)) return;
    try {
      const res = await apiFetch(`/api/plugins/${id}/uninstall`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Plugin removed");
        fetchPlugins();
      } else {
        toast.error((await res.json()).error || "Remove failed");
      }
    } catch { toast.error("Remove failed"); }
  };

  const openConfig = async (plugin: PluginRecord) => {
    setConfigPlugin(plugin);
    setVisibleSecrets(new Set());
    try {
      const res = await apiFetch(`/api/plugins/${plugin.id}/config`);
      if (res.ok) {
        const d = await res.json();
        setConfigValues(d.values || {});
      }
    } catch {}
  };

  const saveConfig = async () => {
    if (!configPlugin) return;
    setConfigSaving(true);
    try {
      const res = await apiFetch(`/api/plugins/${configPlugin.id}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: configValues }),
      });
      if (res.ok) {
        toast.success("Config saved");
        setConfigPlugin(null);
      } else {
        toast.error((await res.json()).error || "Save failed");
      }
    } catch { toast.error("Save failed"); }
    finally { setConfigSaving(false); }
  };

  const statusIcon = (plugin: PluginRecord) => {
    if (plugin.status === "disabled") return <PowerOff className="w-4 h-4 text-gray-500" />;
    if (plugin.status === "error") return <XCircle className="w-4 h-4 text-red-400" />;
    const cfg = pluginConfigStatus[plugin.id];
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
          <h2 className="text-3xl font-bold text-white mb-2">Plugins</h2>
          <p className="text-gray-400 text-sm">Extend Daemora with custom tools, channels, and hooks</p>
        </div>
        <Button onClick={fetchPlugins} variant="ghost" size="sm" className="text-gray-400 hover:text-[#38bdf8] text-sm">
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
              placeholder="Install from npm — e.g. daemora-plugin-weather"
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
        <span>{plugins.length} plugin(s)</span>
        <span className="text-emerald-400">{plugins.filter(p => p.status === "loaded").length} active</span>
        {plugins.some(p => p.status === "error") && (
          <span className="text-red-400">{plugins.filter(p => p.status === "error").length} error(s)</span>
        )}
        <span>{plugins.reduce((sum, p) => sum + p.toolNames.length, 0)} tools</span>
      </div>

      {/* Plugin List */}
      {plugins.length === 0 ? (
        <Card className="bg-slate-900/50 border-slate-800">
          <CardContent className="py-16 text-center">
            <Puzzle className="w-12 h-12 text-gray-700 mx-auto mb-4" />
            <p className="text-gray-500 text-base mb-2">No plugins installed</p>
            <p className="text-gray-600 text-sm">Install from npm above, or drop folders in <code className="text-[#38bdf8] bg-slate-800 px-2 py-0.5 rounded">plugins/</code></p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {plugins.map(plugin => (
            <Card key={plugin.id} className={`bg-slate-900/50 border-slate-800 hover:border-slate-700 transition-colors ${
              plugin.status === "error" ? "border-red-500/30" : ""
            }`}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2">
                      {statusIcon(plugin)}
                      <span className="text-base font-semibold text-white">{plugin.name}</span>
                      <span className="text-sm text-gray-500">v{plugin.version || "0.0.0"}</span>
                      <Badge variant="outline" className={`text-xs ${
                        plugin.status === "error" ? "border-red-500/30 text-red-400" :
                        plugin.status === "disabled" ? "border-gray-700 text-gray-500" :
                        pluginConfigStatus[plugin.id] && !pluginConfigStatus[plugin.id].configured ? "border-amber-500/30 text-amber-400" :
                        "border-emerald-500/30 text-emerald-400"
                      }`}>
                        {plugin.status === "error" ? "error" :
                         plugin.status === "disabled" ? "disabled" :
                         plugin.status === "needs-config" ? "needs config" :
                         pluginConfigStatus[plugin.id] && !pluginConfigStatus[plugin.id].configured ? "needs config" :
                         "active"}
                      </Badge>
                      {plugin.tenantPlans && (
                        <Badge variant="outline" className="text-xs border-[#38bdf8]/20 text-[#38bdf8]">
                          {plugin.tenantPlans.join(", ")}
                        </Badge>
                      )}
                    </div>

                    {plugin.description && (
                      <p className="text-sm text-gray-400 mb-2">{plugin.description}</p>
                    )}

                    {pluginConfigStatus[plugin.id] && !pluginConfigStatus[plugin.id].configured && (
                      <div className="flex items-center gap-2 mb-3 p-2 bg-amber-500/5 border border-amber-500/20 rounded-lg">
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                        <span className="text-sm text-amber-400">
                          Missing: {pluginConfigStatus[plugin.id].missing.join(", ")}
                        </span>
                        <button onClick={() => openConfig(plugin)} className="text-xs text-[#38bdf8] hover:underline ml-auto">Configure</button>
                      </div>
                    )}

                    <div className="flex flex-wrap gap-3 text-sm text-gray-500">
                      {plugin.toolNames.length > 0 && (
                        <span className="flex items-center gap-1">
                          <Wrench className="w-3.5 h-3.5" />
                          {plugin.toolNames.length} tool{plugin.toolNames.length > 1 ? "s" : ""}
                          <span className="text-xs text-gray-600">({plugin.toolNames.join(", ")})</span>
                        </span>
                      )}
                      {plugin.channelIds.length > 0 && (
                        <span className="flex items-center gap-1">
                          <Radio className="w-3.5 h-3.5" />
                          {plugin.channelIds.join(", ")}
                        </span>
                      )}
                      {plugin.hookEvents.length > 0 && (
                        <span className="text-xs text-gray-600">hooks: {plugin.hookEvents.join(", ")}</span>
                      )}
                      {plugin.serviceIds.length > 0 && (
                        <span className="text-xs text-gray-600">services: {plugin.serviceIds.join(", ")}</span>
                      )}
                    </div>

                    {plugin.error && (
                      <div className="flex items-center gap-2 mt-2 text-sm text-red-400">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        {plugin.error}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    {plugin.configSchema && Object.keys(plugin.configSchema).length > 0 && (
                      <Button variant="ghost" size="icon" onClick={() => openConfig(plugin)} className="text-gray-500 hover:text-[#38bdf8]" title="Configure">
                        <Settings2 className="w-4 h-4" />
                      </Button>
                    )}
                    <Switch
                      checked={plugin.enabled}
                      onCheckedChange={(v) => handleToggle(plugin.id, v)}
                      className="data-[state=checked]:bg-emerald-500"
                    />
                    <Button variant="ghost" size="icon" onClick={() => handleReload(plugin.id)} className="text-gray-500 hover:text-[#38bdf8]" title="Reload">
                      <RotateCcw className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleUninstall(plugin.id)} className="text-gray-500 hover:text-red-400" title="Remove">
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
      <Dialog open={!!configPlugin} onOpenChange={(v) => { if (!v) setConfigPlugin(null); }}>
        <DialogContent className="bg-slate-950 border-slate-800 text-white max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-lg border-b border-slate-800 pb-4">
              Configure: {configPlugin?.name}
            </DialogTitle>
          </DialogHeader>
          {configPlugin?.configSchema && (
            <div className="space-y-4 pt-4 max-h-[60vh] overflow-y-auto">
              {Object.entries(configPlugin.configSchema).map(([key, field]) => {
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
                className="w-full bg-gradient-to-r from-[#0891b2] to-[#0d9488] text-white text-sm mt-4"
              >
                {configSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                Save Configuration
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
