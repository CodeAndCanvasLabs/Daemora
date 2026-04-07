/**
 * generateVideo - Generate videos using OpenAI (Sora) or compatible APIs.
 * Submits generation request, polls for completion, saves to disk.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import filesystemGuard from "../safety/FilesystemGuard.js";
import { getTenantTmpDir } from "./_paths.js";

const POLL_INTERVAL = 5000;  // 5 seconds
const MAX_POLL_TIME = 300000; // 5 minutes

export async function generateVideo(params) {
  const prompt = params?.prompt;
  if (!prompt) return "Error: prompt is required.";

  const {
    duration = 5,
    size = "1080p",
    style = "natural",
    outputPath = null,
  } = params;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "Error: OPENAI_API_KEY not configured. Video generation requires an API key.";

  try {
    // Submit video generation request
    const res = await fetch("https://api.openai.com/v1/videos/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "sora", prompt, duration, size, style }),
    });

    // If the API doesn't support video yet, try image-to-video fallback info
    if (res.status === 404) {
      return "Error: Video generation API not available for your account. OpenAI Sora API access required.";
    }

    const data = await res.json();
    if (!res.ok) return `Error: ${data.error?.message || res.status}`;

    // If response includes video directly (base64 or URL)
    if (data.data?.[0]?.url || data.data?.[0]?.b64_json) {
      return await _saveVideo(data.data[0], prompt, outputPath);
    }

    // Async generation — poll for completion
    const taskId = data.id || data.task_id;
    if (!taskId) return `Error: Unexpected response format: ${JSON.stringify(data).slice(0, 200)}`;

    console.log(`[generateVideo] Async task ${taskId} — polling...`);
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_POLL_TIME) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));

      const pollRes = await fetch(`https://api.openai.com/v1/videos/generations/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const pollData = await pollRes.json();

      if (pollData.status === "completed" || pollData.status === "succeeded") {
        const videoData = pollData.data?.[0] || pollData.result || pollData;
        return await _saveVideo(videoData, prompt, outputPath);
      }

      if (pollData.status === "failed") {
        return `Error: Video generation failed — ${pollData.error?.message || "unknown error"}`;
      }

      // Still processing — continue polling
      console.log(`[generateVideo] Status: ${pollData.status || "processing"}...`);
    }

    return `Error: Video generation timed out after ${MAX_POLL_TIME / 1000}s. Task ID: ${taskId}`;
  } catch (err) {
    return `Error generating video: ${err.message}`;
  }
}

async function _saveVideo(videoData, prompt, outputPath) {
  const dir = getTenantTmpDir("daemora-videos");
  const filePath = outputPath || join(dir, `video-${Date.now()}.mp4`);

  if (outputPath) {
    const wc = filesystemGuard.checkWrite(outputPath);
    if (!wc.allowed) return `Error: ${wc.reason}`;
  }

  if (videoData.b64_json) {
    writeFileSync(filePath, Buffer.from(videoData.b64_json, "base64"));
  } else if (videoData.url) {
    const res = await fetch(videoData.url);
    if (!res.ok) return `Error: Failed to download video: ${res.status}`;
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(filePath, buf);
  } else {
    return "Error: No video data in response.";
  }

  console.log(`[generateVideo] Saved: ${filePath}`);
  return `Video generated and saved to: ${filePath}\nPrompt: "${prompt.slice(0, 100)}"`;
}
