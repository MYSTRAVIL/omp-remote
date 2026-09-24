# Contributing

## Prerequisites

- Bun 1.4.x
- OMP >= 18.2 (required for bridge work)
- Node-compatible tooling (TypeScript, Biome ship as devDependencies)

## Getting started

```bash
bun install
```

## Running the full gate

Before committing, run:

```bash
bun x --bun tsc -p tsconfig.base.json --noEmit
bun test
bun x biome check packages scripts apps
```

Aliases from `package.json`:

```bash
bun run typecheck    # tsc --noEmit across the workspace
bun run test         # bun test
bun run lint         # biome check
```

For web changes, also build the PWA:

```bash
cd apps/web
bun run build.ts
```

## Conventions

Follow the conventions in `CLAUDE.md`. Key points:

- Runtime is Bun. Every package is `"type": "module"` ESM.
- TypeScript strict. Never use `any` or `as any`.
- Parse unknown input with Zod at every trust boundary (IPC, network, external input).
- Prefer `Promise.withResolvers()` over `new Promise((resolve, reject) => ...)`.
- No wall-clock timers in tests. Await the real condition instead.
- Use `Map`/`Set` for dynamic runtime collections; `Record` for static lookup tables.
- Must run on both Windows (named pipes) and Unix (sockets).
- Protocol changes go in `@omp-remote/protocol` only. Never redefine frames per package.
- The aggregator stays content-blind: it routes sealed bytes and never holds session keys.

## Workflow

- TDD: failing test, then minimal code, then green.
- Frequent, small, scoped commits.
- Run typecheck + tests + biome before committing.
