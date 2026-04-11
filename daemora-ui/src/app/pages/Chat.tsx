import { useState, useRef, useEffect, useMemo } from "react";
import { apiFetch, apiStreamUrl } from "../api";
import { User, Loader2, Terminal, ArrowUp, Wrench, Brain, Bot, Download, Image as ImageIcon, Trash2 } from "lucide-react";
import { Textarea } from "../components/ui/textarea";
import { ScrollArea } from "../components/ui/scroll-area";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Logo } from "../components/ui/Logo";
import { toast } from "sonner";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

const SESSION_ID = "main";

export function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const activeTaskIdRef = useRef<string | null>(sessionStorage.getItem("daemora_active_task"));

  const loadSession = async () => {
    try {
      const res = await apiFetch(`/api/sessions/${SESSION_ID}`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
      } else {
        // Session doesn't exist yet — create it
        await apiFetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: SESSION_ID }),
        });
      }
    } catch (error) {
      console.error("Failed to load session", error);
    } finally {
      setInitialized(true);
    }
  };

  const clearHistory = async () => {
    if (!confirm("Delete all chat history? This cannot be undone.")) return;
    try {
      // Delete the session, then recreate it fresh
      await apiFetch(`/api/sessions/${SESSION_ID}`, { method: "DELETE" });
      await apiFetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: SESSION_ID }),
      });
      setMessages([]);
      sessionStorage.removeItem("daemora_active_task");
      toast.success("Chat history cleared");
    } catch (error) {
      console.error("Failed to clear history", error);
      toast.error("Failed to clear history");
    }
  };

  useEffect(() => {
    loadSession();
    // Reconnect to active task stream if we remounted while a task was running
    const pendingTaskId = sessionStorage.getItem("daemora_active_task");
    if (pendingTaskId) {
      apiFetch(`/api/tasks/${pendingTaskId}`)
        .then((res) => res.ok ? res.json() : null)
        .then((task) => {
          if (task && (task.status === "pending" || task.status === "running")) {
            setIsLoading(true);
            setStreamStatus("Reconnecting...");
            connectToStream(pendingTaskId);
          } else {
            sessionStorage.removeItem("daemora_active_task");
            if (task?.status === "completed") loadSession();
          }
        })
        .catch(() => sessionStorage.removeItem("daemora_active_task"));
    }
  }, []);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      role: "user",
      content: input,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    const currentInput = input;
    setInput("");
    setIsLoading(true);
    setStreamStatus("Queuing...");

    try {
      const response = await apiFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: currentInput, sessionId: SESSION_ID }),
      });

      if (!response.ok) throw new Error(`Error: ${response.statusText}`);

      const data = await response.json();

      if (data.taskId) {
        connectToStream(data.taskId);
      } else if (data.result) {
        const assistantMessage: Message = {
          role: "assistant",
          content: data.result || "(No response from system)",
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMessage]);
        setIsLoading(false);
        setStreamStatus(null);
      }
    } catch (error: any) {
      const errorMessage: Message = {
        role: "assistant",
        content: `**SYSTEM ERROR:** ${error.message}`,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMessage]);
      setIsLoading(false);
      setStreamStatus(null);
    }
  };

  const connectToStream = (taskId: string) => {
    if (eventSourceRef.current) eventSourceRef.current.close();

    activeTaskIdRef.current = taskId;
    sessionStorage.setItem("daemora_active_task", taskId);

    const clearActiveTask = () => {
      activeTaskIdRef.current = null;
      sessionStorage.removeItem("daemora_active_task");
    };

    const es = new EventSource(apiStreamUrl(`/api/tasks/${taskId}/stream`));
    eventSourceRef.current = es;

    es.addEventListener("task:state", (e) => {
      const data = JSON.parse(e.data);
      if (data.status === "completed" && data.result) {
        clearActiveTask();
        setIsLoading(false);
        setStreamStatus(null);
        loadSession();
        es.close();
        eventSourceRef.current = null;
      } else if (data.status === "failed") {
        clearActiveTask();
        setMessages((prev) => [...prev, {
          role: "assistant",
          content: `**SYSTEM ERROR:** ${data.error || "Task failed"}`,
          timestamp: new Date().toISOString(),
        }]);
        setIsLoading(false);
        setStreamStatus(null);
        es.close();
        eventSourceRef.current = null;
      } else if (data.status === "running") {
        setStreamStatus("Processing...");
      }
    });

    es.addEventListener("model:called", (e) => {
      try {
        const data = JSON.parse(e.data);
        const iteration = data.iteration || data.loop || "";
        setStreamStatus(`Thinking${iteration ? ` (step ${iteration})` : ""}...`);
      } catch { setStreamStatus("Thinking..."); }
    });

    es.addEventListener("tool:after", (e) => {
      try {
        const data = JSON.parse(e.data);
        setStreamStatus(`Using ${data.tool_name || data.tool || "tool"}...`);
      } catch { setStreamStatus("Using tool..."); }
    });

    es.addEventListener("agent:spawned", (e) => {
      try {
        const data = JSON.parse(e.data);
        setStreamStatus(`Sub-agent spawned${data.role ? `: ${data.role}` : ""}...`);
      } catch { setStreamStatus("Sub-agent working..."); }
    });

    es.addEventListener("agent:finished", () => {
      setStreamStatus("Sub-agent completed, continuing...");
    });

    es.addEventListener("task:completed", (e) => {
      clearActiveTask();
      loadSession();
      setIsLoading(false);
      setStreamStatus(null);
      es.close();
      eventSourceRef.current = null;
    });

    es.addEventListener("task:failed", (e) => {
      clearActiveTask();
      const data = JSON.parse(e.data);
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: `**SYSTEM ERROR:** ${data.error || "Task failed"}`,
        timestamp: new Date().toISOString(),
      }]);
      setIsLoading(false);
      setStreamStatus(null);
      es.close();
      eventSourceRef.current = null;
    });

    let errorCount = 0;
    es.onerror = () => {
      errorCount++;
      if (es.readyState === EventSource.CLOSED || errorCount >= 3) {
        clearActiveTask();
        setIsLoading(false);
        setStreamStatus(null);
        es.close();
        eventSourceRef.current = null;
      }
    };
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    requestAnimationFrame(() => scrollToBottom());
  }, [messages, isLoading]);

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? new Date().toLocaleTimeString() : d.toLocaleTimeString();
  };

  // Extract file paths from message content and determine type
  const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp|svg|avif|bmp)$/i;
  const VIDEO_EXT = /\.(mp4|webm|mov|avi|mkv)$/i;
  const AUDIO_EXT = /\.(mp3|wav|ogg|flac|m4a|aac)$/i;
  const FILE_PATH_RE = /(?:^|[\s:])(\/?(?:[\w.-]+\/)*[\w.-]+\.(?:png|jpg|jpeg|gif|webp|svg|avif|mp4|webm|mov|mp3|wav|ogg|flac|m4a|pdf|docx|xlsx|pptx|txt|csv|zip))\b/gi;

  function extractFiles(content: string): { path: string; type: "image" | "video" | "audio" | "file" }[] {
    const matches = content.match(FILE_PATH_RE);
    if (!matches) return [];
    const seen = new Set<string>();
    return matches
      .map(m => m.trim().replace(/^[:\s]+/, ""))
      .filter(p => p.includes("/") && !seen.has(p) && (seen.add(p), true))
      .map(path => ({
        path,
        type: IMAGE_EXT.test(path) ? "image" as const
            : VIDEO_EXT.test(path) ? "video" as const
            : AUDIO_EXT.test(path) ? "audio" as const
            : "file" as const,
      }));
  }

  function fileUrl(path: string): string {
    const token = document.querySelector('meta[name="api-token"]')?.getAttribute("content") || "";
    return `/api/file?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`;
  }

  const getStatusIcon = () => {
    if (!streamStatus) return null;
    if (streamStatus.startsWith("Using ")) return <Wrench className="w-3 h-3 text-[#00d9ff] animate-pulse" />;
    if (streamStatus.startsWith("Thinking")) return <Brain className="w-3 h-3 text-[#00d9ff] animate-pulse" />;
    if (streamStatus.startsWith("Sub-agent")) return <Bot className="w-3 h-3 text-[#00d9ff] animate-pulse" />;
    return <Loader2 className="w-3 h-3 text-[#00d9ff] animate-spin" />;
  };

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col bg-slate-950/20 overflow-hidden relative min-w-0">
        <div className="absolute inset-0 opacity-[0.03] pointer-events-none bg-[url('https://grainy-gradients.vercel.app/noise.svg')] bg-repeat" />

        {/* Header */}
        <div className="flex items-center px-4 py-3 border-b border-slate-800/50 bg-slate-900/40 backdrop-blur-md z-10 h-14 gap-3">
          <div className="flex-1" />
          <div className="flex items-center gap-2.5">
            <div className="animate-[bounce-slow_2s_ease-in-out_infinite]">
              <Logo size={28} />
            </div>
            <h2 className="text-base font-bold bg-gradient-to-r from-white via-[#00d9ff] to-[#4ECDC4] bg-clip-text text-transparent tracking-tight">
              Daemora
            </h2>
          </div>
          <div className="flex-1 flex justify-end">
            <button
              onClick={clearHistory}
              disabled={isLoading || messages.length === 0}
              title="Delete chat history"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-mono uppercase tracking-wider text-gray-400 hover:text-red-400 hover:bg-red-500/10 border border-slate-800/60 hover:border-red-500/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-gray-400 disabled:hover:bg-transparent disabled:hover:border-slate-800/60"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear</span>
            </button>
          </div>
        </div>

        {/* Messages Area */}
        <div className="flex-1 min-h-0 relative z-10 flex flex-col">
          <ScrollArea className="flex-1 min-h-0" ref={scrollAreaRef}>
            <div className="max-w-6xl mx-auto py-6 px-4 sm:px-6 space-y-5">
              {!initialized ? (
                <div className="flex flex-col items-center py-24 gap-3 opacity-50">
                  <Loader2 className="w-5 h-5 text-[#00d9ff] animate-spin" />
                  <span className="text-[9px] font-mono text-gray-600 uppercase tracking-widest">Loading...</span>
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center py-24 gap-4">
                  <div className="animate-[bounce-slow_2s_ease-in-out_infinite]">
                    <Logo size={64} />
                  </div>
                  <h2 className="text-lg font-bold bg-gradient-to-r from-white via-[#00d9ff] to-[#4ECDC4] bg-clip-text text-transparent">
                    Dae<span className="text-[#ff4444]">mora</span>
                  </h2>
                  <p className="text-[10px] text-gray-600 font-mono uppercase tracking-widest">
                    Send a message to begin
                  </p>
                </div>
              ) : (
                messages.map((message, i) => (
                  <div
                    key={i}
                    className={`flex gap-3 animate-in slide-in-from-bottom-2 duration-300 ${message.role === "user" ? "justify-end" : ""}`}
                  >
                    {message.role === "assistant" && (
                      <div className="w-7 h-7 rounded-lg bg-slate-950 border border-slate-800/80 p-1 flex-shrink-0 flex items-center justify-center shadow-lg mt-1">
                        <Logo size={18} />
                      </div>
                    )}
                    <div className={`max-w-[88%] ${message.role === "user" ? "flex justify-end" : ""}`}>
                      <div
                        className={`rounded-lg p-4 shadow-md border transition-all ${
                          message.role === "user"
                            ? "bg-[#00d9ff]/5 border-[#00d9ff]/20 text-white"
                            : "bg-slate-800/30 border-slate-800 text-gray-100"
                        }`}
                      >
                        {message.role === "assistant" ? (
                          <div className="space-y-3">
                            <div className="prose prose-invert prose-sm max-w-none font-mono leading-relaxed text-[13px]">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {message.content}
                              </ReactMarkdown>
                            </div>
                            {/* Render detected images/media inline */}
                            {extractFiles(message.content).map((f, fi) => (
                              <div key={fi} className="mt-2">
                                {f.type === "image" && (
                                  <a href={fileUrl(f.path)} target="_blank" rel="noopener noreferrer">
                                    <img
                                      src={fileUrl(f.path)}
                                      alt={f.path.split("/").pop()}
                                      className="rounded-lg border border-slate-700/50 max-w-full max-h-[400px] object-contain shadow-lg hover:opacity-90 transition-opacity cursor-pointer"
                                      onError={(e) => (e.currentTarget.style.display = "none")}
                                    />
                                  </a>
                                )}
                                {f.type === "video" && (
                                  <video
                                    src={fileUrl(f.path)}
                                    controls
                                    className="rounded-lg border border-slate-700/50 max-w-full max-h-[400px] shadow-lg"
                                  />
                                )}
                                {f.type === "audio" && (
                                  <audio src={fileUrl(f.path)} controls className="w-full" />
                                )}
                                {f.type === "file" && (
                                  <a
                                    href={fileUrl(f.path)}
                                    download
                                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/50 border border-slate-700/50 text-[11px] font-mono text-[#00d9ff] hover:bg-slate-700/50 transition-colors"
                                  >
                                    <Download className="w-3.5 h-3.5" />
                                    {f.path.split("/").pop()}
                                  </a>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed tracking-tight">{message.content}</p>
                        )}
                        <div className="text-[8px] text-gray-600 mt-2 font-mono uppercase tracking-widest flex justify-between items-center border-t border-slate-800/20 pt-2 opacity-50">
                          <span className="flex items-center gap-2">
                            {message.role === "user" ? <User className="w-3 h-3" /> : <Terminal className="w-3 h-3" />}
                            {message.role === "user" ? "Link" : "Core"}
                          </span>
                          <span>{formatTime(message.timestamp)}</span>
                        </div>
                      </div>
                    </div>
                    {message.role === "user" && (
                      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#00d9ff] to-[#4ECDC4] flex items-center justify-center flex-shrink-0 shadow-lg border border-white/10 p-1.5 mt-1">
                        <User className="w-full h-full text-white" />
                      </div>
                    )}
                  </div>
                ))
              )}

              {isLoading && (
                <div className="flex gap-3 animate-pulse">
                  <div className="w-7 h-7 rounded-lg bg-slate-950 border border-slate-800/80 p-1 flex-shrink-0 flex items-center justify-center">
                    <Logo size={18} />
                  </div>
                  <div className="max-w-[88%]">
                    <div className="rounded-lg p-4 bg-slate-800/30 border border-slate-800 flex items-center gap-3">
                      {getStatusIcon()}
                      <span className="text-[9px] text-[#00d9ff] font-mono tracking-[0.2em] uppercase">
                        {streamStatus || "Processing..."}
                      </span>
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          {/* Input */}
          <div className="px-4 pb-4 pt-2 backdrop-blur-xl shrink-0">
            <div className="max-w-6xl mx-auto">
              <div className="flex items-end gap-0 bg-slate-800/60 border border-slate-700/50 rounded-full px-2 py-1.5 shadow-[0_0_30px_rgba(0,0,0,0.3)] focus-within:border-[#00d9ff]/30 transition-all">
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="Ask anything..."
                  className="flex-1 min-h-[36px] max-h-[120px] bg-transparent border-0 text-white placeholder:text-gray-600 focus-visible:ring-0 focus-visible:ring-offset-0 font-mono text-sm px-3 py-2 resize-none shadow-none"
                  disabled={isLoading}
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isLoading}
                  className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-all ${
                    input.trim() && !isLoading
                      ? "bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-slate-950 shadow-[0_0_15px_rgba(0,217,255,0.3)]"
                      : "bg-slate-700/50 text-gray-600"
                  }`}
                >
                  {isLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <ArrowUp className="w-4 h-4" />
                  )}
                </button>
              </div>
              <div className="text-center mt-1.5">
                <span className="text-[8px] text-gray-700 font-mono tracking-widest uppercase">
                  Enter to send // Shift+Enter for newline
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
