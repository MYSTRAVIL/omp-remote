import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionMeta, UplinkFrame } from "@omp-remote/protocol";
import { ChatPreferences } from "../src/core/chat-preferences";
import { ComposerPreferences } from "../src/core/composer-preferences";
import type { OverlayEntry } from "../src/core/history-nav";
import { type MediaEntry, buildTranscript } from "../src/core/transcript";
import { SessionView, renderMedia } from "../src/ui/conversation";
import type { ControlHandlers } from "../src/ui/render";

// Register a DOM only for this file and tear it down after, so happy-dom's
// globals never leak into the crypto/WebSocket-based suites in the same process.
beforeAll(() => {
  GlobalRegistrator.register();
  // happy-dom has no FontFaceSet; the composer only awaits it to re-measure.
  if (!Reflect.has(document, "fonts"))
    Object.defineProperty(document, "fonts", {
      value: { ready: Promise.resolve() },
      configurable: true,
    });
});
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => document.body.replaceChildren());

/** These tests never open the viewer, so its history entry stays inert. */
const onOverlay = (): OverlayEntry => ({ dismiss() {} });

function entry(over: Partial<MediaEntry>): MediaEntry {
  return {
    mediaId: "m:0",
    mimeType: "image/png",
    size: 1,
    totalChunks: 1,
    chunks: [],
    received: 1,
    status: "loading",
    ...over,
  };
}

test("a ready entry renders an <img> from its data URL", () => {
  const host = document.createElement("div");
  renderMedia(
    host,
    [entry({ status: "ready", dataUrl: "data:image/png;base64,AAAA" })],
    onOverlay,
  );
  const img = host.querySelector<HTMLImageElement>("img.media-image");
  expect(img).not.toBeNull();
  expect(img?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
});

test("loading and deferred show a placeholder, error and expired a marker, none an <img>", () => {
  const host = document.createElement("div");
  for (const status of ["loading", "deferred"] as const) {
    renderMedia(host, [entry({ status })], onOverlay);
    expect(host.querySelector(".media-loading")).not.toBeNull();
    expect(host.querySelector("img")).toBeNull();
  }
  for (const status of ["error", "expired"] as const) {
    renderMedia(host, [entry({ status })], onOverlay);
    expect(host.querySelector(".media-error")).not.toBeNull();
    expect(host.querySelector("img")).toBeNull();
  }
});

test("an empty list clears the container", () => {
  const host = document.createElement("div");
  renderMedia(
    host,
    [entry({ status: "ready", dataUrl: "data:image/png;base64,AAAA" })],
    onOverlay,
  );
  renderMedia(host, [], onOverlay);
  expect(host.childNodes.length).toBe(0);
});

const META: SessionMeta = {
  id: "s1",
  cwd: "/p/alpha",
  project: "alpha",
  model: "host/model",
  title: "s1",
  pid: 1,
  startedAt: 1,
};

const handlers: ControlHandlers = {
  onSelect: () => {},
  onBack: () => {},
  onOverlay,
  onPrompt: async () => true,
  onInterrupt: async () => true,
  onServiceTier: async () => true,
  onSetModel: async () => true,
  onSetThinkingLevel: async () => true,
  onCompact: async () => true,
  onCloseSession: async () => true,
  onUpload: async () => "resource",
  onSpawn: async () => true,
  onCancelSpawn: () => {},
  onInteractionReply: async () => true,
  onRenameMachine: () => true,
};

/** Image `mediaId` announced in session s1, anchored to message "m" or tool
 *  call "c1"; `deferred` marks a backfill announcement. */
function announce(
  mediaId: string,
  anchor: "message" | "tool",
  deferred?: true,
): UplinkFrame {
  return {
    t: "mediaInit",
    sessionId: "s1",
    mediaId,
    anchor:
      anchor === "tool"
        ? { kind: "tool", callId: "c1" }
        : { kind: "message", msgId: "m" },
    mimeType: "image/png",
    size: 1,
    totalChunks: 1,
    deferred,
  };
}

test("a drawn session asks its host for each deferred image and for no other", () => {
  const asked: string[] = [];
  const asking: ControlHandlers = {
    ...handlers,
    onMediaFetch: (sessionId, mediaId) => asked.push(`${sessionId} ${mediaId}`),
  };
  const view = new SessionView(
    META,
    asking,
    new ComposerPreferences(),
    new ChatPreferences(),
  );
  document.body.append(view.node);
  const transcript = buildTranscript([
    announce("in-message", "message", true),
    announce("in-tool", "tool", true),
    announce("arriving", "message"),
    announce("gone", "message", true),
    { t: "mediaError", sessionId: "s1", mediaId: "gone", code: "expired" },
  ]);
  view.update(META, transcript, asking, [], { models: [], roles: [] });
  expect(asked.sort()).toEqual(["s1 in-message", "s1 in-tool"]);
});
