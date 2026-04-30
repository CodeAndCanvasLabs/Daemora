# Contributing to Daemora

Thanks for your interest in helping. This guide covers the dev setup, the
basics of how the codebase is organised, and the PR flow.

## Prerequisites

- **Node.js 22+** (engine pinned in `package.json`)
- A working C/C++ toolchain (for `better-sqlite3` native build)
  - macOS: `xcode-select --install`
  - Debian/Ubuntu: `sudo apt install build-essential python3`
  - Windows: install **Visual Studio Build Tools** (the "Desktop development
    with C++" workload) or use WSL
- Either `npm` (ships with Node) or `pnpm` / `yarn` — all work

## Clone + install

```bash
git clone https://github.com/CodeAndCanvasLabs/Daemora.git
cd Daemora

# pick whichever you prefer
npm install
# or: pnpm install
# or: yarn install

# UI deps live in their own workspace
cd ui && npm install && cd ..
```

## Run in dev mode

```bash
# starts the server with file-watch + hot-reload (uses tsx)
npm run dev
```

The web UI dev server lives in the `ui/` workspace:

```bash
cd ui
npm run dev    # vite dev server, separate port, proxies to the API
```

## Common scripts

| Command                | What it does                                          |
| ---------------------- | ----------------------------------------------------- |
| `npm run dev`          | Server with watch (tsx)                               |
| `npm start`            | Server one-shot (tsx)                                 |
| `npm run typecheck`    | `tsc --noEmit` against the strict dev tsconfig        |
| `npm run test`         | Vitest, single run                                    |
| `npm run test:watch`   | Vitest watch mode                                     |
| `npm run build`        | Full production build (server + ui + voice bundle)   |
| `npm run build:server` | Compile `src/` → `dist/` via `tsconfig.build.json`    |
| `npm run build:ui`     | `cd ui && npm ci && npm run build`                    |
| `npm run build:voice`  | Bundle the LiveKit worker via esbuild                 |
| `npm run clean`        | Remove `dist/`                                        |

## Repository layout

```
src/                  TypeScript sources (server, CLI, agent, channels, ...)
ui/                   React + Vite web UI (its own package.json)
crew/                 Built-in crew member manifests + tool implementations
skills/               Built-in skill definitions (mostly markdown)
public/               Static assets (banner, architecture diagrams)
tests/                Vitest test suites
docs/                 Long-form docs (install, CLI reference, ...)
.github/              CI + publish workflows, dependabot, issue templates
```

## Branch + PR flow

- Target **`dev`** for new work — `main` is the latest published / publishable
  state.
- Branch naming: `feature/<short-name>`, `fix/<short-name>`, `docs/<short-name>`.
- One logical change per PR. If the diff touches both server and UI, that's
  fine when they're tied to the same feature; otherwise split them.
- Before opening: `npm run typecheck && npm run test`.
- The PR template will ask for a Summary, Changes, Type, and Testing notes —
  fill them in honestly. "Tested locally" without specifics doesn't help a
  reviewer.

## Style + correctness

- TypeScript is strict (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`). Don't loosen these flags.
- ESM only — imports use `.js` suffixes (`"./foo.js"`) even for `.ts` source.
- Prefer Zod schemas at API boundaries over hand-rolled validation.
- Don't introduce a new dependency without flagging it in the PR description.
- Don't commit secrets. `.env` is gitignored; use the runtime vault for
  anything sensitive.

## Tests

Vitest is the runner. Tests live in `tests/` mirroring the `src/` tree.
Network calls and filesystem writes should be mocked or routed through a
temp dir. Database tests should run against an in-memory SQLite instance.

```bash
npm run test                    # all tests
npm run test -- path/to/file    # single file
npm run test:watch              # interactive
```

## Publishing (maintainers only)

Publishes are GitHub Actions–driven. Don't publish from a laptop.

- **Pre-releases** (alpha/beta/rc): bump `package.json` to e.g.
  `1.0.0-alpha.1`, merge to `main`, run the **Publish to npm** workflow
  manually with `branch: main`. The workflow auto-detects the pre-release
  tag from the version string and ships under that dist-tag.
- **Stable**: bump to `1.0.0`, merge to `main`, run the workflow. It
  publishes to the `latest` dist-tag.
- **Dev snapshots**: pushing the workflow against the `dev` branch produces
  a unique pre-release version (`1.0.0-dev.<date>.<sha>`) on the `dev`
  dist-tag.

See `.github/workflows/publish.yml` for the full state machine.

## Reporting bugs / asking for features

- Bug? Use the **Bug Report** issue template.
- Feature? Use the **Feature Request** issue template.
- Security issue? Read [`SECURITY.md`](SECURITY.md) — please don't open a
  public issue.

## Code of conduct

Be excellent. See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
