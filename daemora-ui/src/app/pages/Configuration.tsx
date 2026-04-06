import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { Globe, Settings as SettingsIcon, Database, Shield, Cpu, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";

interface ConfigData {
  defaultModel: string;
  permissionTier: string;
  maxCostPerTask: number;
  maxDailyCost: number;
  daemonMode: boolean;
  heartbeatIntervalMinutes: number;
  channels: Record<string, { enabled: boolean }>;
}

export function Configuration() {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    apiFetch("/api/config")
      .then((res) => res.json())
      .then((data) => {
        setConfig(data);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch config", err);
        setIsLoading(false);
      });
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-[#00d9ff] animate-spin" />
      </div>
    );
  }

  if (!config) {
    return (
      <div className="text-center py-12">
        <p className="text-red-400 font-mono">ERROR: COULD NOT RETRIEVE SYSTEM CONFIGURATION</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold text-white mb-2 uppercase tracking-tighter">Configuration</h2>
        <p className="text-gray-400 font-mono text-sm tracking-widest">ENVIRONMENT SETTINGS</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Global Settings */}
        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl h-full">
          <CardHeader>
            <div className="flex items-center gap-3">
              <SettingsIcon className="w-6 h-6 text-[#00d9ff]" />
              <div>
                <CardTitle className="text-white uppercase tracking-tight text-lg">General Settings</CardTitle>
                <CardDescription className="text-gray-500 font-mono text-xs uppercase">
                  CURRENT .ENV VALUES
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 gap-4">
              <div className="p-4 bg-slate-800/30 rounded-lg border border-slate-800/50">
                <div className="text-xs text-gray-500 font-mono uppercase mb-1">Default Model</div>
                <div className="text-white font-bold font-mono text-lg">{config.defaultModel}</div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-slate-800/30 rounded-lg border border-slate-800/50">
                  <div className="text-xs text-gray-500 font-mono uppercase mb-1">Max Cost / Task</div>
                  <div className="text-white font-bold font-mono text-lg">${config.maxCostPerTask?.toFixed(2)}</div>
                </div>
                <div className="p-4 bg-slate-800/30 rounded-lg border border-slate-800/50">
                  <div className="text-xs text-gray-500 font-mono uppercase mb-1">Max Daily Limit</div>
                  <div className="text-white font-bold font-mono text-lg">${config.maxDailyCost?.toFixed(2)}</div>
                </div>
              </div>

              <div className="p-4 bg-slate-800/30 rounded-lg border border-slate-800/50">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-gray-500 font-mono uppercase mb-1">Permission Tier</div>
                    <div className="text-white font-bold font-mono uppercase">{config.permissionTier}</div>
                  </div>
                  <Shield className={`w-6 h-6 ${config.permissionTier === 'admin' ? 'text-red-500' : 'text-[#00ff88]'}`} />
                </div>
              </div>

              <div className="p-4 bg-slate-800/30 rounded-lg border border-slate-800/50">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-gray-500 font-mono uppercase mb-1">Daemon Service</div>
                    <div className="text-white font-bold font-mono uppercase">{config.daemonMode ? 'ENABLED' : 'DISABLED'}</div>
                  </div>
                  <Cpu className={`w-6 h-6 ${config.daemonMode ? 'text-[#00d9ff]' : 'text-gray-600'}`} />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Channels */}
        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl h-full">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Globe className="w-6 h-6 text-[#7C6AFF]" />
              <div>
                <CardTitle className="text-white uppercase tracking-tight text-lg">Channels</CardTitle>
                <CardDescription className="text-gray-500 font-mono text-xs uppercase">
                  INTEGRATION STATUS
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {config.channels && Object.entries(config.channels).map(([channel, status]) => (
                <div
                  key={channel}
                  className="flex items-center justify-between p-3 bg-slate-800/20 border border-slate-800/50 rounded-md"
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${status.enabled ? "bg-[#00ff88] shadow-[0_0_8px_rgba(0,255,136,0.5)]" : "bg-slate-700"}`} />
                    <div className="font-mono text-sm text-gray-200 uppercase tracking-tighter">{channel}</div>
                  </div>
                  <Badge variant="outline" className={`font-mono text-[10px] ${status.enabled ? 'text-[#00ff88] border-[#00ff88]/30' : 'text-gray-600 border-slate-800'}`}>
                    {status.enabled ? "ACTIVE" : "OFFLINE"}
                  </Badge>
                </div>
              ))}
            </div>
            <div className="mt-6 p-4 bg-slate-950/50 border border-amber-500/20 rounded-lg">
              <p className="text-[10px] text-amber-500/70 font-mono leading-relaxed uppercase">
                NOTICE: GLOBAL CONFIGURATION IS MANAGED VIA CLI OR .ENV.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
