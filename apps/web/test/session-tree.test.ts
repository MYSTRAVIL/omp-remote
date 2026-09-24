import { expect, test } from "bun:test";
import type { SessionMeta } from "@omp-remote/protocol";
import { type MachineSessions, assembleTree } from "../src/core/session-tree";

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    id: "s",
    cwd: "/home/me/proj",
    project: "proj",
    model: "m",
    title: "T",
    pid: 1,
    startedAt: 0,
    ...over,
  };
}

test("groups sessions machine -> project -> session and sorts each level", () => {
  const machines: MachineSessions[] = [
    {
      machineId: "machine-b",
      label: "machine-b",
      sessions: [
        meta({ id: "b", project: "quant", startedAt: 200 }),
        meta({ id: "a", project: "quant", startedAt: 100 }),
        meta({ id: "c", project: "coral", startedAt: 50 }),
      ],
    },
    {
      machineId: "machine-a",
      label: "machine-a",
      sessions: [meta({ id: "d", project: "web", startedAt: 10 })],
    },
  ];

  const tree = assembleTree(machines);

  // machines sorted by label
  expect(tree.map((m) => m.label)).toEqual(["machine-a", "machine-b"]);

  const tower = tree[1];
  if (!tower) throw new Error("missing machine");
  // projects sorted by name
  expect(tower.projects.map((p) => p.project)).toEqual(["coral", "quant"]);
  // sessions within a project sorted by startedAt
  const quant = tower.projects.find((p) => p.project === "quant");
  expect(quant?.sessions.map((s) => s.id)).toEqual(["a", "b"]);
});

test("breaks a startedAt tie by session id for a total, stable order", () => {
  const machines: MachineSessions[] = [
    {
      machineId: "m",
      label: "m",
      sessions: [
        meta({ id: "z", project: "p", startedAt: 5 }),
        meta({ id: "a", project: "p", startedAt: 5 }),
      ],
    },
  ];
  const tree = assembleTree(machines);
  expect(tree[0]?.projects[0]?.sessions.map((s) => s.id)).toEqual(["a", "z"]);
});

test("a machine with no sessions yields an empty project list, not a crash", () => {
  const tree = assembleTree([{ machineId: "m", label: "m", sessions: [] }]);
  expect(tree).toEqual([{ machineId: "m", label: "m", projects: [] }]);
});

test("input order does not affect output order (no accidental Map ordering)", () => {
  const startedAt: Record<string, number> = { a: 30, b: 20, c: 10 };
  const build = (ids: string[]): MachineSessions[] => [
    {
      machineId: "m",
      label: "m",
      sessions: ids.map((id) =>
        meta({ id, project: id, startedAt: startedAt[id] }),
      ),
    },
  ];
  const forward = assembleTree(build(["a", "b", "c"]));
  const reverse = assembleTree(build(["c", "b", "a"]));
  expect(forward).toEqual(reverse);
});
