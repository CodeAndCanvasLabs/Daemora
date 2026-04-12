import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { apiFetch } from "../api";
import { Logo } from "../components/ui/Logo";
import { Eye, EyeOff, Check, ChevronRight, Shield, Cpu, Mic, Sparkles } from "lucide-react";

const PROVIDERS = {
  anthropic: { name: "Anthropic", detail: "Claude 4.5 / Haiku", key: "ANTHROPIC_API_KEY", model: "anthropic:claude-haiku-4-5" },
  openai:    { name: "OpenAI",    detail: "GPT-4o / o3",        key: "OPENAI_API_KEY",    model: "openai:gpt-4o-mini" },
  google:    { name: "Google",    detail: "Gemini 2.5",         key: "GOOGLE_GENERATIVE_AI_API_KEY", model: "google:gemini-2.5-flash" },
  groq:      { name: "Groq",      detail: "Llama / Mixtral",    key: "GROQ_API_KEY",      model: "groq:llama-3.3-70b-versatile" },
};

const STT_OPTIONS = [
  { value: "groq",      label: "Groq Whisper",    detail: "Fast, free tier" },
  { value: "deepgram",  label: "Deepgram Nova",   detail: "Accurate streaming" },
  { value: "openai",    label: "OpenAI Whisper",   detail: "Multilingual" },
  { value: "assemblyai",label: "AssemblyAI",       detail: "Best accuracy" },
];

const TTS_OPTIONS = [
  { value: "openai",     label: "OpenAI TTS",      detail: "Natural voices" },
  { value: "groq",       label: "Groq Orpheus",    detail: "Ultra-fast" },
  { value: "elevenlabs", label: "ElevenLabs",       detail: "Premium quality" },
  { value: "cartesia",   label: "Cartesia Sonic",   detail: "Low latency" },
];

type Step = "vault" | "provider" | "voice" | "complete";

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

  useEffect(() => {
    checkSetup();
  }, []);

  async function checkSetup() {
    try {
      const res = await apiFetch("/api/setup/status");
      if (res.ok) {
        const data = await res.json();
        if (data.completed) {
          navigate("/", { replace: true });
          return;
        }
        setVaultExists(data.vaultExists);
        if (data.vaultUnlocked && data.hasAnyLlmKey) {
          setStep("voice");
        } else if (data.vaultUnlocked) {
          setStep("provider");
        }
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
        const res = await apiFetch("/api/vault/unlock", {
          method: "POST",
          body: JSON.stringify({ passphrase }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || "Wrong passphrase");
        }
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
        // unlock() creates the vault automatically on first call
        const res = await apiFetch("/api/vault/unlock", {
          method: "POST",
          body: JSON.stringify({ passphrase }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || "Failed to create vault");
        }
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
      const res = await apiFetch("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          updates: {
            [p.key]: apiKey.trim(),
            DEFAULT_MODEL: p.model,
          },
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      setStep("voice");
    } catch (e: any) {
      setError(e.message || String(e));
    }
    setProviderLoading(false);
  }

  async function handleVoice() {
    try {
      await apiFetch("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          updates: {
            DAEMORA_STT_PROVIDER: sttProvider,
            DAEMORA_TTS_PROVIDER: ttsProvider,
            SETUP_COMPLETED: new Date().toISOString(),
          },
        }),
      });
    } catch {}
    setStep("complete");
    setTimeout(() => navigate("/", { replace: true }), 1500);
  }

  const steps: Step[] = ["vault", "provider", "voice", "complete"];
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
                <div className={`w-8 h-px transition-colors ${i < stepIndex ? "bg-[#4ECDC4]" : "bg-[#1e2d45]"}`} />
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
                  {vaultExists
                    ? "Enter your vault passphrase to unlock API keys."
                    : "Create a passphrase to encrypt your API keys. You'll enter this each time you open Daemora."}
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

              <button onClick={skipVault} className="text-xs text-[#4a5568] hover:text-[#6b7a8d] underline transition-colors">
                Skip — keys stored unencrypted
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

              <button
                onClick={handleVoice}
                className="w-full py-3 bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-[#0a0f1a] font-bold rounded-lg text-sm tracking-wide hover:opacity-90 active:scale-[0.98] transition-all"
              >
                Finish Setup
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
