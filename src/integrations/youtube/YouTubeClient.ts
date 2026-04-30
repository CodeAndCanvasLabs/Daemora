/**
 * YouTubeClient — thin wrapper over YouTube Data API v3 calls the
 * `youtube` crew uses. Access tokens come from IntegrationManager and
 * auto-refresh.
 */

import { stat, readFile } from "node:fs/promises";

import { ProviderError } from "../../util/errors.js";
import { authFetch } from "../authFetch.js";
import type { IntegrationManager } from "../IntegrationManager.js";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";

export class YouTubeClient {
  constructor(private readonly integrations: IntegrationManager) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = path.startsWith("http") ? path : `${API}${path}`;
    const resp = await authFetch(this.integrations, "youtube", (token) =>
      fetch(url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
      }),
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      if (resp.status === 401) {
        throw new ProviderError(
          `YouTube auth failed after refresh (${resp.status}). Reconnect in Settings → Integrations. ${body.slice(0, 200)}`,
          "google",
        );
      }
      throw new ProviderError(`YouTube ${resp.status} ${path}: ${body.slice(0, 300)}`, "google");
    }
    if (resp.status === 204) return {} as T;
    return (await resp.json()) as T;
  }

  /**
   * Resumable video upload (YouTube's required protocol for files
   * larger than a few MB). Two-step flow:
   *   1. POST <UPLOAD_API>/videos?uploadType=resumable&part=...
   *      with the snippet+status JSON body. YouTube responds with a
   *      `Location:` header — the actual upload URL.
   *   2. PUT the raw video bytes to that Location URL. YouTube
   *      responds with the final video resource on success.
   *
   * For files we expect to be ≤ 256 MB (Shorts cap is 60s ~ 50-100 MB),
   * we read into memory and PUT in one shot. Large-file streaming is a
   * separate concern — keep this simple until someone hits the limit.
   */
  async uploadVideo(input: {
    videoPath: string;
    snippet: {
      title: string;
      description?: string;
      tags?: readonly string[];
      categoryId?: string;
      defaultLanguage?: string;
    };
    status: {
      privacyStatus: "private" | "unlisted" | "public";
      madeForKids: boolean;
      selfDeclaredMadeForKids?: boolean;
      embeddable?: boolean;
      license?: "youtube" | "creativeCommon";
    };
  }): Promise<{ id: string; raw: unknown }> {
    const fileStat = await stat(input.videoPath);
    if (!fileStat.isFile()) {
      throw new ProviderError(`Not a file: ${input.videoPath}`, "google");
    }
    const fileSize = fileStat.size;
    if (fileSize === 0) throw new ProviderError(`Empty file: ${input.videoPath}`, "google");
    if (fileSize > 256 * 1024 * 1024) {
      throw new ProviderError(
        `Video > 256MB (${(fileSize / 1024 / 1024).toFixed(1)}MB). Streamed-upload path not implemented yet.`,
        "google",
      );
    }

    // Step 1 — start the resumable session.
    const initBody = JSON.stringify({
      snippet: {
        title: input.snippet.title,
        ...(input.snippet.description ? { description: input.snippet.description } : {}),
        ...(input.snippet.tags && input.snippet.tags.length > 0 ? { tags: input.snippet.tags } : {}),
        ...(input.snippet.categoryId ? { categoryId: input.snippet.categoryId } : {}),
        ...(input.snippet.defaultLanguage ? { defaultLanguage: input.snippet.defaultLanguage } : {}),
      },
      status: input.status,
    });

    const initUrl = `${UPLOAD_API}/videos?uploadType=resumable&part=snippet,status`;
    const initResp = await authFetch(this.integrations, "youtube", (token) =>
      fetch(initUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": "video/*",
          "X-Upload-Content-Length": String(fileSize),
        },
        body: initBody,
      }),
    );
    if (!initResp.ok) {
      const body = await initResp.text().catch(() => "");
      throw new ProviderError(
        `YouTube upload init ${initResp.status}: ${body.slice(0, 300)}`,
        "google",
      );
    }
    const uploadUrl = initResp.headers.get("location");
    if (!uploadUrl) {
      throw new ProviderError(
        "YouTube upload init: no Location header in response (resumable session not created).",
        "google",
      );
    }

    // Step 2 — PUT the bytes. The upload URL is single-use and pre-
    // authenticated via the embedded `upload_id`, so we don't need to
    // attach the bearer token here. (Per YouTube's resumable-upload
    // docs.) Sending it doesn't break things but isn't required.
    const bytes = await readFile(input.videoPath);
    const putResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/*",
        "Content-Length": String(fileSize),
      },
      body: bytes,
    });
    if (!putResp.ok) {
      const body = await putResp.text().catch(() => "");
      throw new ProviderError(
        `YouTube upload PUT ${putResp.status}: ${body.slice(0, 300)}`,
        "google",
      );
    }
    const finalJson = (await putResp.json()) as { id?: string };
    if (!finalJson.id) {
      throw new ProviderError("YouTube upload succeeded but response had no video id.", "google");
    }
    return { id: finalJson.id, raw: finalJson };
  }
}
