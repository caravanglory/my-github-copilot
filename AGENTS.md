# AGENTS.md

## Commands

```bash
bun install            # install deps
bun run build          # bundle → dist/index.js (ESM, node target)
bun run typecheck      # tsc --noEmit
bun run test           # all 46 unit tests (single file: src/index.test.ts)
```

Run a single test by name:
```bash
bun test --test-name-pattern "parseStore" src/index.test.ts
```

No linter or formatter is configured.

## Architecture

Single-package CLI (`mgc`). Bun builds and tests; the output targets Node 18+.

- `src/cli/` — interactive UI layer using `@clack/prompts` and `picocolors`
- `src/features/copilot-account-switcher/` — core logic: OAuth device flow, token refresh, store, network retry, session repair
- `src/index.ts` — entrypoint, calls `copilotXCli()`
- `bin/mgc.js` — Node shim that imports `../dist/index.js`
- `dist/` — gitignored build output

## Data files (runtime)

- Account store: `$XDG_CONFIG_HOME/opencode/copilot-x.json` (default `~/.config/opencode/copilot-x.json`)
- Shared auth: `$XDG_DATA_HOME/opencode/auth.json` (default `~/.local/share/opencode/auth.json`)
- Log: `$TMPDIR/mgc.log`

## Conventions

- All dependencies are devDependencies (bundled into a single ESM file at build time)
- Tests use `bun:test` (`describe`/`test`/`expect`) — do not use Jest or Vitest APIs
- TypeScript strict mode; `"types": ["bun-types"]` in tsconfig
- `moduleResolution: "bundler"` — use extensionless imports within `src/`
