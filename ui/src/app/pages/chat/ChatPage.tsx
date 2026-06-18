/**
 * ChatPage — the rebuilt Chat surface (new UI).
 *
 * Multi-chat with ONE active chat: the active chat is where inbound channel
 * messages (Discord/Slack/WhatsApp) land, handled by its agent + project. The
 * list lets you switch which chat you're viewing and mark one active.
 * Responsive (list → drawer on mobile) + animated.
 */

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Plus, MessageSquare, Star, PanelLeft, Radio, Trash2 } from "lucide-react";

import { ChatThread } from "./ChatThread";
import { useSessions, useActiveSession, useSetActiveSession, useCreateSession, useDeleteSession } from "../../lib/query";

export function Chat() {
  const sessions = useSessions();
  const active = useActiveSession();
  const setActive = useSetActiveSession();
  const createSession = useCreateSession();
  const deleteSession = useDeleteSession();

  const activeId = active.data?.sessionId ?? null;
  const [viewedId, setViewedId] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false); // mobile drawer
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // Pick an initial chat to view: the active one, else the most recent, else "main".
  useEffect(() => {
    if (viewedId) return;
    if (active.isLoading || sessions.isLoading) return;
    setViewedId(activeId ?? sessions.data?.[0]?.id ?? "main");
  }, [viewedId, activeId, active.isLoading, sessions.isLoading, sessions.data]);

  // Project chats (proj-<slug>) live inside their project's Chat tab — keep them
  // out of the generic chat list.
  const list = useMemo(() => (sessions.data ?? []).filter((s) => !s.id.startsWith("proj-")), [sessions.data]);

  const newChat = async () => {
    const s = await createSession.mutateAsync(undefined);
    setViewedId(s.id);
    setListOpen(false);
  };

  const confirmDelete = async () => {
    const id = pendingDelete;
    if (!id) return;
    setPendingDelete(null);
    await deleteSession.mutateAsync(id);
    if (viewedId === id) setViewedId(list.find((s) => s.id !== id)?.id ?? "main");
  };

  const ListPanel = (
    <div className="flex flex-col h-full">
      <div className="p-3">
        <button onClick={() => void newChat()} className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-[#0a0f1a] text-sm font-semibold hover:opacity-90 active:scale-[0.98] transition-all">
          <Plus className="w-4 h-4" /> New chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-1">
        {list.length === 0 && <p className="px-2 py-3 text-xs text-gray-500">No chats yet.</p>}
        {list.map((s) => {
          const isActive = s.id === activeId;
          const isViewed = s.id === viewedId;
          return (
            <div key={s.id}
              className={`group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${isViewed ? "bg-[#00d9ff]/10 border border-[#00d9ff]/30" : "border border-transparent hover:bg-slate-800/50"}`}
              onClick={() => { setViewedId(s.id); setListOpen(false); }}
            >
              <MessageSquare className={`w-4 h-4 shrink-0 ${isViewed ? "text-[#00d9ff]" : "text-gray-500"}`} />
              <span className="flex-1 truncate text-sm text-gray-200">{s.title || "Chat"}</span>
              <button
                onClick={(e) => { e.stopPropagation(); setActive.mutate(s.id); }}
                title={isActive ? "Active chat — channel messages land here" : "Make active"}
                className={`shrink-0 ${isActive ? "text-[#ffd166]" : "text-gray-600 opacity-0 group-hover:opacity-100 hover:text-[#ffd166]"} transition-all`}
              >
                <Star className="w-4 h-4" fill={isActive ? "currentColor" : "none"} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setPendingDelete(s.id); }}
                title="Delete chat"
                className="shrink-0 text-gray-600 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      {/* Desktop list */}
      <aside className="hidden lg:flex w-64 shrink-0 flex-col border-r border-slate-800/50 bg-slate-900/10">
        {ListPanel}
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {listOpen && (
          <div className="lg:hidden fixed inset-0 z-40">
            <motion.div className="absolute inset-0 bg-black/60" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setListOpen(false)} />
            <motion.aside className="absolute left-0 top-0 h-full w-72 bg-slate-900/95 backdrop-blur-xl border-r border-slate-800/50"
              initial={{ x: -300 }} animate={{ x: 0 }} exit={{ x: -300 }} transition={{ type: "tween", duration: 0.22, ease: "easeOut" }}>
              {ListPanel}
            </motion.aside>
          </div>
        )}
      </AnimatePresence>

      {/* Thread */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-3 px-3 md:px-6 h-11 border-b border-slate-800/50 shrink-0">
          <button className="lg:hidden text-gray-400 hover:text-[#00d9ff]" onClick={() => setListOpen(true)} aria-label="Chats"><PanelLeft className="w-5 h-5" /></button>
          <span className="text-sm font-medium text-gray-200 truncate">
            {list.find((s) => s.id === viewedId)?.title || "Chat"}
          </span>
          {viewedId && (
            viewedId === activeId
              ? <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-[#ffd166]"><Radio className="w-3 h-3" /> Active</span>
              : <button onClick={() => setActive.mutate(viewedId)} className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-gray-500 hover:text-[#ffd166]"><Star className="w-3 h-3" /> Make active</button>
          )}
        </div>
        <div className="flex-1 min-h-0">
          {viewedId && <ChatThread key={viewedId} sessionId={viewedId} />}
        </div>
      </div>

      {/* Themed delete confirm (replaces the browser's confirm dialog) */}
      <AnimatePresence>
        {pendingDelete && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div className="absolute inset-0 bg-black/60" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setPendingDelete(null)} />
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              className="relative w-full max-w-sm rounded-2xl border border-slate-700/60 bg-slate-900 p-5">
              <h3 className="text-base font-semibold text-white">Delete this chat?</h3>
              <p className="text-sm text-gray-400 mt-1">This permanently removes the conversation and all its messages.</p>
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => setPendingDelete(null)} className="px-3 py-1.5 text-sm text-gray-300 hover:text-white">Cancel</button>
                <button onClick={() => void confirmDelete()} className="px-3 py-1.5 text-sm rounded-lg bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30">Delete</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
