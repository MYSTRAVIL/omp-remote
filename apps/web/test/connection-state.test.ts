import { describe, expect, test } from "bun:test";
import { connectionStatus, decideSend } from "../src/core/connection-state";

describe("connectionStatus", () => {
  test("the dot tells the first connect from a redial, and no network beats both", () => {
    const status = (
      relay: "connected" | "connecting" | "offline",
      connectedOnce: boolean,
      networkOnline: boolean,
    ) => connectionStatus({ relay, connectedOnce, networkOnline });
    expect(status("connecting", false, true)).toBe("connecting");
    expect(status("offline", true, true)).toBe("reconnecting");
    expect(status("connecting", false, false)).toBe("offline");
    expect(status("offline", true, false)).toBe("offline");
    expect(status("connected", true, true)).toBe("connected");
  });
});

describe("decideSend", () => {
  test("an offline machine blocks the send and names the machine", () => {
    const decision = decideSend({ machine: { label: "Desk", offline: true } });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.notice).toContain("Desk");
  });

  test("an online machine may be sent to", () => {
    expect(
      decideSend({ machine: { label: "Desk", offline: false } }).allowed,
    ).toBe(true);
  });

  test("a session whose machine the tree does not list is not blocked", () => {
    expect(decideSend({ machine: undefined }).allowed).toBe(true);
  });
});
