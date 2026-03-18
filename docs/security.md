# Security

Daemora has a 12-layer security architecture designed for production multi-tenant deployment.

## Security Layers

### 1. Permission Tiers
Three levels of tool access:
- **minimal** — read-only tools, no shell
- **standard** — most tools, guarded shell
- **full** — all tools, unrestricted

Set via `daemora setup` or Settings UI.

### 2. Filesystem Sandbox
Control which paths the agent can read/write:
```bash
ALLOWED_PATHS=/Users/me/projects,/tmp
BLOCKED_PATHS=/etc,/usr
```

Per-tenant filesystem isolation available.

### 3. Secret Vault
AES-256-GCM encrypted storage for API keys and tokens.

```bash
daemora vault import mypassphrase
# Imports .env keys into encrypted vault, removes plaintext
```

Vault auto-unlocks on startup with passphrase prompt.

### 4. Command Guard
Blocks dangerous shell commands:
- `rm -rf /`
- `chmod 777`
- `curl | sh`
- And more pattern-based blocks

### 5. Secret Scanner
Double-redacts API keys and tokens from tool outputs:
- Scans all tool results for known secret patterns
- Redacts before sending to LLM
- Prevents accidental key exposure in responses

### 6. Audit Log
Every tool call, permission check, and security event logged to SQLite:
- Tool name, params, result
- Tenant ID
- Timestamp
- Blocked attempts

### 7. Circuit Breaker
Temporarily disables tools that fail repeatedly:
- After N consecutive failures, tool is blocked
- Prevents infinite retry loops
- Auto-resets after cooldown

### 8. Git Rollback
Auto-creates git snapshots before destructive operations:
- Snapshot before first write tool call per task
- Rollback if task fails
- Named: `daemora-snapshot-<taskId>`

### 9. Input Sanitizer
Cleans user input before processing:
- Strips control characters
- Detects prompt injection attempts
- Tags `<untrusted-content>` from external sources

### 10. Execution Approval
Configurable approval gates for shell commands:
- `auto` — execute without asking
- `confirm` — require human approval for destructive ops

### 11. Supervisor
Monitors running tasks:
- Kills stuck tasks exceeding timeout
- Prevents resource exhaustion
- Cascading kill propagation for sub-agents

### 12. Tenant Isolation
Per-tenant boundaries:
- Separate memory, API keys, filesystem paths
- Cost budgets per tenant
- Tool allowlists/blocklists
- MCP server allowlists
- Plugin enable/disable per tenant

## Security Audit

Run the built-in security checker:

```bash
daemora doctor
```

Checks:
- Vault encryption key strength
- Exposed secrets in .env
- Permission tier appropriateness
- Filesystem sandbox configuration
- Daemon mode security
- API key presence
- Multi-tenant isolation
- MCP server access controls
