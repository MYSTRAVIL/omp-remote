/// <reference lib="dom" />
// Throwaway: one orb with a long crossfade, exposed on window so the browser
// driver can trigger a state change and screenshot mid-transition.
import { OrbView } from "../src/ui/orb";

const app = document.getElementById("app");
if (!app) throw new Error("missing #app");
app.style.cssText =
  "background:#000;display:grid;place-items:center;height:100vh;margin:0";

const orb = new OrbView({ size: 64, state: "working", transitionMs: 2000 });
app.append(orb.node);
Object.assign(globalThis, { orb });
