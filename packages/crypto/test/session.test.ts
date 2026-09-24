import { expect, test } from "bun:test";
import {
  AeadError,
  clientSessionKeys,
  newIdentity,
  open,
  seal,
  serverSessionKeys,
} from "../src/index";

const enc = new TextEncoder();
const dec = new TextDecoder();

test("client/server derive mirrored keys and seal round-trips", async () => {
  const client = await newIdentity();
  const server = await newIdentity();
  const ck = await clientSessionKeys(client, server.publicKey);
  const sk = await serverSessionKeys(server, client.publicKey);
  const aad = enc.encode("route:s1");
  const env = seal(ck.tx, enc.encode("hello"), aad);
  expect(dec.decode(open(sk.rx, env, aad))).toBe("hello");
});

test("tampered ciphertext fails auth", async () => {
  const c = await newIdentity();
  const s = await newIdentity();
  const ck = await clientSessionKeys(c, s.publicKey);
  const sk = await serverSessionKeys(s, c.publicKey);
  const aad = new Uint8Array();
  const env = seal(ck.tx, enc.encode("x"), aad);
  const bad = {
    ...env,
    ct: env.ct.slice(0, -2) + (env.ct.endsWith("A") ? "B" : "A"),
  };
  expect(() => open(sk.rx, bad, aad)).toThrow(AeadError);
});

test("wrong aad fails auth", async () => {
  const c = await newIdentity();
  const s = await newIdentity();
  const ck = await clientSessionKeys(c, s.publicKey);
  const sk = await serverSessionKeys(s, c.publicKey);
  const env = seal(ck.tx, enc.encode("x"), enc.encode("a"));
  expect(() => open(sk.rx, env, enc.encode("b"))).toThrow(AeadError);
});
