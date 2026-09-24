import { createInterface } from "node:readline/promises";

/** Ask one line on the terminal. An empty answer returns `fallback` when given. */
export async function ask(
  question: string,
  fallback?: string,
): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = fallback === undefined ? "" : ` [${fallback}]`;
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer === "" && fallback !== undefined ? fallback : answer;
  } finally {
    rl.close();
  }
}

/** Ask for a choice by number. Returns the chosen index. */
export async function choose(
  question: string,
  options: readonly string[],
): Promise<number> {
  const lines = options.map((o, i) => `  ${i + 1}) ${o}`).join("\n");
  for (;;) {
    const answer = await ask(`${question}\n${lines}\nChoose`, "1");
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
    console.log(`Enter a number from 1 to ${options.length}.`);
  }
}

/**
 * Read a password without echoing it. Uses raw mode on a TTY; with no TTY
 * (piped input) it reads one line as-is.
 */
export async function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);
  process.stdout.write(`${question}: `);
  stdin.setRawMode(true);
  stdin.resume();
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let value = "";
  const onData = (chunk: Buffer): void => {
    for (const ch of chunk.toString("utf8")) {
      if (ch === "\r" || ch === "\n") {
        done();
        resolve(value);
        return;
      }
      if (ch === "\u0003") {
        done();
        reject(new Error("cancelled"));
        return;
      }
      if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
      else value += ch;
    }
  };
  const done = (): void => {
    stdin.off("data", onData);
    stdin.setRawMode(false);
    stdin.pause();
    process.stdout.write("\n");
  };
  stdin.on("data", onData);
  return promise;
}

/** Read all of stdin (for `--password-stdin`), trimming one trailing newline. */
export async function readStdin(): Promise<string> {
  return (await new Response(Bun.stdin.stream()).text()).replace(/\r?\n$/, "");
}
