/**
 * ChatThread — the conversation + composer for one session (rebuilt clean).
 * Presentational; all streaming/state lives in useChatThread. Responsive
 * (mobile-first) + animated (message enter, tool chips, typing indicator).
 */

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp, Paperclip, Trash2, Wrench, Brain, Loader2, X,
  Image as ImageIcon, File as FileIcon, Bot, User as UserIcon, Mic, PhoneOff,
} from "lucide-react";

import { useChatThread, kindForMime, type AttachmentKind } from "../../lib/useChatThread";
import { Logo } from "../../components/ui/Logo";
import { VoicePanel, type VoiceHandle } from "../../components/VoicePanel";

interface Pending { id: string; file: File; url: string; kind: AttachmentKind; }

const QUICK = [
  "Build an app",
  "Research a topic",
  "Generate an image or video",
];

export function ChatThread({ sessionId }: { sessionId: string }) {
  const { messages, toolEvents, status, isLoading, initialized, send, clear } = useChatThread(sessionId);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [drag, setDrag] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const voiceRef = useRef<VoiceHandle>(null);
  const [voiceOn, setVoiceOn] = useState(false);

  const toggleVoice = () => {
    const v = voiceRef.current;
    if (!v) return;
    if (v.active) { v.stop(); setVoiceOn(false); }
    else { v.start(); setVoiceOn(true); }
  };

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, status]);
  useEffect(() => () => pending.forEach((p) => URL.revokeObjectURL(p.url)), []); // eslint-disable-line

  const addFiles = (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, 10);
    if (!list.length) return;
    setPending((prev) => [...prev, ...list.map((f) => ({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, file: f, url: URL.createObjectURL(f), kind: kindForMime(f.type || "") }))].slice(0, 10));
  };
  const removePending = (id: string) => setPending((prev) => { const v = prev.find((p) => p.id === id); if (v) URL.revokeObjectURL(v.url); return prev.filter((p) => p.id !== id); });

  const doSend = async () => {
    if (!input.trim() && pending.length === 0) return;
    const files = pending.map((p) => p.file);
    setInput(""); setPending([]);
    if (taRef.current) taRef.current.style.height = "auto";
    await send(input, files);
  };

  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void doSend(); } };
  const empty = initialized && messages.length === 0;

  return (
    <div
      className="relative flex flex-col h-full"
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files); }}
    >
      {drag && (
        <div className="absolute inset-0 z-30 m-3 rounded-2xl border-2 border-dashed border-[#00d9ff]/60 bg-[#00d9ff]/5 flex items-center justify-center pointer-events-none">
          <span className="text-[#00d9ff] text-sm font-medium">Drop files to attach</span>
        </div>
      )}

      {/* Thread actions */}
      {!empty && (
        <div className="flex items-center justify-end px-4 md:px-6 pt-3">
          <button onClick={() => setClearOpen(true)} className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-red-400 transition-colors">
            <Trash2 className="w-3.5 h-3.5" /> Clear
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 md:px-6 py-4">
        <div className="max-w-3xl mx-auto space-y-5">
          {empty ? (
            <div className="h-full flex flex-col items-center justify-center text-center gap-6 py-16">
              <Logo size={56} />
              <h2 className="text-2xl md:text-3xl font-semibold text-white">What are we building today?</h2>
              <div className="flex flex-wrap justify-center gap-2">
                {QUICK.map((q) => (
                  <button key={q} onClick={() => setInput(q)} className="px-3 py-1.5 rounded-full text-sm border border-slate-700/70 text-gray-300 hover:border-[#00d9ff]/50 hover:text-[#00d9ff] transition-colors">{q}</button>
                ))}
              </div>
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {messages.map((m, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className={`flex gap-3 ${m.role === "user" ? "flex-row-reverse" : ""}`}
                >
                  <div className={`w-7 h-7 rounded-lg shrink-0 flex items-center justify-center ${m.role === "user" ? "bg-[#4ECDC4]/15 text-[#4ECDC4]" : "bg-[#00d9ff]/15 text-[#00d9ff]"}`}>
                    {m.role === "user" ? <UserIcon className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                  </div>
                  <div className={`max-w-[85%] min-w-0 overflow-hidden rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words ${m.role === "user" ? "bg-[#4ECDC4]/10 border border-[#4ECDC4]/20 text-gray-100" : "bg-slate-800/40 border border-slate-700/50 text-gray-200"}`}>
                    {m.role === "assistant"
                      ? <div className="prose prose-invert prose-sm max-w-none break-words prose-pre:overflow-x-auto prose-pre:max-w-full prose-a:break-all prose-code:break-words"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
                      : <span className="whitespace-pre-wrap break-words">{m.content}</span>}
                    {m.attachments && m.attachments.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {m.attachments.map((a, j) =>
                          a.kind === "image" ? <img key={j} src={a.url} alt={a.filename} className="max-h-60 rounded-lg border border-slate-700/50" />
                          : a.kind === "video" ? <video key={j} src={a.url} controls playsInline className="max-h-72 w-full max-w-md rounded-lg border border-slate-700/50 bg-black" />
                          : a.kind === "audio" ? <audio key={j} src={a.url} controls className="w-full max-w-md" />
                          : <a key={j} href={a.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs text-[#00d9ff] underline"><FileIcon className="w-3.5 h-3.5" />{a.filename}</a>)}
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          )}

          {/* Tool timeline */}
          {toolEvents.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {toolEvents.map((t) => (
                <span key={t.id} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] border ${t.status === "running" ? "border-[#00d9ff]/40 text-[#00d9ff]" : t.status === "error" ? "border-red-500/40 text-red-400" : "border-slate-700/60 text-gray-400"}`}>
                  <Wrench className={`w-3 h-3 ${t.status === "running" ? "animate-pulse" : ""}`} />{t.name}{t.preview ? ` · ${t.preview}` : ""}
                </span>
              ))}
            </div>
          )}

          {/* Typing / status */}
          {isLoading && status && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 text-xs text-gray-400">
              {status.startsWith("Thinking") ? <Brain className="w-3.5 h-3.5 text-[#00d9ff] animate-pulse" /> : <Loader2 className="w-3.5 h-3.5 text-[#00d9ff] animate-spin" />}
              {status}
            </motion.div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      {/* Composer */}
      <div className="px-3 md:px-6 pb-4 pt-2">
        <div className="max-w-3xl mx-auto">
          {/* Mounted always (so the mic button can start it). During a call it
              floats as a compact overlay so it never covers the conversation. */}
          <div className={voiceOn
            ? "fixed bottom-28 right-4 z-40 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-[#00d9ff]/30 bg-slate-900/95 backdrop-blur-xl p-3 shadow-2xl"
            : "hidden"}>
            {voiceOn && (
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-[#00d9ff]">Voice call</span>
                <button onClick={toggleVoice} className="text-gray-400 hover:text-red-400"><PhoneOff className="w-4 h-4" /></button>
              </div>
            )}
            <VoicePanel ref={voiceRef} />
          </div>
          {pending.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {pending.map((p) => (
                <div key={p.id} className="relative group">
                  {p.kind === "image"
                    ? <img src={p.url} alt={p.file.name} className="h-14 w-14 object-cover rounded-lg border border-slate-700/50" />
                    : <div className="h-14 w-14 rounded-lg border border-slate-700/50 flex items-center justify-center text-gray-400"><ImageIcon className="w-5 h-5" /></div>}
                  <button onClick={() => removePending(p.id)} className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-slate-900 border border-slate-600 flex items-center justify-center text-gray-300 hover:text-red-400"><X className="w-2.5 h-2.5" /></button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2 rounded-2xl border border-slate-700/60 bg-slate-900/40 backdrop-blur px-2.5 py-2 focus-within:border-[#00d9ff]/50 transition-colors">
            <button onClick={() => fileRef.current?.click()} className="p-2 text-gray-400 hover:text-[#00d9ff] transition-colors shrink-0" aria-label="Attach">
              <Paperclip className="w-5 h-5" />
            </button>
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
            <textarea
              ref={taRef} value={input} rows={1}
              onChange={(e) => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`; }}
              onKeyDown={onKey}
              onPaste={(e) => { const files = Array.from(e.clipboardData.files); if (files.length) addFiles(files); }}
              placeholder="Ask anything — paste or drop files"
              className="flex-1 resize-none bg-transparent outline-none text-sm text-gray-100 placeholder:text-gray-500 py-1.5 max-h-44"
            />
            {/* Voice call DISABLED FOR NOW — uncomment to restore the mic button.
            <button onClick={toggleVoice}
              className={`p-2 rounded-xl shrink-0 transition-all active:scale-95 ${voiceOn ? "bg-red-500/20 text-red-400" : "text-gray-400 hover:text-[#00d9ff]"}`} aria-label="Voice call" title={voiceOn ? "End voice" : "Start voice call"}>
              {voiceOn ? <PhoneOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button> */}
            <button onClick={() => void doSend()} disabled={!input.trim() && pending.length === 0}
              className="p-2 rounded-xl bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-[#0a0f1a] shrink-0 disabled:opacity-30 hover:opacity-90 active:scale-95 transition-all" aria-label="Send">
              <ArrowUp className="w-5 h-5" />
            </button>
          </div>
          <p className="text-center text-[10px] text-gray-600 mt-1.5 font-mono uppercase tracking-wider">Enter to send · Shift+Enter for newline</p>
        </div>
      </div>

      {/* Clear confirm */}
      <AnimatePresence>
        {clearOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div className="absolute inset-0 bg-black/60" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setClearOpen(false)} />
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              className="relative w-full max-w-sm rounded-2xl border border-slate-700/60 bg-slate-900 p-5">
              <h3 className="text-base font-semibold text-white">Clear this chat?</h3>
              <p className="text-sm text-gray-400 mt-1">This deletes the conversation history. This can't be undone.</p>
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => setClearOpen(false)} className="px-3 py-1.5 text-sm text-gray-300 hover:text-white">Cancel</button>
                <button onClick={() => { setClearOpen(false); void clear(); }} className="px-3 py-1.5 text-sm rounded-lg bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30">Clear</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
