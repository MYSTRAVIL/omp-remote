import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDiagnostic } from "../src/diagnostics";
import { DEFAULT_AWAY_SEC, NotifyPolicy } from "../src/notify-policy";
import { AgentService } from "../src/service";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

/** A policy file path in a fresh state dir. */
async function policyPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omp-remote-policy-"));
  dirs.push(dir);
  return join(dir, "notify-policy.json");
}

test("the policy the phone set is loaded by the next agent", async () => {
  const path = await policyPath();
  await new NotifyPolicy({ path }).set(300);

  const restarted = new NotifyPolicy({ path });
  expect(restarted.awaySec).toBe(DEFAULT_AWAY_SEC);
  await restarted.load();
  expect(restarted.awaySec).toBe(300);
});

test("a missing policy file keeps the default quietly; an unreadable one keeps it and is reported", async () => {
  const events: AgentDiagnostic[] = [];
  const diagnostic = (event: AgentDiagnostic) => events.push(event);
  const missing = new NotifyPolicy({ path: await policyPath(), diagnostic });
  await missing.load();
  expect(missing.awaySec).toBe(DEFAULT_AWAY_SEC);
  expect(events).toEqual([]);

  const path = await policyPath();
  await writeFile(path, '{"awaySec":-5}');
  const invalid = new NotifyPolicy({ path, diagnostic });
  await invalid.load();
  expect(invalid.awaySec).toBe(DEFAULT_AWAY_SEC);
  expect(events).toEqual([
    { event: "notify_policy_failed", code: "load-failed" },
  ]);
});

test("a phone's notifyPolicy reaches the policy through the service router", () => {
  const notifyPolicy = new NotifyPolicy();
  const changes: number[] = [];
  notifyPolicy.onChange(() => changes.push(notifyPolicy.awaySec));
  const svc = new AgentService({
    token: "tok",
    ipcPath: "unused: never listened on",
    notifyPolicy,
  });

  svc.deliverDownlink({ t: "notifyPolicy", awaySec: 0 });
  // The phone re-sends its policy on every connect: the same value is no change.
  svc.deliverDownlink({ t: "notifyPolicy", awaySec: 0 });
  expect(notifyPolicy.awaySec).toBe(0);
  expect(changes).toEqual([0]);
});
