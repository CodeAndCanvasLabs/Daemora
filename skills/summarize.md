---
name: summarize
description: Summarize long documents, articles, PDFs, web pages, emails, chat threads, meeting notes, or any large text. Use when asked to summarize, give a TL;DR, extract key points, or condense content.
triggers: summarize, summary, tldr, tl;dr, condense, key points, brief, shorten, digest, recap, highlights, executive summary, abstract, overview
metadata: {"daemora": {"emoji": "✂️"}}
---

## Summarization levels

| Level | Output | Use case |
|-------|--------|---------|
| **TL;DR** | 1-3 sentences | Quick skim |
| **Key Points** | 5-10 bullets | Decision making |
| **Executive Summary** | 2-3 paragraphs | Briefing |
| **Action Items** | Bullet list | After meetings |

## Getting content

- URL → `webFetch(url)`
- PDF → `pdftotext file.pdf -` or `pdfplumber`
- `.docx` → `pandoc file.docx -t plain`
- Long content → summarize in chunks, then summarize the summaries

## Code / PR summary

```bash
git diff main..feature --stat
git log main..feature --oneline
```

## Output templates

**TL;DR**
```
**TL;DR:** [1-2 sentences capturing the core message]
```

**Key Points**
```
**Key Points:**
• [Most important insight]
• [Second key point]
• [Third key point]

**Bottom line:** [One sentence conclusion]
```

**Executive Summary**
```
**Executive Summary**

**What:** [one sentence]
**Key findings:** [2-3 sentences]
**Actions / decisions:** [bullets]
**Next steps:** [bullets]
```

**Meeting recap**
```
**Meeting Recap - [Date] - [Topic]**
**Attendees:** [names]
**Discussed:** [bullets]
**Decisions:** [bullets]
**Action items:** [Person → Task by Date]
```

**Code changes**
```
**Changes Summary**
- Files: N changed, +X/-Y lines
**What changed:** [per-component bullets]
**Risk:** Low/Medium/High - [reason]
```
