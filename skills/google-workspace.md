---
name: google-workspace
description: Google Workspace operations — Gmail, Calendar, Drive, Contacts
triggers: gmail, google calendar, google drive, google contacts, google workspace, gsuite, google mail, google docs, google sheets, google meet
---

## Gmail

### Send Email
- `sendEmail({ to: "user@example.com", subject: "Subject", body: "HTML or plain text", cc: "cc@example.com", bcc: "bcc@example.com", attachments: ["/path/to/file"] })`

### Read Email
- `readEmail({ query: "from:user@example.com after:2025/01/01", maxResults: 10 })`
- `readEmail({ messageId: "msg_id" })` — full message with body
- Query syntax: `is:unread`, `from:`, `to:`, `subject:`, `has:attachment`, `after:`, `before:`, `label:`

### Manage Email
- Reply: `sendEmail({ replyTo: "messageId", body: "reply text" })`
- Forward: read message, then sendEmail with original content + new recipient
- Labels: `manageEmail({ messageId: "id", addLabels: ["IMPORTANT"], removeLabels: ["INBOX"] })`
- Mark read/unread: `manageEmail({ messageId: "id", markRead: true })`

## Google Calendar

### Events
- Create: `createCalendarEvent({ summary: "Meeting", start: "2025-06-01T10:00:00", end: "2025-06-01T11:00:00", attendees: ["user@example.com"], location: "Room 1", description: "Agenda" })`
- List: `listCalendarEvents({ timeMin: "2025-06-01T00:00:00Z", timeMax: "2025-06-07T23:59:59Z", maxResults: 20 })`
- Update: `updateCalendarEvent({ eventId: "id", summary: "Updated Title" })`
- Delete: `deleteCalendarEvent({ eventId: "id" })`

### Patterns
- Recurring: `recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]`
- All-day: use date instead of dateTime: `start: { date: "2025-06-01" }`
- Video call: `conferenceData: { createRequest: { requestId: "unique-id" } }`

## Google Drive

### Operations
- List files: `listDriveFiles({ query: "name contains 'report'", maxResults: 10 })`
- Download: `downloadDriveFile({ fileId: "id", outputPath: "/tmp/file.pdf" })`
- Upload: `uploadDriveFile({ filePath: "/tmp/report.pdf", name: "Q1 Report", mimeType: "application/pdf", folderId: "folder_id" })`
- Create folder: `createDriveFolder({ name: "Projects", parentId: "parent_folder_id" })`
- Share: `shareDriveFile({ fileId: "id", email: "user@example.com", role: "reader" })`

### Query Syntax
- By type: `mimeType='application/pdf'`
- By folder: `'folderId' in parents`
- By name: `name contains 'keyword'`
- Combine: `name contains 'report' and mimeType='application/pdf'`

## Google Contacts

### Operations
- Search: `searchContacts({ query: "John" })`
- Create: `createContact({ name: "John Doe", email: "john@example.com", phone: "+1234567890", company: "Acme" })`
- Update: `updateContact({ contactId: "id", email: "newemail@example.com" })`
- List: `listContacts({ maxResults: 50 })`

## Rules
- Always confirm before sending emails or creating events
- Use ISO 8601 format for all dates/times
- Include timezone when creating events
- For bulk operations, process in batches to respect rate limits
- Check existing events before creating to avoid duplicates
