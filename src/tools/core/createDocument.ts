import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { z } from "zod";

import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import type { ToolDef } from "../types.js";

type Format = "md" | "txt" | "html" | "pdf" | "docx" | "pptx" | "xlsx";

const FORMAT_EXT: Record<Format, string> = {
  md: ".md",
  txt: ".txt",
  html: ".html",
  pdf: ".pdf",
  docx: ".docx",
  pptx: ".pptx",
  xlsx: ".xlsx",
};

const inputSchema = z.object({
  filePath: z.string().min(1).describe("Output file path. Extension is appended if missing."),
  content: z.string().min(1).describe("Document content as markdown. Headings, lists, code blocks, and tables are honoured for pdf/docx."),
  format: z.enum(["md", "txt", "html", "pdf", "docx", "pptx", "xlsx"]).default("md"),
  title: z.string().max(200).optional().describe("Optional title used as the document title (pdf/docx) or first slide / sheet name (pptx/xlsx)."),
});

export function makeCreateDocumentTool(guard: FilesystemGuard): ToolDef<typeof inputSchema, { path: string; bytes: number; format: Format }> {
  return {
    name: "create_document",
    description: "Create a formatted document from markdown content. Supports md, txt, html, pdf, docx, pptx, xlsx. Auto-creates parent directories.",
    category: "filesystem",
    source: { kind: "core" },
    alwaysOn: true,
    inputSchema,
    async execute({ filePath, content, format, title }) {
      const ext = FORMAT_EXT[format];
      const path = extname(filePath).toLowerCase() === ext ? filePath : `${filePath}${ext}`;
      const canonical = guard.ensureAllowed(path, "write");
      await mkdir(dirname(canonical), { recursive: true });

      let bytes = 0;
      switch (format) {
        case "md":
          bytes = await writeText(canonical, content);
          break;
        case "txt":
          bytes = await writeText(canonical, stripMarkdown(content));
          break;
        case "html":
          bytes = await writeText(canonical, renderHtml(content, title));
          break;
        case "pdf":
          bytes = await renderPdf(canonical, content, title);
          break;
        case "docx":
          bytes = await renderDocx(canonical, content, title);
          break;
        case "pptx":
          bytes = await renderPptx(canonical, content, title);
          break;
        case "xlsx":
          bytes = await renderXlsx(canonical, content, title);
          break;
      }
      return { path: canonical, bytes, format };
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

async function writeText(path: string, content: string): Promise<number> {
  await writeFile(path, content, "utf-8");
  return Buffer.byteLength(content);
}

function renderHtml(markdown: string, title?: string): string {
  const trimmed = markdown.trim();
  if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) return markdown;
  // Lazy require so the html branch keeps working even if marked is unavailable
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { marked } = require("marked") as typeof import("marked");
  const body = marked.parse(markdown, { async: false }) as string;
  const head = title ? `<title>${escapeHtml(title)}</title>` : "";
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8">${head}</head><body>\n${body}\n</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^>\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "• ")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```\w*\n?|```$/g, ""));
}

// PDF
async function renderPdf(path: string, markdown: string, title?: string): Promise<number> {
  const PDFDocument = (await import("pdfkit")).default;
  const { marked } = await import("marked");
  // breaks: true → every single newline becomes a <br>. LLM-written
  // markdown commonly puts each field on its own line without a blank
  // line in between, expecting visual line breaks. CommonMark's default
  // is to collapse them into one paragraph, which produces wall-of-text
  // output. Honour the author's intent instead.
  const tokens = marked.lexer(markdown, { breaks: true });

  const doc = new PDFDocument({ margin: 54, info: title ? { Title: title } : {} });
  const stream = createWriteStream(path);
  doc.pipe(stream);

  if (title) doc.fontSize(20).font("Helvetica-Bold").text(title).moveDown();

  for (const tok of tokens) {
    switch (tok.type) {
      case "heading": {
        const size = [22, 18, 16, 14, 13, 12][Math.max(0, tok.depth - 1)] ?? 12;
        doc.moveDown(0.5);
        renderInlinePdf(doc, flattenInline(inlineTokensOf(tok), { bold: true, italic: false, mono: false }), { size });
        doc.moveDown(0.3);
        break;
      }
      case "paragraph":
        renderInlinePdf(doc, flattenInline(inlineTokensOf(tok)), { size: 11 });
        doc.moveDown(0.5);
        break;
      case "list":
        for (const item of tok.items) {
          const segs = flattenInline(listItemInlineTokens(item));
          if (segs.length === 0) segs.push({ text: String(item.text ?? ""), bold: false, italic: false, mono: false });
          segs[0] = { ...segs[0], text: `• ${segs[0]!.text}` } as Segment;
          renderInlinePdf(doc, segs, { size: 11, indent: 12 });
        }
        doc.moveDown(0.5);
        break;
      case "code":
        doc.fontSize(10).font("Courier").fillColor("#333").text(tok.text, { indent: 12 }).fillColor("#000").moveDown(0.5);
        break;
      case "blockquote": {
        doc.fillColor("#555");
        renderInlinePdf(doc, flattenInline(inlineTokensOf(tok), { bold: false, italic: true, mono: false }), { size: 11, indent: 18 });
        doc.fillColor("#000").moveDown(0.5);
        break;
      }
      case "hr":
        doc.moveDown(0.3).moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke().moveDown(0.5);
        break;
      case "table": {
        const cols = tok.header.length;
        const cellW = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / cols;
        doc.fontSize(10).font("Helvetica-Bold");
        tok.header.forEach((h: { text: string }, i: number) => doc.text(h.text, doc.page.margins.left + i * cellW, doc.y, { width: cellW, continued: i < cols - 1 }));
        doc.moveDown(0.3).font("Helvetica");
        for (const row of tok.rows) {
          row.forEach((cell: { text: string }, i: number) => doc.text(cell.text, doc.page.margins.left + i * cellW, doc.y, { width: cellW, continued: i < cols - 1 }));
          doc.moveDown(0.2);
        }
        doc.moveDown(0.5);
        break;
      }
      case "space":
        doc.moveDown(0.3);
        break;
      default:
        if ("text" in tok && typeof tok.text === "string") doc.fontSize(11).font("Helvetica").text(tok.text).moveDown(0.3);
    }
  }

  doc.end();
  await new Promise<void>((resolve, reject) => {
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
  return stream.bytesWritten;
}

// DOCX
async function renderDocx(path: string, markdown: string, title?: string): Promise<number> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");
  const { marked } = await import("marked");
  // breaks: true — same reason as renderPdf. Honour line-per-field
  // markdown without requiring the author to insert blank lines.
  const tokens = marked.lexer(markdown, { breaks: true });

  const children: import("docx").Paragraph[] = [];
  if (title) children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));

  for (const tok of tokens) {
    switch (tok.type) {
      case "heading": {
        const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][Math.max(0, tok.depth - 1)] ?? HeadingLevel.HEADING_1;
        children.push(new Paragraph({ heading: level, children: inlineRunsDocx(TextRun, flattenInline(inlineTokensOf(tok))) }));
        break;
      }
      case "paragraph":
        children.push(new Paragraph({ children: inlineRunsDocx(TextRun, flattenInline(inlineTokensOf(tok))) }));
        break;
      case "list":
        for (const item of tok.items) {
          const segs = flattenInline(listItemInlineTokens(item));
          const runs = segs.length > 0
            ? inlineRunsDocx(TextRun, segs)
            : [new TextRun(String(item.text ?? ""))];
          children.push(new Paragraph({ children: runs, bullet: { level: 0 } }));
        }
        break;
      case "code":
        for (const line of tok.text.split("\n")) {
          children.push(new Paragraph({ children: [new TextRun({ text: line, font: "Courier New", size: 20 })] }));
        }
        break;
      case "blockquote": {
        const segs = flattenInline(inlineTokensOf(tok), { bold: false, italic: true, mono: false });
        children.push(new Paragraph({ children: inlineRunsDocx(TextRun, segs) }));
        break;
      }
      case "hr":
        children.push(new Paragraph({ text: "" }));
        break;
      case "space":
        children.push(new Paragraph({ text: "" }));
        break;
      default:
        if ("text" in tok && typeof tok.text === "string") children.push(new Paragraph({ children: [new TextRun(tok.text)] }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  await writeFile(path, buf);
  return buf.byteLength;
}

// PPTX — one slide per top-level heading; bullets become bullet points
async function renderPptx(path: string, markdown: string, title?: string): Promise<number> {
  const mod = await import("pptxgenjs");
  // pptxgenjs is published as a CJS class — under ESM dynamic import the
  // class can land at `.default`, `.default.default`, or be the module
  // itself depending on bundler interop. Probe in priority order.
  const candidate = (mod as { default?: unknown }).default ?? mod;
  const Pptx = (typeof candidate === "function"
    ? candidate
    : (candidate as { default?: unknown }).default) as unknown as new () => {
      layout: string;
      addSlide(): { addText(text: unknown, opts: unknown): void };
      writeFile(opts: { fileName: string }): Promise<unknown>;
    };
  const pres = new Pptx();
  pres.layout = "LAYOUT_WIDE";

  const sections = splitByH1(markdown);
  if (title || sections.length === 0) {
    const slide = pres.addSlide();
    slide.addText(title ?? "Untitled", { x: 0.5, y: 1.5, w: 12, h: 1.5, fontSize: 36, bold: true });
  }

  for (const sec of sections) {
    const slide = pres.addSlide();
    slide.addText(sec.heading, { x: 0.5, y: 0.4, w: 12, h: 0.8, fontSize: 28, bold: true });
    const bullets = extractBullets(sec.body);
    if (bullets.length) {
      slide.addText(bullets.map((b) => ({ text: b, options: { bullet: true } })), { x: 0.5, y: 1.4, w: 12, h: 5.5, fontSize: 18 });
    } else {
      slide.addText(stripMarkdown(sec.body).slice(0, 1500), { x: 0.5, y: 1.4, w: 12, h: 5.5, fontSize: 16 });
    }
  }

  await pres.writeFile({ fileName: path });
  const { stat } = await import("node:fs/promises");
  return (await stat(path)).size;
}

function splitByH1(md: string): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = [];
  const lines = md.split("\n");
  let cur: { heading: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = /^#\s+(.+)$/.exec(line);
    if (m) {
      if (cur) out.push({ heading: cur.heading, body: cur.body.join("\n") });
      cur = { heading: m[1] ?? "", body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) out.push({ heading: cur.heading, body: cur.body.join("\n") });
  return out;
}

function extractBullets(md: string): string[] {
  return md.split("\n").filter((l) => /^\s*[-*+]\s+/.test(l)).map((l) => l.replace(/^\s*[-*+]\s+/, "").trim());
}

// XLSX — first markdown table becomes the sheet; otherwise dump rows of bullets / paragraphs
async function renderXlsx(path: string, markdown: string, title?: string): Promise<number> {
  const ExcelJS = (await import("exceljs")).default;
  const { marked } = await import("marked");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet((title || "Sheet1").slice(0, 31));

  const tokens = marked.lexer(markdown);
  const table = tokens.find((t) => t.type === "table");
  if (table && table.type === "table") {
    ws.addRow(table.header.map((h: { text: string }) => h.text));
    ws.getRow(1).font = { bold: true };
    for (const row of table.rows) {
      ws.addRow(row.map((c: { text: string }) => c.text));
    }
    ws.columns.forEach((col) => {
      let max = 10;
      col.eachCell?.({ includeEmpty: false }, (cell) => {
        const v = String(cell.value ?? "");
        if (v.length > max) max = v.length;
      });
      col.width = Math.min(60, max + 2);
    });
  } else {
    if (title) ws.addRow([title]).font = { bold: true, size: 14 };
    for (const tok of tokens) {
      if (tok.type === "heading") ws.addRow([tok.text]).font = { bold: true };
      else if (tok.type === "paragraph") ws.addRow([tok.text]);
      else if (tok.type === "list") for (const item of tok.items) ws.addRow([`• ${item.text}`]);
    }
    ws.getColumn(1).width = 100;
  }

  await wb.xlsx.writeFile(path);
  const { stat } = await import("node:fs/promises");
  return (await stat(path)).size;
}

// ── Inline markdown rendering ───────────────────────────────────────
// Block tokens from marked carry their inline content as a *raw string*
// in `tok.text`. The parsed inline AST is in `tok.tokens`. The old code
// fed `tok.text` straight into pdfkit / docx, which is why every
// `**bold**` rendered as literal asterisks. These helpers walk the
// inline AST instead so bold / italic / code spans / links produce real
// styled runs in both renderers.

interface Segment {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly mono: boolean;
  /** Hard line break — emitted from `<br>` (marked produces these when `breaks: true` is on). */
  readonly lineBreak?: boolean;
}

interface InlineToken {
  type: string;
  text?: string;
  raw?: string;
  href?: string;
  tokens?: InlineToken[];
}

function inlineTokensOf(tok: { text?: string; tokens?: unknown }): InlineToken[] {
  if (Array.isArray(tok.tokens) && tok.tokens.length > 0) return tok.tokens as InlineToken[];
  return [{ type: "text", text: String(tok.text ?? "") }];
}

/** List items wrap their inline content in a `text` block child; unwrap to the inline tokens. */
function listItemInlineTokens(item: { text?: string; tokens?: unknown }): InlineToken[] {
  const first = Array.isArray(item.tokens) ? (item.tokens[0] as InlineToken | undefined) : undefined;
  if (first && Array.isArray(first.tokens) && first.tokens.length > 0) return first.tokens;
  if (first && typeof first.text === "string") return [{ type: "text", text: first.text }];
  return [{ type: "text", text: String(item.text ?? "") }];
}

const ZERO_BASE: Segment = { text: "", bold: false, italic: false, mono: false };

function flattenInline(
  tokens: readonly InlineToken[],
  base: Omit<Segment, "text"> = ZERO_BASE,
  out: Segment[] = [],
): Segment[] {
  for (const t of tokens) {
    switch (t.type) {
      case "strong":
        flattenInline(t.tokens ?? [], { ...base, bold: true }, out);
        break;
      case "em":
        flattenInline(t.tokens ?? [], { ...base, italic: true }, out);
        break;
      case "codespan":
        out.push({ ...base, mono: true, text: t.text ?? "" });
        break;
      case "del":
      case "link":
        flattenInline(t.tokens ?? [], base, out);
        break;
      case "br":
        out.push({ ...base, text: "", lineBreak: true });
        break;
      case "image":
        out.push({ ...base, text: t.text ?? "" });
        break;
      case "text":
        if (Array.isArray(t.tokens) && t.tokens.length > 0) {
          flattenInline(t.tokens, base, out);
        } else {
          out.push({ ...base, text: t.text ?? "" });
        }
        break;
      case "escape":
        out.push({ ...base, text: t.text ?? "" });
        break;
      case "html":
        out.push({ ...base, text: (t.text ?? "").replace(/<[^>]+>/g, "") });
        break;
      default:
        if (typeof t.text === "string") out.push({ ...base, text: t.text });
    }
  }
  return out;
}

function pdfFontFor(seg: Segment): string {
  if (seg.mono) return "Courier";
  if (seg.bold && seg.italic) return "Helvetica-BoldOblique";
  if (seg.bold) return "Helvetica-Bold";
  if (seg.italic) return "Helvetica-Oblique";
  return "Helvetica";
}

// pdfkit's chainable API is fluent ("returns this") but its types are
// `unknown` under our setup — use `any` here to let the chain compile
// without leaking the looseness elsewhere.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderInlinePdf(doc: any, segments: readonly Segment[], opts: { size: number; indent?: number }): void {
  if (segments.length === 0) {
    doc.fontSize(opts.size).font("Helvetica").text("");
    return;
  }
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    const isLast = i === segments.length - 1;
    doc.fontSize(opts.size).font(pdfFontFor(s));
    const textOpts: { continued: boolean; indent?: number } = { continued: !isLast };
    if (i === 0 && opts.indent !== undefined) textOpts.indent = opts.indent;
    // pdfkit honours \n inside text as a hard line break in continued
    // chains — emit a single \n for explicit <br> tokens.
    doc.text(s.lineBreak ? "\n" : s.text, textOpts);
  }
}

function inlineRunsDocx<T>(
  TextRun: new (opts: { text?: string; bold?: boolean; italics?: boolean; font?: string; size?: number; break?: number }) => T,
  segments: readonly Segment[],
): T[] {
  if (segments.length === 0) return [new TextRun({ text: "" })];
  return segments.map((s) => {
    // Word ignores literal "\n" in a run — explicit <br> tokens have to
    // come through as TextRun({ break: 1 }) for Word to render a line
    // break.
    if (s.lineBreak) return new TextRun({ break: 1 });
    const opts: { text: string; bold?: boolean; italics?: boolean; font?: string; size?: number } = { text: s.text };
    if (s.bold) opts.bold = true;
    if (s.italic) opts.italics = true;
    if (s.mono) { opts.font = "Courier New"; opts.size = 20; }
    return new TextRun(opts);
  });
}
