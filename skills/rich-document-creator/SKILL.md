---
name: rich-document-creator
description: >
  Use this skill whenever the user wants to create rich, visually compelling documents, presentations,
  or PDFs — especially when they mention images, charts, design quality, or need professional output.
  Triggers include: "create a presentation", "make slides", "build a deck", "write a report with images",
  "generate a PDF brochure", "make a Word document with visuals", "create a pitch deck", "make a
  professional presentation on X topic", "generate slides about Y", "create a document with good design",
  "make a pptx", "make a docx", "make a pdf". This skill is essential for multi-format document creation
  (PPTX, DOCX, PDF) with real images sourced from the web. It is also the go-to skill for any
  presentation with more than 5 slides, any document requiring images or charts, and any request
  explicitly mentioning visual quality. Always prefer this skill over individual pptx/docx/pdf skills
  when images, design quality, or multi-format output is involved.
---

# Rich Document Creator

Creates professional, image-rich documents across PPTX, DOCX, and PDF formats.

## Quick Decision Guide

| What they want | Format | Guide |
|---|---|---|
| Slides / presentation / deck | PPTX | [pptx-guide.md](references/pptx-guide.md) |
| Report / letter / memo / Word doc | DOCX | [docx-guide.md](references/docx-guide.md) |
| PDF brochure / handout / polished doc | PDF | [pdf-guide.md](references/pdf-guide.md) |
| Multiple formats at once | All | Generate each in sequence |

> **When to skip this skill.** If the user just wants a *plain* document — markdown notes, a text-only report, a basic table-only doc — daemora's built-in `create_document` tool is faster (one call, no install). Use this skill only when the document needs **real images, custom layouts, or visual design** that markdown can't express.

---

## Step 1: Plan Content First

Before writing any code, plan the document structure:

1. **Identify the topic** — extract key subject matter, goals, and audience from the user's request
2. **Decide slide/section count** — use the table below as a baseline
3. **List key themes** — what major points need to be made?
4. **Pick a visual style** — color palette, font, image style (see design guide in each format file)

### Slide / Section Count Guide

| Document Type | Recommended Count |
|---|---|
| Short presentation (intro/overview) | 8–12 slides |
| Standard presentation | 12–18 slides |
| Comprehensive presentation | 18–25 slides |
| Short report / memo (DOCX/PDF) | 3–6 sections |
| Full report | 6–12 sections |

**Always err on the side of MORE content, not less.** A thin 5-slide deck looks unfinished.

---

## Step 2: Source Images

This is the key differentiator of this skill. Every document must include real images.

All downloads land under the project's data directory. Use `./data/images/` (create it once with `mkdir -p ./data/images`) so the artifacts survive the run and are easy to find.

### Image Sourcing Workflow

There is no dedicated image-search tool — use one of these three paths, in this order:

**Path 1 — Direct image URL (fastest, no API key).** Some hosts return a real image straight from a keyword URL. Try first:

```bash
mkdir -p ./data/images

# Unsplash (keyword-driven, returns a real photo)
curl -L --max-time 20 --user-agent "Mozilla/5.0" \
  -o ./data/images/hero.jpg \
  "https://source.unsplash.com/1600x900/?renewable,energy,solar"

# Lorem Picsum (random, good for abstract / texture backgrounds)
curl -L --max-time 20 -o ./data/images/bg1.jpg \
  "https://picsum.photos/1600/900?random=1"

# Always verify the file is a real image, not an HTML error page
file ./data/images/hero.jpg     # expect "JPEG image data" or "PNG image data"
ls -lh ./data/images/hero.jpg   # expect > 20 KB
```

**Path 2 — `web_search` then download.** Use this when you want a *specific* image (a known landmark, branded product, news photo, etc.). `web_search` is text-only — it returns page URLs and descriptions, not images directly. So:

```
web_search({
  query: "<subject> <visual style> site:unsplash.com OR site:commons.wikimedia.org",
  count: 8
})
```

Good query patterns:
- `"neural network visualization site:unsplash.com"`
- `"solar farm aerial photo site:commons.wikimedia.org"`
- `"open office team collaboration stock photo"`
- `"data dashboard screenshot site:pexels.com"`

Then `web_fetch` the most promising result page, extract the actual image URL (look for `og:image`, the largest `<img>` `src`, or a `download` link), and `curl` it the same way as Path 1.

**Path 3 — Generated placeholder (fallback).** If both paths above fail or the image is purely decorative, generate one with Pillow via `execute_command`:

```python
from PIL import Image, ImageDraw

def create_placeholder(width, height, text, color1, color2, output_path):
    img = Image.new('RGB', (width, height), color1)
    draw = ImageDraw.Draw(img)
    for y in range(height):
        ratio = y / height
        r = int(int(color1[1:3], 16) * (1-ratio) + int(color2[1:3], 16) * ratio)
        g = int(int(color1[3:5], 16) * (1-ratio) + int(color2[3:5], 16) * ratio)
        b = int(int(color1[5:7], 16) * (1-ratio) + int(color2[5:7], 16) * ratio)
        draw.line([(0, y), (width, y)], fill=(r, g, b))
    draw.text((width//2, height//2), text, fill="white", anchor="mm")
    img.save(output_path)
    return output_path

create_placeholder(1280, 720, "Section Visual", "#1a3a5c", "#0d7377", "./data/images/hero.jpg")
```

### Image Rules

- **Always try Path 1 first** — it's a single curl, no extra search/fetch steps.
- **Each major slide/section needs at least one image** — never ship a deck with no visuals.
- **Match image content to slide topic** — keywords in the URL or query should reflect the slide's actual subject.
- **Always verify** with `file ./data/images/<name>.jpg` before embedding — a 200-byte HTML error page silently breaks pptxgenjs/docx/reportlab.
- **Download before embedding** — every renderer below loads from a local path, not a URL.
- **Resize if needed** using Pillow before embedding (target ≤ 1600 px on the long edge).

---

## Step 3: Generate the Document

Read the format-specific guide:

- **PPTX**: Read [references/pptx-guide.md](references/pptx-guide.md) — uses pptxgenjs
- **DOCX**: Read [references/docx-guide.md](references/docx-guide.md) — uses docx npm package
- **PDF**: Read [references/pdf-guide.md](references/pdf-guide.md) — uses reportlab + WeasyPrint

---

## Step 4: QA and Polish

After generating, render each page to a JPEG and eyeball it. Use `soffice` (LibreOffice's CLI) directly — no helper script needed:

```bash
# PPTX → PDF → per-slide JPEGs
soffice --headless --convert-to pdf ./data/output.pptx --outdir ./data/
pdftoppm -jpeg -r 120 ./data/output.pdf ./data/slide
ls ./data/slide-*.jpg

# DOCX → PDF → per-page JPEGs
soffice --headless --convert-to pdf ./data/output.docx --outdir ./data/
pdftoppm -jpeg -r 120 ./data/output.pdf ./data/page

# PDFs are already PDFs — go straight to pdftoppm
pdftoppm -jpeg -r 120 ./data/output.pdf ./data/page
```

If `soffice` isn't on PATH, try `libreoffice` (same flags) or install via the package manager (`brew install --cask libreoffice` on macOS, `apt install libreoffice` on Debian/Ubuntu). On macOS the binary may also live at `/Applications/LibreOffice.app/Contents/MacOS/soffice`.

View the resulting images and check for:
- Text overflow or cut-off
- Images not loading (404 / broken / placeholder boxes where a photo should be)
- Visual hierarchy issues
- Consistent styling across pages

---

## Design Principles (Apply to ALL formats)

### Color Strategy
- Choose ONE dominant color (60–70% of visual space)
- ONE supporting color (20–30%)
- ONE accent color for highlights (10%)
- Dark backgrounds for title/cover pages, light for content

### Typography
- Title text: 36–44pt, bold
- Subheadings: 20–28pt
- Body text: 12–16pt
- Never mix more than 2 font families

### Layouts to Use
- **Hero layout**: Full-bleed image with text overlay (great for title slides)
- **Two-column**: Text on left, image on right (or vice versa)
- **Card grid**: 2×2 or 3×2 grid of content blocks
- **Full-bleed image**: Image fills the slide, sparse text overlay
- **Stat callout**: Large numbers (60–80pt) with small label below

### Things to NEVER Do
- Text-only slides with no visual element
- Default blue/white color scheme without thinking
- All slides with the same layout
- Bullet-point dumps without hierarchy
- Missing images (always add something visual per section)

---

## Dependencies

Install once per machine. All three formats share these:

```bash
# Node packages (PPTX + DOCX renderers)
npm install -g pptxgenjs docx

# Python packages (PDF renderers + Pillow for image ops)
pip install Pillow reportlab WeasyPrint pypdf pdfplumber --break-system-packages

# System binaries (for QA: rendering output back to images)
# macOS:
brew install --cask libreoffice
brew install poppler          # provides pdftoppm
# Debian/Ubuntu:
# apt install libreoffice poppler-utils
```

Run each install via `execute_command`. If a package is already present `npm` / `pip` / `brew` are no-ops, so it's safe to run on every fresh session.
