import { useEffect, useState } from "react";
import { Boxes, Play, Pause, RefreshCw, Plus, Trash2, Loader2, Globe, Cpu, AlertTriangle } from "lucide-react";
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
}

export function MCP() {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [newServer, setNewServer] = useState({
    name: "",
    type: "stdio" as "stdio" | "http",
    command: "",
    url: "",
  });

  const fetchServers = async () => {
    try {
      const res = await fetch("/api/mcp");
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
    const toastId = toast.loading(`${action.toUpperCase()}ING NODE ${name}...`);
    try {
      const res = await fetch(`/api/mcp/${name}/${action}`, { method: "POST" });
      if (res.ok) {
        toast.success(`NODE ${name} ${action.toUpperCase()} SUCCESSFUL`, { id: toastId });
        fetchServers();
      } else {
        const err = await res.json();
        toast.error(err.error || `FAILED TO ${action.toUpperCase()} NODE`, { id: toastId });
      }
    } catch (error: any) {
      toast.error(error.message, { id: toastId });
    }
  };

  const handleDeleteServer = async (name: string) => {
    if (!confirm(`Are you sure you want to remove ${name}?`)) return;
    try {
      const res = await fetch(`/api/mcp/${name}`, { method: "DELETE" });
      if (res.ok) {
        toast.success(`NODE ${name} PURGED`);
        fetchServers();
      }
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const handleAddServer = async () => {
    if (!newServer.name) return;
    try {
      const body = newServer.type === "stdio" 
        ? { name: newServer.name, command: newServer.command }
        : { name: newServer.name, url: newServer.url, transport: newServer.type };
        
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        toast.success("NEW NODE ESTABLISHED");
        setIsAddDialogOpen(false);
        setNewServer({ name: "", type: "stdio", command: "", url: "" });
        fetchServers();
      } else {
        const err = await res.json();
        toast.error(err.error || "LINK ESTABLISHMENT FAILED");
      }
    } catch (error: any) {
      toast.error(error.message);
    }
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
          <h2 className="text-3xl font-bold text-white mb-2 uppercase tracking-tighter">MCP Grid</h2>
          <p className="text-gray-400 font-mono text-sm tracking-widest">NEURAL EXTENSIONS // TOOL SERVERS</p>
        </div>
        <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] hover:opacity-90 text-white font-mono text-xs uppercase tracking-wider">
              <Plus className="w-4 h-4 mr-2" />
              Initialize Node
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-slate-950 border-slate-800 text-white border-2 shadow-[0_0_30px_rgba(0,217,255,0.1)]">
            <DialogHeader>
              <DialogTitle className="text-white uppercase font-bold tracking-widest border-b border-slate-800 pb-4">New MCP Connection</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-4 font-mono">
              <div className="space-y-2">
                <label className="text-[10px] text-gray-500 uppercase">Node Identifier</label>
                <Input
                  value={newServer.name}
                  onChange={(e) => setNewServer({ ...newServer, name: e.target.value })}
                  placeholder="e.g. postgres-db"
                  className="bg-slate-900 border-slate-800 text-[#00d9ff] text-xs"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] text-gray-500 uppercase">Transport Protocol</label>
                <Select
                  value={newServer.type}
                  onValueChange={(value: "stdio" | "http") =>
                    setNewServer({ ...newServer, type: value })
                  }
                >
                  <SelectTrigger className="bg-slate-900 border-slate-800 text-white text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-950 border-slate-800 text-white">
                    <SelectItem value="stdio" className="text-xs">STDIO (LOCAL)</SelectItem>
                    <SelectItem value="http" className="text-xs">HTTP/SSE (REMOTE)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {newServer.type === "stdio" ? (
                <div className="space-y-2">
                  <label className="text-[10px] text-gray-500 uppercase">Binary / Command</label>
                  <Input
                    value={newServer.command}
                    onChange={(e) => setNewServer({ ...newServer, command: e.target.value })}
                    placeholder="npx -y @modelcontextprotocol/server-postgres"
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
              <Button
                onClick={handleAddServer}
                disabled={!newServer.name}
                className="w-full bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] hover:opacity-90 text-white mt-4 uppercase tracking-tighter"
              >
                Establish Link
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Servers List */}
      <div className="grid grid-cols-1 gap-4">
        {servers.length === 0 ? (
          <div className="text-center py-20 border-2 border-dashed border-slate-800 rounded-xl bg-slate-900/20">
            <p className="text-gray-600 font-mono uppercase tracking-widest text-xs">NO MCP NODES REGISTERED</p>
          </div>
        ) : (
          servers.map((server) => (
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
                      </div>
                      <CardDescription className="text-gray-500 font-mono text-[10px] mt-0.5 uppercase flex items-center gap-2">
                        {server.type === "stdio" ? <Cpu className="w-3 h-3" /> : <Globe className="w-3 h-3" />}
                        {server.type === "stdio" ? server.command : server.url}
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleAction(server.name, server.enabled ? "disable" : "enable")}
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
                      Purge
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pb-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-[10px] font-mono text-gray-500 uppercase tracking-widest border-b border-slate-800 pb-2">
                    <span>Active Tools</span>
                    <span className="text-[#00d9ff]">{server.tools?.length || 0} Subroutines</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {!server.connected && server.enabled ? (
                      <div className="p-3 bg-slate-950/50 border border-slate-800 rounded w-full">
                        <p className="text-[10px] text-amber-500/70 font-mono leading-relaxed uppercase">
                          NODE OFFLINE. CHECK .ENV CREDENTIALS OR CLI CONFIGURATION. 
                          SOME NODES REQUIRE VALID API KEYS TO INITIALIZE.
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
                      <span className="text-[10px] text-gray-600 font-mono italic lowercase tracking-tight">no tools exported by node</span>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
