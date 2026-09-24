/**
 * Collab guest smoke — a headless Collab GUEST as a plain Bun process.
 *
 * Joins a real omp host room over the relay, completes the
 * `hello` -> `welcome` -> `snapshot-chunk` handshake, decrypts the
 * AES-256-GCM frames, and prints what it sees. With a control link it can send
 * one `prompt` and observe the host echo it back, then `abort` to avoid running
 * a full turn. Proves the host-agent can drive omp's Collab wire with nothing
 * but WebCrypto + JSON + a WebSocket — no fork, no pi-coding-agent runtime dep.
 *
 * Protocol copied verbatim from the pinned runtime, pi-coding-agent@18.1.20:
 *   src/collab/crypto.ts       seal/open: [12B IV][ciphertext+tag], AES-256-GCM, no AAD
 *   src/collab/protocol.ts     packEnvelope/unpackEnvelope: [4B BE peerId][sealed]; link format
 *   src/collab/relay-client.ts CollabSocket: `${wsUrl}?role=guest`, binaryType arraybuffer
 *   src/collab/host.ts         #handleHello -> welcome + snapshot-chunk(final:true)
 *   @oh-my-pi/pi-wire          COLLAB_PROTO=3, ROOM_KEY_BYTES=32, WRITE_TOKEN_BYTES=16
 *
 * Usage:
 *   bun scripts/parity/collab-guest-spike.ts <link> [--readonly] [--prompt "text"]
 *   <link>       control or view link, e.g. https://my.omp.sh/#<roomId>.<key>
 *   --readonly   omit the write token even from a control link (join read-only)
 *   --prompt T   after the snapshot, send prompt T (needs a control link), then abort
 */

const COLLAB_PROTO = 3;
const ROOM_KEY_BYTES = 32;
const IV_LENGTH = 12;
const ENVELOPE_HEADER_LENGTH = 4;
const DEFAULT_RELAY_ORIGIN = "wss://my.omp.sh";
const WELCOME_TIMEOUT_MS = 20_000;

type Frame = { t: string; [key: string]: unknown };

interface ParsedLink {
  wsUrl: string;
  key: Uint8Array;
  writeToken?: Uint8Array;
}

/** pi-coding-agent collab/crypto.ts asStrict: guarantee a zero-offset ArrayBuffer view for WebCrypto. */
function asStrict(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function parseLink(link: string): ParsedLink {
  let text = link.trim().replace(/%23/gi, "#");
  if (/^https?:\/\//i.test(text)) {
    const hash = text.indexOf("#");
    if (hash >= 0) text = text.slice(hash + 1);
  }
  let origin = DEFAULT_RELAY_ORIGIN;
  let roomId: string;
  let secretB64: string;
  const bare = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/.exec(text);
  if (bare) {
    roomId = bare[1] ?? "";
    secretB64 = bare[2] ?? "";
  } else {
    if (!text.includes("://")) text = `wss://${text}`;
    const url = new URL(text);
    origin = `${url.protocol === "ws:" || url.protocol === "http:" ? "ws:" : "wss:"}//${url.host}`;
    const m = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/.exec(
      url.pathname,
    );
    if (!m) throw new Error(`link missing /r/<roomId>: ${link}`);
    roomId = m[1] ?? "";
    secretB64 =
      m[2] ?? (url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  }
  const secret = new Uint8Array(Buffer.from(secretB64, "base64url"));
  if (
    secret.byteLength !== ROOM_KEY_BYTES &&
    secret.byteLength !== ROOM_KEY_BYTES + 16
  ) {
    throw new Error(
      `bad key length ${secret.byteLength} (want 32 view / 48 control)`,
    );
  }
  return {
    wsUrl: `${origin}/r/${roomId}`,
    key: secret.subarray(0, ROOM_KEY_BYTES),
    writeToken:
      secret.byteLength > ROOM_KEY_BYTES
        ? secret.subarray(ROOM_KEY_BYTES)
        : undefined,
  };
}

async function seal(key: CryptoKey, frame: Frame): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const pt = asStrict(new TextEncoder().encode(JSON.stringify(frame)));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt),
  );
  const out = new Uint8Array(IV_LENGTH + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, IV_LENGTH);
  return out;
}

async function openFrame(key: CryptoKey, data: Uint8Array): Promise<Frame> {
  const iv = asStrict(data.subarray(0, IV_LENGTH));
  const ct = asStrict(data.subarray(IV_LENGTH));
  const pt = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct),
  );
  return JSON.parse(new TextDecoder().decode(pt)) as Frame;
}

function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array {
  const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + sealed.byteLength);
  new DataView(out.buffer).setUint32(0, peerId, false);
  out.set(sealed, ENVELOPE_HEADER_LENGTH);
  return out;
}

function unpackEnvelope(
  data: Uint8Array,
): { peerId: number; payload: Uint8Array } | null {
  if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
  const peerId = new DataView(
    data.buffer,
    data.byteOffset,
    ENVELOPE_HEADER_LENGTH,
  ).getUint32(0, false);
  return { peerId, payload: data.subarray(ENVELOPE_HEADER_LENGTH) };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const link = argv.find((a) => !a.startsWith("--"));
  if (!link)
    throw new Error(
      "usage: bun collab-guest-spike.ts <link> [--readonly] [--prompt T]",
    );
  const readOnly = argv.includes("--readonly");
  const promptIdx = argv.indexOf("--prompt");
  const promptText = promptIdx >= 0 ? argv[promptIdx + 1] : undefined;

  const { wsUrl, key: rawKey, writeToken } = parseLink(link);
  const useToken = readOnly ? undefined : writeToken;
  const key = await crypto.subtle.importKey(
    "raw",
    asStrict(rawKey),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  console.log(
    `[smoke] relay=${wsUrl}?role=guest keyBytes=${rawKey.byteLength} control=${useToken !== undefined} prompt=${promptText !== undefined}`,
  );

  const done = Promise.withResolvers<void>();
  const seen = new Map<string, number>();
  let settled = false;
  let gotWelcome = false;
  let gotFinalSnapshot = false;
  let promptSent = false;
  let snapshotEntries = 0;

  const ws = new WebSocket(`${wsUrl}?role=guest`);
  ws.binaryType = "arraybuffer";

  const timer = setTimeout(
    () => finish(false, "timeout waiting for welcome + final snapshot"),
    WELCOME_TIMEOUT_MS,
  );

  function finish(ok: boolean, why: string): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    console.log(`[smoke] ${ok ? "SUCCESS" : "FAIL"}: ${why}`);
    console.log(
      `[smoke] frames seen: ${JSON.stringify(Object.fromEntries(seen))}`,
    );
    try {
      ws.close(1000);
    } catch {}
    if (ok) done.resolve();
    else done.reject(new Error(why));
  }

  ws.onopen = async () => {
    const hello: Frame = {
      t: "hello",
      proto: COLLAB_PROTO,
      name: "omp-remote-smoke",
    };
    if (useToken)
      hello.writeToken = Buffer.from(useToken).toString("base64url");
    console.log(
      `[smoke] ws open -> hello (${useToken ? "control" : "read-only"})`,
    );
    ws.send(packEnvelope(0, await seal(key, hello)));
  };

  ws.onmessage = async (ev: MessageEvent) => {
    if (typeof ev.data === "string") {
      console.log(`[smoke] control(text): ${ev.data}`);
      return;
    }
    const env = unpackEnvelope(new Uint8Array(ev.data as ArrayBuffer));
    if (!env) return;
    let frame: Frame;
    try {
      frame = await openFrame(key, env.payload);
    } catch (err) {
      finish(false, `AES-GCM decrypt failed (wrong crypto): ${String(err)}`);
      return;
    }
    seen.set(frame.t, (seen.get(frame.t) ?? 0) + 1);
    if (frame.t === "welcome") {
      gotWelcome = true;
      const header = frame.header as
        | { title?: string; cwd?: string }
        | undefined;
      console.log(
        `[smoke] WELCOME proto=${frame.proto} entryCount=${frame.entryCount} readOnly=${frame.readOnly} title=${JSON.stringify(header?.title)}`,
      );
    } else if (frame.t === "snapshot-chunk") {
      const entries = (frame.entries as unknown[]) ?? [];
      snapshotEntries += entries.length;
      if (frame.final === true) gotFinalSnapshot = true;
      console.log(
        `[smoke] snapshot-chunk entries=${entries.length} final=${frame.final} total=${snapshotEntries}`,
      );
    } else if (frame.t === "error") {
      finish(false, `host error frame: ${String(frame.message)}`);
      return;
    }

    if (gotWelcome && gotFinalSnapshot && !promptSent) {
      if (promptText && useToken) {
        promptSent = true;
        console.log(`[smoke] sending prompt: ${JSON.stringify(promptText)}`);
        ws.send(
          packEnvelope(0, await seal(key, { t: "prompt", text: promptText })),
        );
        return;
      }
      finish(
        true,
        `decrypted welcome + full snapshot (${snapshotEntries} entries) over the live relay`,
      );
    } else if (promptSent && (frame.t === "entry" || frame.t === "event")) {
      console.log(
        `[smoke] post-prompt ${frame.t} — host accepted the write; sending abort`,
      );
      ws.send(packEnvelope(0, await seal(key, { t: "abort" })));
      finish(
        true,
        "prompt round-trip: host echoed a live frame after the injected prompt",
      );
    }
  };

  ws.onclose = (ev: CloseEvent) =>
    finish(false, `closed before welcome (code ${ev.code} ${ev.reason})`);
  ws.onerror = () => console.log("[smoke] ws error event");

  await done.promise;
}

await main();

export {};
