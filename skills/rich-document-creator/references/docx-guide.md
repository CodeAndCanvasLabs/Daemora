# DOCX Guide — Rich Word Documents with Images

Use the `docx` npm package to create professional Word documents.

## Setup

```bash
npm install -g docx
```

---

## Document Structure Template

```
Cover Page
├── Title, author, date, logo image
Table of Contents  
├── Auto-generated from headings
Executive Summary
├── 2–3 paragraph overview
Section 1: [Topic]
├── Heading, body text, image, table (if needed)
Section 2: [Topic]
├── ...
(Repeat 3–6 sections)
Conclusion / Recommendations
Appendix (optional)
```

---

## Full Working Example

```javascript
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        ImageRun, Header, Footer, AlignmentType, HeadingLevel, BorderStyle,
        WidthType, ShadingType, VerticalAlign, PageNumber, PageBreak,
        LevelFormat, TableOfContents } = require('docx');
const fs = require('fs');

// ── Helper: read image safely ─────────────────────────────
function loadImage(path, fallbackW = 400, fallbackH = 300) {
  try {
    return fs.readFileSync(path);
  } catch {
    return null;
  }
}

// ── Color constants ───────────────────────────────────────
const PRIMARY = '1E3A5F';
const ACCENT  = '2E86AB';
const LIGHT   = 'E8F4F8';

// ── Shared styles ─────────────────────────────────────────
const styles = {
  default: {
    document: { run: { font: 'Calibri', size: 24, color: '1A1A2E' } }
  },
  paragraphStyles: [
    {
      id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal',
      quickFormat: true,
      run: { size: 40, bold: true, font: 'Calibri', color: PRIMARY },
      paragraph: { spacing: { before: 360, after: 180 }, outlineLevel: 0 }
    },
    {
      id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal',
      quickFormat: true,
      run: { size: 28, bold: true, font: 'Calibri', color: ACCENT },
      paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 }
    },
    {
      id: 'Caption', name: 'Caption', basedOn: 'Normal',
      run: { size: 18, italic: true, font: 'Calibri', color: '777777' },
      paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 60, after: 120 } }
    },
  ]
};

// ── Helpers ───────────────────────────────────────────────
function heading1(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)] });
}
function heading2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(text)] });
}
function body(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 24 })],
    spacing: { after: 160 }
  });
}
function caption(text) {
  return new Paragraph({ style: 'Caption', children: [new TextRun(text)] });
}
function spacer() {
  return new Paragraph({ children: [new TextRun('')], spacing: { after: 120 } });
}
function pageBreak() {
  return new Paragraph({ children: [new PageBreak()] });
}

function imageBlock(imgPath, widthInches = 5.5, heightInches = 3.2, capText = '') {
  const data = loadImage(imgPath);
  if (!data) return spacer();

  const W_EMU = Math.round(widthInches * 914400);
  const H_EMU = Math.round(heightInches * 914400);

  const ext = imgPath.split('.').pop().toLowerCase();
  const typeMap = { jpg: 'jpg', jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'png' };
  const imgType = typeMap[ext] || 'jpg';

  const paragraphs = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 180, after: 60 },
      children: [new ImageRun({ data, transformation: { width: W_EMU / 9144, height: H_EMU / 9144 }, type: imgType })]
    })
  ];
  if (capText) paragraphs.push(caption(capText));
  return paragraphs;
}

function highlightBox(text, bgColor = LIGHT) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [9360],
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: 9360, type: WidthType.DXA },
        shading: { fill: bgColor, type: ShadingType.CLEAR },
        margins: { top: 180, bottom: 180, left: 240, right: 240 },
        borders: {
          top: { style: BorderStyle.SINGLE, size: 8, color: ACCENT },
          bottom: { style: BorderStyle.NONE },
          left: { style: BorderStyle.SINGLE, size: 16, color: PRIMARY },
          right: { style: BorderStyle.NONE },
        },
        children: [new Paragraph({ children: [new TextRun({ text, italic: true, size: 24 })] })]
      })]
    })]
  });
}

// ── Build document ────────────────────────────────────────
const heroImg = loadImage('./data/images/hero.jpg');

const doc = new Document({
  styles,
  numbering: {
    config: [
      {
        reference: 'bullets',
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: '•',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } }, run: { font: 'Calibri' } }
        }]
      }
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
      }
    },
    headers: {
      default: new Header({
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: ACCENT } },
            children: [new TextRun({ text: 'Document Title | Confidential', size: 18, color: '888888' })]
          })
        ]
      })
    },
    footers: {
      default: new Footer({
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            border: { top: { style: BorderStyle.SINGLE, size: 4, color: ACCENT } },
            children: [
              new TextRun({ text: 'Page ', size: 18, color: '888888' }),
              new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '888888' }),
              new TextRun({ text: ' of ', size: 18, color: '888888' }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: '888888' }),
            ]
          })
        ]
      })
    },
    children: [
      // ── COVER PAGE ───────────────────────────────────────
      ...(heroImg ? [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 0 },
          children: [new ImageRun({ data: heroImg, transformation: { width: 620, height: 200 }, type: 'jpg' })]
        })
      ] : []),
      spacer(),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 480, after: 240 },
        children: [new TextRun({ text: 'Document Title Here', bold: true, size: 64, font: 'Calibri', color: PRIMARY })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: 'Subtitle or Organization', size: 32, color: ACCENT, italic: true })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 480 },
        children: [new TextRun({ text: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), size: 22, color: '888888' })]
      }),
      pageBreak(),

      // ── TABLE OF CONTENTS ─────────────────────────────────
      heading1('Table of Contents'),
      new TableOfContents('Table of Contents', {
        hyperlink: true,
        headingStyleRange: '1-2',
      }),
      pageBreak(),

      // ── EXECUTIVE SUMMARY ─────────────────────────────────
      heading1('Executive Summary'),
      body('This section provides a high-level overview of the document\'s key findings and recommendations. Write 2–3 paragraphs summarizing the most important content.'),
      body('Second paragraph of the executive summary with additional context and key points.'),
      spacer(),
      highlightBox('Key Insight: This is the most important takeaway from this document, highlighted for emphasis.'),
      spacer(),
      pageBreak(),

      // ── SECTION 1 ─────────────────────────────────────────
      heading1('Section 1: Background & Context'),
      body('Opening paragraph that provides context for this section. Explain the situation and why this topic matters.'),
      body('Second paragraph with additional details and supporting information.'),
      spacer(),
      ...imageBlock('./data/images/content1.jpg', 5.5, 3.2, 'Figure 1: Caption describing the image above'),
      spacer(),
      heading2('1.1 Key Points'),
      new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: [new TextRun('First bullet point with important information')] }),
      new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: [new TextRun('Second bullet point elaborating on the topic')] }),
      new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: [new TextRun('Third bullet point with additional context')] }),
      spacer(),
      pageBreak(),

      // ── SECTION 2 ─────────────────────────────────────────
      heading1('Section 2: Analysis & Findings'),
      body('Detailed analysis of the topic. Present findings clearly and support with data or examples.'),
      spacer(),
      // Data table
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [2340, 2340, 2340, 2340],
        rows: [
          new TableRow({
            tableHeader: true,
            children: ['Category', 'Q1', 'Q2', 'Change'].map(h =>
              new TableCell({
                width: { size: 2340, type: WidthType.DXA },
                shading: { fill: PRIMARY, type: ShadingType.CLEAR },
                margins: { top: 80, bottom: 80, left: 120, right: 120 },
                children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: 22 })] })]
              })
            )
          }),
          ...[ ['Revenue', '$1.2M', '$1.5M', '+25%'], ['Users', '8,400', '11,200', '+33%'], ['NPS', '42', '58', '+16pts'] ].map(row =>
            new TableRow({
              children: row.map((cell, ci) =>
                new TableCell({
                  width: { size: 2340, type: WidthType.DXA },
                  shading: { fill: ci === 0 ? LIGHT : 'FFFFFF', type: ShadingType.CLEAR },
                  margins: { top: 80, bottom: 80, left: 120, right: 120 },
                  borders: { top: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' }, bottom: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
                  children: [new Paragraph({ alignment: ci === 0 ? AlignmentType.LEFT : AlignmentType.CENTER, children: [new TextRun({ text: cell, bold: ci === 0, size: 22 })] })]
                })
              )
            })
          )
        ]
      }),
      spacer(),
      pageBreak(),

      // ── CONCLUSION ────────────────────────────────────────
      heading1('Conclusion & Recommendations'),
      body('Summary of the key findings and what they mean for the reader.'),
      body('Specific, actionable recommendations based on the analysis.'),
      spacer(),
      ...imageBlock('./data/images/content2.jpg', 5.0, 3.0, 'Figure 2: Supporting visual'),
      spacer(),

      heading2('Next Steps'),
      new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: [new TextRun('Action item 1: Assign owner and deadline')] }),
      new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: [new TextRun('Action item 2: Follow-up meeting to review progress')] }),
      new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: [new TextRun('Action item 3: Prepare summary for stakeholders')] }),
    ]
  }]
});

Packer.toBuffer(doc)
  .then(buf => { fs.writeFileSync('./data/output.docx', buf); console.log('✅ output.docx saved'); })
  .catch(err => console.error('❌ Error:', err));
```

---

## Key Rules

- **Page size**: Always set explicitly — default is A4, US Letter = `{ width: 12240, height: 15840 }`
- **Images**: Always check `fs.existsSync` before embedding; use fallback if missing
- **Bullets**: Never use unicode `•` — always use `LevelFormat.BULLET` with numbering config
- **Tables**: Always set both `columnWidths` on table AND `width` on each cell
- **Shading**: Always use `ShadingType.CLEAR`, never `SOLID`
- **PageBreak**: Always inside a `Paragraph`, never standalone
