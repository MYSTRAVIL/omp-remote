import { expect, test } from "bun:test";
import { MIN_OMP_VERSION, meetsMinOmp } from "../src/collab/omp-cli";

test("meetsMinOmp enforces the 18.1.20 collab floor", () => {
  expect(MIN_OMP_VERSION).toBe("18.1.20");
  expect(meetsMinOmp("omp/18.1.20")).toBe(true);
  expect(meetsMinOmp("omp/18.1.21")).toBe(true);
  expect(meetsMinOmp("omp/18.2.0")).toBe(true);
  expect(meetsMinOmp("omp/19.0.0")).toBe(true);
  expect(meetsMinOmp("omp/18.1.19")).toBe(false);
  expect(meetsMinOmp("omp/18.0.99")).toBe(false);
  expect(meetsMinOmp("omp/17.9.9")).toBe(false);
  expect(meetsMinOmp("not a version")).toBe(false);
});
