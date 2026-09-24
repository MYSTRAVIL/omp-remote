import { expect, test } from "bun:test";
import { agentSocketUrl } from "../src/server-url";

test("an http(s) server URL dials the matching ws(s) /agent endpoint", () => {
  expect(agentSocketUrl("http://box:8788")).toBe("ws://box:8788/agent");
  expect(agentSocketUrl("https://x/")).toBe("wss://x/agent");
});

test("a ws(s) server URL passes through with /agent appended", () => {
  expect(agentSocketUrl("ws://127.0.0.1:9")).toBe("ws://127.0.0.1:9/agent");
  expect(agentSocketUrl("wss://agg.example:443/")).toBe(
    "wss://agg.example/agent",
  );
});

test("a reverse-proxy path prefix is kept", () => {
  expect(agentSocketUrl("https://host.example/omp//")).toBe(
    "wss://host.example/omp/agent",
  );
});

test("a server URL that is not http(s) or ws(s) is refused", () => {
  expect(() => agentSocketUrl("ftp://box/")).toThrow("ftp:");
});
