import { useEffect, useState } from "react";
import { LogOut, Monitor, Trash2 } from "lucide-react";

import { listSessions, revokeAll, revokeSession } from "../auth";

interface Row {
  id: string;
  deviceName: string | null;
  createdAt: number;
  lastUsedAt: number;
}

export function Sessions() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      const data = await listSessions();
      setRows(data.sessions);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function onRevoke(id: string) {
    if (!confirm("Revoke this session? The device will be signed out.")) return;
    await revokeSession(id);
    void refresh();
  }

  async function onRevokeAll() {
    if (!confirm("Revoke every signed-in device, including this one?")) return;
    await revokeAll();
    window.location.href = "/login";
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Active sessions</h1>
          <p className="text-sm text-muted-foreground">Devices currently signed in to this Daemora instance.</p>
        </div>
        <button
          onClick={onRevokeAll}
          className="inline-flex items-center gap-2 rounded-md border border-destructive/40 text-destructive px-3 py-2 text-sm hover:bg-destructive/5 transition"
        >
          <LogOut className="w-4 h-4" />
          Sign out everywhere
        </button>
      </div>

      {err && <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive mb-4">{err}</div>}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No active sessions.</div>
      ) : (
        <div className="rounded-md border">
          {rows.map((r, i) => (
            <div key={r.id} className={`flex items-center justify-between p-4 ${i > 0 ? "border-t" : ""}`}>
              <div className="flex items-center gap-3">
                <Monitor className="w-4 h-4 text-muted-foreground" />
                <div>
                  <div className="font-medium">{r.deviceName ?? "Unknown device"}</div>
                  <div className="text-xs text-muted-foreground">
                    Signed in {fmt(r.createdAt)} · last used {fmt(r.lastUsedAt)}
                  </div>
                </div>
              </div>
              <button
                onClick={() => onRevoke(r.id)}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-destructive hover:bg-destructive/5 transition"
                aria-label="Revoke this session"
              >
                <Trash2 className="w-4 h-4" />
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fmt(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
