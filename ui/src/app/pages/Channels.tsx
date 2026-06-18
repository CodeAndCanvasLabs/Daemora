import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import { Radio, X, Power, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "../lib/api-client";
import { apiFetch } from "../api";
import { PageHeader, Card, Btn, Loading, EmptyState, Pill, Toggle } from "../components/kit";

interface RequiredKey { key: string; label: string; secret: boolean }
interface Channel { id: string; name?: string; label?: string; running?: boolean; configured?: boolean; description?: string; requiredKeys?: RequiredKey[]; missingKeys?: Array<string | RequiredKey> }

/** Fields the config modal should ask for — prefer the rich requiredKeys, fall back to missingKeys. */
function fieldsFor(c: Channel): RequiredKey[] {
  if (c.requiredKeys && c.requiredKeys.length) return c.requiredKeys;
  return (c.missingKeys ?? []).map((k) => (typeof k === "string" ? { key: k, label: k, secret: true } : k));
}

export function Channels() {
  const qc = useQueryClient();
  const channels = useQuery({ queryKey: ["channels"], queryFn: () => api.get<{ channels?: Channel[] }>("/api/channels").then((d) => d.channels ?? (d as unknown as Channel[]) ?? []) });
  const list = Array.isArray(channels.data) ? channels.data : [];
  const [configuring, setConfiguring] = useState<Channel | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["channels"] });

  const stop = async (c: Channel) => {
    try { await apiFetch(`/api/channels/${c.id}/stop`, { method: "POST" }); refresh(); toast.success(`${c.name || c.id} stopped`); }
    catch { toast.error("Failed to stop"); }
  };

  return (
    <div>
      <PageHeader title="Channels" description="Reach the agent from Discord, Slack, WhatsApp, Telegram and more. Inbound messages land in your active chat." icon={Radio} />
      {channels.isLoading ? <Loading /> : list.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {list.map((c) => (
            <Card key={c.id} className="p-4 cursor-pointer" onClick={() => (c.running ? void stop(c) : setConfiguring(c))}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-100 capitalize">{c.name || c.label || c.id}</span>
                <Pill tone={c.running ? "ok" : "off"}>{c.running ? "Live" : "Off"}</Pill>
              </div>
              <div className="flex items-center justify-between mt-3" onClick={(e) => e.stopPropagation()}>
                <span className="text-xs text-gray-500">{c.running ? "Connected" : "Needs config"}</span>
                <Toggle checked={!!c.running} onChange={() => (c.running ? void stop(c) : setConfiguring(c))} />
              </div>
            </Card>
          ))}
        </div>
      ) : <EmptyState icon={Radio} title="No channels available" hint="Add channel secrets to connect one." />}

      <AnimatePresence>
        {configuring && <ConfigModal channel={configuring} onClose={() => setConfiguring(null)} onDone={() => { setConfiguring(null); refresh(); }} />}
      </AnimatePresence>
    </div>
  );
}

function ConfigModal({ channel, onClose, onDone }: { channel: Channel; onClose: () => void; onDone: () => void }) {
  const keys = fieldsFor(channel);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const enable = async () => {
    setBusy(true);
    try {
      const provided = keys.filter((k) => (vals[k.key] ?? "").trim());
      if (provided.length) {
        const updates: Record<string, string> = {};
        for (const k of provided) updates[k.key] = vals[k.key];
        const r = await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify({ updates }) });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.message || "Couldn't save config (is the vault unlocked?)"); }
      }
      const s = await apiFetch(`/api/channels/${channel.id}/start`, { method: "POST" });
      if (!s.ok) { const d = await s.json().catch(() => ({})); throw new Error(d.error || "Channel couldn't start — check the values."); }
      toast.success(`${channel.name || channel.id} enabled`);
      onDone();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div className="absolute inset-0 bg-black/60" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
        className="relative w-full max-w-md rounded-2xl border border-slate-700/60 bg-slate-900 p-5">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-gray-300"><X className="w-4 h-4" /></button>
        <div className="flex items-center gap-2 mb-1"><Radio className="w-4 h-4 text-[#00d9ff]" /><h3 className="text-base font-semibold text-white capitalize">Connect {channel.name || channel.id}</h3></div>
        {channel.description && <p className="text-xs text-gray-400 mb-4">{channel.description}</p>}

        {keys.length === 0 ? (
          <p className="text-sm text-gray-400 mb-4">No configuration required — just enable it.</p>
        ) : (
          <div className="space-y-3 mb-4">
            {keys.map((k) => (
              <div key={k.key}>
                <label className="text-xs text-gray-400">{k.label}{k.secret && <span className="text-gray-600"> · stored encrypted</span>}</label>
                <input
                  type={k.secret ? "password" : "text"} value={vals[k.key] ?? ""}
                  onChange={(e) => setVals((s) => ({ ...s, [k.key]: e.target.value }))}
                  placeholder={k.key}
                  className="w-full mt-1 px-3 py-2 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50 font-mono"
                />
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn onClick={() => void enable()} disabled={busy || (keys.length > 0 && !keys.every((k) => (vals[k.key] ?? "").trim()))}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Power className="w-4 h-4" />} Save & enable
          </Btn>
        </div>
      </motion.div>
    </div>
  );
}
