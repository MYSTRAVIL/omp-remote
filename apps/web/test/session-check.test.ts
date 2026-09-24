import { expect, test } from "bun:test";
import { checkSession } from "../src/core/session-check";

/** A `fetch` that answers every request with `status` and records the request. */
function answering(status: number): {
  fetch: typeof fetch;
  seen: { url: string; authorization: string | null }[];
} {
  const seen: { url: string; authorization: string | null }[] = [];
  const fake = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    seen.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(null, { status });
  };
  return { fetch: fake as typeof fetch, seen };
}

test("asks /auth/session with the token as a bearer", async () => {
  const deps = answering(204);
  expect(
    await checkSession({ baseUrl: "https://relay.test", ...deps }, "tok"),
  ).toBe("valid");
  expect(deps.seen).toEqual([
    { url: "https://relay.test/auth/session", authorization: "Bearer tok" },
  ]);
});

test("only a 401 is a refusal", async () => {
  expect(await checkSession({ baseUrl: "", ...answering(401) }, "tok")).toBe(
    "invalid",
  );
});

test("an aggregator without the route, or a failing one, gives no answer", async () => {
  // 404: an aggregator that predates the route, or runs without sign-in.
  for (const status of [404, 405, 500, 502])
    expect(
      await checkSession({ baseUrl: "", ...answering(status) }, "tok"),
    ).toBe("unknown");
});

test("a network error gives no answer", async () => {
  const failing = (async () => {
    throw new TypeError("network down");
  }) as unknown as typeof fetch; // test double for the fetch signature
  expect(await checkSession({ baseUrl: "", fetch: failing }, "tok")).toBe(
    "unknown",
  );
});
