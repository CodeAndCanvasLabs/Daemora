---
name: slack-ops
description: Slack operations — send, edit, delete messages, react, pin, threads, formatting
triggers: slack, slack message, slack react, slack pin, slack thread, slack channel, slack notification
---

## Sending Messages
- Plain text: `messageChannel("Hello world", channelId, sessionId)`
- With blocks: `messageChannel({ blocks: [...] }, channelId, sessionId)`
- Threaded reply: `messageChannel({ text: "reply", thread_ts: "1234567890.123456" }, channelId, sessionId)`

## Message Formatting (mrkdwn)
- Bold: `*text*`, Italic: `_text_`, Strike: `~text~`, Code: `` `code` ``
- Code block: ` ```code``` `
- Quote: `> quoted text`
- List: `- item` or `1. item`
- Link: `<https://url|Display Text>`
- Mentions: `<@userId>`, `<#channelId>`, `<!here>`, `<!channel>`

## Block Kit
- Section: `{ type: "section", text: { type: "mrkdwn", text: "content" } }`
- Divider: `{ type: "divider" }`
- Header: `{ type: "header", text: { type: "plain_text", text: "Title" } }`
- Actions (buttons): `{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Click" }, action_id: "btn1" }] }`
- Context: `{ type: "context", elements: [{ type: "mrkdwn", text: "footnote" }] }`
- Max 50 blocks per message

## Reactions
- Add/remove reactions via messageChannel with reaction payload
- Common: `+1`, `-1`, `white_check_mark`, `eyes`, `rocket`, `tada`

## Threads
- Start thread: send a reply with `thread_ts` set to parent message ts
- Broadcast to channel: include `reply_broadcast: true`

## Pins
- Pin/unpin messages via channel operations
- Max 100 pins per channel

## Files
- Send file: `sendFile(filePath, channelId, sessionId)`
- Send with comment: `sendFile(filePath, channelId, sessionId, { initial_comment: "Here's the data" })`

## Rules
- Use blocks for rich layouts, plain text for simple replies
- Keep messages under 40,000 chars (Slack limit)
- Use threads to avoid channel noise
- Respect rate limits: ~1 msg/sec per channel
- Use `<!here>` sparingly — notify only when needed
