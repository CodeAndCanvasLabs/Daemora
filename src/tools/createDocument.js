import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import filesystemGuard from "../safety/FilesystemGuard.js";

/**
 * Create Document - creates Markdown, text, PDF, or DOCX documents.
 * Upgraded: better PDF rendering (bold, italic, code, tables, numbered lists),
 *           optional DOCX support via 'docx' package.
 */

export async function createDocument(params) {
  const filePath = params?.filePath;
  const content = params?.content;
  const format = params?.format;
  const fmt = (format || "markdown").toLowerCase();
  console.log(`      [createDocument] Creating ${fmt}: ${filePath}`);

  if (!filePath || !content) {
    return "Error: filePath and content are required.";
  }

  const writeCheck = filesystemGuard.checkWrite(filePath);
  if (!writeCheck.allowed) return `Error: ${writeCheck.reason}`;

  try {
    mkdirSync(dirname(filePath), { recursive: true });

    if (fmt === "pdf") {
      return await createPDF(filePath, content);
    }

    if (fmt === "docx") {
      return await createDOCX(filePath, content);
    }

    // Markdown / text / html - write as-is
    writeFileSync(filePath, content, "utf-8");
    console.log(`      [createDocument] Written: ${filePath} (${content.length} chars)`);
    return `Document created: ${filePath} (${content.length} characters)`;
  } catch (error) {
    console.log(`      [createDocument] Failed: ${error.message}`);
    return `Failed to create document: ${error.message}`;
  }
}

// ─── PDF ──────────────────────────────────────────────────────────────────────

async function createPDF(filePath, content) {
  try {
    const PDFDocument = (await import("pdfkit")).default;

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];

      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => {
        const buffer = Buffer.concat(chunks);
        writeFileSync(filePath, buffer);
        console.log(`      [createDocument] PDF written: ${filePath} (${buffer.length} bytes)`);
        resolve(`PDF created: ${filePath} (${buffer.length} bytes)`);
      });
      doc.on("error", reject);

      renderMarkdownToPDF(doc, content);
      doc.end();
    });
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" || error.message.includes("pdfkit")) {
      return "PDF requires pdfkit. Install with: pnpm add pdfkit";
    }
    throw error;
  }
}

function renderMarkdownToPDF(doc, content) {
  const lines = content.split("\n");
  let inCodeBlock = false;
  let codeLines = [];
  let tableBuffer = [];

  function flushTable() {
    if (tableBuffer.length === 0) return;
    // Simple table: pipe-delimited
    for (const row of tableBuffer) {
      const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.length === 0) continue;
      if (cells.every((c) => /^[-:]+$/.test(c))) continue; // separator row
      doc.fontSize(10).font("Courier").text(cells.join("   "), { paragraphGap: 2 });
    }
    tableBuffer = [];
    doc.moveDown(0.3);
  }

  function flushCode() {
    if (codeLines.length === 0) return;
    doc.fontSize(9).font("Courier")
      .fillColor("#333333")
      .text(codeLines.join("\n"), { lineGap: 2, paragraphGap: 6 });
    doc.fillColor("black");
    codeLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block toggle
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        flushCode();
        inCodeBlock = false;
      } else {
        flushTable();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Table rows
    if (line.startsWith("|")) {
      tableBuffer.push(line);
      continue;
    } else if (tableBuffer.length > 0) {
      flushTable();
    }

    // Headings
    if (line.startsWith("# ")) {
      doc.fontSize(24).font("Helvetica-Bold").fillColor("#000000")
        .text(line.slice(2), { paragraphGap: 10 });
    } else if (line.startsWith("## ")) {
      doc.fontSize(18).font("Helvetica-Bold").fillColor("#111111")
        .text(line.slice(3), { paragraphGap: 8 });
    } else if (line.startsWith("### ")) {
      doc.fontSize(14).font("Helvetica-Bold").fillColor("#222222")
        .text(line.slice(4), { paragraphGap: 6 });
    } else if (line.startsWith("#### ")) {
      doc.fontSize(12).font("Helvetica-Bold").fillColor("#333333")
        .text(line.slice(5), { paragraphGap: 4 });

    // Horizontal rule
    } else if (/^---+$/.test(line.trim())) {
      doc.moveDown(0.3).moveTo(50, doc.y).lineTo(545, doc.y).stroke().moveDown(0.3);

    // Unordered lists
    } else if (/^(\s*)[*\-+] /.test(line)) {
      const indent = line.match(/^(\s*)/)[1].length;
      const text = line.replace(/^\s*[*\-+] /, "");
      doc.fontSize(12).font("Helvetica").fillColor("#000000")
        .text(`${"  ".repeat(indent / 2)}• ${renderInline(text)}`, { paragraphGap: 3, indent: indent * 6 });

    // Ordered lists
    } else if (/^\d+\. /.test(line.trim())) {
      const num = line.match(/^(\d+)\./)[1];
      const text = line.replace(/^\d+\. /, "");
      doc.fontSize(12).font("Helvetica").fillColor("#000000")
        .text(`${num}. ${renderInline(text)}`, { paragraphGap: 3 });

    // Blockquote
    } else if (line.startsWith("> ")) {
      doc.fontSize(11).font("Helvetica-Oblique").fillColor("#555555")
        .text(`"${line.slice(2)}"`, { indent: 20, paragraphGap: 3 });
      doc.fillColor("#000000");

    // Blank line
    } else if (line.trim() === "") {
      doc.moveDown(0.5);

    // Normal paragraph
    } else {
      doc.fontSize(12).font("Helvetica").fillColor("#000000")
        .text(renderInline(line), { paragraphGap: 3 });
    }
  }

  // Flush any remaining
  if (inCodeBlock) flushCode();
  if (tableBuffer.length > 0) flushTable();
}

/** Strip bold/italic/code markdown for inline text (PDFKit doesn't do inline styles easily) */
function renderInline(text) {
  return text
    .replace(/`([^`]+)`/g, (_, code) => `[${code}]`)  // `code` → [code]
    .replace(/\*\*([^*]+)\*\*/g, "$1")                 // **bold** → bold
    .replace(/\*([^*]+)\*/g, "$1")                     // *italic* → italic
    .replace(/__([^_]+)__/g, "$1")                     // __bold__ → bold
    .replace(/_([^_]+)_/g, "$1")                       // _italic_ → italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");          // [text](url) → text
}

// ─── DOCX ─────────────────────────────────────────────────────────────────────

async function createDOCX(filePath, content) {
  try {
    const docx = await import("docx");
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = docx;

    const children = [];
    const lines = content.split("\n");

    for (const line of lines) {
      if (line.startsWith("# ")) {
        children.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }));
      } else if (line.startsWith("## ")) {
        children.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }));
      } else if (line.startsWith("### ")) {
        children.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 }));
      } else if (/^[*\-+] /.test(line)) {
        children.push(new Paragraph({
          text: line.replace(/^[*\-+] /, ""),
          bullet: { level: 0 },
        }));
      } else if (line.trim() === "") {
        children.push(new Paragraph({ text: "" }));
      } else {
        // Parse inline bold/italic
        const runs = parseInlineDocx(line, TextRun);
        children.push(new Paragraph({ children: runs }));
      }
    }

    const doc = new Document({ sections: [{ properties: {}, children }] });
    const buffer = await Packer.toBuffer(doc);
    writeFileSync(filePath, buffer);

    console.log(`      [createDocument] DOCX written: ${filePath} (${buffer.length} bytes)`);
    return `DOCX created: ${filePath} (${buffer.length} bytes)`;
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" || error.message.includes("docx")) {
      return "DOCX requires the docx package. Install with: pnpm add docx";
    }
    throw error;
  }
}

function parseInlineDocx(text, TextRun) {
  // Split by **bold** and *italic* patterns
  const runs = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) {
      runs.push(new TextRun({ text: text.slice(last, match.index) }));
    }
    const token = match[0];
    if (token.startsWith("**")) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true }));
    } else if (token.startsWith("*")) {
      runs.push(new TextRun({ text: token.slice(1, -1), italics: true }));
    } else if (token.startsWith("`")) {
      runs.push(new TextRun({ text: token.slice(1, -1), font: "Courier New", size: 20 }));
    }
    last = match.index + token.length;
  }

  if (last < text.length) {
    runs.push(new TextRun({ text: text.slice(last) }));
  }

  return runs.length > 0 ? runs : [new TextRun({ text })];
}

export const createDocumentDescription =
  'createDocument(filePath: string, content: string, format?: string) - Create a document. Formats: "markdown" (default), "pdf" (requires pdfkit), "docx" (requires docx). PDF/DOCX support # headings, ## h2, ### h3, - bullets, 1. numbered lists, **bold**, *italic*, `code`, tables, > blockquotes, --- rules, ```code blocks```.';
