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

/** omp's terminal dialog: open until answered, or until its signal aborts
 *  (then it resolves as a cancel, as omp's `select` resolves nothing). */
function terminal() {
  const answer = Promise.withResolvers<boolean>();
  let signal: AbortSignal | undefined;
  return {
    askLocal: (s: AbortSignal): Promise<boolean> => {
      signal = s;
      s.addEventListener("abort", () => answer.resolve(false), { once: true });
      return answer.promise;
    },
    answer: answer.resolve,
    closed: (): boolean => signal?.aborted === true,
  };
}

test("tool approval takes the terminal's answer and withdraws the phone's prompt", async () => {
  const raiser = new FakeRaiser(undefined, { never: true });
  const desk = terminal();
  const pending = runToolApproval({
    id: "a4",
    tool: "bash",
    raiser,
    askLocal: desk.askLocal,
  });
  desk.answer(true);
  expect(await pending).toEqual({ block: false });
  expect(raiser.aborted).toBe(true);
});

test("tool approval takes the phone's answer and closes the terminal dialog", async () => {
  const raiser = new FakeRaiser({ kind: "approval", decision: "deny" });
  const desk = terminal();
  const decision = await runToolApproval({
    id: "a5",
    tool: "bash",
    raiser,
    askLocal: desk.askLocal,
  });
  expect(decision).toEqual({
    block: true,
    reason: "omp-remote: bash denied by user",
  });
  expect(desk.closed()).toBe(true);
});

test("a cancel at the terminal denies the call", async () => {
  const raiser = new FakeRaiser(undefined, { never: true });
  const decision = await runToolApproval({
    id: "a6",
    tool: "bash",
    raiser,
    askLocal: () => Promise.resolve(false),
  });
  expect(decision.block).toBe(true);
  expect(raiser.aborted).toBe(true);
});

test("a phone prompt that ends unanswered leaves the call to the terminal", async () => {
  // The bridge stopped: the phone's prompt resolves with no answer.
  const raiser = new FakeRaiser(undefined);
  const desk = terminal();
  const pending = runToolApproval({
    id: "a7",
    tool: "bash",
    raiser,
    askLocal: desk.askLocal,
  });
  // The phone's settled prompt is handled before this continuation runs.
  await Promise.resolve();
  desk.answer(true);
  expect(await pending).toEqual({ block: false });
});

test("tool approval blocks once neither side can answer, or when the call aborts", async () => {
  const failed = await runToolApproval({
    id: "a8",
    tool: "bash",
    raiser: new FakeRaiser(undefined),
    askLocal: () => Promise.reject(new Error("no dialog")),
  });
  expect(failed).toEqual({
    block: true,
    reason: "omp-remote: bash not approved",
  });

  const controller = new AbortController();
  const raiser = new FakeRaiser(undefined, { never: true });
  const desk = terminal();
  const aborted = runToolApproval({
    id: "a9",
    tool: "bash",
    raiser,
    askLocal: desk.askLocal,
    signal: controller.signal,
  });
  controller.abort();
  expect((await aborted).block).toBe(true);
  expect(raiser.aborted).toBe(true);
  expect(desk.closed()).toBe(true);
});
