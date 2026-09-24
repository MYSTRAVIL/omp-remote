// Loopback WS client for the single-machine foundation smoke test.
// Lists the agent's sessions; with SEND_PROMPT set, drives the first session
// and exits 0 when a relayed assistant frame carries the prompt's marker.
// Needs the host-agent's dev client (`agent.devClient` in config.json), which
// creates the per-install secret this client presents.
import { devClientSecretPath, readSecret } from "../packages/protocol/src/ipc";
import { devClientProtocols } from "../packages/protocol/src/local-auth";

const port = Number(process.env.OMP_REMOTE_CLIENT_PORT ?? "4319");
const sendPrompt = process.env.SEND_PROMPT;
const marker = process.env.EXPECT_MARKER;
const deadlineMs = Number(process.env.SMOKE_TIMEOUT_MS ?? "60000");

const secret = await readSecret(devClientSecretPath());
if (secret === undefined) {
  console.error(
    "no dev-client secret: set agent.devClient in config.json and restart omp-remote run",
  );
  process.exit(1);
}
const ws = new WebSocket(`ws://127.0.0.1:${port}`, devClientProtocols(secret));
let promptSent = false;

const timer = setTimeout(() => {
  console.error("SMOKE TIMEOUT: no matching frame within budget");
  process.exit(1);
}, deadlineMs);

ws.addEventListener("open", () => console.log("connected"));
ws.addEventListener("error", (e) => {
  console.error("WS ERROR", String(e));
  process.exit(1);
});
ws.addEventListener("message", (e) => {
  const frame = JSON.parse(String(e.data));
  if (frame.t === "sessions") {
    console.log(
      "SESSIONS:",
      frame.sessions.map(
        (s: { id: string; project: string }) => `${s.project}/${s.id}`,
      ),
    );
    const first = frame.sessions[0];
    if (first && sendPrompt && !promptSent) {
      promptSent = true;
      ws.send(
        JSON.stringify({
          t: "prompt",
          sessionId: first.id,
          text: sendPrompt,
          mode: "steer",
        }),
      );
      console.log("sent prompt to", first.id);
    }
    return;
  }
  const text = typeof frame.text === "string" ? frame.text : "";
  console.log("FRAME:", frame.t, frame.sessionId ?? "", text.slice(0, 80));
  if (marker && text.includes(marker)) {
    console.log("SMOKE OK: saw marker", marker);
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  }
});
