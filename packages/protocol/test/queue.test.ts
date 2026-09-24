import { expect, test } from "bun:test";
import { BoundedQueue } from "../src/queue";

test("preserves FIFO order and drains-then-empties", () => {
  const q = new BoundedQueue<number>(3);
  expect(q.push(1)).toBeUndefined();
  expect(q.push(2)).toBeUndefined();
  expect(q.size).toBe(2);
  expect(q.drain()).toEqual([1, 2]);
  expect(q.size).toBe(0);
  expect(q.drain()).toEqual([]);
});

test("drops the OLDEST item on overflow and returns it", () => {
  const q = new BoundedQueue<string>(2);
  expect(q.push("a")).toBeUndefined();
  expect(q.push("b")).toBeUndefined();
  // over capacity: oldest ("a") is evicted and returned, newest retained
  expect(q.push("c")).toBe("a");
  expect(q.push("d")).toBe("b");
  expect(q.size).toBe(2);
  expect(q.drain()).toEqual(["c", "d"]);
});

test("capacity of 1 keeps only the newest", () => {
  const q = new BoundedQueue<number>(1);
  q.push(1);
  expect(q.push(2)).toBe(1);
  expect(q.drain()).toEqual([2]);
});

test("clear empties without returning", () => {
  const q = new BoundedQueue<number>(2);
  q.push(1);
  q.clear();
  expect(q.size).toBe(0);
});

test("rejects a non-positive or non-integer capacity", () => {
  expect(() => new BoundedQueue(0)).toThrow(RangeError);
  expect(() => new BoundedQueue(-1)).toThrow(RangeError);
  expect(() => new BoundedQueue(1.5)).toThrow(RangeError);
});
