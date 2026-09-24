import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionMeta } from "@omp-remote/protocol";
import { LaunchPreferences } from "../src/core/launch-preferences";
import { type MachineNode, assembleTree } from "../src/core/session-tree";

// Register a DOM only for this file (for localStorage) so happy-dom's globals
// never leak into the crypto/WebSocket-based suites in the same process.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => localStorage.clear());

function session(id: string, cwd: string, startedAt: number): SessionMeta {
  const project = cwd.split("/").pop() ?? cwd;
  return { id, cwd, project, model: "m", title: id, pid: 1, startedAt };
}

function tree(...sessions: SessionMeta[]): MachineNode[] {
  return assembleTree([{ machineId: "machine-a", label: "a", sessions }]);
}

const cwds = (prefs: LaunchPreferences) =>
  prefs.projectsFor("machine-a").map((project) => project.cwd);

test("a removed project stays gone while its old sessions keep reporting, also after a reload", () => {
  const prefs = new LaunchPreferences();
  const live = tree(
    session("s1", "/tmp/alpha", 100),
    session("s2", "/tmp/beta", 50),
  );
  prefs.observeProjects(live);
  prefs.removeProject("machine-a", "/tmp/alpha");
  prefs.observeProjects(live);
  expect(cwds(prefs)).toEqual(["/tmp/beta"]);

  const reloaded = new LaunchPreferences();
  reloaded.observeProjects(live);
  expect(cwds(reloaded)).toEqual(["/tmp/beta"]);
});

test("a session started later in a removed directory brings the project back", () => {
  const prefs = new LaunchPreferences();
  prefs.observeProjects(tree(session("s1", "/tmp/alpha", 100)));
  prefs.removeProject("machine-a", "/tmp/alpha");
  // Same start time as the removed session's: not newer, stays removed.
  prefs.observeProjects(tree(session("s1b", "/tmp/alpha", 100)));
  expect(cwds(prefs)).toEqual([]);
  prefs.observeProjects(tree(session("s2", "/tmp/alpha", 101)));
  expect(cwds(prefs)).toEqual(["/tmp/alpha"]);
  // Restored for good: the old tombstone no longer applies after a reload.
  const reloaded = new LaunchPreferences();
  reloaded.observeProjects(tree(session("s1", "/tmp/alpha", 100)));
  expect(cwds(reloaded)).toEqual(["/tmp/alpha"]);
});

test("starting a session from this device in a removed directory brings it back", () => {
  const prefs = new LaunchPreferences();
  const live = tree(session("s1", "/tmp/alpha", 100));
  prefs.observeProjects(live);
  prefs.removeProject("machine-a", "/tmp/alpha");
  prefs.rememberProject("machine-a", "/tmp/alpha");
  prefs.observeProjects(live);
  expect(cwds(prefs)).toEqual(["/tmp/alpha"]);
});

test("hide keeps a project out of the list until unhidden, across reloads", () => {
  const prefs = new LaunchPreferences();
  const live = tree(
    session("s1", "/tmp/alpha", 100),
    session("s2", "/tmp/beta", 50),
  );
  prefs.observeProjects(live);
  prefs.hideProject("machine-a", "/tmp/alpha");
  prefs.observeProjects(live);
  expect(cwds(prefs)).toEqual(["/tmp/beta"]);

  const reloaded = new LaunchPreferences();
  expect(cwds(reloaded)).toEqual(["/tmp/beta"]);
  expect(reloaded.hiddenProjects()).toEqual([
    { machineId: "machine-a", cwd: "/tmp/alpha", project: "alpha" },
  ]);
  reloaded.unhideProject("machine-a", "/tmp/alpha");
  expect(cwds(new LaunchPreferences())).toEqual(["/tmp/alpha", "/tmp/beta"]);
  expect(reloaded.hiddenProjects()).toEqual([]);
});

test("launch defaults persist: a new preference object reads each back", () => {
  const prefs = new LaunchPreferences();
  prefs.observeProjects(tree(session("s1", "/tmp/alpha", 100)));
  prefs.setDefaultMachine("machine-a");
  prefs.setDefaultEffort("high");
  prefs.setDefaultModel("machine-a", "  qwen/coder  ");
  prefs.setDefaultProject("machine-a", "/tmp/alpha");

  const reloaded = new LaunchPreferences();
  expect(reloaded.defaultMachine).toBe("machine-a");
  expect(reloaded.defaultEffort).toBe("high");
  expect(reloaded.defaultModel("machine-a")).toBe("qwen/coder");
  expect(reloaded.defaultModel("machine-b")).toBe("");
  expect(reloaded.defaultProject("machine-a")).toBe("/tmp/alpha");

  // Empty and undefined return each to omp's own default.
  reloaded.setDefaultModel("machine-a", " ");
  reloaded.setDefaultEffort(undefined);
  reloaded.setDefaultMachine(undefined);
  const cleared = new LaunchPreferences();
  expect(cleared.defaultModel("machine-a")).toBe("");
  expect(cleared.defaultEffort).toBeUndefined();
  expect(cleared.defaultMachine).toBeUndefined();
});

test("hiding or removing a machine's default project clears it, and unhiding does not bring it back", () => {
  const prefs = new LaunchPreferences();
  prefs.observeProjects(
    tree(session("s1", "/tmp/alpha", 100), session("s2", "/tmp/beta", 50)),
  );
  prefs.setDefaultProject("machine-a", "/tmp/alpha");
  prefs.hideProject("machine-a", "/tmp/alpha");
  expect(prefs.defaultProject("machine-a")).toBeUndefined();
  prefs.unhideProject("machine-a", "/tmp/alpha");
  expect(new LaunchPreferences().defaultProject("machine-a")).toBeUndefined();

  prefs.setDefaultProject("machine-a", "/tmp/beta");
  prefs.removeProject("machine-a", "/tmp/beta");
  expect(prefs.defaultProject("machine-a")).toBeUndefined();
  expect(new LaunchPreferences().defaultProject("machine-a")).toBeUndefined();
});

test("forgetting a machine drops only its launch defaults, also after a reload", () => {
  const prefs = new LaunchPreferences();
  for (const machineId of ["machine-a", "machine-b"]) {
    prefs.rememberProject(machineId, `/p/${machineId}`);
    prefs.setDefaultProject(machineId, `/p/${machineId}`);
    prefs.setDefaultModel(machineId, `${machineId}/model`);
  }
  prefs.setDefaultMachine("machine-a");
  const defaults = (p: LaunchPreferences, machineId: string) => [
    p.defaultModel(machineId),
    p.defaultProject(machineId),
  ];

  prefs.forgetMachine("machine-b");
  for (const p of [prefs, new LaunchPreferences()]) {
    expect(p.defaultMachine).toBe("machine-a");
    expect(defaults(p, "machine-a")).toEqual([
      "machine-a/model",
      "/p/machine-a",
    ]);
    expect(defaults(p, "machine-b")).toEqual(["", undefined]);
  }

  prefs.forgetMachine("machine-a");
  const reloaded = new LaunchPreferences();
  expect(reloaded.defaultMachine).toBeUndefined();
  expect(defaults(reloaded, "machine-a")).toEqual(["", undefined]);
});
