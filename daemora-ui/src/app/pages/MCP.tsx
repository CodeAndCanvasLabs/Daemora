import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { Play, Pause, RefreshCw, Plus, Trash2, Loader2, Globe, Cpu, AlertTriangle, Key, X, Settings } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";

interface MCPServer {
  name: string;
  enabled: boolean;
  connected: boolean;
  tools: any[];
  type: "stdio" | "http" | "sse";
  command?: string;
  url?: string;
  description?: string | null;
  envKeys?: string[];
  headerKeys?: string[];
  needsConfig?: boolean;
}

interface KVPair {
  key: string;
  value: string;
}

export function MCP() {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [newServer, setNewServer] = useState({
    name: "",
    type: "stdio" as "stdio" | "http" | "sse",
    command: "",
    url: "",
    description: "",
  });
  const [envVars, setEnvVars] = useState<KVPair[]>([]);
  const [headers, setHeaders] = useState<KVPair[]>([]);

  // Configure dialog state
  const [configServer, setConfigServer] = useState<MCPServer | null>(null);
  const [configValues, setConfigValues] = useState<KVPair[]>([]);
  const [configSaving, setConfigSaving] = useState(false);

  const fetchServers = async () => {
    try {
      const res = await apiFetch("/api/mcp");
      if (res.ok) {
        const data = await res.json();
        setServers(data.servers || []);
      }
    } catch (error) {
      console.error("Failed to fetch MCP servers", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchServers();
  }, []);

  const handleAction = async (name: string, action: "enable" | "disable" | "reload") => {
    const toastId = toast.loading(`${action === "enable" ? "Enabling" : action === "disable" ? "Disabling" : "Reloading"} ${name}...`);
    try {
      const res = await apiFetch(`/api/mcp/${name}/${action}`, { method: "POST" });
      if (res.ok) {
        toast.success(`${name} ${action}d successfully`, { id: toastId });
        fetchServers();
      } else {
        const err = await res.json();
        toast.error(err.error || `Failed to ${action} server`, { id: toastId });
      }
    } catch (error: any) {
      toast.error(error.message, { id: toastId });
    }
  };

  const handleDeleteServer = async (name: string) => {
    if (!confirm(`Are you sure you want to remove ${name}?`)) return;
    try {
      const res = await apiFetch(`/api/mcp/${name}`, { method: "DELETE" });
      if (res.ok) {
        toast.success(`${name} removed`);
        fetchServers();
      }
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const resetAddForm = () => {
    setNewServer({ name: "", type: "stdio", command: "", url: "", description: "" });
    setEnvVars([]);
    setHeaders([]);
  };

  const handleAddServer = async () => {
    if (!newServer.name) return;
    try {
      const env: Record<string, string> = {};
      envVars.forEach((kv) => { if (kv.key.trim()) env[kv.key.trim()] = kv.value; });

      const hdrs: Record<string, string> = {};
      headers.forEach((kv) => { if (kv.key.trim()) hdrs[kv.key.trim()] = kv.value; });

      const body: any = { name: newServer.name };
      if (newServer.description.trim()) body.description = newServer.description.trim();

      if (newServer.type === "stdio") {
        body.command = newServer.command;
        if (Object.keys(env).length > 0) body.env = env;
      } else {
        body.url = newServer.url;
        if (newServer.type === "sse") body.transport = "sse";
        if (Object.keys(hdrs).length > 0) body.headers = hdrs;
      }

      const res = await apiFetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        toast.success("Server added successfully");
        setIsAddDialogOpen(false);
        resetAddForm();
        fetchServers();
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to add server");
      }
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  // ── Configure credentials ─────────────────────────────────────────────────

  const openConfigDialog = (server: MCPServer) => {
    const keys = server.type === "stdio" ? (server.envKeys || []) : (server.headerKeys || []);
    setConfigValues(keys.map((k) => ({ key: k, value: "" })));
    setConfigServer(server);
  };

  const handleSaveConfig = async () => {
    if (!configServer) return;
    setConfigSaving(true);
    try {
      const isStdio = configServer.type === "stdio";
      const payload: Record<string, string> = {};
      for (const kv of configValues) {
        if (kv.key.trim() && kv.value.trim()) {
          payload[kv.key.trim()] = kv.value.trim();
        }
      }
      if (Object.keys(payload).length === 0) {
        toast.error("Enter at least one credential value");
        setConfigSaving(false);
        return;
      }

      const body = isStdio ? { env: payload } : { headers: payload };
      const res = await apiFetch(`/api/mcp/${configServer.name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        toast.success(`Credentials saved for ${configServer.name}`);
        setConfigServer(null);
        setConfigValues([]);
        // Auto-enable after configuring
        const enableRes = await apiFetch(`/api/mcp/${configServer.name}/enable`, { method: "POST" });
        if (enableRes.ok) {
          toast.success(`${configServer.name} activated`);
        }
        fetchServers();
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to save credentials");
      }
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setConfigSaving(false);
    }
  };

  // ── KV pair helpers ────────────────────────────────────────────────────────

  const addKVPair = (list: KVPair[], setList: (l: KVPair[]) => void) => {
    setList([...list, { key: "", value: "" }]);
  };

  const updateKVPair = (list: KVPair[], setList: (l: KVPair[]) => void, index: number, field: "key" | "value", val: string) => {
    const updated = [...list];
    updated[index][field] = val;
    setList(updated);
  };

  const removeKVPair = (list: KVPair[], setList: (l: KVPair[]) => void, index: number) => {
    setList(list.filter((_, i) => i !== index));
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-[#00d9ff] animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-white mb-2 uppercase tracking-tighter">MCP Servers</h2>
          <p className="text-gray-400 font-mono text-sm tracking-widest">EXTERNAL TOOL INTEGRATIONS</p>
        </div>
        <Dialog open={isAddDialogOpen} onOpenChange={(open) => { setIsAddDialogOpen(open); if (!open) resetAddForm(); }}>
          <DialogTrigger asChild>
            <Button className="bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] hover:opacity-90 text-white font-mono text-xs uppercase tracking-wider">
              <Plus className="w-4 h-4 mr-2" />
              Add Server
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-slate-950 border-slate-800 text-white border-2 shadow-[0_0_30px_rgba(0,217,255,0.1)] max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-white uppercase font-bold tracking-widest border-b border-slate-800 pb-4">New MCP Connection</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-4 font-mono">
              {/* Name */}
              <div className="space-y-2">
                <label className="text-[10px] text-gray-500 uppercase">Server Name</label>
                <Input
                  value={newServer.name}
                  onChange={(e) => setNewServer({ ...newServer, name: e.target.value })}
                  placeholder="e.g. github, slack, postgres"
                  className="bg-slate-900 border-slate-800 text-[#00d9ff] text-xs"
                />
              </div>

              {/* Description */}
              <div className="space-y-2">
                <label className="text-[10px] text-gray-500 uppercase">Description (optional)</label>
                <Input
                  value={newServer.description}
                  onChange={(e) => setNewServer({ ...newServer, description: e.target.value })}
                  placeholder="e.g. GitHub repos, PRs, issues"
                  className="bg-slate-900 border-slate-800 text-white text-xs"
                />
              </div>

              {/* Transport */}
              <div className="space-y-2">
                <label className="text-[10px] text-gray-500 uppercase">Transport Protocol</label>
                <Select
                  value={newServer.type}
                  onValueChange={(value: "stdio" | "http" | "sse") =>
                    setNewServer({ ...newServer, type: value })
                  }
                >
                  <SelectTrigger className="bg-slate-900 border-slate-800 text-white text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-950 border-slate-800 text-white">
                    <SelectItem value="stdio" className="text-xs">STDIO (LOCAL PROCESS)</SelectItem>
                    <SelectItem value="http" className="text-xs">HTTP (STREAMABLE)</SelectItem>
                    <SelectItem value="sse" className="text-xs">SSE (LEGACY)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Connection config */}
              {newServer.type === "stdio" ? (
                <div className="space-y-2">
                  <label className="text-[10px] text-gray-500 uppercase">Command</label>
                  <Input
                    value={newServer.command}
                    onChange={(e) => setNewServer({ ...newServer, command: e.target.value })}
                    placeholder="npx -y @modelcontextprotocol/server-github"
                    className="bg-slate-900 border-slate-800 text-white text-xs"
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <label className="text-[10px] text-gray-500 uppercase">Endpoint URL</label>
                  <Input
                    value={newServer.url}
                    onChange={(e) => setNewServer({ ...newServer, url: e.target.value })}
                    placeholder="https://mcp.example.com/sse"
                    className="bg-slate-900 border-slate-800 text-white text-xs"
                  />
                </div>
              )}

              {/* Env vars — for stdio servers */}
              {newServer.type === "stdio" && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] text-gray-500 uppercase flex items-center gap-1">
                      <Key className="w-3 h-3" /> Environment Variables
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => addKVPair(envVars, setEnvVars)}
                      className="text-[10px] text-[#00d9ff] hover:bg-[#00d9ff]/10 h-6 px-2"
                    >
                      <Plus className="w-3 h-3 mr-1" /> Add
                    </Button>
                  </div>
                  {envVars.length === 0 && (
                    <p className="text-[10px] text-gray-600 italic">No env vars. Click Add if server needs API keys.</p>
                  )}
                  {envVars.map((kv, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <Input
                        value={kv.key}
                        onChange={(e) => updateKVPair(envVars, setEnvVars, i, "key", e.target.value)}
                        placeholder="GITHUB_TOKEN"
                        className="bg-slate-900 border-slate-800 text-gray-300 text-xs flex-1"
                      />
                      <Input
                        type="password"
                        value={kv.value}
                        onChange={(e) => updateKVPair(envVars, setEnvVars, i, "value", e.target.value)}
                        placeholder="value or ${ENV_VAR}"
                        className="bg-slate-900 border-slate-800 text-gray-300 text-xs flex-1"
                      />
                      <button
                        onClick={() => removeKVPair(envVars, setEnvVars, i)}
                        className="text-gray-600 hover:text-red-400 shrink-0"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Headers — for HTTP/SSE servers */}
              {(newServer.type === "http" || newServer.type === "sse") && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] text-gray-500 uppercase flex items-center gap-1">
                      <Key className="w-3 h-3" /> Auth Headers
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => addKVPair(headers, setHeaders)}
                      className="text-[10px] text-[#00d9ff] hover:bg-[#00d9ff]/10 h-6 px-2"
                    >
                      <Plus className="w-3 h-3 mr-1" /> Add
                    </Button>
                  </div>
                  {headers.length === 0 && (
                    <p className="text-[10px] text-gray-600 italic">No headers. Click Add for auth (e.g. Authorization: Bearer token).</p>
                  )}
                  {headers.map((kv, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <Input
                        value={kv.key}
                        onChange={(e) => updateKVPair(headers, setHeaders, i, "key", e.target.value)}
                        placeholder="Authorization"
                        className="bg-slate-900 border-slate-800 text-gray-300 text-xs flex-[0.8]"
                      />
                      <Input
                        type="password"
                        value={kv.value}
                        onChange={(e) => updateKVPair(headers, setHeaders, i, "value", e.target.value)}
                        placeholder="Bearer ${MY_TOKEN}"
                        className="bg-slate-900 border-slate-800 text-gray-300 text-xs flex-1"
                      />
                      <button
                        onClick={() => removeKVPair(headers, setHeaders, i)}
                        className="text-gray-600 hover:text-red-400 shrink-0"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  {headers.length > 0 && (
                    <p className="text-[9px] text-gray-600">Use {"${ENV_VAR}"} to reference .env values instead of pasting secrets.</p>
                  )}
                </div>
              )}

              {/* Submit */}
              <Button
                onClick={handleAddServer}
                disabled={!newServer.name || (newServer.type === "stdio" ? !newServer.command : !newServer.url)}
                className="w-full bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] hover:opacity-90 text-white mt-4 uppercase tracking-tighter"
              >
                Add Server
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* ── Configure Credentials Dialog ───────────────────────────────────── */}
      <Dialog open={!!configServer} onOpenChange={(open) => { if (!open) { setConfigServer(null); setConfigValues([]); } }}>
        <DialogContent className="bg-slate-950 border-slate-800 text-white border-2 shadow-[0_0_30px_rgba(0,217,255,0.1)]">
          <DialogHeader>
            <DialogTitle className="text-white uppercase font-bold tracking-widest border-b border-slate-800 pb-4 flex items-center gap-2">
              <Key className="w-4 h-4 text-[#00d9ff]" />
              Configure {configServer?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2 font-mono">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">
              Enter credentials to enable this server. Values are saved to config/mcp.json.
            </p>
            {configValues.map((kv, i) => (
              <div key={i} className="space-y-1.5">
                <label className="text-[10px] text-gray-400 uppercase">{kv.key}</label>
                <Input
                  type="password"
                  value={kv.value}
                  onChange={(e) => {
                    const updated = [...configValues];
                    updated[i].value = e.target.value;
                    setConfigValues(updated);
                  }}
                  placeholder={`Enter ${kv.key}...`}
                  className="bg-slate-900 border-slate-800 text-white text-xs"
                />
              </div>
            ))}
            {/* Allow adding extra keys */}
            {configValues.length === 0 && (
              <div className="space-y-2">
                <p className="text-[10px] text-gray-600 italic">No credential keys configured. Add one below.</p>
                <div className="flex gap-2">
                  <Input
                    placeholder="KEY_NAME"
                    className="bg-slate-900 border-slate-800 text-gray-300 text-xs"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.target as HTMLInputElement).value.trim()) {
                        setConfigValues([...configValues, { key: (e.target as HTMLInputElement).value.trim(), value: "" }]);
                        (e.target as HTMLInputElement).value = "";
                      }
                    }}
                  />
                </div>
              </div>
            )}
            <Button
              onClick={handleSaveConfig}
              disabled={configSaving || configValues.every((kv) => !kv.value.trim())}
              className="w-full bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] hover:opacity-90 text-white mt-2 uppercase tracking-tighter"
            >
              {configSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Key className="w-4 h-4 mr-2" />}
              Save & Activate
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Servers List */}
      <div className="grid grid-cols-1 gap-4">
        {servers.length === 0 ? (
          <div className="text-center py-20 border-2 border-dashed border-slate-800 rounded-xl bg-slate-900/20">
            <p className="text-gray-600 font-mono uppercase tracking-widest text-xs">NO MCP SERVERS CONFIGURED</p>
          </div>
        ) : (
          servers.map((server) => {
            const hasCredKeys = (server.envKeys && server.envKeys.length > 0) || (server.headerKeys && server.headerKeys.length > 0);

            return (
              <Card
                key={server.name}
                className={`bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl transition-all border-l-4 ${server.connected ? 'border-l-[#00ff88]' : 'border-l-slate-700'}`}
              >
                <CardHeader className="py-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className={`w-2 h-2 rounded-full ${server.connected ? "bg-[#00ff88] shadow-[0_0_8px_rgba(0,255,136,0.5)]" : "bg-slate-700"}`} />
                      <div>
                        <div className="flex items-center gap-2">
                          <CardTitle className="text-white font-mono text-lg uppercase tracking-tight">{server.name}</CardTitle>
                          {!server.connected && server.enabled && (
                            <div className="flex items-center gap-1 text-[9px] text-red-400 font-mono uppercase bg-red-500/10 px-1.5 py-0.5 rounded border border-red-500/20">
                              <AlertTriangle className="w-2.5 h-2.5" />
                              Connection Failed
                            </div>
                          )}
                          {!server.enabled && server.needsConfig && (
                            <Badge variant="outline" className="text-[9px] text-amber-500 border-amber-700/40 bg-amber-500/5">NEEDS CREDENTIALS</Badge>
                          )}
                          {!server.enabled && !server.needsConfig && (
                            <Badge variant="outline" className="text-[9px] text-gray-500 border-gray-700">DISABLED</Badge>
                          )}
                        </div>
                        {server.description && (
                          <p className="text-gray-400 text-[11px] mt-0.5">{server.description}</p>
                        )}
                        <CardDescription className="text-gray-500 font-mono text-[10px] mt-0.5 uppercase flex items-center gap-2">
                          {server.type === "stdio" ? <Cpu className="w-3 h-3" /> : <Globe className="w-3 h-3" />}
                          {server.type === "stdio" ? server.command : server.url}
                        </CardDescription>
                        {/* Show configured auth keys (names only, not values) */}
                        {hasCredKeys && (
                          <div className="flex items-center gap-1.5 mt-1">
                            <Key className="w-3 h-3 text-gray-600" />
                            {server.envKeys?.map((k) => (
                              <Badge key={k} variant="outline" className="text-[8px] text-gray-500 border-gray-800 font-mono">{k}</Badge>
                            ))}
                            {server.headerKeys?.map((k) => (
                              <Badge key={k} variant="outline" className="text-[8px] text-amber-600/70 border-amber-900/30 font-mono">{k}</Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Configure button — shown when server needs credentials or has configurable keys */}
                      {hasCredKeys && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openConfigDialog(server)}
                          className={`font-mono text-[10px] uppercase ${server.needsConfig ? 'text-amber-500 hover:bg-amber-500/10' : 'text-gray-400 hover:bg-slate-800'}`}
                        >
                          <Settings className="w-3 h-3 mr-1" />
                          Configure
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleAction(server.name, server.enabled ? "disable" : "enable")}
                        disabled={!server.enabled && server.needsConfig}
                        title={!server.enabled && server.needsConfig ? "Configure credentials first" : undefined}
                        className={`font-mono text-[10px] uppercase ${server.enabled ? 'text-amber-500 hover:bg-amber-500/10' : server.needsConfig ? 'text-gray-600 cursor-not-allowed opacity-40' : 'text-[#00ff88] hover:bg-[#00ff88]/10'}`}
                      >
                        {server.enabled ? <Pause className="w-3 h-3 mr-1" /> : <Play className="w-3 h-3 mr-1" />}
                        {server.enabled ? "Suspend" : "Activate"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleAction(server.name, "reload")}
                        className="text-gray-400 hover:text-white font-mono text-[10px] uppercase hover:bg-slate-800"
                      >
                        <RefreshCw className="w-3 h-3 mr-1" />
                        Sync
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDeleteServer(server.name)}
                        className="text-red-500/70 hover:text-red-500 font-mono text-[10px] uppercase hover:bg-red-500/10"
                      >
                        <Trash2 className="w-3 h-3 mr-1" />
                        Remove
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pb-4">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-[10px] font-mono text-gray-500 uppercase tracking-widest border-b border-slate-800 pb-2">
                      <span>Active Tools</span>
                      <span className="text-[#00d9ff]">{server.tools?.length || 0} Tools</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {!server.connected && server.enabled ? (
                        <div className="p-3 bg-slate-950/50 border border-slate-800 rounded w-full">
                          <p className="text-[10px] text-amber-500/70 font-mono leading-relaxed uppercase">
                            Server offline. Check credentials or CLI configuration.
                            Some servers require valid API keys to connect.
                          </p>
                        </div>
                      ) : server.tools && server.tools.length > 0 ? (
                        server.tools.map((tool: any) => (
                          <Badge
                            key={tool.name || tool}
                            variant="outline"
                            className="bg-slate-950/50 text-gray-400 border-slate-800 font-mono text-[10px] hover:text-[#00d9ff] hover:border-[#00d9ff]/30 transition-colors"
                          >
                            {tool.name || tool}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-[10px] text-gray-600 font-mono italic lowercase tracking-tight">
                          {server.enabled ? "no tools exported" : server.needsConfig ? "configure credentials to activate" : "server disabled"}
                        </span>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
