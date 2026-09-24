/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { type NavigatorLike, registerServiceWorker } from "../src/register-sw";

const fakeReg = { scope: "/" } as unknown as ServiceWorkerRegistration;

test("registers the worker when the navigator supports service workers", async () => {
  const registered: string[] = [];
  const nav: NavigatorLike = {
    serviceWorker: {
      register: async (url: string) => {
        registered.push(url);
        return fakeReg;
      },
    },
  };
  const reg = await registerServiceWorker(nav, "/sw.js");
  expect(reg).toBe(fakeReg);
  expect(registered).toEqual(["/sw.js"]);
});

test("returns undefined when service workers are unsupported (no crash)", async () => {
  expect(await registerServiceWorker({}, "/sw.js")).toBeUndefined();
});

test("swallows a registration failure and returns undefined", async () => {
  const nav: NavigatorLike = {
    serviceWorker: {
      register: async () => {
        throw new Error("blocked");
      },
    },
  };
  expect(await registerServiceWorker(nav, "/sw.js")).toBeUndefined();
});
