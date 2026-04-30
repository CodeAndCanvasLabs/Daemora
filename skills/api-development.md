---
name: api-development
description: REST API design, endpoint implementation, request validation, error handling
triggers: api, rest, endpoint, route, controller, middleware, request, response, http, express, fastify, status code, authentication, authorization, jwt, oauth, cors, rate limit
---
## Workflow: Design → Implement → Validate → Test → Document

1. **Design** - define routes, HTTP methods, request/response shapes. Follow REST conventions.
2. **Implement** - write handler, validation, business logic. Keep handlers thin.
3. **Validate** - validate request body/params/query at the boundary. Return 400 for bad input.
4. **Test** - `curl` or write a test. Check success + error cases + edge cases.
5. **Document** - update API docs or add inline route comments.

## REST Conventions
- `GET /items` → list, `GET /items/:id` → get one
- `POST /items` → create (201), `PUT /items/:id` → replace, `PATCH /items/:id` → partial update
- `DELETE /items/:id` → delete (204 or 200)
- Plural nouns for resources. No verbs in URLs.

## Status Codes
- 200 OK, 201 Created, 204 No Content
- 400 Bad Request (validation), 401 Unauthorized, 403 Forbidden, 404 Not Found, 409 Conflict
- 429 Too Many Requests, 500 Internal Server Error

## Error Format
```json
{ "error": { "message": "human readable", "code": "MACHINE_CODE", "details": {} } }
```

## Security
- Validate all input at the boundary - never trust client data
- Use parameterized queries (no SQL injection)
- Rate limit public endpoints
- Don't expose stack traces in production errors
- Authenticate before authorize
