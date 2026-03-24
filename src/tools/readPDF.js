/**
 * readPDF - Extract text content from a PDF file.
 * Uses pdftotext (poppler) if available, falls back to OpenAI vision API.
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import filesystemGuard from "../safety/FilesystemGuard.js";
import tenantContext from "../tenants/TenantContext.js";
import { mergeLegacyOptions as _mergeLegacyOpts } from "../utils/mergeToolParams.js";

export async function readPDF(params) {
  const filePath = params?.filePath;
  if (!filePath) return "Error: filePath is required.";

  const guard = filesystemGuard.checkRead(filePath);
  if (!guard.allowed) return `Access denied: ${guard.reason}`;
  if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;

  const opts = _mergeLegacyOpts(params, ["filePath"]);
  const { pages = null, method = "auto" } = opts;

  // Method 1: pdftotext (poppler-utils) - fast, no API cost
  if (method === "auto" || method === "pdftotext") {
    try {
      const pageFlag = pages ? `-f ${pages.split("-")[0]} -l ${pages.split("-")[1] || pages.split("-")[0]}` : "";
      const text = execSync(`pdftotext ${pageFlag} "${filePath}" -`, { encoding: "utf-8", timeout: 30000 });
      if (text.trim()) return text.trim();
    } catch {
      // pdftotext not available, fall through
    }
  }

  // Method 2: OpenAI vision API - works without pdftotext installed
  if (method === "auto" || method === "vision") {
    const store = tenantContext.getStore();
    const apiKey = store?.apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) return "Error: pdftotext not found and OPENAI_API_KEY not set. Install poppler-utils or set OPENAI_API_KEY.";

    try {
      const fileBytes = readFileSync(filePath);
      const b64 = fileBytes.toString("base64");
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "Extract all text content from this PDF. Return only the text, preserve structure." },
              { type: "image_url", image_url: { url: `data:application/pdf;base64,${b64}` } },
            ],
          }],
          max_tokens: 4096,
        }),
      });
      const data = await res.json();
      if (!res.ok) return `Error: ${data.error?.message || res.status}`;
      return data.choices?.[0]?.message?.content || "No text extracted.";
    } catch (err) {
      return `Error extracting PDF: ${err.message}`;
    }
  }

  return "Error: No extraction method available. Install poppler-utils (brew install poppler) or set OPENAI_API_KEY.";
}

export const readPDFDescription =
  `readPDF(filePath: string, optionsJson?: string) - Extract text from a PDF file.
  filePath: path to the PDF file
  optionsJson: {"pages":"1-5","method":"auto"}
  method: "auto" (pdftotext first, then vision), "pdftotext", "vision"
  pages: page range like "1-5" (pdftotext only)
  Returns extracted text content.`;
