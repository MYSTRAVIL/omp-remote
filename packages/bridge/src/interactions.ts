import type {
  InteractionPayload,
  InteractionQuestion,
  InteractionResponse,
} from "@omp-remote/protocol";

/**
 * The transport seam the interaction flows need: raise a request to the client and
 * await the reply. Resolves `undefined` when the request is cancelled/aborted (e.g.
 * the local side answered first, or the turn was aborted) rather than answered.
 * `SessionBridge` implements it; tests supply a fake.
 */
export interface InteractionRaiser {
  raiseInteraction(
    id: string,
    payload: InteractionPayload,
    signal?: AbortSignal,
  ): Promise<InteractionResponse | undefined>;
}

/**
 * Run a shadowed `ask`: race a local answerer (the desk terminal, via the native
 * `ask` tool) against the remote client (the phone). The first real answer wins and
 * the loser is aborted — mirroring omp's own collab UI delegation, so answering at
 * the desk still works while the session is also reachable from the phone. Remote-only
 * when there is no local answerer; local-only when there is no client. The outer
 * `signal` (turn abort) rejects both.
 *
 * Generic over the tool-result type `T` so this module stays decoupled from omp's
 * `AgentToolResult`: the caller supplies `invokeLocal` (native result) and `fromRemote`
 * (build the same result shape from the phone's answers).
 */
export function runShadowAsk<T>(deps: {
  id: string;
  questions: InteractionQuestion[];
  raiser?: InteractionRaiser;
  invokeLocal?: (signal: AbortSignal) => Promise<T>;
  fromRemote: (answers: string[]) => T;
  signal?: AbortSignal;
}): Promise<T> {
  const { id, questions, raiser, invokeLocal, fromRemote, signal } = deps;
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const local = new AbortController();
  const remote = new AbortController();
  let settled = false;

  const finishOuter = (): void => {
    if (settled) return;
    settled = true;
    local.abort();
    remote.abort();
    reject(new Error("omp-remote: ask aborted"));
  };
  if (signal?.aborted) {
    finishOuter();
    return promise;
  }
  signal?.addEventListener("abort", finishOuter, { once: true });

  const win = (result: T, loser: AbortController): void => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", finishOuter);
    loser.abort();
    resolve(result);
  };

  if (invokeLocal) {
    invokeLocal(local.signal).then(
      (result) => win(result, remote),
      () => {
        // Local aborted (remote won) or failed: let the remote answer stand.
      },
    );
  }
  if (raiser) {
    raiser.raiseInteraction(id, { kind: "ask", questions }, remote.signal).then(
      (response) => {
        if (response?.kind === "ask") win(fromRemote(response.answers), local);
      },
      () => {
        // Remote cancelled/failed: let the local answer stand.
      },
    );
  }
  if (!invokeLocal && !raiser) {
    reject(new Error("omp-remote: ask has no local or remote answerer"));
  }
  return promise;
}

/** A gated tool call's outcome: `block` stops it, and `reason` tells the model why. */
export interface ApprovalDecision {
  block: boolean;
  reason?: string;
}

/**
 * Gate a tool call on the user's approval, asked on the phone (`raiser`) and,
 * with `askLocal`, at the terminal at once: the first answer wins and the other
 * prompt is withdrawn, as in {@link runShadowAsk}. A cancel at the terminal
 * denies. Consent is never assumed: a prompt that ends unanswered (aborted, the
 * bridge stopped, the dialog failed) leaves the decision to the other side, and
 * the call is blocked once neither can answer or `signal` aborts. With neither
 * to begin with (a `task` subagent has no terminal and no phone path) it does
 * not gate: approving the `task` call covered it, as omp's own approval does.
 *
 * `askLocal` is for a session whose own omp approval is off, so this gate is
 * its only one; without it the gate is a phone prompt on top of omp's approval
 * mode. omp bounds a `tool_call` handler by `extensionHandlers.toolCallTimeoutMs`
 * (30 s by default) and blocks the call when it runs out, but pauses that
 * budget while the handler awaits a `ctx.ui` dialog: with the terminal asked,
 * an approval waits as long as the user takes; a phone-only one still fails
 * closed at the timeout. Questions (a tool `execute`) are unbounded.
 */
export function runToolApproval(deps: {
  id: string;
  tool: string;
  reason?: string;
  input?: unknown;
  choices?: string[];
  raiser?: InteractionRaiser;
  /** Ask at the terminal: resolves true to approve, false to deny. */
  askLocal?: (signal: AbortSignal) => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<ApprovalDecision> {
  const { id, tool, reason, input, choices, raiser, askLocal, signal } = deps;
  const allowed: ApprovalDecision = { block: false };
  const denied: ApprovalDecision = {
    block: true,
    reason: `omp-remote: ${tool} denied by user`,
  };
  const unanswered: ApprovalDecision = {
    block: true,
    reason: `omp-remote: ${tool} not approved`,
  };
  if (!raiser && !askLocal) return Promise.resolve(allowed);
  if (signal?.aborted) return Promise.resolve(unanswered);
  const { promise, resolve } = Promise.withResolvers<ApprovalDecision>();
  const local = new AbortController();
  const remote = new AbortController();
  let settled = false;
  // The sides that can still answer.
  let open = (askLocal ? 1 : 0) + (raiser ? 1 : 0);
  const onAbort = (): void => settle(unanswered);
  const settle = (decision: ApprovalDecision): void => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", onAbort);
    local.abort();
    remote.abort();
    resolve(decision);
  };
  const lost = (): void => {
    open -= 1;
    if (open === 0) settle(unanswered);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  askLocal?.(local.signal).then(
    (approved) => settle(approved ? allowed : denied),
    lost,
  );
  if (raiser) {
    const payload: InteractionPayload = {
      kind: "approval",
      tool,
      choices: choices ?? ["Approve", "Deny"],
      ...(reason !== undefined ? { reason } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(askLocal ? { terminal: true as const } : {}),
    };
    raiser.raiseInteraction(id, payload, remote.signal).then((response) => {
      if (response?.kind !== "approval") lost();
      else settle(response.decision === "deny" ? denied : allowed);
    }, lost);
  }
  return promise;
}
