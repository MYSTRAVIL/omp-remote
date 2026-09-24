import { writeFile } from "node:fs/promises";
import type { PasswordFile } from "../../src/password";

/**
 * Write a password file as `setPassword` does, but hashed at argon2id's lowest
 * cost, so a test can check the password hundreds of times in a blink. The
 * gate verifies with whatever cost the hash records, so it treats this file
 * like any other. `setAt` is epoch ms.
 */
export async function writeCheapPassword(
  path: string,
  plain: string,
  setAt: number,
): Promise<void> {
  const file: PasswordFile = {
    hash: await Bun.password.hash(plain, {
      algorithm: "argon2id",
      memoryCost: 8,
      timeCost: 1,
    }),
    setAt,
  };
  await writeFile(path, JSON.stringify(file));
}
