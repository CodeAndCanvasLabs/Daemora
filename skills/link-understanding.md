---
name: link-understanding
description: Auto-detect and summarize URLs in user messages
triggers: url, link, http, website, article, page, read this
---

# Link Understanding

When the user's message contains URLs:

1. Detect all HTTP/HTTPS URLs in the message
2. For each URL, use `webFetch` to retrieve the page content
3. Summarize the key information from each page
4. Incorporate the summaries into your response

Rules:
- Fetch URLs before answering — don't guess what a link contains
- If a URL fails to load, mention it and proceed with what you have
- For very long pages, focus on the main content (first 2000 chars usually sufficient)
- Don't fetch URLs that are clearly file downloads (.zip, .tar, .exe) — just note the filename
- If the user asks about a specific part of the page, focus your summary on that
