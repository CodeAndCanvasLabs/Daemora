# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Daemora, please **email** the
maintainer directly rather than opening a public GitHub issue:

**umarfarooq0149@gmail.com**

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (proof of concept welcome)
- Affected versions
- Any suggested mitigation

We aim to:

- Acknowledge your report within **72 hours**
- Provide a remediation timeline within **7 days** for confirmed issues
- Credit you in the release notes when a fix ships (unless you prefer to
  remain anonymous)

Please **do not** disclose the vulnerability publicly until a fix has been
released and users have had time to update.

## Supported Versions

| Version    | Status                                 |
| ---------- | -------------------------------------- |
| `1.x`      | Supported (active development)         |

## Scope

Security reports are welcome for:

- The Daemora server, CLI, and web UI
- Built-in skills, crews, and channels shipped in this repository
- Authentication, vault, and OAuth flows

Out of scope:

- Third-party MCP servers, model providers, or integrations the user
  installs themselves
- Vulnerabilities that require physical access to a machine that already
  holds an unlocked Daemora vault
- Issues in dependencies that have already been disclosed upstream and are
  awaiting a published fix

## Hardening Guidance

If you operate Daemora in a multi-user or untrusted environment, please
review the security notes in the project documentation, in particular:

- Vault passphrase strength and rotation
- `DAEMORA_AUTH_ENABLED` and the loopback file-token model
- Network exposure of the HTTP server (`HOST` / `PORT` / reverse proxy)
- API key handling for OAuth and provider integrations
