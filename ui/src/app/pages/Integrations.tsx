import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Loader2, Link2, Unplug, CheckCircle2, AlertCircle, Settings, Copy, ExternalLink, Trash2, ChevronRight } from "lucide-react";
import { apiFetch } from "../api";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

type IntegrationId =
  | "twitter"
  | "youtube"
  | "facebook"
  | "instagram"
  | "github"
  | "notion"
  | "gmail"
  | "google_calendar"
  | "reddit"
  | "linkedin"
  | "tiktok";

interface Availability {
  available: boolean;
  reason?: string;
}

interface Account {
  integration: IntegrationId;
  provider: string;
  accountId: string;
  accountLabel: string;
  scopes: string[];
  connectedAt: number;
  expiresAt: number;
}

interface State {
  availability: Record<IntegrationId, Availability>;
  accounts: Account[];
}

interface CredentialsInfo {
  integration: IntegrationId;
  provider: string;
  configured: boolean;
  hasClientId: boolean;
  hasClientSecret: boolean;
  requiresClientSecret: boolean;
  /**
   * True when the secret field should be RENDERED in the form, even if
   * it's optional (Twitter — only Confidential apps need a secret).
   * Distinct from `requiresClientSecret`, which gates whether save is
   * allowed without one.
   */
  showsClientSecret?: boolean;
  clientIdLabel: string;
  clientSecretLabel: string | null;
  consoleUrl: string;
  redirectUri: string;
  legacyRedirectUri: string;
  sharedWith: IntegrationId[];
  defaultScopes: string[];
  extraScopes: string[];
  /** Pinned redirect URI override. Empty string = no override (auto). */
  redirectUriOverride?: string;
}

const INTEGRATIONS: Array<{
  id: IntegrationId;
  name: string;
  tagline: string;
  /** Brand-accurate hex — matches each platform's current logo. */
  accent: string;
  /** Inline SVG logo, sized to fit 48x48 box. */
  logo: JSX.Element;
}> = [
  {
    id: "twitter",
    name: "X / Twitter",
    tagline: "Post tweets, search, manage DMs, follow/unfollow, and more.",
    accent: "#ffffff",
    logo: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    ),
  },
  {
    id: "youtube",
    name: "YouTube",
    tagline: "Search, manage your channel, playlists, comments, video metadata.",
    accent: "#FF0033",
    logo: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8">
        <path d="M23.498 6.186a2.999 2.999 0 0 0-2.113-2.12C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.385.521A2.999 2.999 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a2.999 2.999 0 0 0 2.113 2.12C4.495 20.455 12 20.455 12 20.455s7.505 0 9.385-.521a2.999 2.999 0 0 0 2.113-2.12C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
      </svg>
    ),
  },
  {
    id: "facebook",
    name: "Facebook Pages",
    tagline: "Manage Pages: post, schedule, upload photos, manage comments, view insights.",
    accent: "#1877F2",
    logo: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8">
        <path d="M24 12a12 12 0 1 0-13.875 11.854v-8.385H7.078V12h3.047V9.356c0-3.007 1.791-4.668 4.533-4.668 1.312 0 2.686.234 2.686.234v2.953h-1.513c-1.49 0-1.955.926-1.955 1.874V12h3.328l-.532 3.469h-2.796v8.385A12.002 12.002 0 0 0 24 12z" />
      </svg>
    ),
  },
  {
    id: "instagram",
    name: "Instagram",
    tagline: "Publish images/videos/carousels, manage comments, read insights.",
    accent: "#E1306C",
    logo: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8">
        <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z" />
      </svg>
    ),
  },
  {
    id: "github",
    name: "GitHub",
    tagline: "Triage issues, review PRs, search code, manage workflows — served through GitHub's remote MCP.",
    accent: "#f0f6fc",
    logo: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8">
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
      </svg>
    ),
  },
  {
    id: "notion",
    name: "Notion",
    tagline: "Pages, databases, comments, relations — OAuth-backed; only sees pages you share at consent.",
    accent: "#ffffff",
    logo: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7">
        <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.263c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933z" />
      </svg>
    ),
  },
  {
    id: "gmail",
    name: "Gmail",
    tagline: "Triage inbox, send/reply/draft, search, labels — native Gmail API with OAuth scopes.",
    accent: "#EA4335",
    logo: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8">
        <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z" />
      </svg>
    ),
  },
  {
    id: "google_calendar",
    name: "Google Calendar",
    tagline: "Events, free-busy, invites, quick-add — native Calendar API with multi-calendar support.",
    accent: "#4285F4",
    logo: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7">
        <path d="M19.5 22h-15A2.5 2.5 0 0 1 2 19.5v-15A2.5 2.5 0 0 1 4.5 2h15A2.5 2.5 0 0 1 22 4.5v15a2.5 2.5 0 0 1-2.5 2.5zM4.5 4a.5.5 0 0 0-.5.5v15a.5.5 0 0 0 .5.5h15a.5.5 0 0 0 .5-.5v-15a.5.5 0 0 0-.5-.5h-15z M8 8h8v2H8zM8 12h8v2H8zM8 16h5v2H8z" />
      </svg>
    ),
  },
  {
    id: "reddit",
    name: "Reddit",
    tagline: "Subreddit search, post/comment drafts, votes, inbox. Always checks subreddit rules before posting.",
    accent: "#FF4500",
    logo: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8">
        <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12.2c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z" />
      </svg>
    ),
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    tagline: "Publish to your feed, share articles, comment & like. Member-level scopes; company pages need Partner status.",
    accent: "#0A66C2",
    logo: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.063 2.063 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
      </svg>
    ),
  },
  {
    id: "tiktok",
    name: "TikTok",
    tagline: "Publish videos, list own videos, manage comments. Pre-audit: videos post as SELF_ONLY until TikTok review.",
    accent: "#25F4EE",
    logo: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8">
        <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
      </svg>
    ),
  },
];

export function Integrations() {
  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<IntegrationId | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<{ id: IntegrationId; accountId: string; label: string } | null>(null);
  const [credsInfo, setCredsInfo] = useState<CredentialsInfo | null>(null);
  const [credsForm, setCredsForm] = useState<{
    clientId: string;
    clientSecret: string;
    extraScopesText: string;
    /** "auto" = derive from browser URL on connect. "pinned" = use the
     *  redirectUriOverride string verbatim (registered tunnel URL etc). */
    redirectMode: "auto" | "pinned";
    redirectUriOverride: string;
  }>({ clientId: "", clientSecret: "", extraScopesText: "", redirectMode: "auto", redirectUriOverride: "" });
  const [credsBusy, setCredsBusy] = useState(false);
  // Confirm-clear popup — separate state from the configure dialog so
  // both can render at once (the AlertDialog opens on top of the modal).
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const refresh = async () => {
    try {
      const resp = await apiFetch("/api/integrations");
      if (resp.ok) setState((await resp.json()) as State);
    } catch (e) {
      console.error("integrations fetch failed", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  // Surface connect / error flashes returned from the OAuth callback.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const connected = q.get("connected");
    const label = q.get("label");
    const error = q.get("error");
    if (connected && label) {
      toast.success(`Connected ${connected} — ${label}`);
      refresh();
      navigate("/integrations", { replace: true });
    } else if (error) {
      toast.error(`Connect failed: ${decodeURIComponent(error)}`);
      navigate("/integrations", { replace: true });
    }
  }, [location.search, navigate]);

  const connect = async (id: IntegrationId) => {
    setBusyId(id);
    try {
      const resp = await apiFetch(`/api/integrations/${id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uiOrigin: window.location.origin }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Failed" }));
        toast.error(`Could not start auth: ${err.error ?? resp.statusText}`);
        setBusyId(null);
        return;
      }
      const { url } = (await resp.json()) as { url: string };
      // Provider redirects back to /oauth/integrations/:id/callback →
      // which then 302s back to /integrations?connected=...
      window.location.assign(url);
    } catch (e) {
      toast.error(`Could not start auth: ${(e as Error).message}`);
      setBusyId(null);
    }
  };

  const openCreds = async (id: IntegrationId): Promise<void> => {
    try {
      const resp = await apiFetch(`/api/integrations/${id}/credentials`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        toast.error(`Could not load credentials: ${err.error ?? resp.statusText}`);
        return;
      }
      const info = (await resp.json()) as CredentialsInfo;
      setCredsInfo(info);
      setCredsForm({
        clientId: "",
        clientSecret: "",
        extraScopesText: info.extraScopes.join(", "),
        redirectMode: info.redirectUriOverride && info.redirectUriOverride.length > 0 ? "pinned" : "auto",
        redirectUriOverride: info.redirectUriOverride ?? "",
      });
    } catch (e) {
      toast.error(`Could not load credentials: ${(e as Error).message}`);
    }
  };

  const saveCreds = async (): Promise<void> => {
    if (!credsInfo) return;
    setCredsBusy(true);
    try {
      const extraScopes = credsForm.extraScopesText
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const body: Record<string, unknown> = {
        clientId: credsForm.clientId.trim(),
        extraScopes,
        // "auto" → empty string clears any pinned override server-side.
        // "pinned" → send the user's URL (server validates http/https).
        redirectUriOverride: credsForm.redirectMode === "pinned"
          ? credsForm.redirectUriOverride.trim()
          : "",
      };
      // Send the secret whenever the field is rendered — required or
       // optional. Server treats blank as "clear" when optional.
       if (credsInfo.requiresClientSecret || credsInfo.showsClientSecret) {
         body["clientSecret"] = credsForm.clientSecret.trim();
       }
      const resp = await apiFetch(`/api/integrations/${credsInfo.integration}/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        toast.error(`Save failed: ${err.error ?? resp.statusText}`);
        return;
      }
      toast.success(
        credsInfo.sharedWith.length > 1
          ? `Saved — also unlocks ${credsInfo.sharedWith.filter((s) => s !== credsInfo.integration).join(", ")}`
          : "Credentials saved",
      );
      setCredsInfo(null);
      await refresh();
    } catch (e) {
      toast.error(`Save failed: ${(e as Error).message}`);
    } finally {
      setCredsBusy(false);
    }
  };

  // The Clear button just opens the confirmation popup — actual delete
  // runs from the AlertDialog's "Remove" action.
  const requestClearCreds = (): void => {
    if (!credsInfo) return;
    setClearConfirmOpen(true);
  };

  const performClearCreds = async (): Promise<void> => {
    if (!credsInfo) return;
    setClearConfirmOpen(false);
    setCredsBusy(true);
    try {
      const resp = await apiFetch(`/api/integrations/${credsInfo.integration}/credentials`, { method: "DELETE" });
      if (!resp.ok) {
        toast.error(`Clear failed: ${resp.statusText}`);
        return;
      }
      toast.success("Credentials cleared");
      setCredsInfo(null);
      await refresh();
    } finally {
      setCredsBusy(false);
    }
  };

  const copyToClipboard = (text: string, label: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error(`Couldn't copy ${label}`),
    );
  };

  const confirmDisconnect = async () => {
    if (!pendingDisconnect) return;
    const { id, accountId } = pendingDisconnect;
    setPendingDisconnect(null);
    setBusyId(id);
    try {
      const resp = await apiFetch(`/api/integrations/${id}/${encodeURIComponent(accountId)}`, { method: "DELETE" });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Failed" }));
        toast.error(`Disconnect failed: ${err.error ?? resp.statusText}`);
        return;
      }
      toast.success(`Disconnected ${id}`);
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  if (loading || !state) {
    return (
      <div className="p-8 flex items-center gap-3 text-gray-500 font-mono text-[11px]">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading integrations…
      </div>
    );
  }

  return (
    <div className="relative flex-1 flex flex-col overflow-y-auto">
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none bg-[url('https://grainy-gradients.vercel.app/noise.svg')] bg-repeat" />
      <div className="max-w-5xl mx-auto w-full px-6 py-8 relative z-10">
        <header className="mb-8">
          <h1 className="text-2xl font-bold bg-gradient-to-r from-white via-[#00d9ff] to-[#4ECDC4] bg-clip-text text-transparent">
            Integrations
          </h1>
          <p className="mt-1 text-xs text-gray-500 font-mono uppercase tracking-widest">
            Connect services — crews unlock on connect.
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {INTEGRATIONS.map((cfg) => {
            const avail = state.availability[cfg.id];
            const connected = state.accounts.filter((a) => a.integration === cfg.id);
            const isBusy = busyId === cfg.id;
            return (
              <div
                key={cfg.id}
                className="rounded-xl border border-slate-800/60 bg-slate-900/40 backdrop-blur-sm overflow-hidden"
              >
                <div className="flex items-start gap-4 px-5 py-4">
                  <div
                    className="w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 shadow-md"
                    style={{ color: cfg.accent, background: "rgba(0,0,0,0.45)", border: `1px solid ${cfg.accent}40` }}
                  >
                    {cfg.logo}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-white tracking-tight">{cfg.name}</h3>
                      {connected.length > 0 && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[9px] font-mono uppercase tracking-widest text-[#4ECDC4] bg-[#4ECDC4]/10 border border-[#4ECDC4]/30">
                          <CheckCircle2 className="w-2.5 h-2.5" /> connected
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-gray-400 leading-relaxed">{cfg.tagline}</p>
                    {!avail?.available && (
                      <div className="mt-2 flex items-start gap-1.5 text-[10px] font-mono text-amber-400/80">
                        <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                        <span>{avail?.reason ?? "Not configured"}</span>
                      </div>
                    )}
                  </div>
                </div>

                {connected.length > 0 && (
                  <div className="px-5 pb-3 space-y-2">
                    {connected.map((a) => (
                      <div
                        key={a.accountId}
                        className="flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-slate-950/40 border border-slate-800/60"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <div
                            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                            style={{ background: cfg.accent }}
                          />
                          <span className="text-[11px] font-mono text-gray-200 truncate">{a.accountLabel}</span>
                          {a.expiresAt > 0 && a.expiresAt < Math.floor(Date.now() / 1000) && (
                            <span className="text-[9px] font-mono text-amber-400 uppercase tracking-widest">refresh due</span>
                          )}
                        </div>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => setPendingDisconnect({ id: cfg.id, accountId: a.accountId, label: a.accountLabel })}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-widest text-gray-400 hover:text-red-400 hover:bg-red-500/10 border border-slate-800/60 hover:border-red-500/30 rounded transition-colors disabled:opacity-50"
                        >
                          <Unplug className="w-3 h-3" /> disconnect
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="px-5 py-3 border-t border-slate-800/60 bg-slate-950/30 flex items-center justify-between gap-2">
                  <span className="text-[9px] font-mono text-gray-600 uppercase tracking-widest">
                    {connected.length > 0 ? `${connected.length} account${connected.length === 1 ? "" : "s"}` : "not connected"}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openCreds(cfg.id)}
                      className="inline-flex items-center gap-1 px-2 py-1.5 text-[10px] font-mono uppercase tracking-widest rounded text-gray-400 hover:text-white hover:bg-slate-800/60 border border-slate-800/60 hover:border-slate-700 transition-colors"
                      title="Configure OAuth credentials"
                    >
                      <Settings className="w-3 h-3" /> setup
                    </button>
                    <button
                      type="button"
                      disabled={!avail?.available || isBusy}
                      onClick={() => connect(cfg.id)}
                      className={[
                        "inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono uppercase tracking-widest rounded transition-all disabled:opacity-40 disabled:cursor-not-allowed",
                        connected.length > 0
                          ? "text-[#4ECDC4] bg-[#4ECDC4]/10 border border-[#4ECDC4]/30 hover:bg-[#4ECDC4]/20"
                          : "text-[#00d9ff] bg-[#00d9ff]/10 border border-[#00d9ff]/40 hover:bg-[#00d9ff]/20",
                      ].join(" ")}
                    >
                      {isBusy ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Link2 className="w-3 h-3" />
                      )}
                      {connected.length > 0 ? "add account" : "connect"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* OAuth credentials modal — user pastes the client id / secret
            from each provider's developer console. Persisted in vault. */}
        <Dialog open={credsInfo !== null} onOpenChange={(o) => !o && !credsBusy && setCredsInfo(null)}>
          <DialogContent className="bg-slate-950 border border-slate-800 text-gray-200 font-mono w-[92vw] max-w-[480px] p-0 overflow-hidden shadow-2xl shadow-[#00d9ff]/5">
            {credsInfo && (
              <>
                {/* Header strip — `pr-10` reserves space for the Radix
                    Dialog's built-in absolute-positioned close X so the
                    SAVED badge doesn't overlap it. */}
                <div className="px-5 py-4 pr-10 border-b border-slate-800 bg-gradient-to-r from-slate-900/80 to-slate-950">
                  <DialogHeader>
                    <DialogTitle className="text-sm font-semibold text-white tracking-tight uppercase flex items-center gap-2 pr-2">
                      <span className="w-1 h-4 bg-[#00d9ff] rounded-sm" />
                      <span>Configure {credsInfo.provider}</span>
                      {credsInfo.configured && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] tracking-widest text-[#4ECDC4] bg-[#4ECDC4]/10 border border-[#4ECDC4]/30">
                          <CheckCircle2 className="w-2.5 h-2.5" /> SAVED
                        </span>
                      )}
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                      Configure OAuth credentials for {credsInfo.provider}.
                    </DialogDescription>
                  </DialogHeader>
                </div>

                {/* Body — scrollable so it never blows past the viewport */}
                <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
                  {/* Shared-with notice for multi-integration providers */}
                  {credsInfo.sharedWith.length > 1 && (
                    <div className="flex items-start gap-2 px-3 py-2 bg-[#00d9ff]/5 border-l-2 border-[#00d9ff] rounded-r">
                      <AlertCircle className="w-3.5 h-3.5 text-[#00d9ff] flex-shrink-0 mt-0.5" />
                      <p className="text-[11px] text-gray-300 leading-relaxed">
                        Saves credentials for <span className="text-[#00d9ff]">{credsInfo.sharedWith.join(", ")}</span> — they share one OAuth app.
                      </p>
                    </div>
                  )}

                  {/* Console link — full width, prominent */}
                  <a
                    href={credsInfo.consoleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between px-3 py-2 rounded text-[11px] text-[#00d9ff] bg-[#00d9ff]/5 border border-[#00d9ff]/20 hover:bg-[#00d9ff]/10 hover:border-[#00d9ff]/40 transition-colors"
                  >
                    <span>Open {credsInfo.provider} developer console</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>

                  {/* Redirect URI — copy-only field */}
                  <div>
                    <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-1.5">
                      Step 1 — Authorized redirect URI
                    </label>
                    <div className="flex items-stretch rounded overflow-hidden border border-slate-800 bg-slate-900">
                      <code className="flex-1 px-3 py-2 text-[11px] text-gray-300 truncate">
                        {credsInfo.redirectUri}
                      </code>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(credsInfo.redirectUri, "Redirect URI")}
                        className="px-3 border-l border-slate-800 text-gray-400 hover:text-[#00d9ff] hover:bg-slate-800/60 transition-colors"
                        title="Copy"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <p className="mt-1 text-[10px] text-gray-500">Paste this verbatim into the provider's console.</p>
                  </div>

                  {/* Redirect URI mode — Auto vs Pinned. Pinned lets the
                      user keep browsing localhost while OAuth still uses
                      a tunnel URL registered in the provider's portal
                      (TikTok rejects http://localhost so this is required
                      for them; useful for any provider whose portal needs
                      a stable URL). */}
                  <div>
                    <div className="flex items-baseline justify-between mb-2">
                      <label className="text-[10px] uppercase tracking-widest text-gray-500">
                        Redirect URI mode
                      </label>
                      <span className="text-[9px] tracking-normal text-gray-600 normal-case">
                        Affects what daemora sends as <code>redirect_uri</code>
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-1 p-1 rounded border border-slate-800 bg-slate-900/50">
                      <button
                        type="button"
                        onClick={() => setCredsForm({ ...credsForm, redirectMode: "auto" })}
                        className={`px-3 py-1.5 rounded text-[10px] font-mono uppercase tracking-wider transition-colors ${
                          credsForm.redirectMode === "auto"
                            ? "bg-[#00d9ff]/15 text-[#00d9ff] border border-[#00d9ff]/40"
                            : "text-gray-500 hover:text-gray-300 border border-transparent"
                        }`}
                      >
                        Auto · browser URL
                      </button>
                      <button
                        type="button"
                        onClick={() => setCredsForm({ ...credsForm, redirectMode: "pinned" })}
                        className={`px-3 py-1.5 rounded text-[10px] font-mono uppercase tracking-wider transition-colors ${
                          credsForm.redirectMode === "pinned"
                            ? "bg-[#00d9ff]/15 text-[#00d9ff] border border-[#00d9ff]/40"
                            : "text-gray-500 hover:text-gray-300 border border-transparent"
                        }`}
                      >
                        Pinned · custom
                      </button>
                    </div>

                    {credsForm.redirectMode === "auto" ? (
                      (() => {
                        // Auto sends `${window.location.origin}/oauth/callback` —
                        // i.e. the URL of the tab the user is on right now,
                        // NOT what `getPublicUrl()` returns. Show the actual
                        // value so the helper doesn't lie. Warn loudly if the
                        // browser URL differs from what'll be registered in
                        // the provider's portal (Step 1 above) — that's the
                        // mismatch most users hit (browsing localhost while
                        // the portal has a tunnel URL registered).
                        const browserCallback = `${window.location.origin}/oauth/callback`;
                        const registered = credsInfo.redirectUri;
                        const mismatch = browserCallback !== registered;
                        return (
                          <div className="mt-2 space-y-1.5">
                            <p className="text-[10px] text-gray-500 leading-relaxed">
                              Auto sends your <em>browser's</em> URL —
                              right now: <code className="text-gray-300">{browserCallback}</code>.
                            </p>
                            {mismatch && (
                              <div className="flex items-start gap-2 px-2.5 py-1.5 rounded border border-amber-500/30 bg-amber-500/5">
                                <AlertCircle className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" />
                                <p className="text-[10px] text-amber-300 leading-relaxed">
                                  This <strong>doesn't match</strong> the URL in Step 1
                                  (<code className="text-amber-200">{registered}</code>) —
                                  Auto mode will send your browser's URL instead.
                                  Switch to <strong>Pinned</strong> and paste the registered
                                  URL, or reopen daemora at that URL.
                                </p>
                              </div>
                            )}
                          </div>
                        );
                      })()
                    ) : (
                      <div className="mt-2">
                        <input
                          type="url"
                          value={credsForm.redirectUriOverride}
                          onChange={(e) => setCredsForm({ ...credsForm, redirectUriOverride: e.target.value })}
                          placeholder="https://your-tunnel.example.com/oauth/callback"
                          className="w-full px-3 py-2.5 text-[12px] rounded bg-slate-900 border border-slate-800 text-white placeholder:text-gray-600 focus:outline-none focus:border-[#00d9ff] focus:ring-1 focus:ring-[#00d9ff]/40 transition-colors"
                        />
                        <p className="mt-1 text-[10px] text-gray-500 leading-relaxed">
                          Sent verbatim — must match what's registered in the provider's portal.
                          Useful when the URL bar disagrees with the registered URL (e.g. TikTok
                          rejects <code>http://localhost</code> and needs an HTTPS tunnel).
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Client ID */}
                  <div>
                    <label className="flex items-baseline justify-between text-[10px] uppercase tracking-widest text-gray-500 mb-1.5">
                      <span>Step 2 — {credsInfo.clientIdLabel}</span>
                      {credsInfo.hasClientId && (
                        <span className="text-[#4ECDC4] normal-case tracking-normal text-[10px]">saved · leave blank to keep</span>
                      )}
                    </label>
                    <input
                      type="text"
                      value={credsForm.clientId}
                      onChange={(e) => setCredsForm({ ...credsForm, clientId: e.target.value })}
                      placeholder={credsInfo.hasClientId ? "•••••••• overwrite to change" : "Paste from console"}
                      className="w-full px-3 py-2.5 text-[12px] rounded bg-slate-900 border border-slate-800 text-white placeholder:text-gray-600 focus:outline-none focus:border-[#00d9ff] focus:ring-1 focus:ring-[#00d9ff]/40 transition-colors"
                    />
                  </div>

                  {/* Client Secret — rendered whenever `showsClientSecret`
                      OR the legacy `requiresClientSecret`. For Twitter the
                      field is shown but blank is allowed (Public app). */}
                  {(credsInfo.requiresClientSecret || credsInfo.showsClientSecret) && credsInfo.clientSecretLabel && (
                    <div>
                      <label className="flex items-baseline justify-between text-[10px] uppercase tracking-widest text-gray-500 mb-1.5">
                        <span>Step 3 — {credsInfo.clientSecretLabel}</span>
                        {credsInfo.hasClientSecret && (
                          <span className="text-[#4ECDC4] normal-case tracking-normal text-[10px]">saved · leave blank to keep</span>
                        )}
                      </label>
                      <input
                        type="password"
                        value={credsForm.clientSecret}
                        onChange={(e) => setCredsForm({ ...credsForm, clientSecret: e.target.value })}
                        placeholder={credsInfo.hasClientSecret ? "•••••••• overwrite to change" : "Paste from console"}
                        className="w-full px-3 py-2.5 text-[12px] rounded bg-slate-900 border border-slate-800 text-white placeholder:text-gray-600 focus:outline-none focus:border-[#00d9ff] focus:ring-1 focus:ring-[#00d9ff]/40 transition-colors"
                      />
                    </div>
                  )}

                  {/* Default scopes — collapsible list */}
                  {credsInfo.defaultScopes.length > 0 && (
                    <details className="group">
                      <summary className="cursor-pointer text-[10px] uppercase tracking-widest text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1.5">
                        <ChevronRight className="w-3 h-3 group-open:rotate-90 transition-transform" />
                        Default scopes ({credsInfo.defaultScopes.length}) — included automatically
                      </summary>
                      <div className="mt-2 space-y-1 max-h-32 overflow-y-auto pr-1">
                        {credsInfo.defaultScopes.map((s) => (
                          <div key={s} className="text-[10px] px-2 py-1 rounded bg-slate-900 border border-slate-800/60 text-gray-400 font-mono break-all">
                            {s}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  {/* Extra scopes — comma-separated */}
                  <div>
                    <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-1.5">
                      Extra scopes <span className="normal-case tracking-normal text-gray-600">· comma-separated · optional</span>
                    </label>
                    <input
                      type="text"
                      value={credsForm.extraScopesText}
                      onChange={(e) => setCredsForm({ ...credsForm, extraScopesText: e.target.value })}
                      placeholder="https://www.googleapis.com/auth/drive.readonly, ..."
                      className="w-full px-3 py-2.5 text-[11px] rounded bg-slate-900 border border-slate-800 text-white placeholder:text-gray-600 focus:outline-none focus:border-[#00d9ff] focus:ring-1 focus:ring-[#00d9ff]/40 transition-colors font-mono"
                    />
                    <p className="mt-1 text-[10px] text-gray-500">Applied on next connect. Existing accounts keep their scopes until reconnected.</p>
                  </div>
                </div>

                {/* Sticky footer */}
                <div className="px-5 py-3 border-t border-slate-800 bg-slate-950 flex items-center justify-between gap-2">
                  {credsInfo.configured ? (
                    <button
                      type="button"
                      onClick={requestClearCreds}
                      disabled={credsBusy}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-widest text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-500/30 hover:border-red-500/50 rounded transition-colors disabled:opacity-50"
                    >
                      <Trash2 className="w-3 h-3" /> clear
                    </button>
                  ) : <span />}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setCredsInfo(null)}
                      disabled={credsBusy}
                      className="px-3 py-1.5 text-[11px] font-mono uppercase tracking-widest rounded bg-slate-900 border border-slate-800 text-gray-300 hover:bg-slate-800 hover:text-white disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={saveCreds}
                      disabled={
                        credsBusy ||
                        (!credsInfo?.hasClientId && !credsForm.clientId.trim()) ||
                        (credsInfo?.requiresClientSecret && !credsInfo?.hasClientSecret && !credsForm.clientSecret.trim())
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono uppercase tracking-widest rounded text-[#00d9ff] bg-[#00d9ff]/10 border border-[#00d9ff]/40 hover:bg-[#00d9ff]/20 hover:shadow-[0_0_12px_rgba(0,217,255,0.25)] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                    >
                      {credsBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                      save
                    </button>
                  </div>
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>

        {/* Clear-credentials confirmation popup — replaces the native
            window.confirm() so the UX matches the rest of the app. */}
        <AlertDialog open={clearConfirmOpen} onOpenChange={setClearConfirmOpen}>
          <AlertDialogContent className="bg-slate-950 border-slate-800/80 text-gray-200 font-mono">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-white tracking-tight flex items-center gap-2">
                <Trash2 className="w-4 h-4 text-red-400" />
                Remove credentials for {credsInfo?.provider}
              </AlertDialogTitle>
              <AlertDialogDescription className="text-gray-400 text-sm leading-relaxed">
                Stored Client ID, Client Secret (if any), and Extra Scopes will be deleted from
                the vault. Already-connected accounts keep working until their access tokens
                expire — at that point you'll need to reconfigure to refresh.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                className="bg-slate-900 border-slate-800 text-gray-300 hover:bg-slate-800 hover:text-white"
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={performClearCreds}
                disabled={credsBusy}
                className="bg-red-600 hover:bg-red-500 text-white border border-red-500/40"
              >
                {credsBusy ? "Removing…" : "Remove"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Disconnect confirmation — matches the Clear-history dialog
            elsewhere so the look/feel stays consistent. */}
        <AlertDialog open={pendingDisconnect !== null} onOpenChange={(o) => !o && setPendingDisconnect(null)}>
          <AlertDialogContent className="bg-slate-950 border-slate-800/80 text-gray-200 font-mono">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-white tracking-tight flex items-center gap-2">
                <Unplug className="w-4 h-4 text-red-400" />
                Disconnect {pendingDisconnect?.id}
              </AlertDialogTitle>
              <AlertDialogDescription className="text-gray-400 text-sm leading-relaxed">
                {pendingDisconnect && (
                  <>
                    This will disconnect <span className="text-[#00d9ff]">{pendingDisconnect.label}</span>.
                    The <code>{pendingDisconnect.id}-crew</code> will disappear from the agent's crew list
                    until you reconnect. Your stored posts and history stay intact.
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="bg-slate-900 border-slate-800 text-gray-300 hover:bg-slate-800 hover:text-white">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDisconnect}
                className="bg-red-600 hover:bg-red-500 text-white border border-red-500/40"
              >
                Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <div className="mt-8 p-4 rounded-xl border border-slate-800/60 bg-slate-900/40">
          <h4 className="text-[11px] font-mono uppercase tracking-widest text-gray-400 mb-2">How this works</h4>
          <ul className="text-[12px] text-gray-500 leading-relaxed space-y-1 list-disc list-inside">
            <li>Click <em>connect</em> — you're redirected to the provider to grant access.</li>
            <li>On return, a crew appears (e.g. <code className="text-[#00d9ff]">twitter-crew</code>) with all that platform's tools.</li>
            <li>Tokens are refreshed automatically while a refresh grant is valid; you only re-connect on revocation or scope changes.</li>
            <li>Disconnect hides the crew instantly; reconnect to restore it.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
