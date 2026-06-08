import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import { Network, Power, Plus, X, Loader2, Link2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "../lib/api-client";
import { apiFetch } from "../api";
import { PageHeader, Card, Btn, Loading, EmptyState, Pill, Toggle } from "../components/kit";

interface McpServer {
  name: string; status?: string; connected?: boolean; configured?: boolean;
  description?: string; transport?: string; tools?: unknown[];
  requiredEnv?: string[]; missingEnv?: string[];
}

const isOn = (s: McpServer) => s.status === "connected" || s.connected === true;

export function MCP() {
  const qc = useQueryClient();
  const servers = useQuery({ queryKey: ["mcp"], queryFn: () => api.get<{ servers?: McpServer[] }>("/api/mcp").then((d) => d.servers ?? (d as unknown as McpServer[]) ?? []) });
  const list = Array.isArray(servers.data) ? servers.data : [];
  const [configuring, setConfiguring] = useState<McpServer | null>(null);
  const [adding, setAdding] = useState(false);
  const [oauthFor, setOauthFor] = useState<McpServer | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["mcp"] });

  // OAuth (github/notion etc.) reuses the integrations OAuth: start → open the
  // provider's authorize URL. If the OAuth app creds aren't set, ask for them.
  const connectOAuth = async (s: McpServer) => {
    try {
      const r = await apiFetch(`/api/integrations/${s.name}/start`, { method: "POST", body: JSON.stringify({ uiOrigin: window.location.origin }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.url) { window.open(d.url, "_blank", "noopener"); toast.success("Authorize in the new tab, then toggle it on."); refresh(); }
      else setOauthFor(s); // needs the OAuth app's CLIENT_ID / CLIENT_SECRET
    } catch { setOauthFor(s); }
  };

  const enable = async (s: McpServer) => {
    if ((s.missingEnv?.length ?? 0) > 0) { setConfiguring(s); return; } // needs config first
    try {
      const r = await apiFetch(`/api/mcp/${s.name}/enable`, { method: "POST" });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || d.message || "failed"); }
      refresh(); toast.success(`${s.name} enabled`);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  };
  const disable = async (s: McpServer) => {
    try { await apiFetch(`/api/mcp/${s.name}/disable`, { method: "POST" }); refresh(); toast.success(`${s.name} disabled`); }
    catch { toast.error("Failed"); }
  };

  return (
    <div>
      <PageHeader title="MCP" description="Model Context Protocol servers — extra tools the agent can call." icon={Network}
        actions={<Btn onClick={() => setAdding(true)}><Plus className="w-4 h-4" /> Add server</Btn>} />
      {servers.isLoading ? <Loading /> : list.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {list.map((s) => {
            const on = isOn(s);
            const needsConfig = (s.missingEnv?.length ?? 0) > 0;
            return (
              <Card key={s.name} className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-100">{s.name}</span>
                  <div className="flex items-center gap-1.5">
                    {s.transport === "http" ? <Pill tone="warn">OAuth</Pill> : s.transport && <Pill>{s.transport}</Pill>}
                    <Pill tone={on ? "ok" : "off"}>{on ? "On" : "Off"}</Pill>
                  </div>
                </div>
                {s.description && <div className="text-xs text-gray-400 mt-1 line-clamp-2">{s.description}</div>}
                <div className="flex items-center justify-between mt-3 gap-2">
                  <span className="text-xs text-gray-500 truncate">{Array.isArray(s.tools) && s.tools.length ? `${s.tools.length} tools` : needsConfig ? <button className="text-[#ffaa00] hover:underline" onClick={() => setConfiguring(s)}>Needs config</button> : ""}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    {s.transport === "http" && <Btn variant="ghost" onClick={() => void connectOAuth(s)}><Link2 className="w-3.5 h-3.5" /> Connect</Btn>}
                    <Toggle checked={on} onChange={() => (on ? void disable(s) : void enable(s))} />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      ) : <EmptyState icon={Power} title="No MCP servers" hint="Add one to extend the agent with external tools." action={<div className="mt-2"><Btn onClick={() => setAdding(true)}><Plus className="w-4 h-4" /> Add server</Btn></div>} />}

      <AnimatePresence>
        {configuring && <ConfigModal server={configuring} onClose={() => setConfiguring(null)} onDone={() => { setConfiguring(null); refresh(); }} />}
        {adding && <AddModal onClose={() => setAdding(false)} onDone={() => { setAdding(false); refresh(); }} />}
        {oauthFor && <OAuthModal server={oauthFor} onClose={() => setOauthFor(null)} onSaved={() => { const s = oauthFor; setOauthFor(null); if (s) void connectOAuth(s); }} />}
      </AnimatePresence>
    </div>
  );
}

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div className="absolute inset-0 bg-black/60" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }} className="relative w-full max-w-md rounded-2xl border border-slate-700/60 bg-slate-900 p-5">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-gray-300"><X className="w-4 h-4" /></button>
        <h3 className="text-base font-semibold text-white mb-4 flex items-center gap-2"><Network className="w-4 h-4 text-[#00d9ff]" />{title}</h3>
        {children}
      </motion.div>
    </div>
  );
}

function ConfigModal({ server, onClose, onDone }: { server: McpServer; onClose: () => void; onDone: () => void }) {
  const keys = server.missingEnv ?? server.requiredEnv ?? [];
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const enable = async () => {
    setBusy(true);
    try {
      const updates: Record<string, string> = {};
      for (const k of keys) if ((vals[k] ?? "").trim()) updates[k] = vals[k];
      if (Object.keys(updates).length) {
        const r = await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify({ updates }) });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.message || "Couldn't save (unlock vault?)"); }
      }
      const e = await apiFetch(`/api/mcp/${server.name}/enable`, { method: "POST" });
      if (!e.ok) { const d = await e.json().catch(() => ({})); throw new Error(d.error || "Couldn't enable"); }
      toast.success(`${server.name} enabled`); onDone();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); } finally { setBusy(false); }
  };
  return (
    <Shell title={`Configure ${server.name}`} onClose={onClose}>
      <p className="text-xs text-gray-400 mb-4">This server needs these values to connect (stored encrypted):</p>
      <div className="space-y-3 mb-4">
        {keys.map((k) => (
          <div key={k}>
            <label className="text-xs text-gray-400">{k}</label>
            <input type="password" value={vals[k] ?? ""} onChange={(e) => setVals((s) => ({ ...s, [k]: e.target.value }))} placeholder={k}
              className="w-full mt-1 px-3 py-2 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50 font-mono" />
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={() => void enable()} disabled={busy || !keys.every((k) => (vals[k] ?? "").trim())}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Power className="w-4 h-4" />} Save & enable</Btn>
      </div>
    </Shell>
  );
}

function AddModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!name.trim() || !command.trim()) return;
    setBusy(true);
    try {
      const envObj: Record<string, string> = {};
      for (const line of env.split("\n")) { const i = line.indexOf("="); if (i > 0) envObj[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
      const r = await apiFetch("/api/mcp", { method: "POST", body: JSON.stringify({ name, command, args: args.split(/\s+/).filter(Boolean), env: envObj }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || d.message || "Couldn't add"); }
      toast.success("MCP server added"); onDone();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); } finally { setBusy(false); }
  };
  return (
    <Shell title="Add custom MCP server" onClose={onClose}>
      <div className="space-y-3 mb-4">
        <Field label="Name" value={name} onChange={setName} placeholder="my-server" />
        <Field label="Command" value={command} onChange={setCommand} placeholder="npx -y @scope/mcp-server" mono />
        <Field label="Args (space-separated, optional)" value={args} onChange={setArgs} placeholder="--port 1234" mono />
        <div>
          <label className="text-xs text-gray-400">Env (KEY=value per line, optional)</label>
          <textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={3} placeholder="API_KEY=..." className="w-full mt-1 px-3 py-2 bg-slate-900/60 border border-slate-700/60 rounded-lg text-xs font-mono text-gray-100 outline-none focus:border-[#00d9ff]/50" />
        </div>
        <p className="text-[11px] text-gray-500">Stdio (command) servers. HTTP/SSE transport support is coming.</p>
      </div>
      <div className="flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={() => void add()} disabled={busy || !name.trim() || !command.trim()}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add</Btn>
      </div>
    </Shell>
  );
}

function OAuthModal({ server, onClose, onSaved }: { server: McpServer; onClose: () => void; onSaved: () => void }) {
  const P = server.name.toUpperCase();
  const idKey = `${P}_CLIENT_ID`; const secretKey = `${P}_CLIENT_SECRET`;
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!clientId.trim() || !secret.trim()) return;
    setBusy(true);
    try {
      const r = await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify({ updates: { [idKey]: clientId.trim(), [secretKey]: secret.trim() } }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.message || "Couldn't save (unlock vault?)"); }
      toast.success("OAuth app saved — starting sign-in"); onSaved();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); } finally { setBusy(false); }
  };
  return (
    <Shell title={`Connect ${server.name} (OAuth)`} onClose={onClose}>
      <p className="text-xs text-gray-400 mb-4">This needs your OAuth app credentials (create an app in {server.name}'s developer portal, set the redirect to this site). Stored encrypted.</p>
      <div className="space-y-3 mb-4">
        <Field label={idKey} value={clientId} onChange={setClientId} placeholder="client id" mono />
        <div>
          <label className="text-xs text-gray-400">{secretKey}</label>
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="client secret"
            className="w-full mt-1 px-3 py-2 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50 font-mono" />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={() => void save()} disabled={busy || !clientId.trim() || !secret.trim()}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />} Save & sign in</Btn>
      </div>
    </Shell>
  );
}

function Field({ label, value, onChange, placeholder, mono }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return (
    <div>
      <label className="text-xs text-gray-400">{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className={`w-full mt-1 px-3 py-2 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50 ${mono ? "font-mono" : ""}`} />
    </div>
  );
}
