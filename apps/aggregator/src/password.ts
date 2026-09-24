import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeFileAtomic } from "./atomic-write";

export const PasswordFile = z.object({
  hash: z.string(),
  setAt: z.number().int(),
});
export type PasswordFile = z.infer<typeof PasswordFile>;

export const MIN_PASSWORD_LENGTH = 12;

export async function setPassword(
  path: string,
  plain: string,
  now: number,
): Promise<void> {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  const hash = await Bun.password.hash(plain, { algorithm: "argon2id" });
  const file: PasswordFile = { hash, setAt: now };
  await writeFileAtomic(path, JSON.stringify(file), 0o600);
}

/** The stored password, or undefined when none is set. A corrupt file throws. */
export async function readPassword(
  path: string,
): Promise<PasswordFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT")
      return undefined;
    throw err;
  }
  return PasswordFile.parse(JSON.parse(raw));
}
