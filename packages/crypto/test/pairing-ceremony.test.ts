import { expect, test } from "bun:test";
import { newIdentity } from "../src/identity";
import {
  hostCommitment,
  newPairingCode,
  pairingSas,
  phoneCommitment,
  verifyPeerMac,
} from "../src/pairing-ceremony";

const MACHINE = "machine-a";

test("a fresh code carries 128 bits: 26 base32 symbols, grouped", async () => {
  const code = await newPairingCode();
  const symbols = code.replace(/-/g, "");
  expect(symbols).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(code).toContain("-");
  expect(await newPairingCode()).not.toBe(code);
});

test("host and phone derive the SAME rendezvous id from the same code", async () => {
  const code = await newPairingCode();
  const host = await newIdentity();
  const phone = await newIdentity();
  const h = await hostCommitment(code, MACHINE, host.publicKey);
  const p = await phoneCommitment(code, phone.publicKey);
  expect(h.rendezvousId).toBe(p.rendezvousId);
});

test("a different code yields a different rendezvous id", async () => {
  const id = await newIdentity();
  const a = await hostCommitment(await newPairingCode(), MACHINE, id.publicKey);
  const b = await hostCommitment(await newPairingCode(), MACHINE, id.publicKey);
  expect(a.rendezvousId).not.toBe(b.rendezvousId);
});

test("each side accepts the peer's honest MAC over the code", async () => {
  const code = await newPairingCode();
  const host = await newIdentity();
  const phone = await newIdentity();
  const h = await hostCommitment(code, MACHINE, host.publicKey);
  const p = await phoneCommitment(code, phone.publicKey);
  // Phone checks the host's commitment (over machineId+key); host checks the phone's.
  expect(
    await verifyPeerMac(code, "host", host.publicKey, h.mac, MACHINE),
  ).toBe(true);
  expect(await verifyPeerMac(code, "phone", phone.publicKey, p.mac)).toBe(true);
});

test("the WRONG code rejects an otherwise-valid MAC", async () => {
  const host = await newIdentity();
  const h = await hostCommitment(
    await newPairingCode(),
    MACHINE,
    host.publicKey,
  );
  const wrong = await newPairingCode();
  expect(
    await verifyPeerMac(wrong, "host", host.publicKey, h.mac, MACHINE),
  ).toBe(false);
});

test("the role tag stops a host MAC being replayed as a phone MAC", async () => {
  const code = await newPairingCode();
  const id = await newIdentity();
  const h = await hostCommitment(code, MACHINE, id.publicKey);
  // Same key, same code, but the verifier expects the other role.
  expect(await verifyPeerMac(code, "phone", id.publicKey, h.mac)).toBe(false);
});

test("a relay that relabels the machineId cannot pass the host MAC", async () => {
  const code = await newPairingCode();
  const host = await newIdentity();
  const h = await hostCommitment(code, "machine-A", host.publicKey);
  // The real key + MAC, but the relay claims a different machine label.
  expect(
    await verifyPeerMac(code, "host", host.publicKey, h.mac, "machine-B"),
  ).toBe(false);
  // Only the machineId the host actually committed to verifies.
  expect(
    await verifyPeerMac(code, "host", host.publicKey, h.mac, "machine-A"),
  ).toBe(true);
});

test("adversarial: a relay that substitutes a public key cannot forge its MAC, so the peer refuses it", async () => {
  const code = await newPairingCode();
  const host = await newIdentity();
  const evil = await newIdentity(); // the malicious relay's own keypair

  // Honest host commits to hostPub; the relay swaps the key toward the phone.
  const honest = await hostCommitment(code, MACHINE, host.publicKey);

  // The relay can't recompute the MAC over the swapped key without the code.
  expect(
    await verifyPeerMac(code, "host", evil.publicKey, honest.mac, MACHINE),
  ).toBe(false);
  // Even re-signing evil.publicKey under a guessed code fails against the real code.
  const forged = await hostCommitment(
    await newPairingCode(),
    MACHINE,
    evil.publicKey,
  );
  expect(
    await verifyPeerMac(code, "host", evil.publicKey, forged.mac, MACHINE),
  ).toBe(false);
  // The only key the phone WILL accept is the real host key.
  expect(
    await verifyPeerMac(code, "host", host.publicKey, honest.mac, MACHINE),
  ).toBe(true);
});

test("a tampered MAC is rejected and never throws", async () => {
  const code = await newPairingCode();
  const host = await newIdentity();
  const h = await hostCommitment(code, MACHINE, host.publicKey);
  expect(
    await verifyPeerMac(code, "host", host.publicKey, `${h.mac}AA`, MACHINE),
  ).toBe(false);
  expect(
    await verifyPeerMac(code, "host", host.publicKey, "!!!notb64", MACHINE),
  ).toBe(false);
});

test("the SAS matches on both sides and changes if a key is swapped", async () => {
  const code = await newPairingCode();
  const host = await newIdentity();
  const phone = await newIdentity();
  const evil = await newIdentity();
  const a = await pairingSas(code, MACHINE, host.publicKey, phone.publicKey);
  const b = await pairingSas(code, MACHINE, host.publicKey, phone.publicKey);
  expect(a).toBe(b);
  expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  const swapped = await pairingSas(
    code,
    MACHINE,
    evil.publicKey,
    phone.publicKey,
  );
  expect(swapped).not.toBe(a);
});

test("the SAS changes if the machineId is relabelled", async () => {
  const code = await newPairingCode();
  const host = await newIdentity();
  const phone = await newIdentity();
  const a = await pairingSas(
    code,
    "machine-A",
    host.publicKey,
    phone.publicKey,
  );
  const b = await pairingSas(
    code,
    "machine-B",
    host.publicKey,
    phone.publicKey,
  );
  expect(a).not.toBe(b);
});

test("codes normalize: lowercase, spaces, and look-alikes decode identically", async () => {
  const id = await newIdentity();
  const canonical = await hostCommitment("0011-2345", MACHINE, id.publicKey);
  // lowercase + spaces instead of hyphens, and Crockford look-alikes fold:
  // o→0, i→1, l→1 — so "ooil 2345" must decode to the same "0011-2345".
  const messy = await hostCommitment("ooil 2345", MACHINE, id.publicKey);
  expect(messy.rendezvousId).toBe(canonical.rendezvousId);
  expect(messy.mac).toBe(canonical.mac);
});
