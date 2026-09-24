# omp-remote — agent guide

Remote control of OMP sessions from a phone. Read `docs/omp-remote/ARCHITECTURE.md`
before non-trivial work. Maintainer design specs and plans live in
`docs/superpowers/` when present (not published).

## Environment (this machine)

- Bun must be on PATH (machine-specific toolchain locations live in `memory/reference_local_toolchain.md` when present).
- Run long-lived processes (`omp-remote run`) via a supervised process, not a
  raw backgrounded shell.
- `omp` (18.x) is installed with models configured (`modelRoles.task` = a local **qwen**
  model); `omp --mode rpc -e <ext>` works for headless bridge testing.
- Nested `omp` subagents work here (verified 2026-09-07 — the old "No model selected" blocker is
  gone). Overnight links run under the relay's `-Engine omp`: qwen workhorses (`task`/`scout`/
  `sonic`, pinned via `task.agentModelOverrides`) and opus reviewers (`reviewer`/`security-reviewer`,
  inheriting the link's `--model`).

## Commands

```bash
bun install
bun test                                   # whole suite
bun test packages/<pkg>/                   # one package
bunx tsc -p tsconfig.base.json --noEmit    # typecheck workspace
bunx biome check packages scripts apps          # lint + format check
bunx biome check --write packages scripts apps  # apply safe fixes
```

Always run typecheck + tests + biome before committing.

## Runtime config and CLI

- One CLI, `apps/cli` (bin `omp-remote`): `init`, `run`, `join <url>`, `pair`,
  `passwd`, `doctor`, `install`, `uninstall`. Install with `cd apps/cli && bun link`,
  or run `bun run omp-remote <command>` from the repo root.
- The server and agent read `<stateDir>/config.json` through `@omp-remote/config`
  (`server` and/or `agent` sections). `stateDir` is `OMP_REMOTE_STATE_DIR` or
  `~/.omp-remote`; secrets (`secretPaths`) live beside it, owner-only.
- No env-var config. `OMP_REMOTE_STATE_DIR` and `OMP_REMOTE_IPC_PATH` are the
  only runtime env vars. Point tests at a temp `OMP_REMOTE_STATE_DIR`.
- User docs: `docs/SELF-HOSTING.md` (local network, HTTPS) and
  `docs/omp-remote/PUBLIC-SERVER.md` (VPS).

## Conventions (enforced repo rules — do not fight them)

- Runtime **Bun**; every package `"type": "module"` ESM; TypeScript **strict**.
- **Never** `any` / `as any`. Parse `unknown` with Zod at every trust boundary
  (IPC/network/external input); type guards for in-process narrowing;
  `as unknown as T` with a one-line reason only at a library boundary.
- Prefer **`Promise.withResolvers()`** over `new Promise((resolve, reject) =>)`.
- **No wall-clock timers in tests** (`setTimeout`/`Bun.sleep`) — await the real
  condition (an event, a promise, a snapshot) instead.
- No assignment-in-expression; no redundant `clearTimeout`/`clearInterval`
  guards; name concrete types instead of `ReturnType<typeof fn>`.
- `Map`/`Set` for dynamic runtime collections; `Record` for static lookup tables.
- Don't inline-wrap trivial one-expression functions unless the name is a real
  exported contract.
- Every inbound frame is **Zod-parsed**, never cast.
- Cross-platform: must run on **Windows** (named pipes) and **Unix** (sockets).

## Architecture invariants

- The **aggregator is content-blind**: it routes opaque sealed bytes and
  never holds room/session keys or plaintext. Confidentiality + control
  integrity live in the phone↔host-agent E2E channel. This holds on plain HTTP
  too: the local default serves over HTTP, and the E2E layer is unchanged.
- Agents dial **out** to the aggregator; each authenticates with its own
  per-machine token. The aggregator is the only listening surface. No VPN is
  required on the phone path.
- The **bridge** is the single conduit for both adopted and spawned sessions;
  bridge failures must never crash the OMP session.
- The shared **frame contract** is `@omp-remote/protocol` — change it there,
  never redefine frames per package.

## Workflow

- TDD: failing test → minimal code → green → commit. Frequent, scoped commits.
- If a plan in `docs/superpowers/plans/` is active, follow it task by task and
  commit with the messages it specifies.
