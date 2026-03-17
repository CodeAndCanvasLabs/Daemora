import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "../api";
import {
  Puzzle, RefreshCw, Loader2, Power, PowerOff, RotateCcw, Trash2,
  CheckCircle2, XCircle, AlertTriangle, Wrench, Radio
} from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { toast } from "sonner";

interface PluginRecord {
  id: string;
  name: string;
  version: string | null;
  description: string | null;
  enabled: boolean;
  status: "loaded" | "disabled" | "error";
  error: string | null;
  toolNames: string[];
  channelIds: string[];
  hookEvents: string[];
  serviceIds: string[];
  cliCommands: string[];
  httpRouteCount: number;
  tenantPlans: string[] | null;
}

export function Plugins() {
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchPlugins = useCallback(async () => {
    try {
      const res = await apiFetch("/api/plugins");
      if (res.ok) {
        const d = await res.json();
        setPlugins(d.plugins || []);
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
        const err = await res.json();
        toast.error(err.error || "Failed");
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
        const err = await res.json();
        toast.error(err.error || "Reload failed");
      }
    } catch { toast.error("API error"); }
  };

  const statusIcon = (status: string) => {
    if (status === "loaded") return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
    if (status === "disabled") return <PowerOff className="w-4 h-4 text-gray-500" />;
    return <XCircle className="w-4 h-4 text-red-400" />;
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
            <p className="text-gray-600 text-sm">
              Drop plugin folders in <code className="text-[#38bdf8] bg-slate-800 px-2 py-0.5 rounded">plugins/</code> directory
            </p>
            <p className="text-gray-700 text-xs mt-4">
              Each plugin needs a plugin.json manifest + index.js entry point
            </p>
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
                    {/* Header row */}
                    <div className="flex items-center gap-3 mb-2">
                      {statusIcon(plugin.status)}
                      <span className="text-base font-semibold text-white">{plugin.name}</span>
                      <span className="text-sm text-gray-500">v{plugin.version || "0.0.0"}</span>
                      <Badge variant="outline" className={`text-xs ${
                        plugin.status === "loaded" ? "border-emerald-500/30 text-emerald-400" :
                        plugin.status === "disabled" ? "border-gray-700 text-gray-500" :
                        "border-red-500/30 text-red-400"
                      }`}>
                        {plugin.status}
                      </Badge>
                      {plugin.tenantPlans && (
                        <Badge variant="outline" className="text-xs border-[#38bdf8]/20 text-[#38bdf8]">
                          {plugin.tenantPlans.join(", ")}
                        </Badge>
                      )}
                    </div>

                    {/* Description */}
                    {plugin.description && (
                      <p className="text-sm text-gray-400 mb-3">{plugin.description}</p>
                    )}

                    {/* Registrations */}
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
                        <span className="text-xs text-gray-600">
                          hooks: {plugin.hookEvents.join(", ")}
                        </span>
                      )}
                      {plugin.serviceIds.length > 0 && (
                        <span className="text-xs text-gray-600">
                          services: {plugin.serviceIds.join(", ")}
                        </span>
                      )}
                    </div>

                    {/* Error */}
                    {plugin.error && (
                      <div className="flex items-center gap-2 mt-2 text-sm text-red-400">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        {plugin.error}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch
                      checked={plugin.enabled}
                      onCheckedChange={(v) => handleToggle(plugin.id, v)}
                      className="data-[state=checked]:bg-emerald-500"
                    />
                    <Button variant="ghost" size="icon" onClick={() => handleReload(plugin.id)} className="text-gray-500 hover:text-[#38bdf8]" title="Reload">
                      <RotateCcw className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* How to install */}
      <Card className="bg-slate-900/30 border-slate-800/50">
        <CardContent className="p-5">
          <p className="text-sm text-gray-400 mb-2">How to install plugins:</p>
          <div className="space-y-1 text-sm text-gray-500">
            <p>1. Create a folder in <code className="text-[#38bdf8]">plugins/my-plugin/</code></p>
            <p>2. Add <code className="text-[#38bdf8]">plugin.json</code> with id, name, version</p>
            <p>3. Add <code className="text-[#38bdf8]">index.js</code> with <code className="text-[#38bdf8]">register(api)</code> function</p>
            <p>4. Restart server or run <code className="text-[#38bdf8]">reload all</code></p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
