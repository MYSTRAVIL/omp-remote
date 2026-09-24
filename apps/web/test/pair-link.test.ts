import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { hostCommitment, newIdentity, pairingSas } from "@omp-remote/crypto";
import { claimPairing, takePairLinkCode } from "../src/core/pair";

// Register a DOM only for this file (its `location` and `history`) and tear
// it down after, so happy-dom's globals never leak into the other suites.
beforeAll(() =>
  GlobalRegistrator.register({ url: "https://relay.test/app?tab=1" }),
);
afterAll(() => GlobalRegistrator.unregister());

/** Open `href` in this tab, as tapping a link or scanning a QR code does. */
function open(href: string): void {
  history.pushState(null, "", href);
}

test("a pairing link's code comes off the address in place, before any request", () => {
  const requests: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    open("https://relay.test/app?tab=1#pair=ABCD-2345-EFGH");
    const entries = history.length;
    expect(takePairLinkCode(location, history)).toBe("ABCD-2345-EFGH");
    // Replaced, not pushed: Back never returns to the code either.
    expect(location.href).toBe("https://relay.test/app?tab=1");
    expect(history.length).toBe(entries);
    expect(requests).toEqual([]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an address without a pairing link is left alone", () => {
  open("https://relay.test/app#settings");
  expect(takePairLinkCode(location, history)).toBeUndefined();
  expect(location.href).toBe("https://relay.test/app#settings");
  // An empty or malformed code is dropped from the address all the same.
  open("https://relay.test/app#pair=%E0%A4%A");
  expect(takePairLinkCode(location, history)).toBeUndefined();
  expect(location.href).toBe("https://relay.test/app");
});

test("the link's code, percent-encoded or not, is the one the host committed to: claiming yields its SAS", async () => {
  open("https://relay.test/#pair=ABCD%2D2345");
  const code = takePairLinkCode(location, history);
  expect(code).toBe("ABCD-2345");
  if (code === undefined) throw new Error("no code");
  const host = await newIdentity();
  const blob = new Map<string, string>();
  let phonePub = "";
  const paired = await claimPairing(
    {
      baseUrl: "https://relay.test",
      token: "sess.tok",
      getItem: (k) => blob.get(k) ?? null,
      setItem: (k, v) => {
        blob.set(k, v);
      },
      // The host answers the claim with a MAC committed under the typed code.
      fetch: (async (_input: string, init?: RequestInit) => {
        phonePub = String(JSON.parse(String(init?.body)).phonePub);
        const { mac: hostMac } = await hostCommitment(
          "ABCD-2345",
          "m1",
          host.publicKey,
        );
        return new Response(
          JSON.stringify({ machineId: "m1", hostPub: host.publicKey, hostMac }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    },
    code,
  );
  expect(paired.machineId).toBe("m1");
  // The SAS the host shows for the typed code: the operator's eyeball check.
  expect(paired.sas).toBe(
    await pairingSas("ABCD-2345", "m1", host.publicKey, phonePub),
  );
});
