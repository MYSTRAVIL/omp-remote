import { describe, expect, test } from "bun:test";
import { clipNoticeText, openNotice, sealNotice } from "@omp-remote/protocol";
import {
  clientSessionKeys,
  newIdentity,
  notifyKey,
  serverSessionKeys,
} from "../src";

async function pairKeys() {
  const phone = await newIdentity();
  const host = await newIdentity();
  const hostKeys = await serverSessionKeys(host, phone.publicKey);
  const phoneKeys = await clientSessionKeys(phone, host.publicKey);
  return {
    host: await notifyKey(hostKeys.tx),
    phone: await notifyKey(phoneKeys.rx),
  };
}

describe("sealed notices", () => {
  test("the phone opens what the host sealed", async () => {
    const keys = await pairKeys();
    const notice = {
      kind: "attention",
      sessionId: "s1",
      reason: "approval",
      title: "Fix login",
      project: "web",
      detail: "Run bash: bun test",
    } as const;
    const env = await sealNotice(keys.host, "m1", notice);
    expect(await openNotice(keys.phone, env)).toEqual(notice);
  });

  test("an envelope moved to another machine does not open", async () => {
    const keys = await pairKeys();
    const env = await sealNotice(keys.host, "m1", {
      kind: "clear",
      sessionId: "s1",
    });
    await expect(openNotice(keys.phone, { ...env, m: "m2" })).rejects.toThrow();
  });

  test("clipping flattens whitespace and marks the cut", () => {
    expect(clipNoticeText("a\n\n b", 10)).toBe("a b");
    expect(clipNoticeText("abcdefghij", 5)).toBe("abcd…");
  });
});
