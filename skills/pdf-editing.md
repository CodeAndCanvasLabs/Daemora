---
name: pdf-editing
description: Edit existing PDFs — extract text, modify content, recreate. Workaround using extract + rebuild approach.
triggers: edit pdf, modify pdf, update pdf, change pdf, pdf text, pdf replace, fill pdf, annotate pdf, pdf form
---

## Strategy: Extract → Modify → Recreate
- No direct PDF editing tool available
- Workflow: read existing PDF → extract content → modify → generate new PDF

## Step 1: Extract Content
- Read PDF: `readPDF(filePath)` — returns text content per page
- For structured data: parse tables, headings, lists from extracted text
- For forms: identify field labels and current values

## Step 2: Modify Content
- Edit extracted text as needed (replace, append, restructure)
- Preserve original formatting intent (headings, lists, tables)

## Step 3: Recreate PDF

### Option A: HTML → PDF (best for styled docs)
```bash
# writeFile to create HTML with modified content
writeFile("/tmp/edited.html", htmlContent)
# Convert with wkhtmltopdf
executeCommand("wkhtmltopdf --page-size A4 --margin-top 20mm --margin-bottom 20mm /tmp/edited.html /tmp/edited.pdf")
```

### Option B: createDocument Tool
- `createDocument({ type: "pdf", content: modifiedContent, outputPath: "/tmp/edited.pdf" })`
- Best for simple text documents

### Option C: Python (pypdf / reportlab)
```bash
# Merge/split with pypdf
executeCommand("pip install pypdf && python3 -c \"from pypdf import PdfReader, PdfWriter; ...\"")
# Full control with reportlab
executeCommand("pip install reportlab && python3 /tmp/build_pdf.py")
```

## Common Operations

### Replace Text
1. `readPDF(file)` → get content
2. String replace on extracted text
3. Recreate with HTML → PDF

### Merge PDFs
```bash
executeCommand("pip install pypdf")
# writeFile a merge script, then execute
```

### Add Watermark
```bash
# Create watermark PDF, then overlay with pypdf
executeCommand("python3 /tmp/watermark.py input.pdf 'CONFIDENTIAL' /tmp/output.pdf")
```

### Reorder Pages
```bash
# Use pypdf PdfReader + PdfWriter to pick pages in order
executeCommand("python3 /tmp/reorder.py input.pdf '3,1,2,4' /tmp/reordered.pdf")
```

## After Editing
1. Report: "Edited PDF saved to `/tmp/edited.pdf`"
2. Preview (macOS): `executeCommand("open /tmp/edited.pdf")`
3. Deliver: `sendFile("/tmp/edited.pdf", channelId, sessionId)`

## Rules
- Always `readPDF` first to understand existing content and structure
- Warn user that exact visual formatting may differ from original
- For pixel-perfect edits, recommend dedicated PDF editors
- Use `/tmp/` for intermediate files
- Clean up temp files after delivery
