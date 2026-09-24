import { createSocket } from "node:dgram";
import {
  type NetworkInterfaceInfo,
  hostname,
  networkInterfaces,
} from "node:os";
import { ask, askSecret, choose, readStdin } from "./prompt";

/**
 * The IPv4 address the OS would send internet traffic from: the real LAN
 * address, whatever its adapter is called. A UDP `connect` only picks a
 * route and sends nothing; 192.0.2.1 (TEST-NET-1) is never answered.
 * Undefined when there is no default route (offline).
 */
export function defaultRouteAddress(): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const socket = createSocket("udp4");
  socket.once("error", () => {
    socket.close();
    resolve(undefined);
  });
  socket.connect(53, "192.0.2.1", () => {
    const { address } = socket.address();
    socket.close();
    resolve(address === "0.0.0.0" ? undefined : address);
  });
  return promise;
}

/**
 * The impure edges the commands run through: the terminal, the host, the
 * network, the clock and process signals. Tests pass their own so a command
 * runs without a TTY, a real signal or a wall-clock timer.
 */
export interface CliDeps {
  /** Write a line (or a block of lines) to stdout. */
  print(text: string): void;
  /** Write a line to stderr. */
  printError(text: string): void;
  ask(question: string, fallback?: string): Promise<string>;
  choose(question: string, options: readonly string[]): Promise<number>;
  askSecret(question: string): Promise<string>;
  readStdin(): Promise<string>;
  hostname(): string;
  networkInterfaces(): NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** See {@link defaultRouteAddress}. */
  defaultRouteAddress(): Promise<string | undefined>;
  fetch: typeof fetch;
  now(): number;
  /** Wait between two pairing polls. */
  sleep(ms: number): Promise<void>;
  /** Resolves once the operator stops a long-running command (SIGINT/SIGTERM). */
  stopRequested(): Promise<void>;
}

export const processDeps: CliDeps = {
  print: console.log,
  printError: console.error,
  ask,
  choose,
  askSecret,
  readStdin,
  hostname,
  networkInterfaces,
  defaultRouteAddress,
  fetch,
  now: Date.now,
  sleep: Bun.sleep,
  stopRequested: () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
    return promise;
  },
};
