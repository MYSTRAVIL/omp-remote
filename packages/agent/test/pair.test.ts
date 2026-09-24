import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PairingStore,
  newIdentity,
  pairingSas,
  phoneCommitment,
} from "@omp-remote/crypto";
import { PairingBroker } from "../../../apps/aggregator/src/pairing";
import { AggregatorServer } from "../../../apps/aggregator/src/server";
import { tempMachineStore } from "../../../apps/aggregator/test/helpers/machines";
import { performPairing } from "../src/pair";

const NAME_TAKEN =
  "A machine named machine-a is already on this server. If that is this machine, revoke it under Settings > Machines on this server, then pair again. Otherwise use a different --name.";

const FIXED_CODE = "9F3K-2M7Q-8B4T-5H6N";
const BASE_URL = "http://agg.example";

function tempStorePath(): string {
  return join(tmpdir(), `omp-pair-${crypto.randomUUID()}.json`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A `fetch` stand-in that serves `/pair/host` and returns the given sequence of
 * `/pair/result` bodies, one per poll, repeating the last once exhausted. Each
 * `/pair/host` request's `Authorization` header (null: none) is pushed onto
 * `hostAuth`; `/pair/result` takes no bearer, so one sent there fails the test.
 */
function fakeFetch(
  results: unknown[],
  hostAuth: (string | null)[] = [],
): typeof fetch {
  let resultCalls = 0;
  return (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const auth = new Headers(init?.headers).get("authorization");
    if (url.endsWith("/pair/host")) {
      hostAuth.push(auth);
      return jsonResponse({ expiresAt: 123 });
    }
    if (auth !== null) throw new Error(`bearer sent to ${url}`);
    if (url.endsWith("/pair/result")) {
      const body = results[Math.min(resultCalls, results.length - 1)];
      resultCalls += 1;
      return jsonResponse(body);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

test("performPairing claims the phone, verifies its MAC and trusts it", async () => {
  const storePath = tempStorePath();
  const tokenPath = tempStorePath();
  try {
    const store = new PairingStore(storePath);
    await store.load();
    const hostPub = store.self().publicKey;

    const phone = await newIdentity();
    const phonePub = phone.publicKey;
    const { mac: phoneMac } = await phoneCommitment(FIXED_CODE, phonePub);

    const printed: string[] = [];
    const hostAuth: (string | null)[] = [];
    const result = await performPairing({
      baseUrl: BASE_URL,
      fetch: fakeFetch(
        [
          { status: "pending" },
          { status: "claimed", phonePub, phoneMac, agentToken: "agent-tok" },
        ],
        hostAuth,
      ),
      machineId: "machine-a",
      agentTokenPath: tokenPath,
      store,
      print: (line) => printed.push(line),
      newCode: () => Promise.resolve(FIXED_CODE),
      sleep: () => Promise.resolve(),
      now: () => 0,
    });

    const expectedSas = await pairingSas(
      FIXED_CODE,
      "machine-a",
      hostPub,
      phonePub,
    );
    expect(result).toEqual({
      machineId: "machine-a",
      phonePub,
      sas: expectedSas,
      agentToken: "agent-tok",
    });
    // The machine's new /agent token is stored where the caller asked.
    expect(await readFile(tokenPath, "utf8")).toBe("agent-tok");
    // A machine with no token yet registers as a new one: no bearer.
    expect(hostAuth).toEqual([null]);
    expect(printed.some((l) => l.includes(FIXED_CODE))).toBe(true);
    expect(printed.some((l) => l.includes(expectedSas))).toBe(true);

    expect(store.peers().map((p) => p.id)).toContain(phonePub);
  } finally {
    await rm(storePath, { force: true });
    await rm(tokenPath, { force: true });
  }
});

test("performPairing presents the current token only when renewing; a join never sends it", async () => {
  for (const renew of [true, false]) {
    const storePath = tempStorePath();
    const tokenPath = tempStorePath();
    const current = "A".repeat(43);
    try {
      await writeFile(tokenPath, current);
      const store = new PairingStore(storePath);
      const phone = await newIdentity();
      const { mac: phoneMac } = await phoneCommitment(
        FIXED_CODE,
        phone.publicKey,
      );
      const hostAuth: (string | null)[] = [];
      await performPairing({
        baseUrl: BASE_URL,
        fetch: fakeFetch(
          [
            {
              status: "claimed",
              phonePub: phone.publicKey,
              phoneMac,
              agentToken: "B".repeat(43),
            },
          ],
          hostAuth,
        ),
        machineId: "machine-a",
        agentTokenPath: tokenPath,
        store,
        renew,
        print: () => {},
        newCode: () => Promise.resolve(FIXED_CODE),
        sleep: () => Promise.resolve(),
        now: () => 0,
      });
      // A join may name another server, which must never see this token.
      expect(hostAuth).toEqual([renew ? `Bearer ${current}` : null]);
      expect(await readFile(tokenPath, "utf8")).toBe("B".repeat(43));
    } finally {
      await rm(storePath, { force: true });
      await rm(tokenPath, { force: true });
    }
  }
});

test("performPairing rejects and trusts nobody when the phone MAC is forged", async () => {
  const storePath = tempStorePath();
  const tokenPath = tempStorePath();
  try {
    const store = new PairingStore(storePath);
    await store.load();

    const phone = await newIdentity();
    const phonePub = phone.publicKey;
    // MAC computed under a different code — a swapped/forged commitment.
    const { mac: forgedMac } = await phoneCommitment(
      "0000-0000-0000-0000",
      phonePub,
    );

    await expect(
      performPairing({
        baseUrl: BASE_URL,
        fetch: fakeFetch([
          {
            status: "claimed",
            phonePub,
            phoneMac: forgedMac,
            agentToken: "agent-tok",
          },
        ]),
        machineId: "machine-a",
        agentTokenPath: tokenPath,
        store,
        print: () => {},
        newCode: () => Promise.resolve(FIXED_CODE),
        sleep: () => Promise.resolve(),
        now: () => 0,
      }),
    ).rejects.toThrow(/MAC verification failed/);

    expect(store.peers()).toEqual([]);
    // A pairing that failed its MAC check stores no token.
    expect(await Bun.file(tokenPath).exists()).toBe(false);
  } finally {
    await rm(storePath, { force: true });
    await rm(tokenPath, { force: true });
  }
});

test("performPairing stops at once with a rename hint when the server refuses the claim", async () => {
  const storePath = tempStorePath();
  const tokenPath = tempStorePath();
  try {
    const store = new PairingStore(storePath);
    await store.load();
    await expect(
      performPairing({
        baseUrl: BASE_URL,
        fetch: fakeFetch([
          { status: "pending" },
          { status: "refused", reason: "machine-exists" },
        ]),
        machineId: "machine-a",
        agentTokenPath: tokenPath,
        store,
        print: () => {},
        newCode: () => Promise.resolve(FIXED_CODE),
        sleep: () => Promise.resolve(),
        now: () => 0,
      }),
    ).rejects.toThrow(NAME_TAKEN);
    expect(store.peers()).toEqual([]);
    expect(await Bun.file(tokenPath).exists()).toBe(false);
  } finally {
    await rm(storePath, { force: true });
    await rm(tokenPath, { force: true });
  }
});

test("against a real server, pairing under another machine's name fails with the fix as soon as the phone's claim is refused", async () => {
  const storePath = tempStorePath();
  const tokenPath = tempStorePath();
  const machines = await tempMachineStore();
  const taken = await machines.issue("machine-a", Date.now());
  const server = new AggregatorServer({
    machines,
    port: 0,
    pairing: new PairingBroker(),
  });
  server.start();
  const http = `http://127.0.0.1:${server.boundPort}`;
  try {
    const store = new PairingStore(storePath);
    const phone = await newIdentity();
    const { rendezvousId, mac: phoneMac } = await phoneCommitment(
      FIXED_CODE,
      phone.publicKey,
    );
    const claims: number[] = [];
    // The clock counts waits: a host never told of the refusal times out
    // after five polls instead of hanging the test.
    let waits = 0;
    await expect(
      performPairing({
        baseUrl: http,
        fetch,
        machineId: "machine-a",
        agentTokenPath: tokenPath,
        store,
        print: () => {},
        newCode: () => Promise.resolve(FIXED_CODE),
        timeoutMs: 5,
        now: () => waits,
        // The phone claims during the host's first wait; no timer runs.
        sleep: async () => {
          waits += 1;
          if (waits > 1) return;
          const res = await fetch(`${http}/pair/claim`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              rendezvousId,
              phonePub: phone.publicKey,
              phoneMac,
            }),
          });
          await res.text();
          claims.push(res.status);
        },
      }),
    ).rejects.toThrow(NAME_TAKEN);
    expect(claims).toEqual([409]);
    expect(waits).toBe(1);
    // The machine holding the name keeps its token; the newcomer stores none.
    expect(machines.authenticate(taken)).toBe("machine-a");
    expect(await Bun.file(tokenPath).exists()).toBe(false);
  } finally {
    server.stop();
    await rm(storePath, { force: true });
    await rm(tokenPath, { force: true });
  }
});

test("performPairing rejects with a timeout when the claim never lands", async () => {
  const storePath = tempStorePath();
  const tokenPath = tempStorePath();
  try {
    const store = new PairingStore(storePath);
    await store.load();

    let clock = 0;
    await expect(
      performPairing({
        baseUrl: BASE_URL,
        fetch: fakeFetch([{ status: "pending" }]),
        machineId: "machine-a",
        agentTokenPath: tokenPath,
        store,
        print: () => {},
        newCode: () => Promise.resolve(FIXED_CODE),
        pollIntervalMs: 1,
        timeoutMs: 5,
        sleep: () => Promise.resolve(),
        now: () => {
          clock += 100;
          return clock;
        },
      }),
    ).rejects.toThrow(/timed out/);

    expect(store.peers()).toEqual([]);
  } finally {
    await rm(storePath, { force: true });
    await rm(tokenPath, { force: true });
  }
});
