/**
 * safeUrl — small helpers for handling user-supplied provider URLs
 * without two well-known footguns:
 *
 *   1. ReDoS via the trailing-slash regex `/\/+$/`. The `+` quantifier
 *      backtracks polynomially on adversarial input (a megabyte of `/`
 *      followed by one non-slash). `stripTrailingSlashes` does the same
 *      thing in O(n) with no backtracking.
 *
 *   2. SSRF via user-controlled `baseUrl` flowing into `fetch`. The
 *      classic exploit is pointing the URL at a cloud-metadata endpoint
 *      (`http://169.254.169.254/...`) so an attacker — or just an
 *      unwitting user with a typo — exfiltrates an API key the daemon
 *      attaches as `Authorization: Bearer …`. `assertSafeProviderUrl`
 *      blocks the cloud-metadata range and non-http(s) schemes; it
 *      DELIBERATELY leaves localhost and private LANs alone because
 *      legitimate setups (Ollama on localhost, on-prem LLM proxies on
 *      10.x/192.168.x) need them.
 *
 * Scope notes:
 *   - We don't attempt DNS-rebinding protection. Resolving the hostname
 *     adds latency and another failure mode, and the threat model here
 *     is "user mistypes / attacker sets a bad value", not "remote DNS
 *     attacker". The cloud-metadata block is the one that actually
 *     matters because it's where keys leak.
 *   - The function throws on bad input — callers handle the rejection
 *     in the same `try/catch` they already use for fetch errors.
 */

const CLOUD_METADATA_HOSTNAMES: ReadonlySet<string> = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.googleapis.com",
]);

/** Numeric-IP form of the AWS / GCP / Azure instance metadata endpoint. */
const CLOUD_METADATA_IPS: ReadonlySet<string> = new Set([
  "169.254.169.254",
  "fd00:ec2::254", // AWS IMDS over IPv6
]);

/**
 * Trim trailing `/` characters without backtracking. Equivalent to
 * `s.replace(/\/+$/, "")` but with O(n) worst case.
 */
export function stripTrailingSlashes(s: string): string {
  let i = s.length;
  while (i > 0 && s.charCodeAt(i - 1) === 47 /* '/' */) i--;
  return i === s.length ? s : s.slice(0, i);
}

/**
 * Validate a user-supplied provider URL before using it as the base of
 * a `fetch`. Throws on:
 *   - non-string / empty input
 *   - non-http(s) schemes (file://, gopher://, ftp://, javascript:, …)
 *   - cloud-metadata hostnames or 169.254.x link-local addresses
 *
 * Allows everything else — public hostnames, localhost, all private
 * RFC1918 ranges. That keeps Ollama, LM Studio, vLLM, llama.cpp, and
 * on-prem LLM proxies working without configuration.
 */
export function assertSafeProviderUrl(rawUrl: string): URL {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw new Error("provider URL is empty");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`provider URL is not a valid URL: ${truncate(rawUrl)}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`provider URL must use http or https, got "${parsed.protocol}"`);
  }

  const host = parsed.hostname.toLowerCase();
  if (CLOUD_METADATA_HOSTNAMES.has(host)) {
    throw new Error(`provider URL points at a cloud-metadata host: ${host}`);
  }
  // Strip IPv6 brackets before comparing.
  const ip = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (CLOUD_METADATA_IPS.has(ip)) {
    throw new Error(`provider URL points at a cloud-metadata address: ${ip}`);
  }
  // Catch the whole 169.254.0.0/16 link-local range so a slightly
  // different IP doesn't sneak through (e.g. 169.254.170.2 — ECS
  // task-role metadata).
  if (ip.startsWith("169.254.")) {
    throw new Error(`provider URL points at link-local address: ${ip}`);
  }

  return parsed;
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
