/**
 * PKCE helpers for OAuth 2.0 — RFC 7636.
 *
 * Twitter and Google require PKCE. Meta does not. We generate a
 * cryptographically random code_verifier, derive code_challenge via
 * SHA-256, and hand both back so the caller can stash the verifier
 * (session-side) and send the challenge to the authorize endpoint.
 */

import { randomBytes, createHash } from "node:crypto";

export interface PKCEPair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

export function generatePKCE(): PKCEPair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/** Cryptographically random state/nonce — URL-safe. */
export function generateState(): string {
  return base64url(randomBytes(24));
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
