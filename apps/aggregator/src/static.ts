import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** Files the browser must revalidate on every load so a new release is picked up. */
const NO_CACHE = new Set(["/index.html", "/sw.js", "/manifest.webmanifest"]);

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
    return new Response("not found", { status: 404 });
  }
  if (decoded.includes("\0")) return new Response("not found", { status: 404 });
  const requested = decoded === "/" ? "/index.html" : decoded;
  const target = resolve(root, `.${requested}`);
  if (target !== root && !target.startsWith(root + sep))
    return new Response("not found", { status: 404 });

  if (await isFile(target)) return fileResponse(target, requested, req);
  const lastSegment = requested.slice(requested.lastIndexOf("/") + 1);
  if (lastSegment.includes("."))
    return new Response("not found", { status: 404 });
  const index = resolve(root, "index.html");
  if (await isFile(index)) return fileResponse(index, "/index.html", req);
  return new Response("not found", { status: 404 });
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
  const headers = new Headers({ "content-type": file.type });
  if (NO_CACHE.has(urlPath)) headers.set("cache-control", "no-cache");
  return new Response(req.method === "HEAD" ? null : file, { headers });
}
