import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairingBroker } from "../src/pairing";
import { AggregatorServer } from "../src/server";
import { serveStatic } from "../src/static";
import { tempMachineStore } from "./helpers/machines";

let root: string;
let outside: string;

beforeAll(async () => {
  outside = await mkdtemp(join(tmpdir(), "omp-static-"));
  root = join(outside, "dist");
  await Bun.write(join(root, "index.html"), "<!doctype html>shell");
  await writeFile(join(root, "main.js"), "console.log(1)");
  await writeFile(join(root, "sw.js"), "self");
  await writeFile(join(outside, "secret.txt"), "nope");
});
afterAll(() => rm(outside, { recursive: true, force: true }));

const get = (path: string, method = "GET") =>
  serveStatic(root, new Request(`http://x${path}`, { method }), path);

test("/ and unknown routes serve the shell", async () => {
  for (const path of ["/", "/machines/box"]) {
    const res = await get(path);
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe("<!doctype html>shell");
  }
});

test("assets are served with their content type", async () => {
  const res = await get("/main.js");
  expect(res?.status).toBe(200);
  expect(res?.headers.get("content-type")).toContain("javascript");
  expect(res?.headers.get("cache-control")).toBeNull();
});

test("the shell and service worker are never cached", async () => {
  for (const path of ["/", "/sw.js"])
    expect((await get(path))?.headers.get("cache-control")).toBe("no-cache");
});

test("a missing asset is a 404, not the shell", async () => {
  expect((await get("/missing.js"))?.status).toBe(404);
});

test("paths outside webRoot are refused", async () => {
  for (const path of [
    "/../secret.txt",
    "/%2e%2e/secret.txt",
    "/%2e%2e%2fsecret.txt",
    "/..%5csecret.txt",
    "/%00",
  ]) {
    const res = await get(path);
    expect(res?.status).toBe(404);
  }
});

test("only GET and HEAD are handled", async () => {
  expect(await get("/", "POST")).toBeUndefined();
  const head = await get("/main.js", "HEAD");
  expect(head?.status).toBe(200);
  expect(await head?.text()).toBe("");
});

test("the server serves the PWA for unclaimed GETs and keeps API routes", async () => {
  const server = new AggregatorServer({
    port: 0,
    machines: await tempMachineStore(),
    pairing: new PairingBroker(),
    webRoot: root,
  });
  server.start();
  try {
    const base = `http://127.0.0.1:${server.boundPort}`;
    const shell = await fetch(`${base}/machines/box`);
    expect(await shell.text()).toBe("<!doctype html>shell");
    // /pair/result is still the pairing route, not the shell.
    const pair = await fetch(`${base}/pair/result`, {
      method: "POST",
      body: "{}",
    });
    expect(pair.status).toBe(400);
  } finally {
    server.stop();
  }
});
