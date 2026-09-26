import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOwnerOnly } from "@omp-remote/protocol/ipc";
import { PairingStore } from "../src/pairing-store";

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

test.skipIf(process.platform !== "win32")(
  "pairing.json is owner-only on Windows: the host secret key is not left to the folder's ACL",
  async () => {
    const p = tmp();
    const failures: string[] = [];
    const a = new PairingStore(p, { onAclFailure: (f) => failures.push(f) });
    await a.load();
    await a.trust({ id: "phone", publicKey: "AAAA" });
    expect(failures).toEqual([]);
    expect(await checkOwnerOnly(p)).toBeUndefined();
  },
);

test("a pairing.json that exists but cannot be parsed fails loudly, never re-minted", async () => {
  const p = tmp();
  writeFileSync(p, "{ not json");
  await expect(new PairingStore(p).load()).rejects.toThrow(p);
  // The file is left for the owner to inspect: the identity was not replaced.
  expect(readFileSync(p, "utf8")).toBe("{ not json");
});
