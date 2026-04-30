# Changelog

All notable changes to Daemora are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-alpha.0] — 2026-04-25

### Added

- Web UI as the primary management surface — channels, MCP servers, crew,
  integrations, watchers, cron, memory, and skills all configured visually.
- Per-crew model + temperature override: each crew member can pick its own
  model from any configured provider, hot-reloaded without a restart.
- Unified OAuth callback (`/oauth/callback`) shared by every integration —
  one redirect URI to register per provider, regardless of how many you add.
- Integration watcher poller: Gmail, Calendar, GitHub, Reddit, LinkedIn,
  TikTok event polling with diff-based change detection.
- LiveKit voice agent worker bundled as `dist/voice-worker.mjs`.
- AGPL-3.0 LICENSE file shipped in the package.

### Changed

- CLI surface focuses on lifecycle commands: `start`, `setup`, `daemon`,
  `doctor`, `vault`, `config`, `voice-worker`, `version`, `help`. Feature
  management lives in the web UI.

[Unreleased]: https://github.com/CodeAndCanvasLabs/Daemora/compare/v1.0.0-alpha.0...HEAD
[1.0.0-alpha.0]: https://github.com/CodeAndCanvasLabs/Daemora/releases/tag/v1.0.0-alpha.0
