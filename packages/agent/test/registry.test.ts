import { expect, test } from "bun:test";
import type { SessionMeta } from "@omp-remote/protocol";
import { Registry } from "../src/registry";

function meta(id: string, project = "p", startedAt = 0): SessionMeta {
  return {
    id,
    cwd: `/x/${project}`,
    project,
    model: "m",
    title: id,
    pid: 1,
    startedAt,
  };
}

test("upsert then list returns the session", () => {
  const r = new Registry();
  r.upsert(meta("s1"));
  expect(r.list().map((e) => e.meta.id)).toEqual(["s1"]);
});

test("list sorts by project then startedAt", () => {
  const r = new Registry();
  r.upsert(meta("b", "beta", 5));
  r.upsert(meta("a", "alpha", 9));
  r.upsert(meta("c", "alpha", 1));
  expect(r.list().map((e) => e.meta.id)).toEqual(["c", "a", "b"]);
});

test("onChange fires on upsert and remove", () => {
  const r = new Registry();
  let n = 0;
  r.onChange(() => {
    n++;
  });
  r.upsert(meta("s1"));
  r.remove("s1");
  expect(n).toBe(2);
});
