import { CollabGuest } from "../../packages/agent/src/collab/guest";
/**
 * Capture a real Collab host-frame trace as a deterministic test fixture.
 *
 * Joins a room via the production CollabGuest, optionally injects a prompt, and
 * records every decrypted host frame (raw JSON) to a file. The recorded trace
 * feeds packages/agent/src/collab/translate.test.ts, so the translator is tested
 * against reality rather than hand-authored assumptions.
 *
 * Usage:
 *   bun scripts/parity/collab-capture-trace.ts <link> <out.json> [--prompt "T"] [--ms 25000]
 */
import { CollabHostFrameSchema } from "../../packages/agent/src/collab/schema";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const positionals = argv.filter((a) => !a.startsWith("--"));
  const link = positionals[0];
  const out = positionals[1];
  if (!link || !out)
    throw new Error(
      "usage: bun collab-capture-trace.ts <link> <out.json> [--prompt T] [--ms N]",
    );
  const promptIdx = argv.indexOf("--prompt");
  const promptText = promptIdx >= 0 ? argv[promptIdx + 1] : undefined;
  const msIdx = argv.indexOf("--ms");
  const durationMs = msIdx >= 0 ? Number(argv[msIdx + 1]) : 25_000;

  const frames: unknown[] = [];
  const guest = new CollabGuest({ link, name: "trace-capture" });
  const done = Promise.withResolvers<void>();
  let sawFinalSnapshot = false;
  let promptSent = false;

  guest.onOpen = () => console.log("[capture] joined; waiting for snapshot");
  guest.onClose = (reason) => {
    console.log(`[capture] closed: ${reason}`);
    done.resolve();
  };
  guest.onFrame = (frame) => {
    frames.push(frame);
    const parsed = CollabHostFrameSchema.safeParse(frame);
    if (!parsed.success) return;
    if (parsed.data.t === "snapshot-chunk" && parsed.data.final)
      sawFinalSnapshot = true;
    if (sawFinalSnapshot && !promptSent && promptText && guest.canWrite) {
      promptSent = true;
      console.log(`[capture] sending prompt: ${JSON.stringify(promptText)}`);
      guest.send({ t: "prompt", text: promptText });
    }
  };

  await guest.start();
  const timer = setTimeout(() => done.resolve(), durationMs);
  await done.promise;
  clearTimeout(timer);
  guest.stop();

  await Bun.write(out, JSON.stringify(frames, null, 2));
  const counts: Record<string, number> = {};
  for (const f of frames) {
    const parsed = CollabHostFrameSchema.safeParse(f);
    const t = parsed.success ? parsed.data.t : "?";
    counts[t] = (counts[t] ?? 0) + 1;
  }
  console.log(
    `[capture] wrote ${frames.length} frames to ${out}: ${JSON.stringify(counts)}`,
  );
}

await main();
