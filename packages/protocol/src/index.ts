// Browser-safe barrel. The node-only loopback IPC (`node:net`) lives at the
// `@omp-remote/protocol/ipc` subpath so browser bundles (PWA) never pull it in.
export * from "./frames";
export * from "./codec";
export * from "./aggregator";
export * from "./local-auth";
export * from "./pairing";
export * from "./notify";
export * from "./queue";
export * from "./scheduler";
export * from "./sealed-wire";
export * from "./xdev";
