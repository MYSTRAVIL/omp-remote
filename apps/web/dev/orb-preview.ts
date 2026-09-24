/// <reference lib="dom" />
// Throwaway visual harness (not part of the production build). Renders every
// orb state on the app's dark stylesheet and mocks both real placements — the
// sessions-list row badge and the above-composer strip — so the state→orb
// mapping can be eyeballed in context. Build + serve via dev/build-preview.ts.
import type { OrbState } from "thinking-orbs/engine";
import { OrbView } from "../src/ui/orb";

const STATES: ReadonlyArray<{ state: OrbState; blurb: string }> = [
  { state: "working", blurb: "particles on tilted orbits" },
  { state: "searching", blurb: "a scan meridian sweeps a globe" },
  { state: "solving", blurb: "bands scramble, then click solved" },
  { state: "listening", blurb: "a waveform rolls through rings" },
  { state: "connecting", blurb: "a constellation wires itself" },
  { state: "weaving", blurb: "three strands plait a sphere" },
  { state: "composing", blurb: "an undulating multi-band sash" },
  { state: "breathing", blurb: "a ring slowly morphing" },
  { state: "shaping", blurb: "circle → triangle → square" },
];

const live: OrbView[] = [];

function cell(state: OrbState, blurb: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cell";
  const big = new OrbView({ size: 64, state });
  const small = new OrbView({ size: 20, state });
  live.push(big, small);
  const orbs = document.createElement("div");
  orbs.className = "cell-orbs";
  orbs.append(big.node, small.node);
  const name = document.createElement("div");
  name.className = "cell-name";
  name.textContent = state;
  const desc = document.createElement("div");
  desc.className = "cell-blurb";
  desc.textContent = blurb;
  wrap.append(orbs, name, desc);
  return wrap;
}

function sessionRow(
  title: string,
  model: string,
  state: OrbState | null,
  pulse?: "done" | "error" | "question",
): HTMLElement {
  const node = document.createElement("button");
  node.className = "session";
  node.type = "button";
  if (pulse) node.dataset.pulse = pulse;
  const copy = document.createElement("span");
  copy.className = "session-row-copy";
  const t = document.createElement("span");
  t.className = "session-row-title";
  t.textContent = title;
  const m = document.createElement("span");
  m.className = "session-row-model";
  m.textContent = model;
  copy.append(t, m);
  const orb = new OrbView({ size: 20, state, className: "session-row-orb" });
  live.push(orb);
  node.append(copy, orb.node);
  return node;
}

function heading(text: string): HTMLElement {
  const h = document.createElement("h2");
  h.className = "preview-heading";
  h.textContent = text;
  return h;
}

const root = document.getElementById("preview");
if (!root) throw new Error("missing #preview");

// 1. The nine shipped states, avatar (64) + inline (20).
root.append(heading("Nine shipped states — 64 px (avatar) + 20 px (inline)"));
const grid = document.createElement("div");
grid.className = "grid";
for (const { state, blurb } of STATES) grid.append(cell(state, blurb));
root.append(grid);

// 2. Sessions-list rows, mapped by activity (working / awaiting / idle / ended).
root.append(heading("In the sessions list — one orb per row"));
const list = document.createElement("div");
list.className = "project-sessions";
list.append(
  sessionRow("Refactoring the bridge", "opus · streaming", "working"),
  sessionRow("Finished a turn", "opus · done", "breathing", "done"),
  sessionRow(
    "Waiting on your approval",
    "qwen · question",
    "listening",
    "question",
  ),
  sessionRow("Hit a control error", "qwen · error", "breathing", "error"),
  sessionRow("Idle, connected", "qwen · idle", "breathing"),
  sessionRow("Ended session", "opus · ended", null),
);
root.append(list);

// 3. The above-composer strip (64), sitting on the real session-bottom chrome.
root.append(heading("Above the composer — status strip"));
const bottom = document.createElement("div");
bottom.className = "session-bottom preview-bottom";
const strip = document.createElement("div");
strip.className = "session-orb-strip";
const stripOrb = new OrbView({ size: 64, state: "working" });
live.push(stripOrb);
strip.append(stripOrb.node);
const composer = document.createElement("form");
composer.className = "composer";
const row = document.createElement("div");
row.className = "composer-row";
const input = document.createElement("textarea");
input.className = "composer-input";
input.placeholder = "Message…";
const send = document.createElement("button");
send.className = "button primary send";
send.type = "button";
send.textContent = "Queue";
row.append(input, send);
composer.append(row);
bottom.append(strip, composer);
root.append(bottom);
