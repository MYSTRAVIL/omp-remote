import { normalizePromptText } from "@omp-remote/protocol";

/** Most prompts a session may hold not yet taken in before the oldest is forgotten. */
const MAX_OUTSTANDING = 64;

/**
 * The phone prompts the host-agent handed to a session's omp that have not
 * come back as a user message yet, oldest first, keyed by the phone's
 * `clientId`. omp gives a prompt no id, so the user message it becomes is
 * matched by its text (`normalizePromptText`), oldest first: the match names
 * the prompt on that message (`MsgFrame.clientId`), and a replay lists the
 * rest (`ReplayEndFrame.queued`).
 */
export class PromptTracker {
  /** sessionId → clientId → normalized text, in the order they were sent. */
  readonly #sessions = new Map<string, Map<string, string>>();

  /** `clientId`'s prompt reached `sessionId`'s omp. */
  delivered(sessionId: string, clientId: string, text: string): void {
    let prompts = this.#sessions.get(sessionId);
    if (!prompts) {
      prompts = new Map();
      this.#sessions.set(sessionId, prompts);
    }
    prompts.set(clientId, normalizePromptText(text));
    if (prompts.size > MAX_OUTSTANDING) {
      const oldest = prompts.keys().next().value;
      if (oldest !== undefined) prompts.delete(oldest);
    }
  }

  /** The prompt a new user message of `sessionId` is, taken off the list, or
   *  undefined when none has its text (a message typed at the desk). */
  claim(sessionId: string, text: string): string | undefined {
    const prompts = this.#sessions.get(sessionId);
    if (!prompts) return undefined;
    const wanted = normalizePromptText(text);
    for (const [clientId, sent] of prompts) {
      if (sent !== wanted) continue;
      prompts.delete(clientId);
      return clientId;
    }
    return undefined;
  }

  /** `clientId`'s prompt will never be taken in: the bridge refused it. */
  refused(sessionId: string, clientId: string): void {
    this.#sessions.get(sessionId)?.delete(clientId);
  }

  /** Every prompt still waiting to be taken in, in any session. */
  queued(): string[] {
    return [...this.#sessions.values()].flatMap((prompts) => [
      ...prompts.keys(),
    ]);
  }

  /** Forget `sessionId`'s prompts: the omp holding them is gone. */
  drop(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }
}
