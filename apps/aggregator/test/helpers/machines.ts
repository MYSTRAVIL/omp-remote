import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineStore } from "../../src/machine-store";

/**
 * A machine store at a fresh temp path. Nothing touches the disk until a token
 * is issued, so a harness that never dials `/agent` leaves nothing behind.
 */
export function tempMachineStore(): Promise<MachineStore> {
  const dir = join(tmpdir(), `omp-machines-${randomBytes(6).toString("hex")}`);
  return MachineStore.load(join(dir, "machines.json"));
}
