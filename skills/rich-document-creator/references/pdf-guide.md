# PDF Guide — Rich, Designed PDFs with Images

Two approaches depending on complexity:

| Use Case | Tool | When |
|---|---|---|
| Simple reports, brochures | `reportlab` (Python) | Precise layout control, charts |
| HTML-to-PDF with CSS | `WeasyPrint` (Python) | Modern HTML design, easier styling |

---

## Approach A: ReportLab (Precise Layout)

```bash
pip install reportlab Pillow --break-system-packages
```

```python
from reportlab.lib.pagesizes import letter, A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle,
    PageBreak, HRFlowable, KeepTogether
)
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
import os

OUTPUT = './data/output.pdf'

# ── Colors ────────────────────────────────────────────────
PRIMARY = colors.HexColor('#1E3A5F')
ACCENT  = colors.HexColor('#2E86AB')
LIGHT   = colors.HexColor('#E8F4F8')
AMBER   = colors.HexColor('#F18F01')
WHITE   = colors.white
DARK    = colors.HexColor('#1A1A2E')

# ── Styles ────────────────────────────────────────────────
styles = getSampleStyleSheet()

def make_style(name, parent='Normal', **kwargs):
    s = ParagraphStyle(name=name, parent=styles[parent], **kwargs)
    styles.add(s)
    return s

title_style = make_style('DocTitle', fontSize=36, textColor=WHITE,
    fontName='Helvetica-Bold', alignment=TA_CENTER, spaceAfter=12)

h1_style = make_style('H1', fontSize=22, textColor=PRIMARY,
    fontName='Helvetica-Bold', spaceBefore=24, spaceAfter=10,
    borderPadding=(0, 0, 4, 0))

h2_style = make_style('H2', fontSize=16, textColor=ACCENT,
    fontName='Helvetica-Bold', spaceBefore=16, spaceAfter=8)

body_style = make_style('Body', fontSize=11, textColor=DARK,
    fontName='Helvetica', leading=16, spaceAfter=8)

caption_style = make_style('Caption', fontSize=9, textColor=colors.grey,
    fontName='Helvetica-Oblique', alignment=TA_CENTER, spaceAfter=12)

# ── Helpers ───────────────────────────────────────────────
def img_block(path, width=5*inch, caption_text=''):
    """Insert image with optional caption. Skips if file missing."""
    if not os.path.exists(path):
        return []
    try:
        img = Image(path, width=width, height=width * 0.6)
        img.hAlign = 'CENTER'
        items = [Spacer(1, 0.15*inch), img]
        if caption_text:
            items.append(Paragraph(caption_text, caption_style))
        items.append(Spacer(1, 0.15*inch))
        return items
    except Exception as e:
        print(f"Image error: {e}")
        return []

def highlight_box(text, bg=LIGHT, border=ACCENT):
    """Callout box with colored background."""
    data = [[Paragraph(text, body_style)]]
    t = Table(data, colWidths=[6.5*inch])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), bg),
        ('LEFTPADDING', (0,0), (-1,-1), 12),
        ('RIGHTPADDING', (0,0), (-1,-1), 12),
        ('TOPPADDING', (0,0), (-1,-1), 10),
        ('BOTTOMPADDING', (0,0), (-1,-1), 10),
        ('LINECOLOR', (0,0), (0,-1), border),
        ('LINEWIDTH', (0,0), (0,-1), 3),
        ('LEFTLINE', (0,0), (0,-1), 3),
    ]))
    return t

def data_table(headers, rows):
    """Styled data table."""
    data = [headers] + rows
    col_w = [6.5*inch / len(headers)] * len(headers)
    t = Table(data, colWidths=col_w)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), PRIMARY),
        ('TEXTCOLOR', (0,0), (-1,0), WHITE),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE', (0,0), (-1,0), 11),
        ('ALIGN', (0,0), (-1,-1), 'CENTER'),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('FONTNAME', (0,1), (-1,-1), 'Helvetica'),
        ('FONTSIZE', (0,1), (-1,-1), 10),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [WHITE, LIGHT]),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#CCCCCC')),
        ('TOPPADDING', (0,0), (-1,-1), 8),
        ('BOTTOMPADDING', (0,0), (-1,-1), 8),
    ]))
    return t

# ── Page layout with header/footer ────────────────────────
DOC_TITLE = 'Your Report Title'

def on_page(canvas, doc):
    canvas.saveState()
    w, h = letter
    # Header
    canvas.setFillColor(PRIMARY)
    canvas.rect(0, h - 0.6*inch, w, 0.6*inch, fill=1, stroke=0)
    canvas.setFillColor(WHITE)
    canvas.setFont('Helvetica-Bold', 10)
    canvas.drawString(0.5*inch, h - 0.35*inch, DOC_TITLE)
    canvas.setFont('Helvetica', 9)
    canvas.drawRightString(w - 0.5*inch, h - 0.35*inch, f'Confidential')
    # Footer
    canvas.setFillColor(colors.HexColor('#888888'))
    canvas.setFont('Helvetica', 9)
    canvas.drawCentredString(w/2, 0.35*inch, f'Page {doc.page}')
    canvas.restoreState()

# ── Build story ───────────────────────────────────────────
doc = SimpleDocTemplate(
    OUTPUT,
    pagesize=letter,
    rightMargin=0.75*inch, leftMargin=0.75*inch,
    topMargin=0.9*inch, bottomMargin=0.75*inch,
)

story = []

# Cover page
story.extend(img_block('./data/images/hero.jpg', width=6.5*inch))
story.append(Paragraph(DOC_TITLE, title_style))
story.append(Paragraph('Subtitle or Author Name', make_style('Sub', fontSize=16, textColor=ACCENT, alignment=TA_CENTER, fontName='Helvetica-Oblique')))
story.append(Spacer(1, 0.3*inch))
story.append(HRFlowable(width='80%', color=AMBER, thickness=2))
story.append(PageBreak())

# Executive Summary
story.append(Paragraph('Executive Summary', h1_style))
story.append(HRFlowable(width='100%', color=ACCENT, thickness=1))
story.append(Spacer(1, 0.1*inch))
story.append(Paragraph('This is the executive summary section. Provide a 2–3 paragraph overview of the document\'s key findings and recommendations.', body_style))
story.append(Spacer(1, 0.15*inch))
story.append(highlight_box('💡 Key Insight: The most important takeaway from this document, formatted as a highlighted callout.'))
story.append(PageBreak())

# Section 1
story.append(Paragraph('1. Background & Context', h1_style))
story.append(HRFlowable(width='100%', color=ACCENT, thickness=1))
story.append(Spacer(1, 0.1*inch))
story.append(Paragraph('Opening paragraph describing the background. Explain why this topic is important and provide necessary context.', body_style))
story.extend(img_block('./data/images/content1.jpg', width=5*inch, caption_text='Figure 1: Caption describing this image'))
story.append(Paragraph('1.1 Key Findings', h2_style))
story.append(Paragraph('Detailed findings from the research or analysis. Support with data and specific examples.', body_style))
story.append(PageBreak())

# Data table
story.append(Paragraph('2. Data Analysis', h1_style))
story.append(HRFlowable(width='100%', color=ACCENT, thickness=1))
story.append(Spacer(1, 0.1*inch))
story.append(data_table(
    ['Metric', 'Baseline', 'Current', 'Change'],
    [['Revenue', '$1.2M', '$1.5M', '+25%'],
     ['Users', '8,400', '11,200', '+33%'],
     ['Satisfaction', '72%', '88%', '+16pts']]
))
story.append(Spacer(1, 0.2*inch))
story.extend(img_block('./data/images/content2.jpg', width=5*inch, caption_text='Figure 2: Data visualization'))
story.append(PageBreak())

# Conclusion
story.append(Paragraph('3. Conclusion & Recommendations', h1_style))
story.append(HRFlowable(width='100%', color=ACCENT, thickness=1))
story.append(Spacer(1, 0.1*inch))
story.append(Paragraph('Summary of findings and actionable recommendations for stakeholders.', body_style))
story.append(Spacer(1, 0.2*inch))
story.append(highlight_box('Next Steps: Outline the specific actions to be taken, who is responsible, and target dates.', bg=colors.HexColor('#FFF8E8'), border=AMBER))

# Build
doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
print('✅ PDF saved:', OUTPUT)
```

---

## Approach B: WeasyPrint (HTML-to-PDF)

Best when you want modern CSS-based design.

```bash
pip install WeasyPrint --break-system-packages
```

```python
from weasyprint import HTML, CSS
import base64, os

def img_to_base64(path):
    if not os.path.exists(path): return ''
    ext = path.split('.')[-1].lower()
    mime = {'jpg': 'jpeg', 'jpeg': 'jpeg', 'png': 'png'}.get(ext, 'jpeg')
    with open(path, 'rb') as f:
        return f"data:image/{mime};base64,{base64.b64encode(f.read()).decode()}"

html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page {{ size: letter; margin: 1in; }}
  body {{ font-family: 'Helvetica', sans-serif; color: #1a1a2e; }}
  .cover {{ text-align: center; padding-top: 2in; }}
  .cover img {{ width: 90%; max-height: 3in; object-fit: cover; border-radius: 8px; }}
  h1 {{ color: #1E3A5F; font-size: 28pt; border-bottom: 2px solid #2E86AB; padding-bottom: 8px; }}
  h2 {{ color: #2E86AB; font-size: 18pt; }}
  p {{ line-height: 1.7; }}
  .callout {{ background: #E8F4F8; border-left: 4px solid #2E86AB; padding: 12px 16px; margin: 16px 0; }}
  .img-block {{ text-align: center; margin: 24px 0; }}
  .img-block img {{ max-width: 80%; border-radius: 6px; box-shadow: 0 2px 12px rgba(0,0,0,0.15); }}
  caption {{ font-size: 9pt; color: #777; }}
  table {{ width: 100%; border-collapse: collapse; margin: 16px 0; }}
  th {{ background: #1E3A5F; color: white; padding: 10px; }}
  td {{ padding: 8px 10px; border-bottom: 1px solid #ddd; }}
  tr:nth-child(even) td {{ background: #E8F4F8; }}
  .page-break {{ page-break-after: always; }}
</style>
</head>
<body>
  <div class="cover">
    <img src="{img_to_base64('./data/images/hero.jpg')}" alt="Cover">
    <h1 style="font-size:36pt; border:none; margin-top:0.5in">Document Title</h1>
    <p style="color:#2E86AB; font-size:16pt; font-style:italic">Subtitle or Author</p>
  </div>
  <div class="page-break"></div>

  <h1>Executive Summary</h1>
  <p>Summary paragraph goes here. Key points and overview.</p>
  <div class="callout">Key Insight: Most important finding highlighted here.</div>
  <div class="page-break"></div>

  <h1>Section 1: Background</h1>
  <p>Content for section 1.</p>
  <div class="img-block">
    <img src="{img_to_base64('./data/images/content1.jpg')}" alt="Content">
    <br><caption>Figure 1: Description</caption>
  </div>
  <div class="page-break"></div>

  <h1>Data Analysis</h1>
  <table>
    <tr><th>Metric</th><th>Before</th><th>After</th><th>Change</th></tr>
    <tr><td>Revenue</td><td>$1.2M</td><td>$1.5M</td><td>+25%</td></tr>
    <tr><td>Users</td><td>8,400</td><td>11,200</td><td>+33%</td></tr>
  </table>
</body>
</html>"""

HTML(string=html).write_pdf('./data/output.pdf')
print('✅ PDF saved')
```

---

## Choose Your Approach

- **ReportLab**: Better for data-heavy reports, precise element positioning, charts
- **WeasyPrint**: Better for visually styled brochures, modern layouts, faster iteration
