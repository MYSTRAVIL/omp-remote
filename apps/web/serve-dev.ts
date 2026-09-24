/**
 * Local dev static server for the built PWA (apps/web/dist), bound to loopback.
 * Pairs with the localhost dev mode (see main.ts `isLocalDev`) so the real app
 * opens against live host-agent sessions — for developers and for Playwright
 * visual checks. The host-agent must run its dev client (`agent.devClient` in
 * config.json); the page fetches that client's per-install secret from
 * DEV_CLIENT_SECRET_PATH at runtime, so the secret never enters the build.
 *
 * Usage: bun run apps/web/serve-dev.ts   (PORT overrides the default 4318; the
 * agent then needs that origin in agent.devClient.origins)
 */
import { join, normalize } from "node:path";
import {
  DEV_CLIENT_SECRET_PATH,
  type DevClientSecretResponse,
} from "@omp-remote/protocol";
import { devClientSecretPath, readSecret } from "@omp-remote/protocol/ipc";

const dist = join(import.meta.dir, "dist");
const port = Number(process.env.PORT ?? 4318);
// DNS-rebinding guard: a page on another name that resolves here must not read
// the secret, so only requests addressed to this loopback server are answered.
const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];

/** The dev-client secret, same-origin only (no CORS headers). Read-only: the
 *  host-agent creates it when its dev client starts. */
async function clientSecret(): Promise<Response> {
  let secret: string | undefined;
  try {
    secret = await readSecret(devClientSecretPath());
  } catch {
    return new Response("dev-client secret is unreadable", { status: 500 });
  }
  if (secret === undefined)
    return new Response(
      "no dev-client secret: set agent.devClient in config.json and restart omp-remote run",
      { status: 404 },
    );
  const body: DevClientSecretResponse = { secret };
  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Serve dist, the SPA shell, or the dev-client secret. */
async function route(req: Request): Promise<Response> {
  if (!hosts.includes(req.headers.get("host") ?? ""))
    return new Response("Forbidden", { status: 403 });
  const url = new URL(req.url);
  if (url.pathname === DEV_CLIENT_SECRET_PATH) return clientSecret();
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  // Contain traversal, then fall back to the SPA shell for unknown routes.
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const file = Bun.file(join(dist, safe));
  if (await file.exists()) return new Response(file);
  return new Response(Bun.file(join(dist, "index.html")), {
    headers: { "content-type": "text/html" },
  });
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const res = await route(req);
    // A framed dev app would fetch the secret same-origin and expose the
    // unauthenticated local controls to the framing site (clickjacking).
    res.headers.set("content-security-policy", "frame-ancestors 'none'");
    res.headers.set("x-frame-options", "DENY");
    return res;
  },
});

console.log(`omp-remote web dev server → http://127.0.0.1:${port}`);
