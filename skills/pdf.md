---
name: pdf
description: Create, read, extract text from, merge, split, compress, and manipulate PDF files. Use when the user asks to create a PDF, extract text from a PDF, merge PDFs, convert to PDF, or do any PDF operation.
triggers: pdf, create pdf, read pdf, extract pdf, merge pdf, split pdf, convert to pdf, pdf report, pdf document, compress pdf, rotate pdf
metadata: {"daemora": {"emoji": "📄", "requires": {"anyBins": ["wkhtmltopdf", "pandoc", "pdftotext"]}, "install": ["brew install wkhtmltopdf"]}}
---

## Create PDF from HTML (best quality)

```bash
brew install wkhtmltopdf
wkhtmltopdf --page-size A4 --margin-top 20mm --margin-bottom 20mm \
  --encoding UTF-8 --footer-center "[page] / [topage]" \
  /tmp/report.html /tmp/report.pdf
```

## Create PDF with Python (no binary needed)

```bash
pip install reportlab
# Use SimpleDocTemplate, Paragraph, Table from reportlab.platypus
```

## Extract text from PDF

```bash
pip install pdfplumber
python3 -c "import pdfplumber; pdf=pdfplumber.open('file.pdf'); print(pdf.pages[0].extract_text())"
# Or: brew install poppler && pdftotext file.pdf -
```

## Merge PDFs

```bash
pip install pypdf
# PdfWriter + PdfReader from pypdf
# Or with ghostscript:
gs -dBATCH -dNOPAUSE -q -sDEVICE=pdfwrite -sOutputFile=merged.pdf a.pdf b.pdf
```

## Markdown → PDF

```bash
brew install pandoc
pandoc input.md -o output.pdf --pdf-engine=wkhtmltopdf -V geometry:margin=25mm
```

## Compress PDF (macOS)

```bash
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.5 -dPDFSETTINGS=/ebook \
  -dNOPAUSE -dQUIET -dBATCH -sOutputFile=/tmp/compressed.pdf input.pdf
# PDFSET options: /screen (72dpi) /ebook (150dpi) /printer (300dpi) /prepress (HQ)
```

## After creating

1. Report the path: "PDF saved to `/tmp/report.pdf`"
2. On macOS: `executeCommand("open /tmp/report.pdf")` to preview
3. To send: `sendFile("/tmp/report.pdf", channel, sessionId)`
