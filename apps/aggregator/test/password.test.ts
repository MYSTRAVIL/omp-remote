import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIN_PASSWORD_LENGTH,
  PasswordFile,
  readPassword,
  setPassword,
} from "../src/password";

function tempPasswordPath(): string {
  return join(tmpdir(), `omp-pwd-${Date.now()}-${Math.random()}.json`);
}

describe("password store", () => {
  test("setPassword rejects passwords shorter than MIN_PASSWORD_LENGTH", async () => {
    const path = tempPasswordPath();
    try {
      await expect(setPassword(path, "short", 1000)).rejects.toThrow(
        /at least 12/,
      );
      await expect(readPassword(path)).resolves.toBeUndefined();
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("setPassword stores an argon2id hash", async () => {
    const path = tempPasswordPath();
    try {
      await setPassword(path, "correct horse battery staple", 2000);
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      expect(raw.hash).toMatch(/^\$argon2id\$/);
      expect(raw.setAt).toBe(2000);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("readPassword returns the stored file", async () => {
    const path = tempPasswordPath();
    try {
      await setPassword(path, "correct horse battery staple", 3000);
      const stored = await readPassword(path);
      expect(PasswordFile.parse(stored)).toBeDefined();
      expect(stored?.setAt).toBe(3000);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("readPassword returns undefined when file is missing", async () => {
    const path = tempPasswordPath();
    await expect(readPassword(path)).resolves.toBeUndefined();
  });

  test("readPassword throws on corrupt JSON", async () => {
    const path = tempPasswordPath();
    writeFileSync(path, "not json");
    try {
      await expect(readPassword(path)).rejects.toThrow();
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("Bun.password.verify accepts correct and rejects wrong", async () => {
    const path = tempPasswordPath();
    try {
      await setPassword(path, "correct horse battery staple", 4000);
      const stored = await readPassword(path);
      if (stored === undefined) throw new Error("no password stored");
      const ok = await Bun.password.verify(
        "correct horse battery staple",
        stored.hash,
      );
      expect(ok).toBe(true);
      const wrong = await Bun.password.verify(
        "wrong password here",
        stored.hash,
      );
      expect(wrong).toBe(false);
    } finally {
      rmSync(path, { force: true });
    }
  });
});
