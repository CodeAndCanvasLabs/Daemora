---
name: discord-ops
description: Discord channel operations — send messages, react, pin, threads, embeds
triggers: discord, discord message, discord react, discord pin, discord thread, discord embed, discord channel
---

## Sending Messages
- Plain text: `messageChannel("Hello world", channelId, sessionId)`
- With embed: `messageChannel({ embeds: [embed] }, channelId, sessionId)`
- Reply to message: `messageChannel({ content: "reply", reply: { messageId: "123" } }, channelId, sessionId)`

## Embeds
- Structure: `{ title, description, color (hex int), fields: [{ name, value, inline }], footer: { text }, thumbnail: { url }, image: { url }, timestamp }`
- Color examples: `0x5865F2` (blurple), `0xED4245` (red), `0x57F287` (green)
- Max 25 fields, 6000 total chars across all embed properties

## Reactions
- Add reaction via channel meta or messageChannel with reaction payload
- Common: thumbsup, thumbsdown, white_check_mark, x, eyes, rocket

## Threads
- Create thread from message: include `thread: { name: "Thread Title" }` in message payload
- Send to existing thread: use thread ID as channelId in messageChannel

## Files
- Send file: `sendFile(filePath, channelId, sessionId)`
- Send with message: `sendFile(filePath, channelId, sessionId, { content: "Here's the report" })`
- Max file size: 8MB (free), 50MB (boosted)

## Pins
- Pin important messages via channel operations
- Max 50 pins per channel

## Formatting
- Bold: `**text**`, Italic: `*text*`, Code: `` `code` ``, Block: ` ```lang\ncode``` `
- Mentions: `<@userId>`, `<#channelId>`, `<@&roleId>`
- Timestamps: `<t:unixTimestamp:F>` (full), `<t:unixTimestamp:R>` (relative)

## Rules
- Respect rate limits — don't spam messages
- Use embeds for structured data, plain text for conversational replies
- Keep messages under 2000 chars; split longer content into multiple messages
- Use threads for long discussions to keep channels clean
