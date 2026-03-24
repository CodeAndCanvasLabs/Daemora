# Contributing to Daemora

Thanks for your interest in contributing to Daemora! This guide will help you get started.

## Getting Started

```bash
# Fork the repo on GitHub, then:
git clone https://github.com/YOUR_USERNAME/Daemora.git
cd Daemora
pnpm install
cp .env.example .env
# Add at least one AI provider API key to .env
```

## Branch Strategy

| Branch | Purpose |
|---|---|
| `main` | Stable releases only - never push directly |
| `dev` | Active development - all PRs target this branch |

### Workflow

1. Fork the repo
2. Create a feature branch from `dev`:
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b feat/your-feature
   ```
3. Make your changes
4. Run tests: `pnpm test`
5. Commit with a clear message (see conventions below)
6. Push to your fork and open a PR against `dev`

## Commit Convention

Format: `type: short description`

| Type | When |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or updating tests |
| `chore` | Maintenance (deps, CI, config) |

Examples:
```
feat: Add Mastodon channel support
fix: Prevent cross-tenant memory leakage
docs: Add MCP server setup guide
refactor: Extract path validation to shared utility
test: Add FilesystemGuard edge case coverage
```

## What to Contribute

### Good First Issues
Look for issues labeled [`good first issue`](https://github.com/CodeAndCanvasLabs/Daemora/labels/good%20first%20issue) - these are scoped, well-defined tasks ideal for new contributors.

### Areas We Need Help With
- **New channels** - add support for more messaging platforms
- **New tools** - expand the agent's built-in capabilities
- **MCP integrations** - test and document MCP server setups
- **Tests** - increase coverage, especially edge cases
- **Documentation** - guides, examples, tutorials
- **Bug fixes** - check open issues

### What We Probably Won't Merge
- Large refactors without prior discussion
- Features that add significant complexity for niche use cases
- Changes that break existing tests without justification
- Dependencies with restrictive licenses

## Development

### Project Structure

```
src/
├── core/          Agent loop, task queue, task runner
├── models/        Model router, provider setup
├── channels/      Telegram, Discord, Slack, etc.
├── tools/         Built-in tools (51)
├── agents/        Sub-agent manager
├── tenants/       Multi-tenant isolation
├── safety/        Audit, sandbox, guards
├── setup/         Interactive setup wizard
└── config/        Default configuration
```

### Running Tests

```bash
pnpm test              # All tests
pnpm test:unit         # Unit tests only
pnpm test:integration  # Integration tests only
pnpm test:watch        # Watch mode
pnpm test:coverage     # Coverage report
```

### Running Locally

```bash
pnpm start             # Start the agent
# or
node src/index.js
```

## Pull Request Guidelines

- Keep PRs focused - one feature or fix per PR
- Include tests for new functionality
- Update documentation if behavior changes
- Ensure all existing tests pass
- Fill out the PR template

## Code Style

- ES modules (`import/export`), no CommonJS
- No build step - plain JavaScript
- No TypeScript (the project is intentionally JS-only)
- Follow existing patterns - read the code around your changes
- Keep it simple - prefer clarity over cleverness

## Reporting Bugs

Use the [bug report template](https://github.com/CodeAndCanvasLabs/Daemora/issues/new?template=bug_report.md) and include:
- Steps to reproduce
- Expected vs actual behavior
- Node.js version, OS, Daemora version
- Relevant logs (redact any API keys)

## Suggesting Features

Use the [feature request template](https://github.com/CodeAndCanvasLabs/Daemora/issues/new?template=feature_request.md). Describe:
- The problem you're trying to solve
- Your proposed solution
- Alternatives you've considered

## Community

- [GitHub Discussions](https://github.com/CodeAndCanvasLabs/Daemora/discussions) - questions, ideas, show & tell
- [Issues](https://github.com/CodeAndCanvasLabs/Daemora/issues) - bugs and feature requests

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0 License](LICENSE).
