import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Eye, EyeOff, Lock } from "lucide-react";

import { login, LoginError, notifyAuthChange } from "../auth";
import { Logo } from "../components/ui/Logo";

export function Login() {
  const navigate = useNavigate();
  const [passphrase, setPassphrase] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [deviceName, setDeviceName] = useState(detectDeviceName());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(passphrase, deviceName);
      notifyAuthChange();
      navigate("/");
    } catch (err) {
      if (err instanceof LoginError) {
        if (err.code === "login_locked") {
          setRetryAfter(60);
          setError("Too many failed attempts. Try again in a minute.");
        } else if (err.code === "bad_credentials") {
          setError("Wrong passphrase.");
        } else {
          setError(err.message);
        }
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 mb-2">
          <Logo className="w-12 h-12" />
          <h1 className="text-2xl font-semibold">Daemora</h1>
          <p className="text-sm text-muted-foreground">Sign in with your vault passphrase.</p>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="passphrase">
            Passphrase
          </label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              id="passphrase"
              type={showPass ? "text" : "password"}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="w-full pl-9 pr-10 py-2 rounded-md border bg-background outline-none focus:ring-2 focus:ring-ring"
              autoFocus
              autoComplete="current-password"
              disabled={submitting || retryAfter !== null}
            />
            <button
              type="button"
              onClick={() => setShowPass((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              tabIndex={-1}
              aria-label={showPass ? "Hide passphrase" : "Show passphrase"}
            >
              {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="device">
            Device name
          </label>
          <input
            id="device"
            type="text"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value.slice(0, 64))}
            className="w-full px-3 py-2 rounded-md border bg-background outline-none focus:ring-2 focus:ring-ring"
            placeholder="e.g. MacBook Pro"
          />
          <p className="text-xs text-muted-foreground">Shown in your active sessions list so you can revoke this device later.</p>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || retryAfter !== null || passphrase.length < 8}
          className="rounded-md bg-primary text-primary-foreground py-2 font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary/90 transition"
        >
          {submitting ? "Signing in..." : "Sign in"}
        </button>

        <p className="text-xs text-muted-foreground text-center">
          Forgot your passphrase? There's no recovery — you'd need to delete the vault and start over.
        </p>
      </form>
    </div>
  );
}

function detectDeviceName(): string {
  const ua = navigator.userAgent;
  if (/Macintosh/.test(ua)) return "Mac";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "Browser";
}
