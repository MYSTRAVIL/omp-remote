import { z } from "zod";

export const MachineId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

const listenDefaults = { host: "0.0.0.0", port: 8788 };
const listen = z
  .object({
    host: z.string().optional(),
    port: z.number().int().min(0).max(65535).optional(),
  })
  .transform((v) => ({
    host: listenDefaults.host,
    port: listenDefaults.port,
    ...v,
  }));

export const ServerSection = z
  .object({
    listen: listen.optional(),
    publicUrl: z
      .url()
      .refine((u) => u.startsWith("https://"))
      .optional(),
    webRoot: z.string().optional(),
    sessionTtlSec: z.number().int().positive().optional(),
    rememberTtlSec: z.number().int().positive().optional(),
    collabRelay: z.boolean().optional(),
    pushSubject: z.string().optional(),
    /**
     * A loopback peer is a reverse proxy that sets `X-Real-IP` to its client
     * (nginx; Caddy with `header_up X-Real-IP {remote_host}`), which the
     * per-client limits then key on. Off by default: headers are ignored.
     */
    trustProxy: z.boolean().optional(),
  })
  .transform((v) => ({
    listen: v.listen ?? {
      host: listenDefaults.host,
      port: listenDefaults.port,
    },
    publicUrl: v.publicUrl,
    webRoot: v.webRoot,
    sessionTtlSec: v.sessionTtlSec ?? 3600,
    rememberTtlSec: v.rememberTtlSec ?? 2_592_000,
    collabRelay: v.collabRelay ?? false,
    pushSubject: v.pushSubject ?? "mailto:omp-remote@localhost",
    trustProxy: v.trustProxy ?? false,
  }));

const agentDefaults = { collab: false, ompBin: "omp" };
export const AgentSection = z
  .object({
    serverUrl: z.url(),
    phoneId: z.string().optional(),
    collab: z.boolean().optional(),
    ompBin: z.string().optional(),
    devClient: z
      .object({
        port: z.number().int().optional(),
        origins: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .transform((v) => ({
    serverUrl: v.serverUrl,
    phoneId: v.phoneId,
    collab: v.collab ?? agentDefaults.collab,
    ompBin: v.ompBin ?? agentDefaults.ompBin,
    devClient: v.devClient
      ? {
          port: v.devClient.port ?? 4319,
          origins: v.devClient.origins ?? ["http://localhost:4318"],
        }
      : undefined,
  }));

export const Config = z
  .object({
    version: z.literal(1),
    machineId: MachineId,
    server: ServerSection.optional(),
    agent: AgentSection.optional(),
  })
  .refine(
    (c) => c.server || c.agent,
    "config needs a server or an agent section",
  );
export type Config = z.infer<typeof Config>;
