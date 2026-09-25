import { expect, test } from "bun:test";
import { parseXdevWrite } from "../src/xdev";

test("decodes an xd:// device write into its device and JSON content", () => {
  const out = parseXdevWrite("write", {
    path: "xd://ast_edit",
    content: JSON.stringify({ paths: ["src/main.ts"] }),
  });
  expect(out).toEqual({
    device: "ast_edit",
    content: { paths: ["src/main.ts"] },
  });
});

test("keeps unparseable content as the raw string", () => {
  const out = parseXdevWrite("write", {
    path: "xd://lsp",
    content: "not json",
  });
  expect(out).toEqual({ device: "lsp", content: "not json" });
});

test("ignores a plain filesystem write", () => {
  expect(
    parseXdevWrite("write", { path: "src/main.ts", content: "x" }),
  ).toBeUndefined();
});

test("ignores a non-write tool even with an xd:// path argument", () => {
  expect(parseXdevWrite("read", { path: "xd://lsp" })).toBeUndefined();
});

test("ignores a bare xd:// device listing (no device named)", () => {
  expect(
    parseXdevWrite("write", { path: "xd://", content: "{}" }),
  ).toBeUndefined();
});

test("ignores malformed input shapes", () => {
  expect(parseXdevWrite("write", undefined)).toBeUndefined();
  expect(parseXdevWrite("write", "xd://lsp")).toBeUndefined();
  expect(parseXdevWrite("write", { path: 42 })).toBeUndefined();
  expect(parseXdevWrite(undefined, { path: "xd://lsp" })).toBeUndefined();
});
