import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { Play, Pause, RefreshCw, Plus, Trash2, Loader2, Globe, Cpu, AlertTriangle, Key, X, Settings } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter, AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel } from "../components/ui/alert-dialog";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";

interface MCPArgField {
  index: number;
  label: string;
  kind: "path" | "text";
  hint?: string;
  value: string;
}

interface MCPServer {
  name: string;
  enabled: boolean;
  connected: boolean;
  configured: boolean;
  tools: any[];
  /** Backend returns `transport` with values "stdio" | "http" | "sse" | "unknown". */
  transport?: "stdio" | "http" | "sse" | "unknown";
  /** Legacy alias — kept for any code still referencing `type`. */
  type?: "stdio" | "http" | "sse";
  command?: string;
  url?: string;
  description?: string | null;
  status?: string;
  error?: string;
  /** Required env keys declared by the built-in defaults (names only, values live in vault). */
  requiredEnv?: string[];
  /** Required env keys that are still missing a value — drives the "needs config" state. */
  missingEnv?: string[];
  /** Positional args the user can override — e.g. filesystem path. */
  argFields?: MCPArgField[];
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

  // Confirm dialog state
  const [confirmState, setConfirmState] = useState<{ open: boolean; title: string; description?: string; onConfirm: () => void }>({ open: false, title: "", onConfirm: () => {} });

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

  const handleDeleteServer = (name: string) => {
    setConfirmState({
      open: true,
      title: `Remove ${name}?`,
      description: "Are you sure you want to remove this MCP server?",
      onConfirm: async () => {
        try {
          const res = await apiFetch(`/api/mcp/${name}`, { method: "DELETE" });
          if (res.ok) {
            toast.success(`${name} removed`);
            fetchServers();
          }
        } catch (error: any) {
          toast.error(error.message);
        }
      },
    });
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

  // ── Activate / configure flow ────────────────────────────────────────────
  //
  // Activation has two paths:
  //   • "Already configured" — the server has no missing env and no
  //     argFields the user wants to override → one-click POST /activate.
  //   • "Needs config" — render a dialog collecting env values (secrets,
  //     go to vault) + argFields (paths / connection strings stay in
  //     mcp.json), then POST /activate with env + args together.

  const needsDialog = (server: MCPServer): boolean => {
    const missing = server.missingEnv?.length ?? 0;
    const hasArgs = (server.argFields?.length ?? 0) > 0;
    return missing > 0 || hasArgs;
  };

  const openConfigDialog = (server: MCPServer) => {
    const kvs: KVPair[] = [];
    for (const key of server.requiredEnv ?? []) {
      kvs.push({ key, value: "" });
    }
    for (const field of server.argFields ?? []) {
      kvs.push({ key: `__arg_${field.index}`, value: field.value });
    }
    setConfigValues(kvs);
    setConfigServer(server);
  };

  const postActivate = async (
    name: string,
    body: { env?: Record<string, string>; args?: Record<string, string> },
  ): Promise<boolean> => {
    const res = await apiFetch(`/api/mcp/${name}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return true;
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (res.status === 423) {
      toast.error("Vault is locked — unlock it in Settings first.");
    } else if (res.status === 400 && err.missingEnv?.length) {
      toast.error(`Missing: ${err.missingEnv.join(", ")}`);
    } else {
      toast.error(err.error || "Activation failed");
    }
    return false;
  };

  const activateDirect = async (server: MCPServer) => {
    const toastId = toast.loading(`Activating ${server.name}...`);
    const ok = await postActivate(server.name, {});
    if (ok) toast.success(`${server.name} activated`, { id: toastId });
    else toast.dismiss(toastId);
    fetchServers();
  };

  const deactivate = async (server: MCPServer) => {
    const toastId = toast.loading(`Deactivating ${server.name}...`);
    const res = await apiFetch(`/api/mcp/${server.name}/deactivate`, { method: "POST" });
    if (res.ok) toast.success(`${server.name} deactivated`, { id: toastId });
    else toast.error("Failed to deactivate", { id: toastId });
    fetchServers();
  };

  const handleSaveConfig = async () => {
    if (!configServer) return;
    setConfigSaving(true);
    try {
      const env: Record<string, string> = {};
      const args: Record<string, string> = {};
      for (const kv of configValues) {
        const key = kv.key.trim();
        const value = kv.value.trim();
        if (!key) continue;
        if (key.startsWith("__arg_")) {
          if (value) args[key.replace("__arg_", "")] = value;
        } else if (value) {
          env[key] = value;
        }
      }

      // A second+ activation with no new values is still valid — the
      // backend treats empty env as "keep existing vault values". But we
      // at least warn when the user hasn't typed anything AND the server
      // still has missing env.
      const missing = (configServer.missingEnv ?? []).filter((k) => !env[k]);
      if (Object.keys(env).length === 0 && Object.keys(args).length === 0 && missing.length > 0) {
        toast.error(`Fill in: ${missing.join(", ")}`);
        setConfigSaving(false);
        return;
      }

      const body: { env?: Record<string, string>; args?: Record<string, string> } = {};
      if (Object.keys(env).length > 0) body.env = env;
      if (Object.keys(args).length > 0) body.args = args;

      const ok = await postActivate(configServer.name, body);
      if (ok) {
        toast.success(`${configServer.name} activated`);
        setConfigServer(null);
        setConfigValues([]);
      }
      fetchServers();
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

              {/* Env vars - for stdio servers */}
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

              {/* Headers - for HTTP/SSE servers */}
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
            <p className="text-[10px] text-gray-500 uppercase tracking-wider leading-relaxed">
              Secrets (API keys, tokens) go to the encrypted vault. Paths and connection strings stay in mcp.json.
              Leave any field blank to keep its current stored value.
            </p>
            {configValues.map((kv, i) => {
              const isArg = kv.key.startsWith("__arg_");
              const argField = isArg
                ? configServer?.argFields?.find((f) => `__arg_${f.index}` === kv.key)
                : undefined;
              const label = isArg
                ? argField?.label ?? `Argument [${kv.key.replace("__arg_", "")}]`
                : kv.key;
              const hint = isArg
                ? argField?.hint
                : configServer?.missingEnv?.includes(kv.key)
                  ? "Required — not yet set"
                  : "Already stored in vault (leave blank to keep)";
              return (
                <div key={i} className="space-y-1.5">
                  <label className="text-[10px] text-gray-400 uppercase">{label}</label>
                  <Input
                    type={isArg ? "text" : "password"}
                    value={kv.value}
                    onChange={(e) => {
                      const updated = [...configValues];
                      updated[i].value = e.target.value;
                      setConfigValues(updated);
                    }}
                    placeholder={isArg ? (argField?.value ?? "") : `Enter ${kv.key}…`}
                    className="bg-slate-900 border-slate-800 text-white text-xs"
                  />
                  {hint && (
                    <p className="text-[9px] text-gray-600 font-mono">{hint}</p>
                  )}
                </div>
              );
            })}
            {configValues.length === 0 && (
              <p className="text-[10px] text-gray-600 italic">No required fields — this server can be activated directly.</p>
            )}
            <Button
              onClick={handleSaveConfig}
              disabled={configSaving}
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
            // Badge state machine:
            //   ACTIVE          — enabled + connected
            //   CONNECTION FAILED — enabled but couldn't connect (tools/list failed, crashed, etc.)
            //   CONFIGURED      — disabled, but all required env + args are set; one-click activate
            //   NEEDS CONFIG    — disabled, missing required env or args; Activate opens dialog
            //   DISABLED        — disabled, no config needed (rare: keyless servers the user turned off)
            const hasConfigurable = (server.requiredEnv?.length ?? 0) > 0 || (server.argFields?.length ?? 0) > 0;
            const needsConfig = !server.configured;
            const connectionFailed = server.enabled && !server.connected;

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
                          {server.enabled && server.connected && (
                            <Badge variant="outline" className="text-[9px] text-[#00ff88] border-[#00ff88]/40 bg-[#00ff88]/5">ACTIVE</Badge>
                          )}
                          {connectionFailed && (
                            <div className="flex items-center gap-1 text-[9px] text-red-400 font-mono uppercase bg-red-500/10 px-1.5 py-0.5 rounded border border-red-500/20">
                              <AlertTriangle className="w-2.5 h-2.5" />
                              Connection Failed
                            </div>
                          )}
                          {!server.enabled && needsConfig && (
                            <Badge variant="outline" className="text-[9px] text-amber-500 border-amber-700/40 bg-amber-500/5">NEEDS CONFIG</Badge>
                          )}
                          {!server.enabled && !needsConfig && (
                            <Badge variant="outline" className="text-[9px] text-sky-400 border-sky-700/40 bg-sky-500/5">CONFIGURED</Badge>
                          )}
                        </div>
                        {server.description && (
                          <p className="text-gray-400 text-[11px] mt-0.5">{server.description}</p>
                        )}
                        <CardDescription className="text-gray-500 font-mono text-[10px] mt-0.5 uppercase flex items-center gap-2">
                          {server.transport === "stdio" || server.type === "stdio" ? <Cpu className="w-3 h-3" /> : <Globe className="w-3 h-3" />}
                          {server.transport === "stdio" || server.type === "stdio" ? server.command : server.url}
                        </CardDescription>
                        {/* Required env keys — names only, values never leave the vault. */}
                        {(server.requiredEnv?.length ?? 0) > 0 && (
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            <Key className="w-3 h-3 text-gray-600" />
                            {server.requiredEnv?.map((k) => {
                              const isMissing = (server.missingEnv ?? []).includes(k);
                              return (
                                <Badge
                                  key={k}
                                  variant="outline"
                                  className={`text-[8px] font-mono ${isMissing ? 'text-amber-500 border-amber-900/40' : 'text-emerald-500/80 border-emerald-900/40'}`}
                                >
                                  {isMissing ? "✗" : "✓"} {k}
                                </Badge>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Configure — shown when the server has configurable fields and the user wants to edit them. */}
                      {hasConfigurable && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openConfigDialog(server)}
                          className={`font-mono text-[10px] uppercase ${needsConfig ? 'text-amber-500 hover:bg-amber-500/10' : 'text-gray-400 hover:bg-slate-800'}`}
                        >
                          <Settings className="w-3 h-3 mr-1" />
                          Configure
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (server.enabled) {
                            deactivate(server);
                            return;
                          }
                          if (needsDialog(server)) {
                            openConfigDialog(server);
                          } else {
                            activateDirect(server);
                          }
                        }}
                        className={`font-mono text-[10px] uppercase ${server.enabled ? 'text-amber-500 hover:bg-amber-500/10' : 'text-[#00ff88] hover:bg-[#00ff88]/10'}`}
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

      <AlertDialog open={confirmState.open} onOpenChange={(open) => setConfirmState((s) => ({ ...s, open }))}>
        <AlertDialogContent className="bg-slate-900 border border-slate-700 text-white">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white font-mono uppercase text-sm tracking-wide">{confirmState.title}</AlertDialogTitle>
            {confirmState.description && (
              <AlertDialogDescription className="text-gray-400 font-mono text-xs">{confirmState.description}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-slate-800 border-slate-700 text-gray-300 hover:bg-slate-700 font-mono text-xs uppercase">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 font-mono text-xs uppercase"
              onClick={() => { confirmState.onConfirm(); setConfirmState((s) => ({ ...s, open: false })); }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
