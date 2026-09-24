import { expect, test } from "bun:test";
import { newIdentity, open, seal, serverSessionKeys } from "@omp-remote/crypto";
import {
  PAIRING_KEY,
  forgetPairing,
  loadOrCreateIdentity,
  loadPairedMachines,
  savePairing,
} from "../src/core/pairing-browser";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A Map-backed `localStorage` pair for the writer/identity tests. */
function storage(): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
} {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

test("loads paired machines and derives working session keys", async () => {
  const phone = await newIdentity();
  const agent = await newIdentity();
  const blob = JSON.stringify({
    identity: phone,
    peers: [{ machineId: "machine-a", publicKey: agent.publicKey }],
  });
  const machines = await loadPairedMachines((k) =>
    k === PAIRING_KEY ? blob : null,
  );
  expect(machines.map((m) => m.machineId)).toEqual(["machine-a"]);

  // The derived keys interoperate with the agent side: seal on the agent, open
  // on the phone under the shared route AAD.
  const agentKeys = await serverSessionKeys(agent, phone.publicKey);
  const aad = enc.encode("machine-a");
  const sealed = seal(agentKeys.tx, enc.encode("hello"), aad);
  const phoneKeys = machines[0]?.keys;
  if (!phoneKeys) throw new Error("no keys");
  expect(dec.decode(open(phoneKeys.rx, sealed, aad))).toBe("hello");
});

test("returns an empty list when nothing is stored or the blob is malformed", async () => {
  expect(await loadPairedMachines(() => null)).toEqual([]);
  expect(await loadPairedMachines(() => "not json")).toEqual([]);
  expect(await loadPairedMachines(() => JSON.stringify({ peers: 5 }))).toEqual(
    [],
  );
});

test("loadOrCreateIdentity mints and persists an identity once, then reuses it", async () => {
  const store = storage();
  const identity = await loadOrCreateIdentity(store.getItem, store.setItem);
  expect(typeof identity.publicKey).toBe("string");
  expect(typeof identity.secretKey).toBe("string");
  // Persisted under the pairing key with an empty peer list (no machines yet).
  expect(store.getItem(PAIRING_KEY)).not.toBeNull();
  expect(await loadPairedMachines(store.getItem)).toEqual([]);
  // A second call returns the SAME identity — it never mints a second keypair.
  const again = await loadOrCreateIdentity(store.getItem, store.setItem);
  expect(again).toEqual(identity);
});

test("savePairing upserts a peer that loadPairedMachines then returns", async () => {
  const store = storage();
  const phone = await loadOrCreateIdentity(store.getItem, store.setItem);
  const agent = await newIdentity();
  savePairing(store.getItem, store.setItem, "m1", agent.publicKey);
  const afterInsert = await loadPairedMachines(store.getItem);
  expect(afterInsert.map((m) => m.machineId)).toEqual(["m1"]);

  // Re-pairing "m1" with a new key REPLACES it in place (upsert, not append):
  // one entry remains and its derived key interoperates with the NEW host key.
  const agent2 = await newIdentity();
  savePairing(store.getItem, store.setItem, "m1", agent2.publicKey);
  const afterRepair = await loadPairedMachines(store.getItem);
  expect(afterRepair.map((m) => m.machineId)).toEqual(["m1"]);

  const agentKeys = await serverSessionKeys(agent2, phone.publicKey);
  const aad = enc.encode("m1");
  const sealed = seal(agentKeys.tx, enc.encode("hi"), aad);
  const keys = afterRepair[0]?.keys;
  if (!keys) throw new Error("no keys");
  expect(dec.decode(open(keys.rx, sealed, aad))).toBe("hi");
});

test("savePairing throws when no phone identity has been created yet", () => {
  const store = storage();
  expect(() =>
    savePairing(store.getItem, store.setItem, "m1", "hostpub"),
  ).toThrow("no phone identity; call loadOrCreateIdentity first");
  // It refused before writing anything.
  expect(store.getItem(PAIRING_KEY)).toBeNull();
});

test("forgetPairing drops only that machine, keeping the identity and every other peer", async () => {
  const store = storage();
  const phone = await loadOrCreateIdentity(store.getItem, store.setItem);
  const hostA = await newIdentity();
  const hostB = await newIdentity();
  savePairing(store.getItem, store.setItem, "m1", hostA.publicKey);
  savePairing(store.getItem, store.setItem, "m2", hostB.publicKey);

  forgetPairing(store.getItem, store.setItem, "m1");
  const machines = await loadPairedMachines(store.getItem);
  expect(machines.map((m) => m.machineId)).toEqual(["m2"]);
  expect(await loadOrCreateIdentity(store.getItem, store.setItem)).toEqual(
    phone,
  );
  // m2's pairing still works end to end: its host key was kept as it was.
  const hostKeys = await serverSessionKeys(hostB, phone.publicKey);
  const aad = enc.encode("m2");
  const keys = machines[0]?.keys;
  if (!keys) throw new Error("no keys");
  expect(
    dec.decode(open(keys.rx, seal(hostKeys.tx, enc.encode("still"), aad), aad)),
  ).toBe("still");

  // An id this browser never paired (or already forgot) changes nothing.
  const before = store.getItem(PAIRING_KEY);
  forgetPairing(store.getItem, store.setItem, "m1");
  forgetPairing(store.getItem, store.setItem, "never-paired");
  expect(store.getItem(PAIRING_KEY)).toBe(before);
});
