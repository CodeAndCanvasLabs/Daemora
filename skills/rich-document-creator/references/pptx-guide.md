# PPTX Guide — Rich Presentations with Images

Use pptxgenjs to create presentations from scratch. Always aim for 12–20+ slides with diverse layouts.

## Setup

```bash
npm install -g pptxgenjs
```

---

## Slide Structure Template

A good presentation follows this flow:

1. **Title / Cover slide** — hero image, title, subtitle, date
2. **Agenda / Overview** — what's covered today
3. **Context / Background** — why this matters
4. **Main Content Sections** (3–5 topics × 2–3 slides each)
   - Section divider slide (bold color, section title)
   - Content slide with data/visuals
   - Insight or takeaway slide
5. **Data / Statistics slide** — large stat callouts
6. **Case Study or Example**
7. **Roadmap or Timeline**
8. **Summary / Key Takeaways**
9. **Call to Action / Next Steps**
10. **Thank You / Q&A**

---

## Full Working Example (with images)

```javascript
const pptxgen = require('pptxgenjs');
const fs = require('fs');

const prs = new pptxgen();

// ── Global settings ──────────────────────────────────────
prs.layout = 'LAYOUT_WIDE'; // 16:9

// ── Color palette (customize per topic) ──────────────────
const C = {
  primary:   '1E3A5F',   // Deep navy
  secondary: '2E86AB',   // Ocean blue
  accent:    'F18F01',   // Amber
  light:     'F0F4F8',   // Off-white
  white:     'FFFFFF',
  dark:      '0D1B2A',
};

// ── Font settings ─────────────────────────────────────────
const F = {
  title:  { face: 'Calibri', bold: true },
  body:   { face: 'Calibri' },
  accent: { face: 'Georgia', italic: true },
};

// ─────────────────────────────────────────────────────────
// SLIDE 1: Cover / Hero
// ─────────────────────────────────────────────────────────
{
  const slide = prs.addSlide();
  slide.background = { color: C.dark };

  // Full-bleed hero image (if available)
  if (fs.existsSync('./data/images/hero.jpg')) {
    slide.addImage({
      path: './data/images/hero.jpg',
      x: 0, y: 0, w: '100%', h: '100%',
      transparency: 40  // dim image so text is readable
    });
  }

  // Dark overlay rectangle
  slide.addShape(prs.ShapeType.rect, {
    x: 0, y: 0, w: '100%', h: '100%',
    fill: { color: C.primary, transparency: 30 },
    line: { type: 'none' }
  });

  // Accent bar
  slide.addShape(prs.ShapeType.rect, {
    x: 0.5, y: 2.8, w: 0.12, h: 1.4,
    fill: { color: C.accent },
    line: { type: 'none' }
  });

  // Title
  slide.addText('Your Presentation Title', {
    x: 0.8, y: 2.6, w: 8.5, h: 1.0,
    fontSize: 44, bold: true, color: C.white,
    fontFace: F.title.face, valign: 'middle',
  });

  // Subtitle
  slide.addText('Subtitle or Organization Name', {
    x: 0.8, y: 3.65, w: 7, h: 0.6,
    fontSize: 20, color: 'CADCFC',
    fontFace: F.body.face,
  });

  // Date
  slide.addText(new Date().toLocaleDateString('en-US', { year:'numeric', month:'long' }), {
    x: 0.8, y: 4.6, w: 4, h: 0.4,
    fontSize: 14, color: 'AABBCC',
    fontFace: F.body.face,
  });
}

// ─────────────────────────────────────────────────────────
// SLIDE 2: Agenda
// ─────────────────────────────────────────────────────────
{
  const slide = prs.addSlide();
  slide.background = { color: C.light };

  slide.addText('Agenda', {
    x: 0.5, y: 0.3, w: 12, h: 0.8,
    fontSize: 36, bold: true, color: C.primary,
    fontFace: F.title.face,
  });

  const items = [
    { num: '01', label: 'Introduction & Background' },
    { num: '02', label: 'Key Findings' },
    { num: '03', label: 'Data & Analysis' },
    { num: '04', label: 'Recommendations' },
    { num: '05', label: 'Next Steps' },
  ];

  items.forEach((item, i) => {
    const y = 1.3 + i * 0.75;

    // Number circle
    slide.addShape(prs.ShapeType.ellipse, {
      x: 0.5, y: y, w: 0.55, h: 0.55,
      fill: { color: C.secondary },
      line: { type: 'none' },
    });

    slide.addText(item.num, {
      x: 0.5, y: y, w: 0.55, h: 0.55,
      fontSize: 14, bold: true, color: C.white,
      fontFace: F.title.face, align: 'center', valign: 'middle',
    });

    // Label
    slide.addText(item.label, {
      x: 1.25, y: y + 0.08, w: 8, h: 0.4,
      fontSize: 18, color: C.dark,
      fontFace: F.body.face,
    });

    // Divider line
    if (i < items.length - 1) {
      slide.addShape(prs.ShapeType.line, {
        x: 0.5, y: y + 0.65, w: 10, h: 0,
        line: { color: 'DDDDDD', width: 1 },
      });
    }
  });
}

// ─────────────────────────────────────────────────────────
// SLIDE 3: Section Divider
// ─────────────────────────────────────────────────────────
{
  const slide = prs.addSlide();
  slide.background = { color: C.primary };

  slide.addText('01', {
    x: 0.5, y: 1.2, w: 12, h: 1.5,
    fontSize: 120, bold: true, color: C.secondary,
    fontFace: F.title.face, transparency: 60,
  });

  slide.addText('Introduction & Background', {
    x: 0.7, y: 2.5, w: 10, h: 1.0,
    fontSize: 40, bold: true, color: C.white,
    fontFace: F.title.face,
  });

  slide.addShape(prs.ShapeType.rect, {
    x: 0.7, y: 3.6, w: 3, h: 0.08,
    fill: { color: C.accent }, line: { type: 'none' },
  });
}

// ─────────────────────────────────────────────────────────
// SLIDE 4: Two-column content with image
// ─────────────────────────────────────────────────────────
{
  const slide = prs.addSlide();
  slide.background = { color: C.white };

  // Title
  slide.addText('Content Slide Title', {
    x: 0.4, y: 0.25, w: 12, h: 0.65,
    fontSize: 28, bold: true, color: C.primary,
    fontFace: F.title.face,
  });

  // Left column text
  const bullets = [
    'Key insight or finding number one here',
    'Another important point worth highlighting',
    'Third bullet point with supporting detail',
    'Final key takeaway from this section',
  ];

  bullets.forEach((b, i) => {
    slide.addShape(prs.ShapeType.ellipse, {
      x: 0.4, y: 1.1 + i * 0.75, w: 0.18, h: 0.18,
      fill: { color: C.accent }, line: { type: 'none' },
    });
    slide.addText(b, {
      x: 0.75, y: 1.05 + i * 0.75, w: 5.2, h: 0.6,
      fontSize: 15, color: C.dark,
      fontFace: F.body.face, valign: 'middle',
    });
  });

  // Right column image
  if (fs.existsSync('./data/images/content1.jpg')) {
    slide.addImage({
      path: './data/images/content1.jpg',
      x: 6.5, y: 1.0, w: 6.0, h: 4.0,
    });
  } else {
    // Placeholder box
    slide.addShape(prs.ShapeType.rect, {
      x: 6.5, y: 1.0, w: 6.0, h: 4.0,
      fill: { color: 'E8EEF4' }, line: { color: 'CCCCCC', width: 1 },
    });
    slide.addText('[ Image ]', {
      x: 6.5, y: 1.0, w: 6.0, h: 4.0,
      fontSize: 18, color: 'AAAAAA', align: 'center', valign: 'middle',
    });
  }
}

// ─────────────────────────────────────────────────────────
// SLIDE 5: Stats / Data Callouts
// ─────────────────────────────────────────────────────────
{
  const slide = prs.addSlide();
  slide.background = { color: C.dark };

  slide.addText('Key Statistics', {
    x: 0.5, y: 0.2, w: 12, h: 0.7,
    fontSize: 32, bold: true, color: C.white,
    fontFace: F.title.face,
  });

  const stats = [
    { num: '87%', label: 'Customer Satisfaction', icon: '★' },
    { num: '$2.4M', label: 'Annual Revenue Growth', icon: '▲' },
    { num: '3.2×', label: 'ROI Multiplier', icon: '◆' },
    { num: '50K+', label: 'Active Users', icon: '●' },
  ];

  stats.forEach((s, i) => {
    const x = 0.4 + (i % 2) * 6.4;
    const y = 1.2 + Math.floor(i / 2) * 2.2;

    slide.addShape(prs.ShapeType.rect, {
      x, y, w: 5.8, h: 1.9,
      fill: { color: C.primary }, line: { color: C.secondary, width: 1 },
    });

    slide.addText(s.num, {
      x: x + 0.2, y: y + 0.1, w: 5.4, h: 1.0,
      fontSize: 56, bold: true, color: C.accent,
      fontFace: F.title.face, align: 'center',
    });

    slide.addText(s.label, {
      x: x + 0.2, y: y + 1.2, w: 5.4, h: 0.5,
      fontSize: 14, color: 'AABBCC',
      fontFace: F.body.face, align: 'center',
    });
  });
}

// ─────────────────────────────────────────────────────────
// SLIDE 6: Full-bleed image with quote overlay
// ─────────────────────────────────────────────────────────
{
  const slide = prs.addSlide();

  if (fs.existsSync('./data/images/wide1.jpg')) {
    slide.addImage({
      path: './data/images/wide1.jpg',
      x: 0, y: 0, w: '100%', h: '100%',
      transparency: 20,
    });
  } else {
    slide.background = { color: C.secondary };
  }

  // Dark overlay on bottom third
  slide.addShape(prs.ShapeType.rect, {
    x: 0, y: 3.5, w: '100%', h: 2.6,
    fill: { color: '000000', transparency: 40 },
    line: { type: 'none' },
  });

  // Quote
  slide.addText('"A compelling quote or key insight goes here."', {
    x: 0.7, y: 3.6, w: 11, h: 1.4,
    fontSize: 26, italic: true, color: C.white,
    fontFace: F.accent.face, valign: 'middle',
  });

  slide.addText('— Source or Attribution', {
    x: 0.7, y: 5.1, w: 8, h: 0.5,
    fontSize: 14, color: 'CCDDEE',
    fontFace: F.body.face,
  });
}

// ─────────────────────────────────────────────────────────
// SLIDE 7: 2×2 Feature Grid
// ─────────────────────────────────────────────────────────
{
  const slide = prs.addSlide();
  slide.background = { color: C.light };

  slide.addText('Key Features / Pillars', {
    x: 0.4, y: 0.2, w: 12, h: 0.7,
    fontSize: 32, bold: true, color: C.primary,
    fontFace: F.title.face,
  });

  const features = [
    { title: 'Feature One', desc: 'Brief description of this feature and its benefits', color: C.primary },
    { title: 'Feature Two', desc: 'Another key capability that delivers value', color: C.secondary },
    { title: 'Feature Three', desc: 'Third pillar of the overall solution', color: '6D597A' },
    { title: 'Feature Four', desc: 'Final feature that rounds out the offer', color: 'B5838D' },
  ];

  features.forEach((f, i) => {
    const x = 0.4 + (i % 2) * 6.5;
    const y = 1.1 + Math.floor(i / 2) * 2.4;

    slide.addShape(prs.ShapeType.rect, {
      x, y, w: 6.0, h: 2.1,
      fill: { color: f.color }, line: { type: 'none' },
    });

    slide.addText(f.title, {
      x: x + 0.3, y: y + 0.2, w: 5.4, h: 0.55,
      fontSize: 20, bold: true, color: C.white,
      fontFace: F.title.face,
    });

    slide.addText(f.desc, {
      x: x + 0.3, y: y + 0.8, w: 5.4, h: 1.0,
      fontSize: 14, color: 'FFFFFF', transparency: 20,
      fontFace: F.body.face,
    });
  });
}

// ─────────────────────────────────────────────────────────
// SLIDE 8: Timeline / Roadmap
// ─────────────────────────────────────────────────────────
{
  const slide = prs.addSlide();
  slide.background = { color: C.white };

  slide.addText('Roadmap', {
    x: 0.4, y: 0.2, w: 12, h: 0.7,
    fontSize: 32, bold: true, color: C.primary,
    fontFace: F.title.face,
  });

  // Timeline line
  slide.addShape(prs.ShapeType.line, {
    x: 0.8, y: 2.5, w: 11.4, h: 0,
    line: { color: C.secondary, width: 3 },
  });

  const milestones = [
    { label: 'Q1 2025', desc: 'Phase 1\nLaunch' },
    { label: 'Q2 2025', desc: 'Phase 2\nExpansion' },
    { label: 'Q3 2025', desc: 'Phase 3\nOptimize' },
    { label: 'Q4 2025', desc: 'Phase 4\nScale' },
  ];

  milestones.forEach((m, i) => {
    const x = 0.8 + i * 2.85;

    // Dot on timeline
    slide.addShape(prs.ShapeType.ellipse, {
      x: x - 0.15, y: 2.35, w: 0.3, h: 0.3,
      fill: { color: C.accent }, line: { type: 'none' },
    });

    // Date label
    slide.addText(m.label, {
      x: x - 0.8, y: 2.8, w: 1.8, h: 0.5,
      fontSize: 13, bold: true, color: C.primary,
      fontFace: F.title.face, align: 'center',
    });

    // Description (alternating above/below)
    const yDesc = i % 2 === 0 ? 1.5 : 3.4;
    slide.addText(m.desc, {
      x: x - 0.85, y: yDesc, w: 1.9, h: 0.8,
      fontSize: 13, color: C.dark,
      fontFace: F.body.face, align: 'center',
    });
  });
}

// ─────────────────────────────────────────────────────────
// SLIDE 9: Summary / Takeaways
// ─────────────────────────────────────────────────────────
{
  const slide = prs.addSlide();
  slide.background = { color: C.light };

  slide.addText('Key Takeaways', {
    x: 0.4, y: 0.2, w: 12, h: 0.7,
    fontSize: 32, bold: true, color: C.primary,
    fontFace: F.title.face,
  });

  const takeaways = [
    'First and most important conclusion from this presentation',
    'Second major takeaway that the audience should remember',
    'Third key point reinforcing the core message',
  ];

  takeaways.forEach((t, i) => {
    const y = 1.2 + i * 1.4;
    slide.addShape(prs.ShapeType.rect, {
      x: 0.4, y, w: 12, h: 1.1,
      fill: { color: C.white }, line: { color: C.secondary, width: 2 },
    });
    slide.addText(`${i + 1}`, {
      x: 0.5, y, w: 0.9, h: 1.1,
      fontSize: 28, bold: true, color: C.secondary,
      fontFace: F.title.face, align: 'center', valign: 'middle',
    });
    slide.addText(t, {
      x: 1.6, y: y + 0.05, w: 10.5, h: 1.0,
      fontSize: 16, color: C.dark,
      fontFace: F.body.face, valign: 'middle',
    });
  });
}

// ─────────────────────────────────────────────────────────
// SLIDE 10: Thank You / CTA
// ─────────────────────────────────────────────────────────
{
  const slide = prs.addSlide();
  slide.background = { color: C.primary };

  slide.addText('Thank You', {
    x: 0.5, y: 1.5, w: 12, h: 1.8,
    fontSize: 72, bold: true, color: C.white,
    fontFace: F.title.face, align: 'center',
  });

  slide.addText('Questions? Let\'s discuss.', {
    x: 0.5, y: 3.4, w: 12, h: 0.7,
    fontSize: 24, color: C.accent,
    fontFace: F.accent.face, align: 'center', italic: true,
  });

  slide.addText('contact@example.com  |  www.example.com', {
    x: 0.5, y: 4.5, w: 12, h: 0.5,
    fontSize: 14, color: 'AABBCC',
    fontFace: F.body.face, align: 'center',
  });
}

// ─────────────────────────────────────────────────────────
// Save
// ─────────────────────────────────────────────────────────
prs.writeFile({ fileName: './data/output.pptx' })
  .then(() => console.log('✅ Presentation saved: output.pptx'))
  .catch(err => console.error('❌ Error:', err));
```

---

## Customization Checklist

Before generating, replace these placeholders in the script:
- [ ] `'Your Presentation Title'` → actual title
- [ ] Subtitle, date
- [ ] Agenda items (reflect actual sections)
- [ ] Section divider titles
- [ ] Bullet content per slide
- [ ] Stats data (numbers and labels)
- [ ] Quote text
- [ ] Features/pillars grid content
- [ ] Timeline milestones
- [ ] Takeaways
- [ ] Contact info on final slide
- [ ] Color palette (match topic/brand)
- [ ] Image paths (from Step 2 sourcing)

## Extra Slide Types

For additional slides, refer to these patterns:

### Process Flow (3–5 steps with arrows)
```javascript
const steps = ['Research', 'Design', 'Build', 'Test', 'Launch'];
steps.forEach((step, i) => {
  const x = 0.5 + i * 2.5;
  slide.addShape(prs.ShapeType.rect, { x, y: 2, w: 2.1, h: 1.4, fill: { color: C.primary } });
  slide.addText(step, { x, y: 2, w: 2.1, h: 1.4, fontSize: 16, bold: true, color: C.white, align: 'center', valign: 'middle' });
  if (i < steps.length - 1) {
    slide.addText('→', { x: x + 2.1, y: 2.4, w: 0.4, h: 0.6, fontSize: 22, color: C.accent });
  }
});
```

### Image Gallery (3 images side by side)
```javascript
['img1.jpg', 'img2.jpg', 'img3.jpg'].forEach((img, i) => {
  slide.addImage({ path: `./data/images/${img}`, x: 0.4 + i * 4.3, y: 1.2, w: 4.0, h: 3.5 });
});
```
