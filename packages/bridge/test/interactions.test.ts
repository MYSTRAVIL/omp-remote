import { expect, test } from "bun:test";
import type {
  InteractionPayload,
  InteractionResponse,
} from "@omp-remote/protocol";
import {
  type InteractionRaiser,
  runShadowAsk,
  runToolApproval,
} from "../src/interactions";

/** A fake client: answers with a preset response, or never (until aborted). */
class FakeRaiser implements InteractionRaiser {
  readonly raised: { id: string; payload: InteractionPayload }[] = [];
  aborted = false;
  readonly #response: InteractionResponse | undefined;
  readonly #never: boolean;

  constructor(
    response: InteractionResponse | undefined,
    opts: { never?: boolean } = {},
  ) {
    this.#response = response;
    this.#never = opts.never ?? false;
  }

  raiseInteraction(
    id: string,
    payload: InteractionPayload,
    signal?: AbortSignal,
  ): Promise<InteractionResponse | undefined> {
    this.raised.push({ id, payload });
    if (!this.#never) return Promise.resolve(this.#response);
    const { promise, resolve } = Promise.withResolvers<
      InteractionResponse | undefined
    >();
    signal?.addEventListener(
      "abort",
      () => {
        this.aborted = true;
        resolve(undefined);
      },
      { once: true },
    );
    return promise;
  }
}

test("shadow ask returns the phone answer when only the client answers", async () => {
  const raiser = new FakeRaiser({ kind: "ask", answers: ["B"] });
  const result = await runShadowAsk({
    id: "i1",
    questions: [{ question: "Pick a letter" }],
    raiser,
    fromRemote: (answers) => ({ text: answers.join(",") }),
  });
  expect(result).toEqual({ text: "B" });
  expect(raiser.raised[0]?.payload).toMatchObject({ kind: "ask" });
});

test("shadow ask returns the desk answer and aborts the phone when local wins", async () => {
  const raiser = new FakeRaiser(undefined, { never: true });
  const result = await runShadowAsk({
    id: "i2",
    questions: [{ question: "Q" }],
    raiser,
    invokeLocal: () => Promise.resolve({ text: "desk" }),
    fromRemote: (answers) => ({ text: answers.join(",") }),
  });
  expect(result).toEqual({ text: "desk" });
  expect(raiser.aborted).toBe(true);
});

test("shadow ask rejects when the turn is aborted", async () => {
  const controller = new AbortController();
  const raiser = new FakeRaiser(undefined, { never: true });
  const pending = runShadowAsk({
    id: "i3",
    questions: [{ question: "Q" }],
    raiser,
    fromRemote: (answers) => ({ text: answers.join(",") }),
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toThrow(/aborted/);
  expect(raiser.aborted).toBe(true);
});

test("shadow ask rejects when there is neither a local nor a remote answerer", async () => {
  await expect(
    runShadowAsk({
      id: "i4",
      questions: [{ question: "Q" }],
      fromRemote: (answers) => ({ text: answers.join(",") }),
    }),
  ).rejects.toThrow();
});

test("tool approval blocks on a deny", async () => {
  const raiser = new FakeRaiser({ kind: "approval", decision: "deny" });
  const decision = await runToolApproval({ id: "a1", tool: "bash", raiser });
  expect(decision.block).toBe(true);
});

test("tool approval allows on an allow", async () => {
  const raiser = new FakeRaiser({ kind: "approval", decision: "allow" });
  const decision = await runToolApproval({ id: "a2", tool: "bash", raiser });
  expect(decision.block).toBe(false);
});

test("tool approval does not gate when there is no client", async () => {
  const decision = await runToolApproval({ id: "a3", tool: "bash" });
  expect(decision.block).toBe(false);
});
