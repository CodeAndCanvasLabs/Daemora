import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { apiFetch } from "../api";
import { Logo } from "../components/ui/Logo";
import { Eye, EyeOff, Check, Shield, Cpu, Mic, Sparkles, User, MessageSquare } from "lucide-react";

const PROVIDERS = {
  anthropic: { name: "Anthropic", detail: "Claude 4.5 / Haiku", key: "ANTHROPIC_API_KEY", model: "anthropic:claude-haiku-4-5" },
  openai:    { name: "OpenAI",    detail: "GPT-4o / o3",        key: "OPENAI_API_KEY",    model: "openai:gpt-4o-mini" },
  google:    { name: "Google",    detail: "Gemini 2.5",         key: "GOOGLE_GENERATIVE_AI_API_KEY", model: "google:gemini-2.5-flash" },
  groq:      { name: "Groq",      detail: "GPT-OSS / Llama",    key: "GROQ_API_KEY",      model: "groq:openai/gpt-oss-120b" },
};

// Each voice provider needs an API key — we track which env key matches
const STT_OPTIONS = [
  { value: "groq",      label: "Groq Whisper",     detail: "Fast, free tier",       keyEnv: "GROQ_API_KEY" },
  { value: "deepgram",  label: "Deepgram Nova",    detail: "Accurate streaming",    keyEnv: "DEEPGRAM_API_KEY" },
  { value: "openai",    label: "OpenAI Whisper",   detail: "Multilingual",          keyEnv: "OPENAI_API_KEY" },
  { value: "assemblyai",label: "AssemblyAI",       detail: "Best accuracy",         keyEnv: "ASSEMBLYAI_API_KEY" },
];

const TTS_OPTIONS = [
  { value: "openai",     label: "OpenAI TTS",      detail: "Natural voices",         keyEnv: "OPENAI_API_KEY" },
  { value: "groq",       label: "Groq Orpheus",    detail: "Ultra-fast",             keyEnv: "GROQ_API_KEY" },
  { value: "elevenlabs", label: "ElevenLabs",      detail: "Premium quality",        keyEnv: "ELEVENLABS_API_KEY" },
  { value: "cartesia",   label: "Cartesia Sonic",  detail: "Low latency",            keyEnv: "CARTESIA_API_KEY" },
];

type Step = "vault" | "provider" | "voice" | "wake" | "profile" | "connect" | "complete";

const COMM_STYLES = [
  { value: "concise",  label: "Concise",  detail: "Short, direct answers" },
  { value: "detailed", label: "Detailed", detail: "Thorough with context" },
  { value: "casual",   label: "Casual",   detail: "Warm and conversational" },
  { value: "formal",   label: "Formal",   detail: "Professional tone" },
];

const WAKE_WORDS = [
  { value: "hey_jarvis",  label: "Hey Jarvis",    detail: "Most accurate" },
  { value: "hey_daemora", label: "Hey Daemora",   detail: "Falls back to Jarvis" },
  { value: "hey_mycroft", label: "Hey Mycroft",   detail: "Classic open-source" },
  { value: "hey_rhasspy", label: "Hey Rhasspy",   detail: "Alternative phrase" },
  { value: "alexa",       label: "Alexa",         detail: "If you like the name" },
];

export function Setup() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("vault");
  const [vaultExists, setVaultExists] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Vault
  const [passphrase, setPassphrase] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [vaultLoading, setVaultLoading] = useState(false);

  // Provider
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [providerLoading, setProviderLoading] = useState(false);

  // Voice
  const [sttProvider, setSttProvider] = useState("groq");
  const [ttsProvider, setTtsProvider] = useState("openai");
  const [voiceKeys, setVoiceKeys] = useState<Record<string, string>>({});
  const [voiceError, setVoiceError] = useState<string | null>(null);

  // Wake word
  const [wakeWord, setWakeWord] = useState("hey_jarvis");

  // Profile (seeds USER.md declarative memory)
  const [profileName, setProfileName] = useState("");
  const [profileRole, setProfileRole] = useState("");
  const [profileTimezone, setProfileTimezone] = useState(
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "",
  );
  const [profileStyle, setProfileStyle] = useState("concise");
  const [profileLoading, setProfileLoading] = useState(false);

  // Channels
  type ChannelItem = {
    id: string;
    label: string;
    description: string;
    configured: boolean;
    running: boolean;
    requiredKeys: Array<{ key: string; label: string; secret: boolean }>;
    missingKeys: string[];
  };
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [expandedChannel, setExpandedChannel] = useState<string | null>(null);
  const [channelFormValues, setChannelFormValues] = useState<Record<string, string>>({});
  const [channelSaving, setChannelSaving] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);

  useEffect(() => {
    checkSetup();
  }, []);

  /**
   * Wrap an API call with auto re-unlock. During setup the user's
   * passphrase is held in React state; if a write fails because the
   * vault locked (dev-mode hot reload, idle timeout, etc.) we silently
   * re-unlock with the same passphrase and retry once.
   */
  async function apiFetchAutoUnlock(path: string, init?: RequestInit): Promise<Response> {
    let res = await apiFetch(path, init);
    if (res.ok || !passphrase) return res;
    const snapshot = res.clone();
    let body: any = null;
    try { body = await snapshot.json(); } catch { /* non-JSON */ }
    const msg = String(body?.message ?? body?.error ?? "").toLowerCase();
    const locked = msg.includes("vault is locked") || body?.code === "vault_locked";
    if (!locked) return res;
    // Re-unlock and retry once. /auth/login runs through LocalAuthProvider
    // which unlocks the vault + issues a fresh JWT in a single call.
    const unlock = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ passphrase }),
    });
    if (!unlock.ok) return res;
    return apiFetch(path, init);
  }

  async function checkSetup() {
    try {
      const res = await apiFetch("/api/setup/status");
      if (res.ok) {
        const data = await res.json();
        // Allow re-running the wizard via ?force=1 (linked from Settings).
        const force = new URLSearchParams(window.location.search).get("force") === "1";
        if (data.completed && !force) {
          navigate("/", { replace: true });
          return;
        }
        setVaultExists(data.vaultExists);
        if (data.vaultExists) {
          // If vault exists but is LOCKED, show the unlock step first.
          // Otherwise jump ahead: skip provider if one is already set.
          if (!data.vaultUnlocked) {
            setStep("vault");
          } else if (data.hasProvider || data.hasAnyLlmKey) {
            setStep("voice");
          } else {
            setStep("provider");
          }
        }
        // else: vault doesn't exist — show create passphrase step
      }
    } catch {}
    setLoading(false);
  }

  async function handleVault() {
    setError(null);
    if (vaultExists) {
      if (!passphrase) { setError("Enter your passphrase"); return; }
      setVaultLoading(true);
      try {
        // Unified unlock: /auth/login delegates to LocalAuthProvider
        // which unlocks the vault and issues a JWT in one call.
        const res = await apiFetch("/auth/login", {
          method: "POST",
          body: JSON.stringify({ passphrase }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || "Wrong passphrase");
        }
        sessionStorage.setItem("daemora_vault_pass", passphrase);
        setStep("provider");
      } catch (e: any) {
        setError(e.message || String(e));
      }
      setVaultLoading(false);
    } else {
      if (passphrase.length < 8) { setError("Passphrase must be at least 8 characters"); return; }
      if (passphrase !== confirmPass) { setError("Passphrases don't match"); return; }
      setVaultLoading(true);
      try {
        // First run: vault doesn't exist yet. /api/vault/unlock creates
        // it with this passphrase. We then call /auth/login so the same
        // passphrase immediately issues a JWT — no double prompt.
        const create = await apiFetch("/api/vault/unlock", {
          method: "POST",
          body: JSON.stringify({ passphrase }),
        });
        if (!create.ok) {
          const d = await create.json().catch(() => ({}));
          throw new Error(d.error || "Failed to create vault");
        }
        const login = await apiFetch("/auth/login", {
          method: "POST",
          body: JSON.stringify({ passphrase }),
        });
        if (!login.ok) {
          const d = await login.json().catch(() => ({}));
          throw new Error(d.error || "Vault created but login failed");
        }
        sessionStorage.setItem("daemora_vault_pass", passphrase);
        setStep("provider");
      } catch (e: any) {
        setError(e.message || String(e));
      }
      setVaultLoading(false);
    }
  }

  function skipVault() {
    setStep("provider");
  }

  async function handleProvider() {
    setError(null);
    if (!selectedProvider || !apiKey.trim()) {
      setError("Select a provider and enter your API key");
      return;
    }
    setProviderLoading(true);
    try {
      const p = PROVIDERS[selectedProvider as keyof typeof PROVIDERS];
      const res = await apiFetchAutoUnlock("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          updates: {
            [p.key]: apiKey.trim(),
            DEFAULT_MODEL: p.model,
          },
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d?.message || d?.error || "Failed to save");
      }
      setStep("voice");
    } catch (e: any) {
      setError(e.message || String(e));
    }
    setProviderLoading(false);
  }

  async function handleVoice() {
    setVoiceError(null);
    // Figure out which API keys are needed for the selected providers
    const sttOpt = STT_OPTIONS.find((o) => o.value === sttProvider);
    const ttsOpt = TTS_OPTIONS.find((o) => o.value === ttsProvider);
    const neededKeys = new Set<string>();
    if (sttOpt?.keyEnv) neededKeys.add(sttOpt.keyEnv);
    if (ttsOpt?.keyEnv) neededKeys.add(ttsOpt.keyEnv);

    // If user picked the same provider for LLM (e.g., OPENAI_API_KEY already set), skip asking
    const missingKeys = Array.from(neededKeys).filter((k) => !voiceKeys[k]);
    // Check if already saved (from LLM step)
    const stillMissing: string[] = [];
    for (const k of missingKeys) {
      // If key env matches LLM provider key we already saved, skip
      const llmKey = selectedProvider ? PROVIDERS[selectedProvider as keyof typeof PROVIDERS].key : null;
      if (llmKey === k) continue;
      stillMissing.push(k);
    }
    if (stillMissing.length > 0) {
      setVoiceError(`Enter API key for: ${stillMissing.join(", ")}`);
      return;
    }

    const updates: Record<string, string> = {
      DAEMORA_STT_PROVIDER: sttProvider,
      DAEMORA_TTS_PROVIDER: ttsProvider,
    };
    // Save voice provider keys
    for (const [envKey, value] of Object.entries(voiceKeys)) {
      if (value?.trim()) updates[envKey] = value.trim();
    }

    try {
      await apiFetchAutoUnlock("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ updates }),
      });
    } catch {}
    setStep("wake");
  }

  async function handleWake() {
    try {
      await apiFetchAutoUnlock("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          updates: {
            WAKE_WORD: wakeWord,
            WAKE_WORD_ENABLED: "true",
          },
        }),
      });
      // Start the wake word listener immediately
      await apiFetch("/api/voice/wake/start", {
        method: "POST",
        body: JSON.stringify({ wake_word: wakeWord }),
      }).catch(() => {});
    } catch {}
    setStep("profile");
  }

  async function handleProfile() {
    setProfileLoading(true);
    try {
      // Seed USER.md declarative memory with the agent's long-term profile
      // facts — these are frozen into every turn's system prompt.
      const entries: string[] = [];
      if (profileName.trim()) entries.push(`User's name is ${profileName.trim()}.`);
      if (profileRole.trim())  entries.push(`User's role: ${profileRole.trim()}.`);
      if (profileTimezone.trim()) entries.push(`User's timezone is ${profileTimezone.trim()}.`);
      if (profileStyle) {
        const style = COMM_STYLES.find((s) => s.value === profileStyle);
        if (style) entries.push(`User prefers ${style.label.toLowerCase()} responses (${style.detail.toLowerCase()}).`);
      }
      for (const content of entries) {
        await apiFetchAutoUnlock("/api/brain/user", {
          method: "POST",
          body: JSON.stringify({ action: "add", content }),
        }).catch(() => {});
      }
    } catch {}
    setProfileLoading(false);
    await loadChannels();
    setStep("connect");
  }

  async function loadChannels() {
    setChannelsLoading(true);
    try {
      const res = await apiFetch("/api/channels");
      if (res.ok) {
        const data = await res.json();
        setChannels(
          (data.channels ?? []).map((c: any) => ({
            id: c.id,
            label: c.name ?? c.id,
            description: c.description ?? "",
            configured: !!c.configured,
            running: !!c.running,
            requiredKeys: c.requiredKeys ?? [],
            missingKeys: c.missingKeys ?? [],
          })),
        );
      }
    } catch {}
    setChannelsLoading(false);
  }

  function openConfigureChannel(c: ChannelItem) {
    setExpandedChannel(c.id);
    setChannelError(null);
    // Pre-fill form with empty strings for each required key.
    const initial: Record<string, string> = {};
    for (const k of c.requiredKeys) initial[k.key] = "";
    setChannelFormValues(initial);
  }

  async function saveChannelConfig(c: ChannelItem) {
    setChannelSaving(true);
    setChannelError(null);
    try {
      // Separate secrets (→ vault) from plain settings (→ settings store).
      const secretUpdates: Array<[string, string]> = [];
      const settingUpdates: Record<string, string> = {};
      for (const k of c.requiredKeys) {
        const v = (channelFormValues[k.key] ?? "").trim();
        if (!v) continue;
        if (k.secret) secretUpdates.push([k.key, v]);
        else settingUpdates[k.key] = v;
      }
      // Secrets go one by one to /api/vault/:key
      for (const [key, value] of secretUpdates) {
        const r = await apiFetchAutoUnlock(`/api/vault/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: JSON.stringify({ value }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.error || d.message || `${key}: ${r.status}`);
        }
      }
      // Non-secrets go batched to /api/settings
      if (Object.keys(settingUpdates).length > 0) {
        const r = await apiFetchAutoUnlock("/api/settings", {
          method: "PUT",
          body: JSON.stringify({ updates: settingUpdates }),
        });
        if (!r.ok) throw new Error("settings save failed");
      }
      // Start the channel now that config exists
      await apiFetch(`/api/channels/${c.id}/start`, { method: "POST" }).catch(() => {});
      await loadChannels();
      setExpandedChannel(null);
      setChannelFormValues({});
    } catch (e: any) {
      setChannelError(e?.message || String(e));
    }
    setChannelSaving(false);
  }

  async function handleConnect() {
    try {
      await apiFetchAutoUnlock("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          updates: { SETUP_COMPLETED: new Date().toISOString() },
        }),
      });
    } catch {}
    setStep("complete");
    setTimeout(() => navigate("/", { replace: true }), 1500);
  }

  async function toggleChannel(id: string, running: boolean) {
    const path = running ? `/api/channels/${id}/stop` : `/api/channels/${id}/start`;
    try { await apiFetch(path, { method: "POST" }); } catch {}
    await loadChannels();
  }

  // Compute which voice provider keys need to be entered (excluding already-saved LLM key)
  function neededVoiceKeys(): string[] {
    const sttOpt = STT_OPTIONS.find((o) => o.value === sttProvider);
    const ttsOpt = TTS_OPTIONS.find((o) => o.value === ttsProvider);
    const keys = new Set<string>();
    if (sttOpt?.keyEnv) keys.add(sttOpt.keyEnv);
    if (ttsOpt?.keyEnv) keys.add(ttsOpt.keyEnv);
    const llmKey = selectedProvider ? PROVIDERS[selectedProvider as keyof typeof PROVIDERS].key : null;
    if (llmKey) keys.delete(llmKey);
    return Array.from(keys);
  }

  const steps: Step[] = ["vault", "provider", "voice", "wake", "profile", "connect", "complete"];
  const stepIndex = steps.indexOf(step);

  if (loading) {
    return (
      <div className="fixed inset-0 bg-[#0a0f1a] flex items-center justify-center">
        <div className="animate-pulse text-[#00d9ff] font-mono text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-[#0a0f1a] flex items-center justify-center overflow-auto">
      {/* Subtle background glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-[#00d9ff] opacity-[0.03] rounded-full blur-[120px] pointer-events-none" />

      <div className="relative z-10 w-full max-w-md px-6 py-12 flex flex-col items-center gap-6">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14">
            <Logo />
          </div>
          <h1 className="text-2xl font-bold tracking-[3px] bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] bg-clip-text text-transparent">
            DAEMORA
          </h1>
        </div>

        {/* Progress */}
        <div className="flex items-center gap-2">
          {steps.slice(0, -1).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full transition-all duration-300 ${
                i < stepIndex ? "bg-[#4ECDC4]" :
                i === stepIndex ? "bg-[#00d9ff] shadow-[0_0_8px_rgba(0,217,255,0.5)]" :
                "bg-[#1e2d45]"
              }`} />
              {i < steps.length - 2 && (
                <div className={`w-5 h-px transition-colors ${i < stepIndex ? "bg-[#4ECDC4]" : "bg-[#1e2d45]"}`} />
              )}
            </div>
          ))}
        </div>

        {/* Step Content */}
        <div className="w-full animate-in fade-in slide-in-from-bottom-2 duration-300">

          {/* VAULT STEP */}
          {step === "vault" && (
            <div className="flex flex-col gap-4">
              <div className="text-center">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[#131b2e] border border-[#1e2d45] mb-3">
                  <Shield className="w-6 h-6 text-[#00d9ff]" />
                </div>
                <h2 className="text-lg font-semibold text-white">Secure Your Keys</h2>
                <p className="text-sm text-[#6b7a8d] mt-1">
                  Create a passphrase to encrypt your API keys. You'll enter this each time you open Daemora. Choose something you'll remember — if you forget it, your keys can't be recovered.
                </p>
              </div>

              <div className="relative">
                <input
                  type={showPass ? "text" : "password"}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleVault()}
                  placeholder={vaultExists ? "Vault passphrase" : "Create passphrase (8+ chars)"}
                  className="w-full px-4 py-3 bg-[#131b2e] border border-[#1e2d45] rounded-lg text-white font-mono text-sm outline-none focus:border-[#00d9ff] focus:shadow-[0_0_0_2px_rgba(0,217,255,0.12)] transition-all"
                  autoFocus
                />
                <button onClick={() => setShowPass(!showPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#4a5568] hover:text-[#00d9ff] transition-colors">
                  {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>

              {!vaultExists && (
                <input
                  type="password"
                  value={confirmPass}
                  onChange={(e) => setConfirmPass(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleVault()}
                  placeholder="Confirm passphrase"
                  className="w-full px-4 py-3 bg-[#131b2e] border border-[#1e2d45] rounded-lg text-white font-mono text-sm outline-none focus:border-[#00d9ff] focus:shadow-[0_0_0_2px_rgba(0,217,255,0.12)] transition-all"
                />
              )}

              {error && <p className="text-xs text-red-400 text-center">{error}</p>}

              <button
                onClick={handleVault}
                disabled={vaultLoading}
                className="w-full py-3 bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-[#0a0f1a] font-bold rounded-lg text-sm tracking-wide hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-40"
              >
                {vaultLoading ? "Starting..." : vaultExists ? "Unlock" : "Create & Continue"}
              </button>

            </div>
          )}

          {/* PROVIDER STEP */}
          {step === "provider" && (
            <div className="flex flex-col gap-4">
              <div className="text-center">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[#131b2e] border border-[#1e2d45] mb-3">
                  <Cpu className="w-6 h-6 text-[#00d9ff]" />
                </div>
                <h2 className="text-lg font-semibold text-white">AI Model</h2>
                <p className="text-sm text-[#6b7a8d] mt-1">Pick your AI provider and enter the API key.</p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {Object.entries(PROVIDERS).map(([id, p]) => (
                  <button
                    key={id}
                    onClick={() => { setSelectedProvider(id); setError(null); }}
                    className={`p-3 rounded-lg border text-left transition-all ${
                      selectedProvider === id
                        ? "border-[#00d9ff] bg-[#0d1a2d] shadow-[0_0_12px_rgba(0,217,255,0.1)]"
                        : "border-[#1e2d45] bg-[#131b2e] hover:border-[#00d9ff]/50"
                    }`}
                  >
                    <div className="text-sm font-semibold text-white">{p.name}</div>
                    <div className="text-[10px] text-[#4a5568] mt-0.5">{p.detail}</div>
                  </button>
                ))}
              </div>

              {selectedProvider && (
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleProvider()}
                  placeholder={`${PROVIDERS[selectedProvider as keyof typeof PROVIDERS].name} API key`}
                  className="w-full px-4 py-3 bg-[#131b2e] border border-[#1e2d45] rounded-lg text-white font-mono text-sm outline-none focus:border-[#00d9ff] focus:shadow-[0_0_0_2px_rgba(0,217,255,0.12)] transition-all"
                  autoFocus
                />
              )}

              {error && <p className="text-xs text-red-400 text-center">{error}</p>}

              <button
                onClick={handleProvider}
                disabled={providerLoading || !selectedProvider}
                className="w-full py-3 bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-[#0a0f1a] font-bold rounded-lg text-sm tracking-wide hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-40"
              >
                {providerLoading ? "Saving..." : "Continue"}
              </button>
            </div>
          )}

          {/* VOICE STEP */}
          {step === "voice" && (
            <div className="flex flex-col gap-4">
              <div className="text-center">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[#131b2e] border border-[#1e2d45] mb-3">
                  <Mic className="w-6 h-6 text-[#00d9ff]" />
                </div>
                <h2 className="text-lg font-semibold text-white">Voice</h2>
                <p className="text-sm text-[#6b7a8d] mt-1">Choose speech-to-text and text-to-speech providers.</p>
              </div>

              <div>
                <label className="text-[10px] uppercase tracking-wider text-[#6b7a8d] mb-1 block">Speech-to-Text</label>
                <div className="grid grid-cols-2 gap-2">
                  {STT_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      onClick={() => setSttProvider(o.value)}
                      className={`p-2.5 rounded-lg border text-left transition-all ${
                        sttProvider === o.value
                          ? "border-[#00d9ff] bg-[#0d1a2d]"
                          : "border-[#1e2d45] bg-[#131b2e] hover:border-[#00d9ff]/50"
                      }`}
                    >
                      <div className="text-xs font-semibold text-white">{o.label}</div>
                      <div className="text-[9px] text-[#4a5568]">{o.detail}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-[10px] uppercase tracking-wider text-[#6b7a8d] mb-1 block">Text-to-Speech</label>
                <div className="grid grid-cols-2 gap-2">
                  {TTS_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      onClick={() => setTtsProvider(o.value)}
                      className={`p-2.5 rounded-lg border text-left transition-all ${
                        ttsProvider === o.value
                          ? "border-[#4ECDC4] bg-[#0d1a2d]"
                          : "border-[#1e2d45] bg-[#131b2e] hover:border-[#4ECDC4]/50"
                      }`}
                    >
                      <div className="text-xs font-semibold text-white">{o.label}</div>
                      <div className="text-[9px] text-[#4a5568]">{o.detail}</div>
                    </button>
                  ))}
                </div>
              </div>

              {neededVoiceKeys().length > 0 && (
                <div className="flex flex-col gap-2 border-t border-[#1e2d45] pt-3">
                  <label className="text-[10px] uppercase tracking-wider text-[#6b7a8d]">API Keys for Voice</label>
                  {neededVoiceKeys().map((envKey) => (
                    <input
                      key={envKey}
                      type="password"
                      value={voiceKeys[envKey] || ""}
                      onChange={(e) => setVoiceKeys({ ...voiceKeys, [envKey]: e.target.value })}
                      placeholder={`${envKey}`}
                      className="w-full px-4 py-2.5 bg-[#131b2e] border border-[#1e2d45] rounded-lg text-white font-mono text-xs outline-none focus:border-[#00d9ff] transition-colors"
                    />
                  ))}
                </div>
              )}

              {voiceError && <p className="text-xs text-red-400 text-center">{voiceError}</p>}

              <button
                onClick={handleVoice}
                className="w-full py-3 bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-[#0a0f1a] font-bold rounded-lg text-sm tracking-wide hover:opacity-90 active:scale-[0.98] transition-all"
              >
                Finish Setup
              </button>

              <button
                onClick={() => { setVoiceError(""); setStep("wake"); }}
                className="w-full py-2 text-xs text-[#6b7a8d] hover:text-[#00d9ff] transition-colors"
              >
                Skip voice setup — configure later in Settings
              </button>
            </div>
          )}

          {/* WAKE STEP */}
          {step === "wake" && (
            <div className="flex flex-col gap-4">
              <div className="text-center">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[#131b2e] border border-[#1e2d45] mb-3">
                  <Mic className="w-6 h-6 text-[#00d9ff]" />
                </div>
                <h2 className="text-lg font-semibold text-white">Wake Word</h2>
                <p className="text-sm text-[#6b7a8d] mt-1">
                  Daemora listens for this phrase and activates voice mode when heard.
                  Say the phrase, wait for the beep, then speak.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-2">
                {WAKE_WORDS.map((w) => (
                  <button
                    key={w.value}
                    onClick={() => setWakeWord(w.value)}
                    className={`p-3 rounded-lg border text-left transition-all flex items-center justify-between ${
                      wakeWord === w.value
                        ? "border-[#00d9ff] bg-[#0d1a2d] shadow-[0_0_12px_rgba(0,217,255,0.1)]"
                        : "border-[#1e2d45] bg-[#131b2e] hover:border-[#00d9ff]/50"
                    }`}
                  >
                    <div>
                      <div className="text-sm font-semibold text-white">&quot;{w.label}&quot;</div>
                      <div className="text-[10px] text-[#4a5568]">{w.detail}</div>
                    </div>
                    {wakeWord === w.value && <Check className="w-4 h-4 text-[#00d9ff]" />}
                  </button>
                ))}
              </div>

              <button
                onClick={handleWake}
                className="w-full py-3 bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-[#0a0f1a] font-bold rounded-lg text-sm tracking-wide hover:opacity-90 active:scale-[0.98] transition-all"
              >
                Finish Setup
              </button>

              <button
                onClick={async () => {
                  // Skip wake word but continue to profile step.
                  try {
                    await apiFetchAutoUnlock("/api/settings", {
                      method: "PUT",
                      body: JSON.stringify({ updates: {
                        WAKE_WORD_ENABLED: "false",
                      }}),
                    });
                  } catch {}
                  setStep("profile");
                }}
                className="w-full py-2 text-xs text-[#6b7a8d] hover:text-[#00d9ff] transition-colors"
              >
                Skip — I'll enable wake word later
              </button>
            </div>
          )}

          {/* PROFILE STEP — seeds USER.md declarative memory */}
          {step === "profile" && (
            <div className="flex flex-col gap-4">
              <div className="text-center">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[#131b2e] border border-[#1e2d45] mb-3">
                  <User className="w-6 h-6 text-[#00d9ff]" />
                </div>
                <h2 className="text-lg font-semibold text-white">Tell Daemora About You</h2>
                <p className="text-sm text-[#6b7a8d] mt-1">
                  This goes into long-term memory (USER.md). Daemora reads it at the start of every session so you don't have to repeat yourself.
                </p>
              </div>

              <input
                type="text"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                placeholder="Your name"
                className="w-full px-4 py-2.5 bg-[#131b2e] border border-[#1e2d45] rounded-lg text-white font-mono text-sm outline-none focus:border-[#00d9ff] focus:shadow-[0_0_0_2px_rgba(0,217,255,0.12)] transition-all"
              />
              <input
                type="text"
                value={profileRole}
                onChange={(e) => setProfileRole(e.target.value)}
                placeholder="Your role (e.g. Software engineer)"
                className="w-full px-4 py-2.5 bg-[#131b2e] border border-[#1e2d45] rounded-lg text-white font-mono text-sm outline-none focus:border-[#00d9ff] focus:shadow-[0_0_0_2px_rgba(0,217,255,0.12)] transition-all"
              />
              <input
                type="text"
                value={profileTimezone}
                onChange={(e) => setProfileTimezone(e.target.value)}
                placeholder="Timezone (e.g. Asia/Karachi)"
                className="w-full px-4 py-2.5 bg-[#131b2e] border border-[#1e2d45] rounded-lg text-white font-mono text-sm outline-none focus:border-[#00d9ff] focus:shadow-[0_0_0_2px_rgba(0,217,255,0.12)] transition-all"
              />

              <div>
                <label className="text-[10px] uppercase tracking-wider text-[#6b7a8d] mb-1 block">Communication Style</label>
                <div className="grid grid-cols-2 gap-2">
                  {COMM_STYLES.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => setProfileStyle(s.value)}
                      className={`p-2.5 rounded-lg border text-left transition-all ${
                        profileStyle === s.value
                          ? "border-[#00d9ff] bg-[#0d1a2d]"
                          : "border-[#1e2d45] bg-[#131b2e] hover:border-[#00d9ff]/50"
                      }`}
                    >
                      <div className="text-xs font-semibold text-white">{s.label}</div>
                      <div className="text-[9px] text-[#4a5568]">{s.detail}</div>
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={handleProfile}
                disabled={profileLoading}
                className="w-full py-3 bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-[#0a0f1a] font-bold rounded-lg text-sm tracking-wide hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-40"
              >
                {profileLoading ? "Saving..." : "Continue"}
              </button>

              <button
                onClick={async () => { await loadChannels(); setStep("connect"); }}
                className="w-full py-2 text-xs text-[#6b7a8d] hover:text-[#00d9ff] transition-colors"
              >
                Skip — I'll add this later
              </button>
            </div>
          )}

          {/* CONNECT STEP — channel picker */}
          {step === "connect" && (
            <div className="flex flex-col gap-4">
              <div className="text-center">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[#131b2e] border border-[#1e2d45] mb-3">
                  <MessageSquare className="w-6 h-6 text-[#00d9ff]" />
                </div>
                <h2 className="text-lg font-semibold text-white">Connect Your Channels</h2>
                <p className="text-sm text-[#6b7a8d] mt-1">
                  Reach Daemora from wherever you already chat. Configure keys later from Settings → Channels.
                </p>
              </div>

              {channelsLoading && (
                <p className="text-xs text-[#6b7a8d] text-center">Loading channels…</p>
              )}

              {!channelsLoading && channels.length === 0 && (
                <p className="text-xs text-[#6b7a8d] text-center">No channels registered.</p>
              )}

              <div className="flex flex-col gap-2 max-h-[360px] overflow-auto">
                {channels.map((c) => (
                  <div
                    key={c.id}
                    className="rounded-lg border border-[#1e2d45] bg-[#131b2e]"
                  >
                    <div className="flex items-center justify-between p-3">
                      <div>
                        <div className="text-sm font-semibold text-white">{c.label}</div>
                        <div className="text-[10px] text-[#4a5568]">
                          {c.configured ? "Configured" : "Needs API key"}
                          {c.running ? " · Running" : ""}
                          {c.description ? ` · ${c.description}` : ""}
                        </div>
                      </div>
                      {c.configured ? (
                        <button
                          onClick={() => toggleChannel(c.id, c.running)}
                          className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${
                            c.running
                              ? "border border-[#4ECDC4] text-[#4ECDC4]"
                              : "bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-[#0a0f1a]"
                          }`}
                        >
                          {c.running ? "Stop" : "Start"}
                        </button>
                      ) : (
                        <button
                          onClick={() => (expandedChannel === c.id ? setExpandedChannel(null) : openConfigureChannel(c))}
                          className="px-3 py-1.5 rounded text-xs font-medium bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-[#0a0f1a] hover:opacity-90"
                        >
                          {expandedChannel === c.id ? "Cancel" : "Configure"}
                        </button>
                      )}
                    </div>

                    {/* Inline configure form */}
                    {expandedChannel === c.id && (
                      <div className="px-3 pb-3 border-t border-[#1e2d45] pt-3 flex flex-col gap-2">
                        {c.requiredKeys.map((k) => (
                          <div key={k.key}>
                            <label className="text-[10px] uppercase tracking-wider text-[#6b7a8d] mb-1 block">
                              {k.label} <span className="text-[#4a5568] normal-case tracking-normal">({k.key})</span>
                            </label>
                            <input
                              type={k.secret ? "password" : "text"}
                              value={channelFormValues[k.key] ?? ""}
                              onChange={(e) => setChannelFormValues({ ...channelFormValues, [k.key]: e.target.value })}
                              placeholder={k.secret ? "•••••••" : ""}
                              className="w-full px-3 py-2 bg-[#0a0f1a] border border-[#1e2d45] rounded text-white font-mono text-xs outline-none focus:border-[#00d9ff] transition-colors"
                            />
                          </div>
                        ))}
                        {channelError && <p className="text-[10px] text-red-400">{channelError}</p>}
                        <button
                          onClick={() => saveChannelConfig(c)}
                          disabled={channelSaving}
                          className="w-full py-2 bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-[#0a0f1a] font-bold rounded text-xs tracking-wide hover:opacity-90 disabled:opacity-40"
                        >
                          {channelSaving ? "Saving..." : "Save & Start"}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <button
                onClick={handleConnect}
                className="w-full py-3 bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-[#0a0f1a] font-bold rounded-lg text-sm tracking-wide hover:opacity-90 active:scale-[0.98] transition-all"
              >
                Finish Setup
              </button>

              <button
                onClick={handleConnect}
                className="w-full py-2 text-xs text-[#6b7a8d] hover:text-[#00d9ff] transition-colors"
              >
                Skip — I'll connect later
              </button>
            </div>
          )}

          {/* COMPLETE */}
          {step === "complete" && (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-[#00d9ff] to-[#4ECDC4] flex items-center justify-center animate-in zoom-in duration-500">
                <Sparkles className="w-8 h-8 text-[#0a0f1a]" />
              </div>
              <h2 className="text-xl font-bold text-white">You're All Set</h2>
              <p className="text-sm text-[#6b7a8d]">Launching Daemora...</p>
              <div className="flex gap-1.5 mt-2">
                <div className="w-1.5 h-1.5 rounded-full bg-[#00d9ff] animate-pulse" />
                <div className="w-1.5 h-1.5 rounded-full bg-[#00d9ff] animate-pulse [animation-delay:0.2s]" />
                <div className="w-1.5 h-1.5 rounded-full bg-[#00d9ff] animate-pulse [animation-delay:0.4s]" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
