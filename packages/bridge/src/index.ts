import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import {
  type CatalogRole,
  type SessionMeta,
  normalizeAskQuestions,
} from "@omp-remote/protocol";
import { ipcPath, resolveIpcToken } from "@omp-remote/protocol/ipc";
import {
  type BridgeDiagnosticSink,
  type PromptDispatchRoute,
  bridgeLoggerDiagnostic,
} from "./diagnostics";
import { runShadowAsk, runToolApproval } from "./interactions";
import { chunkImage, imagesOf } from "./media-chunker";
import {
  type AssembledResource,
  ResourceAssembler,
} from "./resource-assembler";
import { SessionBridge } from "./session-bridge";

/**
 * Opt-in remote tool approval, from `OMP_REMOTE_APPROVAL`:
 *   unset/`off` → never gate (default; the desk keeps omp's own approval mode)
 *   `all`       → gate every tool
 *   a CSV list  → gate exactly those tool names
 * The `ask` tool is never gated (it is the question channel itself).
 */
type ApprovalGate =
  | { mode: "off" }
  | { mode: "all" }
  | { mode: "list"; tools: Set<string> };

function parseApprovalGate(raw: string | undefined): ApprovalGate {
  const value = raw?.trim();
  if (!value || value === "off" || value === "false") return { mode: "off" };
  if (value === "all" || value === "true") return { mode: "all" };
  return {
    mode: "list",
    tools: new Set(
      value
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    ),
  };
}

function shouldGate(gate: ApprovalGate, toolName: string): boolean {
  if (toolName === "ask") return false;
  if (gate.mode === "off") return false;
  if (gate.mode === "all") return true;
  return gate.tools.has(toolName);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c) =>
        c && typeof c === "object" && "text" in c && typeof c.text === "string"
          ? c.text
          : "",
      )
      .join("");
  return "";
}

/** Pin the first non-empty session name; once pinned, later re-titles are ignored. */
export function firstTitle(
  pinned: string | undefined,
  current: string | undefined,
): string | undefined {
  return pinned ?? (current && current.length > 0 ? current : undefined);
}

/**
 * Run an omp operation the phone triggered so that a sync throw or a rejection
 * calls `onFailure` instead of escaping as an unhandled rejection, which can
 * take down the user's omp session. A throwing `onFailure` is contained too.
 */
export async function containFailure(
  op: () => Promise<unknown>,
  onFailure: () => void,
): Promise<void> {
  try {
    await op();
  } catch {
    try {
      onFailure();
    } catch {
      // Reporting the failure failed as well; nothing further is safe to do.
    }
  }
}

/**
 * Wire the phone's `compact` control. A failed compaction is logged and
 * reported to the phone as a `control-failed` `controlError`; it never escapes
 * as an unhandled rejection.
 */
export function wireCompact(
  bridge: SessionBridge,
  compact: (instructions?: string) => Promise<void>,
  diagnostic: BridgeDiagnosticSink,
): void {
  bridge.onCompact((instructions) => {
    void containFailure(
      () => compact(instructions),
      () => {
        diagnostic({
          event: "bridge_operation_failed",
          code: "compact-failed",
        });
        bridge.emitControlFailed("compact", "Compaction failed.");
      },
    );
  });
}

function sessionMeta(ctx: ExtensionContext, title: string): SessionMeta {
  return {
    id: ctx.sessionManager.getSessionId() ?? `sess-${process.pid}`,
    cwd: ctx.cwd,
    project: basename(ctx.cwd),
    model: ctx.models.current()?.id ?? "unknown",
    title: title || basename(ctx.cwd),
    pid: process.pid,
    startedAt: Date.now(),
    spawnId: process.env.OMP_REMOTE_SPAWN_ID,
  };
}

/** The current model's provider family iff it appears in the session's service-tier map. */
function fastFamily(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Parameters<typeof pi.setServiceTier>[0] | undefined {
  const provider = ctx.models.current()?.provider;
  if (!provider || !(provider in pi.getServiceTiers())) return undefined;
  return provider as Parameters<typeof pi.setServiceTier>[0];
}

function deliverPrompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  text: string,
  mode: "steer" | "followUp" | "aside",
  images: AssembledResource[],
): PromptDispatchRoute {
  // Plain sends start idle sessions. Active turns need the explicit destination
  // so Queue waits for the boundary while Steer redirects the current turn.
  const content =
    images.length > 0
      ? [
          { type: "text" as const, text },
          ...images.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ]
      : text;
  if (ctx.isIdle()) {
    pi.sendUserMessage(content);
    return "idle-start";
  }
  pi.sendUserMessage(content, { deliverAs: mode });
  return mode === "steer"
    ? "active-steer"
    : mode === "aside"
      ? "active-aside"
      : "active-follow-up";
}

// Permissive JSON Schema for the shadow `ask` — omp validates the model's call against
// it, so it stays loose (the raw params are forwarded to the native tool and the phone).
// omp accepts a plain JSON Schema here (verified against the live 18.1.14 binary); its
// public `ToolDefinition` types the field as TypeBox `TSchema`, hence the boundary cast.
const ASK_PARAMETERS = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          question: { type: "string" },
          options: { type: "array" },
          multi: { type: "boolean" },
          recommended: { type: "number" },
        },
        required: ["question"],
      },
    },
  },
  required: ["questions"],
} as unknown as ToolDefinition["parameters"];

/** How often the collab bridge re-reads the async-job snapshot while jobs run. */
const JOBS_POLL_MS = 2000;

/** Thinking levels a phone may request or a role spec may carry as a suffix. */
const THINKING_LEVELS: Record<string, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  inherit: true,
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string")
    : [];
}

function asStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      if (typeof v === "string") out[k] = v;
  return out;
}

/** The slice of omp's config the model picker curates from. */
interface OmpConfig {
  enabledModels: string[];
  modelRoles: Record<string, string>;
  agentModelOverrides: Record<string, string>;
}

/**
 * Memoized successful config read. omp may load this extension in more than one
 * context (an early probe load can run before the config file is readable),
 * so we cache the first non-empty read and reuse it. This guarantees the model
 * catalog never regresses to the unfiltered fallback once the curated config
 * has been seen — later emits stay on the real 10-model set + roles.
 */
let configCache: OmpConfig | null = null;

/**
 * Read `~/.omp/agent/config.yml` for the user's curated model set + roles. Best
 * effort: a missing file or absent YAML runtime yields empties, and the catalog
 * falls back to the full authenticated set and a probe of well-known role aliases.
 */
function readOmpConfig(): OmpConfig {
  if (configCache) return configCache;
  const empty: OmpConfig = {
    enabledModels: [],
    modelRoles: {},
    agentModelOverrides: {},
  };
  try {
    const text = readFileSync(
      join(homedir(), ".omp", "agent", "config.yml"),
      "utf8",
    );
    const yaml = (
      globalThis as { Bun?: { YAML?: { parse(s: string): unknown } } }
    ).Bun?.YAML;
    if (!yaml) return empty;
    const root = yaml.parse(text);
    if (!root || typeof root !== "object") return empty;
    const r = root as Record<string, unknown>;
    const task = r.task as Record<string, unknown> | undefined;
    const result: OmpConfig = {
      enabledModels: asStringArray(r.enabledModels),
      modelRoles: asStringMap(r.modelRoles),
      agentModelOverrides: asStringMap(task?.agentModelOverrides),
    };
    if (
      result.enabledModels.length > 0 ||
      Object.keys(result.modelRoles).length > 0
    ) {
      configCache = result;
    }
    return result;
  } catch {
    return empty;
  }
}

/** Split a spec like `provider/id:xhigh` into its model spec + trailing level. */
function splitSpec(spec: string): { modelSpec: string; effort?: string } {
  const cut = spec.lastIndexOf(":");
  if (cut > 0 && THINKING_LEVELS[spec.slice(cut + 1)])
    return { modelSpec: spec.slice(0, cut), effort: spec.slice(cut + 1) };
  return { modelSpec: spec };
}

/** Resolve a role's raw spec, following `@alias` chains through `modelRoles`. */
function roleSpec(role: string, config: OmpConfig): string | undefined {
  let spec = config.modelRoles[role] ?? config.agentModelOverrides[role];
  let depth = 0;
  while (spec?.startsWith("@") && depth < 5) {
    const next = config.modelRoles[spec.slice(1)];
    if (!next) break;
    spec = next;
    depth += 1;
  }
  return spec;
}

export default function ompRemoteBridge(pi: ExtensionAPI): void {
  pi.setLabel("omp-remote");
  const ompConfig = readOmpConfig();
  const mediaEmitted = new Map<string, number>(); // msgId → images already sent
  let bridge: SessionBridge | undefined;
  const diagnostic = bridgeLoggerDiagnostic(pi.logger);
  // The IPC token (the per-install ipc-token file), read once per load. If it
  // is unavailable the session runs without the bridge.
  const ipcToken = resolveIpcToken(process.env, {
    onAclFailure: () =>
      diagnostic({
        event: "bridge_operation_failed",
        code: "ipc-token-acl-failed",
      }),
  }).catch(() => {
    diagnostic({
      event: "bridge_operation_failed",
      code: "ipc-token-unavailable",
    });
    return undefined;
  });
  // The first non-empty session name omp reports, pinned per session so the
  // phone keeps a stable title even as omp re-titles the session mid-run. It
  // stays `""` until omp assigns a name, so the phone never pins the cwd
  // fallback the way it would if we sent basename early.
  let pinnedTitle: string | undefined;
  const currentTitle = (): string => {
    pinnedTitle = firstTitle(pinnedTitle, pi.getSessionName());
    return pinnedTitle ?? "";
  };

  const guard =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A): void => {
      try {
        fn(...a);
      } catch {
        diagnostic({
          event: "bridge_operation_failed",
          code: "callback-failed",
        });
      }
    };

  // Role aliases probed for the catalog; only those that resolve to a model are
  // surfaced, so a role without a configured model never appears.
  const KNOWN_ROLES = [
    "default",
    "task",
    "scout",
    "sonic",
    "reviewer",
    "security-reviewer",
    "heavy",
    "design",
    "slow",
    "fast",
    "oracle",
    "plan",
  ];
  let lastCatalogKey: string | undefined;

  const publishState = guard((ctx: ExtensionContext) => {
    if (!bridge) return;
    const family = fastFamily(pi, ctx);
    const tiers = pi.getServiceTiers();
    const usage = ctx.getContextUsage();
    bridge.emitState({
      model: ctx.models.current()?.id ?? "unknown",
      thinkingLevel: pi.getThinkingLevel(),
      contextPct: usage?.percent,
      contextTokens: usage?.tokens,
      contextWindow: usage?.contextWindow,
      streaming: !ctx.isIdle(),
      title: currentTitle(),
      fastMode: family ? tiers[family] === "priority" : undefined,
    });
  });

  /** Publish the async-job snapshot; returns how many jobs are still running
   *  (0 when there is no bridge or omp reports no snapshot). */
  const emitJobs = (ctx: ExtensionContext): number => {
    if (!bridge) return 0;
    const snap = ctx.getAsyncJobSnapshot();
    if (!snap) return 0;
    bridge.emitJobs({
      running: snap.running.map((job) => ({
        id: job.id,
        type: job.type,
        label: job.label,
        status: job.status,
        startMs: job.startTime,
      })),
      recent: snap.recent.length,
    });
    return snap.running.length;
  };
  const publishJobs = guard((ctx: ExtensionContext) => {
    emitJobs(ctx);
  });

  // The selectable-model snapshot for the phone's picker: every authenticated
  // model (grouped client-side by provider) plus the role aliases that resolve,
  // with the current model/effort tagged. Throttled to changes unless forced.
  const buildRoles = (ctx: ExtensionContext): CatalogRole[] => {
    const names = new Set<string>([
      ...Object.keys(ompConfig.modelRoles),
      ...Object.keys(ompConfig.agentModelOverrides),
    ]);
    if (names.size === 0)
      return KNOWN_ROLES.flatMap((role) => {
        const m = ctx.models.resolve(`@${role}`);
        return m
          ? [
              {
                role,
                modelId: `${m.provider}/${m.id}`,
                modelName: m.name,
                provider: m.provider,
              },
            ]
          : [];
      });
    const out: CatalogRole[] = [];
    for (const role of names) {
      const spec = roleSpec(role, ompConfig);
      if (!spec) continue;
      const { modelSpec, effort } = splitSpec(spec);
      const m = ctx.models.resolve(modelSpec);
      if (!m) continue;
      out.push({
        role,
        modelId: `${m.provider}/${m.id}`,
        modelName: m.name,
        provider: m.provider,
        effort,
      });
    }
    return out;
  };

  const publishCatalog = guard((ctx: ExtensionContext, force = false) => {
    if (!bridge) return;
    const current = ctx.models.current();
    const currentId = current ? `${current.provider}/${current.id}` : undefined;
    const currentEffort = pi.getThinkingLevel();
    const configured =
      ompConfig.enabledModels.length > 0 ||
      Object.keys(ompConfig.modelRoles).length > 0 ||
      Object.keys(ompConfig.agentModelOverrides).length > 0;
    const enabledSet =
      ompConfig.enabledModels.length > 0
        ? new Set(ompConfig.enabledModels)
        : undefined;
    const models = ctx.models
      .list()
      .filter((m) => !enabledSet || enabledSet.has(`${m.provider}/${m.id}`))
      .map((m) => ({
        id: `${m.provider}/${m.id}`,
        name: m.name ?? m.id,
        provider: m.provider,
        efforts: [...(m.thinking?.efforts ?? [])],
        acceptsImages: m.input?.includes("image") ?? false,
      }));
    const roles = buildRoles(ctx);
    // Key on set sizes too, so a late-populated list re-emits even when the
    // current model/effort has not changed.
    const key = `${currentId ?? ""}|${currentEffort ?? ""}|${models.length}|${roles.length}|${configured}`;
    if (!force && key === lastCatalogKey) return;
    lastCatalogKey = key;
    bridge.emitCatalog({ models, roles, currentId, currentEffort, configured });
  });

  // Wire the model / thinking / compact / close controls a phone can send.
  // `afterChange` re-publishes whatever the mode surfaces (state + catalog on the
  // IPC feed, catalog only on the collab prompt-control path) once a change lands.
  const wireControls = (
    next: SessionBridge,
    ctx: ExtensionContext,
    afterChange: () => void,
  ): void => {
    next.onSetModel((spec) => {
      void (async () => {
        try {
          const model = ctx.models.resolve(spec);
          if (!model) return;
          await pi.setModel(model);
          afterChange();
        } catch {
          diagnostic({
            event: "bridge_operation_failed",
            code: "callback-failed",
          });
        }
      })();
    });
    next.onSetThinkingLevel(
      guard((level) => {
        if (!THINKING_LEVELS[level]) return;
        // Validated against THINKING_LEVELS above; the extension API types the
        // argument as its ThinkingLevel union.
        pi.setThinkingLevel(
          level as unknown as Parameters<typeof pi.setThinkingLevel>[0],
        );
        afterChange();
      }),
    );
    wireCompact(next, (instructions) => ctx.compact(instructions), diagnostic);
    next.onCloseSession(guard(() => ctx.shutdown()));
  };

  // A per-session chunked-upload assembler plus the prompt handler that resolves
  // a message's attachment ids into model image content. A missing id refuses the
  // send rather than dropping the image silently.
  const wirePromptAndResources = (
    next: SessionBridge,
    ctx: ExtensionContext,
  ): void => {
    const assembler = new ResourceAssembler({
      onProgress: (transferId, received) =>
        next.emitResourceProgress(transferId, received),
      onReady: (transferId, resourceId) =>
        next.emitResourceReady(transferId, resourceId),
      onError: (transferId, code) => next.emitResourceError(transferId, code),
    });
    next.onResourceInit((frame) => assembler.init(frame));
    next.onResourceChunk((frame) => assembler.chunk(frame));
    next.onResourceAbort((transferId) => assembler.abort(transferId));
    next.onPrompt(
      guard((text, mode, attachments) => {
        const ids = attachments ?? [];
        const resolved =
          ids.length > 0
            ? assembler.resolve(ids)
            : { ok: true as const, resources: [] as AssembledResource[] };
        if (!resolved.ok) {
          diagnostic({
            event: "bridge_operation_failed",
            code: "attachment-unresolved",
          });
          return;
        }
        const route = deliverPrompt(pi, ctx, text, mode, resolved.resources);
        for (const id of ids) assembler.release(id);
        next.reportPromptDispatch(mode, route);
      }),
    );
  };

  // omp keeps one extension instance across `/new`, `/fork` and `/resume`, which
  // swap the session under it and emit `session_switch` (not `session_start`).
  // The bridge is keyed on the session id, so each switch re-keys it: `bye` on
  // the old id, then `hello` with fresh meta. `generation` lets a later attach
  // or a shutdown supersede an attach still awaiting its token or connect.
  let attachedId: string | undefined;
  let generation = 0;
  const detach = (): void => {
    generation++;
    bridge?.stop();
    bridge = undefined;
  };
  const attach = async (
    ctx: ExtensionContext,
    role: "prompt-control" | undefined,
    wire: (next: SessionBridge) => void,
    publish: () => void,
  ): Promise<void> => {
    detach();
    const current = generation;
    pinnedTitle = undefined;
    lastCatalogKey = undefined;
    mediaEmitted.clear();
    attachedId = ctx.sessionManager.getSessionId();
    const token = await ipcToken;
    if (token === undefined || current !== generation) return;
    const next = new SessionBridge({
      token,
      path: ipcPath(),
      meta: sessionMeta(ctx, currentTitle()),
      role,
      diagnostic,
    });
    bridge = next;
    wire(next);
    await next.start();
    if (current === generation) publish();
  };
  // True when omp now runs a session other than the one the bridge announced:
  // a `session_switch` to a new id, or a switch omp rolled back after emitting it.
  const switched = (ctx: ExtensionContext): boolean =>
    ctx.sessionManager.getSessionId() !== attachedId;
  // Re-attach from a synchronous event handler: a failure is logged, never
  // left as an unhandled rejection that could take down the omp session.
  const reattach = (
    run: (ctx: ExtensionContext) => Promise<void>,
    ctx: ExtensionContext,
  ): void => {
    run(ctx).catch(() =>
      diagnostic({ event: "bridge_operation_failed", code: "callback-failed" }),
    );
  };

  if (process.env.OMP_REMOTE_MODE === "collab") {
    diagnostic({
      event: "bridge_mode_selected",
      mode: "collab-prompt-control",
    });
    // Collab owns the transcript, but it carries no async-job snapshot: publish
    // it here, and poll while jobs run so the phone sees them finish between
    // turns. The contained timer is cleared once nothing runs, on a re-attach,
    // and on shutdown.
    let jobsPoll: { ctx: ExtensionContext; timer: Timer } | undefined;
    const stopJobsPoll = (): void => {
      jobsPoll?.ctx.clearTimer(jobsPoll.timer);
      jobsPoll = undefined;
    };
    const trackJobs = guard((ctx: ExtensionContext) => {
      if (emitJobs(ctx) === 0) stopJobsPoll();
      else if (!jobsPoll)
        jobsPoll = {
          ctx,
          timer: ctx.setInterval(() => trackJobs(ctx), JOBS_POLL_MS),
        };
    });
    const attachCollab = (ctx: ExtensionContext): Promise<void> => {
      stopJobsPoll();
      return attach(
        ctx,
        "prompt-control",
        (next) => {
          wirePromptAndResources(next, ctx);
          wireControls(next, ctx, () => publishCatalog(ctx));
        },
        () => {
          publishCatalog(ctx, true);
          trackJobs(ctx);
        },
      );
    };
    pi.on("session_start", (_e, ctx) => attachCollab(ctx));
    pi.on("session_switch", async (_e, ctx) => {
      if (switched(ctx)) await attachCollab(ctx);
    });
    pi.on(
      "agent_start",
      guard((_event: unknown, ctx: ExtensionContext) => {
        if (switched(ctx)) reattach(attachCollab, ctx);
        bridge?.reportModelExecutionStarted();
        publishCatalog(ctx);
        trackJobs(ctx);
      }),
    );
    pi.on("turn_end", (_event: unknown, ctx) => trackJobs(ctx));
    pi.on("agent_end", (_event: unknown, ctx) => trackJobs(ctx));
    pi.on(
      "session_shutdown",
      guard(() => {
        stopJobsPoll();
        detach();
      }),
    );
    return;
  }

  const approvalGate = parseApprovalGate(process.env.OMP_REMOTE_APPROVAL);
  diagnostic({ event: "bridge_mode_selected", mode: "ipc-feed" });

  const attachFeed = (ctx: ExtensionContext): Promise<void> =>
    attach(
      ctx,
      undefined,
      (next) => {
        wirePromptAndResources(next, ctx);
        next.onInterrupt(guard(() => ctx.abort()));
        next.onServiceTier(
          guard((enabled) => {
            const family = fastFamily(pi, ctx);
            if (!family) {
              diagnostic({
                event: "bridge_operation_failed",
                code: "service-tier-unsupported",
              });
              return;
            }
            pi.setServiceTier(family, enabled ? "priority" : undefined);
            publishState(ctx);
          }),
        );
        wireControls(next, ctx, () => {
          publishState(ctx);
          publishCatalog(ctx);
        });
      },
      () => {
        publishState(ctx);
        publishCatalog(ctx, true);
      },
    );
  pi.on("session_start", (_e, ctx) => attachFeed(ctx));
  pi.on("session_switch", async (_e, ctx) => {
    if (switched(ctx)) await attachFeed(ctx);
  });

  // Shadow the built-in `ask`: when the agent asks the user something, race the desk
  // terminal (native `ask` via `ctx.invokeTool`) against the phone (a sealed `interaction`
  // frame). First answer wins; an unanswered question blocks the tool indefinitely —
  // exactly what lets a phone answer hours later. Registering it never removes local
  // answering, so a desk user is unaffected.
  const shadowAsk: ToolDefinition = {
    name: "ask",
    label: "Ask",
    description:
      "Ask the user one or more questions and wait for their answer. Use whenever you need a decision or clarification.",
    parameters: ASK_PARAMETERS,
    approval: "read",
    loadMode: "essential",
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const active = bridge;
      const questions = normalizeAskQuestions(params);
      const native = ctx.invokeTool?.bind(ctx);
      // omp has validated `params` against ASK_PARAMETERS (an object), so it is a record;
      // forwarded verbatim to the native tool for the desk dialog.
      const record = params as Record<string, unknown>;
      return runShadowAsk({
        id: `ask-${randomUUID()}`,
        questions,
        raiser: active && questions.length > 0 ? active : undefined,
        invokeLocal: native
          ? (childSignal) => native(record, { signal: childSignal })
          : undefined,
        fromRemote: (answers) => ({
          content: [{ type: "text" as const, text: answers.join("\n") }],
        }),
        signal,
      });
    },
  };
  pi.registerTool(shadowAsk);

  // Opt-in remote approval: intercept a tool BEFORE it runs and gate it on a phone
  // answer. Our own bug must never wedge every tool, so any failure allows (the desk's
  // native approval mode still applies). Off by default — no behaviour change unless
  // OMP_REMOTE_APPROVAL is set.
  pi.on("tool_call", async (event) => {
    try {
      if (!shouldGate(approvalGate, event.toolName)) return undefined;
      const decision = await runToolApproval({
        id: `approval-${randomUUID()}`,
        tool: event.toolName,
        input: event.input,
        raiser: bridge,
      });
      if (!decision.block) return undefined;
      return decision.reason !== undefined
        ? { block: true, reason: decision.reason }
        : { block: true };
    } catch {
      diagnostic({
        event: "bridge_operation_failed",
        code: "approval-failed",
      });
      return undefined;
    }
  });

  pi.on(
    "message_update",
    guard((event: unknown) => {
      const ev = event as {
        id?: string;
        message?: { role?: string; content?: unknown };
      };
      bridge?.emitMsg({
        phase: "update",
        msgId: ev.id ?? "m",
        role: ev.message?.role ?? "assistant",
        text: textOf(ev.message?.content),
      });
      const msgId = ev.id ?? "m";
      const images = imagesOf(ev.message?.content);
      if (images.length > 0) {
        const already = mediaEmitted.get(msgId) ?? 0;
        for (let i = already; i < images.length; i++) {
          const image = images[i];
          if (!image) continue;
          const mediaId = `${msgId}:${i}`;
          const result = chunkImage(mediaId, msgId, image);
          if (result.ok) {
            bridge?.emitMediaInit(result.init);
            for (const chunk of result.chunks) bridge?.emitMediaChunk(chunk);
          } else {
            bridge?.emitMediaError(mediaId, result.code);
          }
        }
        mediaEmitted.set(msgId, images.length);
      }
    }),
  );

  pi.on(
    "tool_execution_start",
    guard((event: unknown) => {
      const ev = event as { toolCallId?: string; toolName?: string };
      if (ev.toolName === "ask") return;
      bridge?.emitTool({
        phase: "start",
        callId: ev.toolCallId ?? "c",
        name: ev.toolName ?? "tool",
        status: "running",
        preview: "",
      });
    }),
  );
  pi.on(
    "tool_execution_end",
    guard((event: unknown) => {
      const ev = event as { toolCallId?: string; toolName?: string };
      if (ev.toolName === "ask") return;
      bridge?.emitTool({
        phase: "end",
        callId: ev.toolCallId ?? "c",
        name: ev.toolName ?? "tool",
        status: "done",
        preview: "",
      });
    }),
  );

  // "Needs input" attention (spec §4.3/§12): the agent loop settled idle awaiting
  // the user, or a tool is blocked on approval. Emitting an attention frame drives
  // the phone badge (sealed) and a sealed push notice (via the host-agent uplink).
  // `willContinue` guards against pinging mid auto-retry/continuation.
  pi.on(
    "agent_start",
    guard((_event: unknown, ctx) => {
      if (switched(ctx)) reattach(attachFeed, ctx);
      bridge?.reportModelExecutionStarted();
      publishState(ctx);
      publishJobs(ctx);
      publishCatalog(ctx);
    }),
  );
  pi.on("turn_start", (_event: unknown, ctx) => {
    publishState(ctx);
    publishJobs(ctx);
    publishCatalog(ctx);
  });
  pi.on("turn_end", (_event: unknown, ctx) => {
    publishState(ctx);
    publishJobs(ctx);
    publishCatalog(ctx);
  });

  pi.on(
    "agent_end",
    guard((event: unknown, ctx) => {
      const ev = event as { willContinue?: boolean };
      publishState(ctx);
      publishJobs(ctx);
      if (!ev.willContinue) bridge?.emitAttention("idle");
    }),
  );
  pi.on(
    "tool_approval_requested",
    guard(() => {
      bridge?.emitAttention("approval");
    }),
  );

  pi.on("session_shutdown", guard(detach));
}
