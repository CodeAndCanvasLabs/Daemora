import { useState, useRef, useEffect } from "react";
import { apiFetch, apiStreamUrl } from "../api";
import { Send, User, Loader2, Plus, Terminal, PanelLeftClose, PanelLeftOpen, ArrowUp, Paperclip, Trash2, Wrench, Brain, Bot } from "lucide-react";
import { Textarea } from "../components/ui/textarea";
import { Button } from "../components/ui/button";
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

interface Session {
  sessionId: string;
  createdAt: string;
  lastMessage: string;
  messageCount: number;
}

export function Chat() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSessionsLoading, setIsSessionsLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const activeTaskIdRef = useRef<string | null>(sessionStorage.getItem("daemora_active_task"));
  const sessionIdRef = useRef<string | null>(currentSessionId);

  // Keep ref in sync with state so SSE handlers always see current sessionId
  useEffect(() => { sessionIdRef.current = currentSessionId; }, [currentSessionId]);

  const fetchSessions = async () => {
    try {
      const res = await apiFetch("/api/sessions");
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
        if (!currentSessionId && data.sessions.length > 0) {
          loadSession(data.sessions[0].sessionId);
        }
      }
    } catch (error) {
      console.error("Failed to fetch sessions", error);
    } finally {
      setIsSessionsLoading(false);
    }
  };

  const loadSession = async (id: string) => {
    setCurrentSessionId(id);
    try {
      const res = await apiFetch(`/api/sessions/${id}`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
      }
    } catch (error) {
      toast.error("FAILED TO RESTORE SESSION HISTORY");
    }
  };

  const createNewSession = async () => {
    try {
      const res = await apiFetch("/api/sessions", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setCurrentSessionId(data.sessionId);
        setMessages([]);
        fetchSessions();
      }
    } catch (error) {
      toast.error("COULD NOT INITIALIZE NEW SESSION");
    }
  };

  const deleteSession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
      if (res.ok) {
        setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
        if (currentSessionId === sessionId) {
          setCurrentSessionId(null);
          setMessages([]);
        }
        toast.success("Session deleted");
      } else {
        toast.error("Failed to delete session");
      }
    } catch (error) {
      toast.error("Failed to delete session");
    }
  };

  useEffect(() => {
    fetchSessions();
    // Reconnect to active task stream if we remounted while a task was running
    const pendingTaskId = sessionStorage.getItem("daemora_active_task");
    if (pendingTaskId) {
      setIsLoading(true);
      setStreamStatus("Reconnecting...");
      connectToStream(pendingTaskId);
    }
  }, []);

  // Cleanup EventSource on unmount (but keep taskId in sessionStorage for reconnect)
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

    let sessionId = currentSessionId;
    if (!sessionId) {
      const res = await apiFetch("/api/sessions", { method: "POST" });
      const data = await res.json();
      sessionId = data.sessionId;
      setCurrentSessionId(sessionId);
    }

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
        body: JSON.stringify({ input: currentInput, sessionId }),
      });

      if (!response.ok) {
        throw new Error(`Error: ${response.statusText}`);
      }

      const data = await response.json();

      // New async flow: connect to SSE stream
      if (data.taskId) {
        connectToStream(data.taskId);
      } else if (data.result) {
        // Fallback for sync response (shouldn't happen but safe)
        const assistantMessage: Message = {
          role: "assistant",
          content: data.result || "(No response from system)",
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMessage]);
        setIsLoading(false);
        setStreamStatus(null);
        fetchSessions();
      }
    } catch (error: any) {
      const errorMessage: Message = {
        role: "assistant",
        content: `**SYSTEM ERROR:** ${error.message}. KERNEL PANIC.`,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMessage]);
      setIsLoading(false);
      setStreamStatus(null);
    }
  };

  const connectToStream = (taskId: string) => {
    // Close any existing stream
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    // Persist taskId so we can reconnect after tab switch
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
        // Task already completed before we connected — reload session to get full history
        clearActiveTask();
        setIsLoading(false);
        setStreamStatus(null);
        if (sessionIdRef.current) loadSession(sessionIdRef.current);
        else fetchSessions();
        es.close();
        eventSourceRef.current = null;
      } else if (data.status === "failed") {
        clearActiveTask();
        const errorMessage: Message = {
          role: "assistant",
          content: `**SYSTEM ERROR:** ${data.error || "Task failed"}`,
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errorMessage]);
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
      } catch {
        setStreamStatus("Thinking...");
      }
    });

    es.addEventListener("tool:after", (e) => {
      try {
        const data = JSON.parse(e.data);
        const toolName = data.tool_name || data.tool || "tool";
        setStreamStatus(`Using ${toolName}...`);
      } catch {
        setStreamStatus("Using tool...");
      }
    });

    es.addEventListener("agent:spawned", (e) => {
      try {
        const data = JSON.parse(e.data);
        setStreamStatus(`Sub-agent spawned${data.role ? `: ${data.role}` : ""}...`);
      } catch {
        setStreamStatus("Sub-agent working...");
      }
    });

    es.addEventListener("agent:finished", (e) => {
      try {
        JSON.parse(e.data);
        setStreamStatus("Sub-agent completed, continuing...");
      } catch {
        // ignore
      }
    });

    es.addEventListener("task:completed", (e) => {
      clearActiveTask();
      const data = JSON.parse(e.data);
      // Reload full session from server to get clean messages (avoids duplicates)
      if (sessionIdRef.current) {
        loadSession(sessionIdRef.current);
      } else {
        const result = data.result || data.output || "(No response from system)";
        const assistantMessage: Message = {
          role: "assistant",
          content: result,
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMessage]);
      }
      setIsLoading(false);
      setStreamStatus(null);
      fetchSessions();
      es.close();
      eventSourceRef.current = null;
    });

    es.addEventListener("task:failed", (e) => {
      clearActiveTask();
      const data = JSON.parse(e.data);
      const errorMessage: Message = {
        role: "assistant",
        content: `**SYSTEM ERROR:** ${data.error || "Task failed"}. KERNEL PANIC.`,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMessage]);
      setIsLoading(false);
      setStreamStatus(null);
      es.close();
      eventSourceRef.current = null;
    });

    es.onerror = () => {
      // EventSource will auto-reconnect on transient errors.
      // Only clean up if the connection is fully closed.
      if (es.readyState === EventSource.CLOSED) {
        setIsLoading(false);
        setStreamStatus(null);
        eventSourceRef.current = null;
      }
    };
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // Scroll to bottom on new messages, loading state change, or session load
  useEffect(() => {
    // Use requestAnimationFrame to ensure DOM has rendered
    requestAnimationFrame(() => scrollToBottom());
  }, [messages, isLoading]);

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? new Date().toLocaleTimeString() : d.toLocaleTimeString();
  };

  const getStatusIcon = () => {
    if (!streamStatus) return null;
    if (streamStatus.startsWith("Using ")) return <Wrench className="w-3 h-3 text-[#00d9ff] animate-pulse" />;
    if (streamStatus.startsWith("Thinking")) return <Brain className="w-3 h-3 text-[#00d9ff] animate-pulse" />;
    if (streamStatus.startsWith("Sub-agent")) return <Bot className="w-3 h-3 text-[#00d9ff] animate-pulse" />;
    return <Loader2 className="w-3 h-3 text-[#00d9ff] animate-spin" />;
  };

  return (
    <div className="flex h-full">
      {/* Session Sidebar */}
      <div className={`flex flex-col gap-0 border-r border-slate-800/50 bg-slate-900/10 backdrop-blur-md transition-all duration-300 ${sidebarOpen ? "w-64" : "w-0 overflow-hidden border-r-0"}`}>
        <div className="p-3 border-b border-slate-800/50 flex items-center gap-2">
          <Button
            onClick={createNewSession}
            className="flex-1 bg-[#00d9ff]/5 border border-[#00d9ff]/30 text-[#00d9ff] hover:bg-[#00d9ff]/15 font-mono text-[10px] uppercase tracking-widest h-9 shadow-sm group transition-all"
          >
            <Plus className="w-3 h-3 mr-1.5 group-hover:rotate-90 transition-transform duration-300" />
            New Chat
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSidebarOpen(false)}
            className="text-[#00d9ff] hover:text-white hover:bg-[#00d9ff]/10 h-9 w-9 p-0 flex-shrink-0"
          >
            <PanelLeftClose className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="py-2 px-3 flex items-center gap-2 text-gray-500 border-b border-slate-800/20">
            <span className="text-[9px] font-mono uppercase tracking-widest font-bold">Sessions</span>
          </div>

          <ScrollArea className="flex-1">
            <div className="p-1.5 space-y-0.5">
              {isSessionsLoading ? (
                <div className="flex flex-col items-center py-12 gap-3 opacity-50">
                  <Loader2 className="w-4 h-4 text-[#00d9ff] animate-spin" />
                </div>
              ) : sessions.length === 0 ? (
                <div className="text-center py-12 text-gray-700 font-mono text-[9px] uppercase italic tracking-widest">Empty Archive</div>
              ) : (
                sessions.map((s) => (
                  <button
                    key={s.sessionId}
                    onClick={() => loadSession(s.sessionId)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg transition-all group border border-transparent ${
                      currentSessionId === s.sessionId
                        ? "bg-slate-800 border-slate-700 text-white"
                        : "text-gray-500 hover:bg-slate-800/30 hover:text-gray-300"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className={`w-1 h-1 rounded-full flex-shrink-0 ${currentSessionId === s.sessionId ? 'bg-[#00d9ff] shadow-[0_0_8px_#00d9ff]' : 'bg-slate-700'}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-mono truncate uppercase tracking-tighter leading-none mb-1">
                          {s.lastMessage.length > 25 ? `${s.lastMessage.slice(0, 25)}...` : s.lastMessage}
                        </div>
                        <div className="opacity-40 font-mono text-[8px] uppercase tracking-widest">
                          {new Date(s.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                      <div
                        onClick={(e) => deleteSession(e, s.sessionId)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-red-500/20 hover:text-red-400 flex-shrink-0 cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* Main Interface Area */}
      <div className="flex-1 flex flex-col bg-slate-950/20 overflow-hidden relative min-w-0">
        <div className="absolute inset-0 opacity-[0.03] pointer-events-none bg-[url('https://grainy-gradients.vercel.app/noise.svg')] bg-repeat" />

        {/* Operational View */}
        {currentSessionId && (
          <>
            {/* Header */}
            <div className="flex items-center px-4 py-3 border-b border-slate-800/50 bg-slate-900/40 backdrop-blur-md z-10 h-14 gap-3">
              {!sidebarOpen && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSidebarOpen(true)}
                  className="text-[#00d9ff] hover:text-white hover:bg-[#00d9ff]/10 h-8 w-8 p-0 flex-shrink-0"
                >
                  <PanelLeftOpen className="w-4 h-4" />
                </Button>
              )}
              <div className="flex items-center gap-2.5 flex-1 justify-center">
                <div className="animate-[bounce-slow_2s_ease-in-out_infinite]">
                  <Logo size={28} />
                </div>
                <h2 className="text-base font-bold bg-gradient-to-r from-white via-[#00d9ff] to-[#4ECDC4] bg-clip-text text-transparent tracking-tight">
                  Daemora
                </h2>
              </div>
              {!sidebarOpen && <div className="w-8" />}
            </div>

            {/* Messages Area */}
            <div className="flex-1 min-h-0 relative z-10 flex flex-col">
              <ScrollArea className="flex-1 min-h-0" ref={scrollAreaRef}>
                <div className="max-w-6xl mx-auto py-6 px-4 sm:px-6 space-y-5">
                  {messages.map((message, i) => (
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
                            <div className="prose prose-invert prose-sm max-w-none font-mono leading-relaxed text-[13px]">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {message.content}
                              </ReactMarkdown>
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
                  ))}

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

              {/* Input Module - Pill Style */}
              <div className="px-4 pb-4 pt-2 backdrop-blur-xl shrink-0">
                <div className="max-w-6xl mx-auto">
                  <div className="flex items-end gap-0 bg-slate-800/60 border border-slate-700/50 rounded-full px-2 py-1.5 shadow-[0_0_30px_rgba(0,0,0,0.3)] focus-within:border-[#00d9ff]/30 transition-all">
                    <button
                      onClick={createNewSession}
                      className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-gray-500 hover:text-[#00d9ff] hover:bg-slate-700/50 transition-all"
                    >
                      <Plus className="w-5 h-5" />
                    </button>
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
          </>
        )}

        {/* Empty State */}
        {!currentSessionId && (
          <div className="flex-1 flex flex-col items-center justify-center space-y-4">
            {!sidebarOpen && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSidebarOpen(true)}
                className="absolute top-3 left-3 text-[#00d9ff] hover:text-white hover:bg-[#00d9ff]/10 h-8 w-8 p-0 z-10"
              >
                <PanelLeftOpen className="w-4 h-4" />
              </Button>
            )}
             <div className="animate-[bounce-slow_2s_ease-in-out_infinite]">
               <Logo size={80} />
             </div>
             <h2 className="text-2xl font-bold bg-gradient-to-r from-white via-[#00d9ff] to-[#4ECDC4] bg-clip-text text-transparent tracking-tight">
               Daemora
             </h2>
             <p className="text-gray-600 font-mono text-xs uppercase tracking-widest">Select or Initialize Session</p>
          </div>
        )}
      </div>
    </div>
  );
}
