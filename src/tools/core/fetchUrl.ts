import { z } from "zod";

import { TimeoutError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().positive().max(60_000).default(15_000),
  maxBytes: z.number().int().positive().max(2_000_000).default(500_000),
  /** Return parsed JSON when content-type is application/json (default true). */
  parseJson: z.boolean().default(true),
});

interface FetchResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string | unknown;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export const fetchUrlTool: ToolDef<typeof inputSchema, FetchResult> = {
  name: "fetch_url",
  description: "HTTP request. Bounded timeout + body size. Auto-parses JSON unless parseJson:false.",
  category: "network",
  source: { kind: "core" },
  alwaysOn: true,
  inputSchema,
  async execute({ url, method, headers, body, timeoutMs, maxBytes, parseJson }, { abortSignal }) {
    const started = Date.now();

    // Compose user-abort with timeout-abort so the upstream cancellation works regardless of which fires.
    const timer = AbortSignal.timeout(timeoutMs);
    const composite = anySignal([abortSignal, timer]);

    const init: RequestInit = { method, signal: composite };
    if (headers) init.headers = headers;
    if (body !== undefined) init.body = body;

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if ((e as Error).name === "TimeoutError" || (e as Error).message?.includes("timed out")) {
        throw new TimeoutError(`fetch_url ${url}`, timeoutMs);
      }
      if (abortSignal.aborted) throw new ValidationError("Fetch cancelled");
      throw e;
    }

    const reader = res.body?.getReader();
    let received = 0;
    const chunks: Uint8Array[] = [];
    let truncated = false;

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.byteLength > maxBytes) {
          chunks.push(value.subarray(0, Math.max(0, maxBytes - received)));
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        received += value.byteLength;
      }
    }

    const text = new TextDecoder("utf-8").decode(concat(chunks));

    const headerObj: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headerObj[k] = v;
    });

    let parsedBody: string | unknown = text;
    if (parseJson && (res.headers.get("content-type") ?? "").includes("application/json")) {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        // fall through with text body
      }
    }

    return {
      status: res.status,
      headers: headerObj,
      body: parsedBody,
      truncated,
      durationMs: Date.now() - started,
    };
  },
};

function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  // Polyfill of AbortSignal.any for Node <= 20. Node 22 has it native.
  // We engines>=22 in package.json so the native path is the common case;
  // the manual path stays for safety.
  const native = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === "function") return native(Array.from(signals));
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
