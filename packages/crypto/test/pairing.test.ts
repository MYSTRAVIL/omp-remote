import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairingStore } from "../src/index";

function tmp() {
  return join(mkdtempSync(join(tmpdir(), "omp-remote-pair-")), "pair.json");
}

test("self identity is stable across reload", async () => {
  const p = tmp();
  const a = new PairingStore(p);
  await a.load();
  const id1 = a.self().publicKey;
  const b = new PairingStore(p);
  await b.load();
  expect(b.self().publicKey).toBe(id1);
});

test("trusted peer persists across stores", async () => {
  const p = tmp();
  const a = new PairingStore(p);
  await a.load();
  await a.trust({ id: "phone", publicKey: "AAAA" });
  const b = new PairingStore(p);
  await b.load();
  expect(b.peer("phone")?.publicKey).toBe("AAAA");
});

test("trust upserts by id", async () => {
  const p = tmp();
  const a = new PairingStore(p);
  await a.load();
  await a.trust({ id: "phone", publicKey: "AAAA" });
  await a.trust({ id: "phone", publicKey: "BBBB" });
  expect(a.peers().length).toBe(1);
  expect(a.peer("phone")?.publicKey).toBe("BBBB");
});
