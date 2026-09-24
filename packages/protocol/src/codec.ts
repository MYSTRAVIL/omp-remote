import { AnyFrame, type Frame } from "./frames";

export class FrameParseError extends Error {}

export function encodeFrame(frame: Frame): string {
  return `${JSON.stringify(frame)}\n`;
}

export class FrameDecoder {
  #buf = "";
  push(chunk: string | Uint8Array): Frame[] {
    this.#buf +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    const out: Frame[] = [];
    for (;;) {
      const nl = this.#buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (line.trim() === "") continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch (err) {
        throw new FrameParseError(`invalid JSON: ${(err as Error).message}`);
      }
      const parsed = AnyFrame.safeParse(json);
      if (!parsed.success) throw new FrameParseError(parsed.error.message);
      out.push(parsed.data);
    }
    return out;
  }
}
