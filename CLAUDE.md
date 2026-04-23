# cmaf-lite

pnpm monorepo for cmaf-lite.

## Packages

- `packages/cmaf-lite` (`cmaf-lite`) — CMAF-compliant media library. See [cmaf-lite docs](packages/cmaf-lite/docs/DESIGN.md).
- `packages/demo` (`demo`) — demo app consuming `cmaf-lite`
- `packages/docs` — documentation (out of scope)

## Tech Stack

- TypeScript, Vite, pnpm workspaces
- Biome for formatting and linting

## Scripts

- `pnpm dev` — run dev in all packages
- `pnpm build` — build all packages
- `pnpm format` — format and lint all packages
- `pnpm tsc` — type check all packages
- `pnpm test` — run tests in all packages

## Working Guidelines

### Workflow

- Use superpowers (brainstorm → plan → execute) for any non-trivial task
- Non-trivial = 3+ steps or architectural decisions
- If something goes sideways, STOP and re-plan immediately

### Subagent Strategy

- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis
- For complex problems, throw more compute at it via subagents

### Code Quality

- Demand elegance: for non-trivial changes, pause and ask "is there a more elegant way?"
- Skip for simple, obvious changes — do not over-engineer
- Simplicity first: make every change as simple as possible, impact minimal code
- Find root causes — no temporary fixes, no workarounds
- Senior developer standards at all times

### Testing

- Vitest with happy-dom. See [testing guidelines](docs/guidelines/testing.md)
- Tests in `packages/cmaf-lite/test/` mirror the `lib/` structure
- Test helpers in `test/__framework__/`, fixtures in `test/fixtures/`
- Test names answer "what behavior breaks if this test fails?"
- Top-level `describe` uses PascalCase module name (e.g., `DashParser`)
- Import types and enums from `lib/` — never duplicate definitions

### Code Style

- JSDoc comments: concise, technical, multi-line format, 80 char max line length
- Follow Biome rules (double quotes, 2-space indent, block statements required)
- Use `import type` for type-only imports
