import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** Files the browser must revalidate on every load so a new release is picked up. */
const NO_CACHE = new Set(["/index.html", "/sw.js", "/manifest.webmanifest"]);

/**
 * The PWA's Content-Security-Policy. Scripts, styles and fonts come only from
 * the app's own files; `'wasm-unsafe-eval'` lets libsodium compile its wasm
 * without allowing `eval`. Images may be `data:` (the SVG icons in styles.css,
 * a received image) or `blob:` (an attachment preview). WebSockets are listed
 * by scheme because Safari and Firefox do not match `ws:`/`wss:` with `'self'`,
 * and the aggregator cannot know the public origin behind a proxy. The app is
 * never framed.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Headers on every response this module serves, a 404 included. */
function securityHeaders(): Headers {
  return new Headers({
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "x-content-type-options": "nosniff",
  });
}

function notFound(): Response {
  return new Response("not found", { status: 404, headers: securityHeaders() });
}

/**
 * Serve the built PWA from `webRoot`. GET/HEAD only. A path that names a file
 * inside `webRoot` gets that file; any other path without a file extension gets
 * `index.html` (SPA fallback). Anything that would resolve outside `webRoot`, or
 * a missing asset with an extension, is a 404. Returns `undefined` for methods
 * it does not serve so the caller can fall through.
 */
export async function serveStatic(
  webRoot: string,
  req: Request,
  pathname: string,
): Promise<Response | undefined> {
  if (req.method !== "GET" && req.method !== "HEAD") return undefined;
  const root = resolve(webRoot);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return notFound();
  }
  if (decoded.includes("\0")) return notFound();
  const requested = decoded === "/" ? "/index.html" : decoded;
  const target = resolve(root, `.${requested}`);
  if (target !== root && !target.startsWith(root + sep)) return notFound();

  if (await isFile(target)) return fileResponse(target, requested, req);
  const lastSegment = requested.slice(requested.lastIndexOf("/") + 1);
  if (lastSegment.includes(".")) return notFound();
  const index = resolve(root, "index.html");
  if (await isFile(index)) return fileResponse(index, "/index.html", req);
  return notFound();
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function fileResponse(path: string, urlPath: string, req: Request): Response {
  const file = Bun.file(path);
  const headers = securityHeaders();
  headers.set("content-type", file.type);
  if (NO_CACHE.has(urlPath)) headers.set("cache-control", "no-cache");
  return new Response(req.method === "HEAD" ? null : file, { headers });
}
