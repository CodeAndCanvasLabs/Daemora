---
id: example-pdf
name: PDF Handling
description: Extract text and tables from PDF files. Use when user asks about a .pdf file or attaches one.
triggers:
  - pdf
  - document
  - extract
requires_tools:
  - read_file
---

# PDF Handling

Use `read_file` first to confirm the path exists. For text extraction, prefer `pdftotext` via `execute_command` if available; otherwise fall back to a fetch of the file's text content.

For tables, use `pdftohtml -xml -nodrm` and parse the resulting XML.
