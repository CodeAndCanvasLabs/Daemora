/**
 * AuthProvider — the credential-checking half of auth.
 *
 * Pluggable so "local self-hosted (passphrase)" and "cloud multi-user
 * (email + password)" share the downstream TokenService + middleware.
 *
 * verifyCredentials returns a resolved user record (id, plan, scopes)
 * on success, or null on failure. Providers MUST use a constant-time
 * comparison and MUST NOT reveal whether the identifier is valid
 * separately from whether the credential matches.
 */

export interface AuthenticatedUser {
  readonly id: string;
  /**
   * Capability scopes carried in the access token. Different clients
   * (UI, daemon, integrations) can request different subsets; the
   * middleware enforces per-route. Default local user has "all".
   */
  readonly scopes: readonly string[];
  /** Display name — used in audit entries and UI. */
  readonly label: string;
}

export interface AuthCredentials {
  readonly passphrase: string;
}

export interface AuthProvider {
  verifyCredentials(creds: AuthCredentials): Promise<AuthenticatedUser | null>;
  /**
   * Is the provider currently ready to verify? Returns false if the
   * backing store (vault, users table) is unreachable so callers can
   * render a degraded state instead of an endless login loop.
   */
  isReady(): boolean;
}
