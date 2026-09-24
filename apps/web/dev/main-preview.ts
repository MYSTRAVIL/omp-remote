/// <reference lib="dom" />
// Throwaway harness: renders the real workspace tree (rail + sessions list) via
// renderTree so the actual main-screen chrome governs — used to eyeball cut
// corners and the session-row border pulse.
import type { SessionMeta } from "@omp-remote/protocol";
import type { OrbState } from "thinking-orbs/engine";
import type { MachineNode } from "../src/core/session-tree";
import type { SessionPulse } from "../src/ui/orb";
import { renderTree } from "../src/ui/render";
import type { ControlHandlers } from "../src/ui/render";

const noop = () => {};
const handlers: ControlHandlers = {
  onSelect: noop,
  onBack: noop,
  onOverlay: () => ({ dismiss: noop }),
  async onPrompt() {
    return true;
  },
  async onInterrupt() {
    return true;
  },
  async onServiceTier() {
    return true;
  },
  async onSetModel() {
    return true;
  },
  async onSetThinkingLevel() {
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
  onCancelSpawn: noop,
  async onInteractionReply() {
    return true;
  },
  onPair: noop,
  onSignOut: noop,
  onRenameMachine: () => true,
  async onUpload() {
    return true;
  },
};

function s(
  id: string,
  title: string,
  model: string,
  started: number,
): SessionMeta {
  return {
    id,
    cwd: "/home/me/proj",
    project: "omp-remote",
    model,
    title,
    pid: 1,
    startedAt: started,
  };
}

const tree: MachineNode[] = [
  {
    machineId: "my-desktop",
    label: "my-desktop",
    projects: [
      {
        project: "omp-remote",
        sessions: [
          s(
            "a",
            "Refactoring the bridge transport layer end to end",
            "opus",
            1,
          ),
          s("b", "Finished a turn, awaiting a look", "opus", 2),
          s("c", "Waiting on your approval", "qwen", 3),
          s("d", "Hit a control error", "qwen", 4),
          s("e", "Idle, connected", "qwen", 5),
        ],
      },
      {
        project: "another-project-with-a-very-long-name-here",
        sessions: [s("f", "Ended session", "opus", 6)],
      },
    ],
  },
];

const pulses: Record<string, SessionPulse> = {
  a: "question",
  b: "done",
  c: "question",
  d: "error",
  f: "done",
};
const orbs: Record<string, OrbState> = {
  a: "working",
  b: "breathing",
  c: "listening",
  d: "breathing",
  e: "breathing",
};

const app = document.getElementById("app");
if (!app) throw new Error("missing #app");
renderTree(
  app,
  tree,
  handlers,
  (id) => pulses[id] ?? null,
  (id) => orbs[id] ?? null,
);
