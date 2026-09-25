/// <reference lib="dom" />
// Throwaway harness: mounts the real SessionView with mock data inside the real
// #app/.workspace chrome so the actual CSS governs layout. Used to eyeball
// markdown rendering, the footer status orb, the running-work strip, and
// composer growth.
import type { SessionMeta } from "@omp-remote/protocol";
import { ChatPreferences } from "../src/core/chat-preferences";
import { ComposerPreferences } from "../src/core/composer-preferences";
import type { SessionCatalog } from "../src/core/store";
import type { TranscriptState } from "../src/core/transcript";
import { SessionView } from "../src/ui/conversation";
import type { ControlHandlers } from "../src/ui/render";

const handlers: ControlHandlers = {
  onSelect() {},
  onBack() {},
  onOverlay() {
    return { dismiss() {} };
  },
  async onPrompt() {
    return true;
  },
  async onInterrupt() {
    return true;
  },
  async onServiceTier() {
    return true;
  },
  async onSetModel(_sessionId, model) {
    console.log("setModel", model);
    return true;
  },
  async onSetThinkingLevel(_sessionId, level) {
    console.log("setThinkingLevel", level);
    return true;
  },
  async onCompact() {
    return true;
  },
  async onCloseSession() {
    return true;
  },
  async onSpawn() {
    return true;
  },
  onCancelSpawn() {},
  async onInteractionReply() {
    return true;
  },
  onPair() {},
  onSignOut() {},
  onRenameMachine() {
    return true;
  },
  async onUpload(_sessionId, _file, onProgress) {
    onProgress(0.4);
    onProgress(1);
    return "res-preview";
  },
};

const session: SessionMeta = {
  id: "s1",
  cwd: "/home/me/proj",
  project: "omp-remote",
  model: "opus",
  title: "Refactoring the bridge",
  pid: 1,
  startedAt: 0,
};

const md = [
  "Here's the plan, with **bold**, *italic*, and `inline code`:",
  "",
  "## Steps",
  "1. Parse the inbound frame",
  "2. Reduce it into transcript state",
  "",
  "- keep the reducer pure",
  "- never trust the wire",
  "",
  "```ts",
  "const x: number = 42;",
  "reduce(state, frame);",
  "```",
  "",
  "> A note worth quoting for later.",
  "",
  "See [the design doc](https://example.com) for the full contract.",
].join("\n");

const transcript: TranscriptState = {
  entries: [
    {
      kind: "message",
      msgId: "u1",
      role: "user",
      text: "Refactor the bridge and show me some markdown, please.",
      streaming: false,
    },
    ...["read", "grep", "read", "edit"].map((name, i) => ({
      kind: "tool" as const,
      callId: `g${i}`,
      name,
      status: "ok",
      preview: "done",
      title: `apps/web/src/ui/file-${i}.ts`,
      done: true,
    })),
    {
      kind: "message",
      msgId: "a1",
      role: "assistant",
      text: md,
      streaming: false,
    },
    {
      kind: "message",
      msgId: "pending-1",
      role: "user",
      text: "actually, steer it toward a crossfade instead",
      streaming: false,
      pending: "steer",
    },
    {
      kind: "tool",
      callId: "t1",
      name: "task",
      status: "running",
      preview: "",
      title: "Scout the reconnect handshake for dropped frames",
      done: false,
    },
  ],
  footer: {
    model: "opus",
    thinkingLevel: "xhigh",
    contextPct: 42.7,
    contextTokens: 85_000,
    contextWindow: 200_000,
    streaming: true,
    title: "Refactoring the bridge v2 (later re-title)",
  },
  title:
    "Refactoring the bridge transport, reducer, and reconnect handshake end to end",
  jobs: {
    running: [
      {
        id: "bg_5",
        type: "bash",
        label: "bun test packages/bridge",
        status: "running",
        startMs: Date.now() - 95_000,
      },
    ],
    recent: 0,
  },
  ended: false,
};

const catalog: SessionCatalog = {
  models: [
    {
      id: "anthropic/claude-opus-4-8",
      name: "Opus 4.8",
      provider: "anthropic",
      efforts: ["low", "medium", "high", "xhigh"],
      acceptsImages: true,
    },
    {
      id: "anthropic/claude-sonnet-4-8",
      name: "Sonnet 4.8",
      provider: "anthropic",
      efforts: ["low", "high"],
      acceptsImages: true,
    },
    {
      id: "qwen/qwen3-coder",
      name: "Qwen3 Coder",
      provider: "qwen",
      efforts: [],
      acceptsImages: false,
    },
  ],
  roles: [
    {
      role: "task",
      modelId: "qwen/qwen3-coder",
      modelName: "Qwen3 Coder",
      provider: "qwen",
    },
    {
      role: "heavy",
      modelId: "anthropic/claude-opus-4-8",
      modelName: "Opus 4.8",
      provider: "anthropic",
    },
  ],
  currentId: "anthropic/claude-opus-4-8",
  currentEffort: "xhigh",
};

const app = document.getElementById("app");
if (!app) throw new Error("missing #app");
const workspace = document.createElement("div");
workspace.className = "workspace has-session";
const content = document.createElement("main");
content.className = "workspace-content";
workspace.append(content);
app.append(workspace);

const view = new SessionView(
  session,
  handlers,
  new ComposerPreferences(),
  new ChatPreferences(),
);
content.append(view.node);
const pending = [
  {
    t: "interaction" as const,
    sessionId: session.id,
    id: "q1",
    payload: {
      kind: "ask" as const,
      questions: [
        {
          question: "Which crossfade curve should the transition use?",
          options: [{ label: "Linear" }, { label: "Equal-power" }],
        },
      ],
    },
  },
];
view.update(
  session,
  transcript,
  handlers,
  [],
  catalog,
  "workstation-alpha-desktop",
);
