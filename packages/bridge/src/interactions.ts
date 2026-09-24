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

/**
 * Gate a tool call on remote approval. Remote-only by design: the desk keeps omp's own
 * approval mode, so this adds a phone-answerable gate on top (opt-in per session). With
 * no client it does not gate. A cancelled/aborted request blocks — consent was never
 * given (fail-closed). Note omp bounds a `tool_call` handler by its own timeout, so an
 * unanswered approval fails closed there too; questions (a tool `execute`) are unbounded.
 */
export async function runToolApproval(deps: {
  id: string;
  tool: string;
  reason?: string;
  input?: unknown;
  choices?: string[];
  raiser?: InteractionRaiser;
  signal?: AbortSignal;
}): Promise<{ block: boolean; reason?: string }> {
  const { id, tool, reason, input, choices, raiser, signal } = deps;
  if (!raiser) return { block: false };
  const payload: InteractionPayload = {
    kind: "approval",
    tool,
    choices: choices ?? ["Approve", "Deny"],
    ...(reason !== undefined ? { reason } : {}),
    ...(input !== undefined ? { input } : {}),
  };
  const response = await raiser.raiseInteraction(id, payload, signal);
  if (response?.kind !== "approval") {
    return { block: true, reason: `omp-remote: ${tool} not approved` };
  }
  return response.decision === "deny"
    ? { block: true, reason: `omp-remote: ${tool} denied by user` }
    : { block: false };
}
